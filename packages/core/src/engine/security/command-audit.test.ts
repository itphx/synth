/**
 * PROP-136 (слайс 136a): файловый append-only журнал исполнений команд.
 *
 * Проверяется контракт `CommandAuditLog` (append/list/prune, битые строки),
 * обезличивание команды (`prepareCommandForAudit`/`redactCommand`) и
 * эффективная секция конфига (env > config > defaults).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandAuditEntry } from '@itphx/synth-shared';
import {
  COMMAND_AUDIT_MAX_COMMAND_BYTES,
  CommandAuditLog,
  commandFromToolArgs,
  createCommandAuditLog,
  isCommandAuditTool,
  prepareCommandForAudit,
  redactCommand,
  resolveCommandAuditConfig,
  sha256Hex,
  truncateUtf8Bytes,
} from './command-audit.js';
import type { CommandAuditMetricsSink } from './command-audit.js';

function makeEntry(overrides: Partial<CommandAuditEntry> = {}): CommandAuditEntry {
  return {
    id: 'exec-1',
    ts: '2026-11-12T10:00:00.000Z',
    sessionId: 'ses-1',
    projectId: 'prj-1',
    actor: 'local',
    agentRole: 'fixer',
    profile: 'default',
    tool: 'execute_shell',
    command: 'ls -la',
    commandHash: sha256Hex('ls -la'),
    cwd: '/work',
    background: false,
    decision: 'allow',
    decidedBy: 'permission',
    phase: 'started',
    ...overrides,
  };
}

describe('CommandAuditLog', () => {
  let dir: string;
  let log: CommandAuditLog;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-command-audit-'));
    log = createCommandAuditLog({ dataDir: dir, config: { enabled: true }, env: {} });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('append(list) — свежие первыми, файл в {dataDir}/audit/commands.jsonl', async () => {
    await log.append(makeEntry({ id: 'a', phase: 'started' }));
    await log.append(makeEntry({ id: 'a', phase: 'finished' }));

    const entries = await log.list();
    expect(entries.map((e) => e.phase)).toEqual(['finished', 'started']);
    expect(log.path).toBe(join(dir, 'audit', 'commands.jsonl'));
    // JSONL: одна строка на запись.
    const raw = await readFile(log.path, 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);
  });

  it('фильтры: sessionId/projectId/decision/from/to/limit', async () => {
    await log.append(makeEntry({ id: 'e1', ts: '2026-11-10T09:00:00.000Z', sessionId: 'ses-1' }));
    await log.append(makeEntry({
      id: 'e2',
      ts: '2026-11-11T09:00:00.000Z',
      sessionId: 'ses-2',
      projectId: 'prj-2',
      decision: 'ask',
    }));
    await log.append(makeEntry({ id: 'e3', ts: '2026-11-12T09:00:00.000Z', sessionId: 'ses-1' }));

    expect((await log.list({ sessionId: 'ses-1' })).map((e) => e.id)).toEqual(['e3', 'e1']);
    expect((await log.list({ projectId: 'prj-2' })).map((e) => e.id)).toEqual(['e2']);
    expect((await log.list({ decision: 'ask' })).map((e) => e.id)).toEqual(['e2']);
    expect((await log.list({ from: '2026-11-11T00:00:00.000Z' })).map((e) => e.id)).toEqual(['e3', 'e2']);
    expect((await log.list({ to: '2026-11-11T23:59:59.000Z' })).map((e) => e.id)).toEqual(['e2', 'e1']);
    expect((await log.list({ limit: 1 })).map((e) => e.id)).toEqual(['e3']);
    // `limit` не положительный — без ограничения.
    expect(await log.list({ limit: 0 })).toHaveLength(3);
  });

  it('PROP-136b: provider/reason/decidedBy="policy" сериализуются и читаются', async () => {
    await log.append(
      makeEntry({
        id: 'p1',
        phase: 'finished',
        decision: 'deny',
        decidedBy: 'policy',
        matchedRule: 'no-rm',
        durationMs: 0,
        reason: 'blocked by rule',
        provider: { kind: 'opa', ruleId: 'no-rm', latencyMs: 3, action: 'deny' },
      }),
    );

    const entries = await log.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      decision: 'deny',
      decidedBy: 'policy',
      matchedRule: 'no-rm',
      durationMs: 0,
      reason: 'blocked by rule',
      provider: { kind: 'opa', ruleId: 'no-rm', latencyMs: 3, action: 'deny' },
    });
    // JSONL — одна строка, поля на месте.
    const raw = await readFile(log.path, 'utf8');
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(parsed['decidedBy']).toBe('policy');
    expect(parsed['reason']).toBe('blocked by rule');
    expect(parsed['provider']).toEqual({
      kind: 'opa',
      ruleId: 'no-rm',
      latencyMs: 3,
      action: 'deny',
    });
  });

  it('битые строки пропускаются (журнал не ломается)', async () => {
    await log.append(makeEntry({ id: 'ok-1' }));
    await writeFile(log.path, `${await readFile(log.path, 'utf8')}{не json}\n`, 'utf8');
    await log.append(makeEntry({ id: 'ok-2' }));

    const entries = await log.list();
    expect(entries.map((e) => e.id)).toEqual(['ok-2', 'ok-1']);
  });

  it('нет файла — пустой список', async () => {
    const empty = createCommandAuditLog({ dataDir: join(dir, 'nested'), config: { enabled: true }, env: {} });
    expect(await empty.list()).toEqual([]);
  });

  it('prune(days) удаляет старые записи и возвращает их число', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    await log.append(makeEntry({ id: 'old', ts: old }));
    await log.append(makeEntry({ id: 'fresh', ts: fresh }));

    expect(await log.prune(30)).toBe(1);
    expect((await log.list()).map((e) => e.id)).toEqual(['fresh']);
    // Повтор — удалять нечего.
    expect(await log.prune(30)).toBe(0);
    // `days <= 0` — ограничения нет.
    expect(await log.prune(0)).toBe(0);
    expect(await log.list()).toHaveLength(1);
  });

  it('выключенный журнал ничего не пишет (append — no-op)', async () => {
    const disabled = createCommandAuditLog({ dataDir: dir, config: { enabled: false }, env: {} });
    expect(disabled.enabled).toBe(false);
    await disabled.append(makeEntry());
    expect(await disabled.list()).toEqual([]);
  });

  it('путь из config.path приоритетнее {dataDir}/audit', async () => {
    const custom = join(dir, 'custom', 'audit.jsonl');
    const customLog = createCommandAuditLog({
      dataDir: dir,
      config: { enabled: true, path: custom },
      env: {},
    });
    await customLog.append(makeEntry());
    expect(customLog.path).toBe(custom);
    expect(await customLog.list()).toHaveLength(1);
  });

  it('метрики: written/failed/dropped', async () => {
    const calls: string[] = [];
    const sink: CommandAuditMetricsSink = {
      onWritten: (phase, tool) => calls.push(`written:${phase}:${tool}`),
      onFailed: (phase, tool) => calls.push(`failed:${phase}:${tool}`),
      onDropped: (count) => calls.push(`dropped:${count}`),
    };
    const withMetrics = createCommandAuditLog({
      dataDir: dir,
      config: { enabled: true },
      env: {},
      metrics: sink,
    });
    await withMetrics.append(makeEntry({ phase: 'started' }));
    expect(calls).toEqual(['written:started:execute_shell']);

    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await withMetrics.append(makeEntry({ id: 'old', ts: old }));
    await withMetrics.prune(5);
    expect(calls).toContain('dropped:1');

    // Сбой записи: каталог вместо файла-родителя.
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a dir', 'utf8');
    const failing = createCommandAuditLog({
      dataDir: dir,
      config: { enabled: true, path: join(blocker, 'commands.jsonl') },
      env: {},
      metrics: sink,
    });
    const before = calls.length;
    await expect(failing.append(makeEntry())).rejects.toThrow();
    expect(calls.slice(before)).toEqual(['failed:started:execute_shell']);
  });
});

describe('resolveCommandAuditConfig', () => {
  it('дефолты: выключено, 30 дней, пустой путь', () => {
    expect(resolveCommandAuditConfig(undefined, {})).toEqual({
      enabled: false,
      retentionDays: 30,
      path: '',
    });
  });

  it('config перебивает дефолты', () => {
    const cfg = resolveCommandAuditConfig({ enabled: true, retentionDays: 7, path: '/x.jsonl' }, {});
    expect(cfg).toEqual({ enabled: true, retentionDays: 7, path: '/x.jsonl' });
  });

  it('env перебивает config (SYNTH_COMMAND_AUDIT_ENABLED/_RETENTION_DAYS)', () => {
    const cfg = resolveCommandAuditConfig(
      { enabled: false, retentionDays: 30, path: '' },
      { SYNTH_COMMAND_AUDIT_ENABLED: 'true', SYNTH_COMMAND_AUDIT_RETENTION_DAYS: '5' },
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.retentionDays).toBe(5);
  });

  it('невалидный env игнорируется (остаётся config/дефолт)', () => {
    const cfg = resolveCommandAuditConfig(
      { enabled: true, retentionDays: 30, path: '' },
      { SYNTH_COMMAND_AUDIT_ENABLED: 'maybe', SYNTH_COMMAND_AUDIT_RETENTION_DAYS: 'abc' },
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.retentionDays).toBe(30);
  });
});

describe('redactCommand', () => {
  it('Bearer/Basic', () => {
    expect(redactCommand('curl -H "Authorization: Bearer abcdef123456" https://x'))
      .toBe('curl -H "Authorization: Bearer ***" https://x');
    expect(redactCommand('curl -H "Authorization: Basic dXNlcjpwYXNz" https://x'))
      .toBe('curl -H "Authorization: Basic ***" https://x');
  });

  it('--password=…, --token=…, --api-key=…', () => {
    expect(redactCommand('tool --password=hunter2 --verbose')).toBe('tool --password=*** --verbose');
    expect(redactCommand('tool --token abc123')).toBe('tool --token ***');
    expect(redactCommand('curl --api-key=sk-live-123 https://x')).toBe('curl --api-key=*** https://x');
  });

  it('URL с userinfo — логин и пароль скрыты', () => {
    expect(redactCommand('git clone https://user:secret@git.example/repo.git'))
      .toBe('git clone https://***@git.example/repo.git');
    expect(redactCommand('git clone https://token@git.example/repo.git'))
      .toBe('git clone https://***@git.example/repo.git');
  });

  it('значения из `secrets` заменяются целиком', () => {
    expect(redactCommand('export KEY=ABC-123 && run', ['ABC-123'])).toBe('export KEY=*** && run');
  });

  it('обычная команда не меняется', () => {
    expect(redactCommand('ls -la && cat README.md')).toBe('ls -la && cat README.md');
  });
});

describe('prepareCommandForAudit', () => {
  it('карта обфускации сессии: плейсхолдер вместо значения, hash — от обезличенной строки', () => {
    const secret = 'sk-live-abcdef123456';
    const map = { '⟦SYNTH_SECRET_1⟧': secret };
    const prepared = prepareCommandForAudit(`export TOKEN=${secret}`, { secretsMap: map });
    expect(prepared.command).toBe('export TOKEN=⟦SYNTH_SECRET_1⟧');
    expect(prepared.commandHash).toBe(sha256Hex('export TOKEN=⟦SYNTH_SECRET_1⟧'));
    expect(prepared.commandHash).not.toBe(sha256Hex(`export TOKEN=${secret}`));
  });

  it('hash считается от полной строки, а command обрезается до 4 КиБ', () => {
    const long = `echo ${'a'.repeat(COMMAND_AUDIT_MAX_COMMAND_BYTES + 500)}`;
    const prepared = prepareCommandForAudit(long);
    expect(Buffer.byteLength(prepared.command, 'utf8')).toBeLessThanOrEqual(COMMAND_AUDIT_MAX_COMMAND_BYTES);
    expect(prepared.commandHash).toBe(sha256Hex(long));
  });
});

describe('truncateUtf8Bytes', () => {
  it('не рвёт UTF-8 (многобайтные символы)', () => {
    // «я» — 2 байта: при лимите 5 влезают 2 символа (4 байта), третий — нет.
    expect(truncateUtf8Bytes('яяя', 5)).toBe('яя');
    expect(truncateUtf8Bytes('hello', 5)).toBe('hello');
    expect(truncateUtf8Bytes('hello', 0)).toBe('');
  });
});

describe('commandFromToolArgs / isCommandAuditTool', () => {
  it('execute_shell → args.command', () => {
    expect(commandFromToolArgs('execute_shell', { command: 'ls -la' })).toBe('ls -la');
    expect(commandFromToolArgs('execute_shell', {})).toBe('');
  });

  it('sandbox_exec → commands.join(" && ")', () => {
    expect(commandFromToolArgs('sandbox_exec', { commands: ['npm ci', 'npm test'] }))
      .toBe('npm ci && npm test');
    expect(commandFromToolArgs('sandbox_exec', { commands: [] })).toBe('');
    expect(commandFromToolArgs('sandbox_exec', { commands: ['only'] })).toBe('only');
  });

  it('журналируются только execute_shell и sandbox_exec', () => {
    expect(isCommandAuditTool('execute_shell')).toBe(true);
    expect(isCommandAuditTool('sandbox_exec')).toBe(true);
    expect(isCommandAuditTool('git_status')).toBe(false);
  });
});
