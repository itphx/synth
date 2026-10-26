/**
 * ADR-077 (протокол 4) / ADR-099: окружение вызова на стороне исполнителя.
 *
 * Порядок наложения env: `env` вызова → CA-тройка `GIT_CONFIG_*` (если задан
 * CA исполнителя) → env секрета (перекрывает всё). CA передаётся env-каналом
 * (git ≥ 2.31), а не argv: `-c http.sslCAInfo=…` в чужую команду подмешивать
 * нельзя.
 *
 * Секреты **не** попадают ни в тело ошибки, ни в текст сообщения: в ответе
 * исполнителя материала быть не должно.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecService } from './exec-service.js';

const CA_FILE = '/etc/synth/tls/ca.pem';
const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nerror-body-must-not-contain-it\n-----END OPENSSH PRIVATE KEY-----\n';

describe('исполнитель: окружение вызова', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'synth-exec-env-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function makeService(opts: { tlsCaFile?: string } = {}): ExecService {
    return new ExecService({
      workspaceRoot: workspace,
      maxConcurrency: 2,
      maxTimeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
      ...(opts.tlsCaFile ? { tlsCaFile: opts.tlsCaFile } : {}),
    });
  }

  it('tlsCaFile задан — в окружении GIT_CONFIG_COUNT/KEY_0/VALUE_0', async () => {
    const service = makeService({ tlsCaFile: CA_FILE });
    const outcome = await service.execute({
      command: {
        kind: 'shell',
        command: 'printf "%s|%s|%s" "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0"',
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.stdout).toBe(`1|http.sslCAInfo|${CA_FILE}`);
  });

  it('tlsCaFile не задан — GIT_CONFIG_* в окружении нет', async () => {
    const service = makeService();
    const outcome = await service.execute({
      command: {
        kind: 'shell',
        command: 'printf "%s|%s|%s" "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0"',
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.stdout).toBe('||');
  });

  it('env вызова мержится, а не заменяет базовое окружение', async () => {
    const service = makeService();
    const outcome = await service.execute({
      command: { kind: 'shell', command: 'printf "%s|%s" "$SYNTH_EXEC_VAR" "$PATH"' },
      env: { SYNTH_EXEC_VAR: 'value' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [value = '', path = ''] = outcome.result.stdout.split('|');
    expect(value).toBe('value');
    // Базовое окружение исполнителя не вытеснено.
    expect(path.length).toBeGreaterThan(0);
  });

  it('CA исполнителя перекрывает значения из env вызова', async () => {
    const service = makeService({ tlsCaFile: CA_FILE });
    const outcome = await service.execute({
      command: {
        kind: 'shell',
        command: 'printf "%s|%s" "$GIT_CONFIG_COUNT" "$GIT_CONFIG_VALUE_0"',
      },
      env: { GIT_CONFIG_COUNT: '9', GIT_CONFIG_VALUE_0: 'spoofed' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.stdout).toBe(`1|${CA_FILE}`);
  });

  it('секреты не попадают в тело ошибки (ненулевой код выхода)', async () => {
    const service = makeService();
    const outcome = await service.execute({
      command: { kind: 'shell', command: 'printf o; exit 3' },
      secrets: [{ kind: 'ssh-key', privateKey: PRIVATE_KEY }],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const serialized = JSON.stringify(outcome.error);
    expect(serialized).not.toContain('error-body-must-not-contain-it');
    expect(serialized).not.toContain('BEGIN OPENSSH PRIVATE KEY');
  });

  it('сбой подготовки секрета — ошибка без материала', async () => {
    const service = makeService();
    const outcome = await service.execute({
      command: { kind: 'shell', command: 'printf hi' },
      secrets: [{ kind: 'ssh-key', privateKey: undefined as unknown as string }],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.reason).toBe('internal_error');
    expect(outcome.error.message).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(JSON.stringify(outcome.error)).not.toContain('privateKey');
  });
});
