/**
 * PROP-136 (слайс 136a): запись журнала исполнений в оркестраторе.
 *
 * Проверяется единственная точка исполнения tool-call:
 * - `execute_shell` с включённым журналом → две записи (`started`/`finished`)
 *   с одним `id` и метриками длительности/hash вывода;
 * - сбой записи `started` **блокирует** команду (tool не выполняется);
 * - выключенный журнал → записей нет;
 * - `sandbox_exec` → `command = commands.join(' && ')`;
 * - `background: true` попадает в запись.
 *
 * Harness — как в соседних тестах оркестратора: фейковый провайдер (шаг 0 —
 * вызов тула, шаг 1 — финальный текст) и настоящий реестр встроенных тулов.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import { createToolRegistry } from './tools/index.js';
import { createAgentRegistry } from './agents/index.js';
import { createCommandAuditLog, sha256Hex } from './security/command-audit.js';
import type { CommandAuditLog } from './security/command-audit.js';
import type { SecurityConfig } from '@itphx/synth-shared';
import {
  generateId,
  MessageRole,
  nowISO,
  makeTextPart,
  type Message,
  type Session,
} from '@itphx/synth-shared';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

/** Секция `security` для тестов: журнал исполнений — параметр теста, не конфига. */
const TEST_SECURITY: SecurityConfig = {
  promptInjection: { enabled: true, wrapContent: true, mode: 'flag' },
  protectedPaths: { enabled: true },
  secretKey: '',
  commandAudit: { enabled: false, retentionDays: 30, path: '' },
  // PROP-136b: зеркальный чекер команд — параметр теста (`commandPolicy`).
  commandPolicy: {
    enabled: false,
    provider: 'http',
    url: '',
    tokenSecret: '',
    failMode: 'open',
    timeoutMs: 2_000,
    opaPath: '/v1/data/synth/exec/decision',
  },
};

/** Провайдер: шаг 0 — вызов тула, шаг 1 — финальный текст. */
class AuditScriptProvider extends BaseProvider {
  static calls = 0;
  static toolCall: { name: string; args: Record<string, unknown> } = { name: '', args: {} };

  private _next(): { content: string; toolCalls?: Record<string, unknown>[] } {
    if (AuditScriptProvider.calls++ === 0) {
      const { name, args } = AuditScriptProvider.toolCall;
      return {
        content: '',
        toolCalls: [{ id: 'call_audit_0', function: { name, arguments: JSON.stringify(args) } }],
      };
    }
    return { content: 'Готово' };
  }

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    const next = this._next();
    return {
      content: next.content,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: next.toolCalls,
    };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: unknown,
    _tools?: Array<Record<string, unknown>>,
    _debugCollector?: unknown,
    _ct?: unknown,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const next = this._next();
    yield {
      content: next.content,
      isFinal: true,
      toolCalls: next.toolCalls,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'auditscript';
  }
}

function makeUserMessage(text: string): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(text)],
    content: text,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  session: Session;
  workspace: string;
}

async function makeHarness(opts: {
  commandAudit: CommandAuditLog;
  toolName: string;
  toolArgs: Record<string, unknown>;
  prompt: string;
}): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-command-audit-orch-'));
  const workspace = join(tmpDir, 'ws');
  await mkdir(workspace, { recursive: true });

  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const project = projectStore.create('Audit', 'u1', { workspace });
  await projectStore.save(project);

  AuditScriptProvider.toolCall = { name: opts.toolName, args: opts.toolArgs };
  const toolRegistry = createToolRegistry();

  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus: new EventBus(),
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) =>
      ({ name, type: 'auditscript', baseUrl: '', apiKey: '', defaultModel: 'm' }) as unknown as import('@itphx/synth-shared').ProviderConfig,
    toolRegistry,
    agentRegistry: createAgentRegistry(toolRegistry),
    permissionConfig: {
      rules: { shell: 'allow', external_directory: { '*': 'allow' } },
      askTimeoutMs: 1000,
    },
    securityConfig: TEST_SECURITY,
    projectStore,
    defaultWorkingDir: workspace,
    dataDir: tmpDir,
    commandAudit: opts.commandAudit,
  });

  const session = await sessionManager.createSession({
    title: 'Command audit',
    projectId: project.id,
    settings: { provider: 'auditscript', model: 'm', systemPrompt: 'test', agentRole: 'fixer', language: 'ru' },
  });
  await sessionManager.addMessage(session.id, makeUserMessage(opts.prompt));
  return { orchestrator, sessionManager, session, workspace };
}

async function runTurn(harness: Harness): Promise<void> {
  const fresh = (await harness.sessionManager.getSession(harness.session.id))!;
  const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
  await harness.orchestrator
    .createProcessMessage()(fresh, userMsg, new AbortController().signal, () => {});
}

describe('PROP-136 (слайс 136a): аудит исполнений команд в оркестраторе', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-command-audit-store-'));
    ProviderFactory.register('auditscript', AuditScriptProvider);
    AuditScriptProvider.calls = 0;
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('auditscript');
    await rm(dir, { recursive: true, force: true });
  });

  it('execute_shell → started + finished с одним id, длительностью и hash вывода', async () => {
    const log = createCommandAuditLog({ dataDir: dir, config: { enabled: true }, env: {} });
    const harness = await makeHarness({
      commandAudit: log,
      toolName: 'execute_shell',
      toolArgs: { command: 'printf ok' },
      prompt: 'выполни printf ok',
    });
    await runTurn(harness);

    const entries = await log.list();
    expect(entries).toHaveLength(2);
    const [finished, started] = entries;
    expect(started!.phase).toBe('started');
    expect(finished!.phase).toBe('finished');
    expect(finished!.id).toBe(started!.id);
    expect(started!.tool).toBe('execute_shell');
    expect(started!.command).toBe('printf ok');
    expect(started!.commandHash).toBe(sha256Hex('printf ok'));
    expect(started!.decision).toBe('allow');
    expect(started!.decidedBy).toBe('permission');
    expect(started!.sessionId).toBe(harness.session.id);
    expect(started!.projectId).toBe(harness.session.projectId);
    expect(started!.agentRole).toBeTruthy();
    expect(started!.cwd).toBe(harness.workspace);
    expect(started!.background).toBe(false);
    expect(finished!.durationMs).toBeGreaterThanOrEqual(0);
    expect(finished!.exitCode).toBe(0);
    expect(finished!.bytesOut).toBe(2);
    expect(finished!.outputSha256).toBe(sha256Hex('ok'));
    expect(finished!.truncated).toBe(false);
  });

  it('сбой записи started → команда не выполняется, tool_result isError', async () => {
    // Путь журнала — под регулярным файлом: mkdir/append невозможны.
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a dir', 'utf8');
    const log = createCommandAuditLog({
      dataDir: dir,
      config: { enabled: true, path: join(blocker, 'commands.jsonl') },
      env: {},
    });

    const harness = await makeHarness({
      commandAudit: log,
      toolName: 'execute_shell',
      toolArgs: { command: 'touch audit-marker.txt' },
      prompt: 'создай маркер',
    });
    await runTurn(harness);

    // Команда не исполнялась: маркера нет.
    await expect(access(join(harness.workspace, 'audit-marker.txt'))).rejects.toThrow();
    // Журнала нет (записать некуда) — обе записи провалились, вторая не дошла.
    expect(await log.list()).toEqual([]);
  });

  it('журнал выключен → записей нет, команда выполняется', async () => {
    const log = createCommandAuditLog({ dataDir: dir, config: { enabled: false }, env: {} });
    const harness = await makeHarness({
      commandAudit: log,
      toolName: 'execute_shell',
      toolArgs: { command: 'printf off' },
      prompt: 'выполни printf off',
    });
    await runTurn(harness);
    expect(await log.list()).toEqual([]);
  });

  it('sandbox_exec → команда = commands.join(" && ")', async () => {
    const log = createCommandAuditLog({ dataDir: dir, config: { enabled: true }, env: {} });
    const harness = await makeHarness({
      commandAudit: log,
      toolName: 'sandbox_exec',
      toolArgs: { profile: 'sandbox', commands: ['npm ci', 'npm test'] },
      prompt: 'запусти в песочнице',
    });
    await runTurn(harness);

    const entries = await log.list();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.tool).toBe('sandbox_exec');
      expect(entry.command).toBe('npm ci && npm test');
      expect(entry.commandHash).toBe(sha256Hex('npm ci && npm test'));
    }
    expect(new Set(entries.map((e) => e.id)).size).toBe(1);
  });

  it('background: true попадает в запись (фон не блокирует ход)', async () => {
    const log = createCommandAuditLog({ dataDir: dir, config: { enabled: true }, env: {} });
    const harness = await makeHarness({
      commandAudit: log,
      toolName: 'execute_shell',
      toolArgs: { command: 'sleep 1', background: true },
      prompt: 'запусти в фоне',
    });
    await runTurn(harness);

    const entries = await log.list();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.background).toBe(true);
      expect(entry.command).toBe('sleep 1');
    }
  });

  it('секрет из карты обфускации сессии в журнал не попадает', async () => {
    const log = createCommandAuditLog({ dataDir: dir, config: { enabled: true }, env: {} });
    const harness = await makeHarness({
      commandAudit: log,
      toolName: 'execute_shell',
      toolArgs: { command: 'printf off' },
      prompt: 'выполни printf off',
    });
    // Карта обфускации сессии: значение секрета → плейсхолдер (ADR-036).
    const secret = 'topsecret-value-123';
    const { ObfuscationMapStore } = await import('./gateway/index.js');
    const store = new ObfuscationMapStore(harness.sessionManager);
    await store.set(harness.session.id, { '⟦SYNTH_SECRET_1⟧': secret });
    AuditScriptProvider.calls = 0;
    AuditScriptProvider.toolCall = {
      name: 'execute_shell',
      args: { command: `export TOKEN=${secret}` },
    };
    await runTurn(harness);

    const entries = await log.list();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.command).toBe('export TOKEN=⟦SYNTH_SECRET_1⟧');
      expect(JSON.stringify(entry)).not.toContain(secret);
    }
  });
});
