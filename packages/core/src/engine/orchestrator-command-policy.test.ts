/**
 * PROP-136b (слайс 136b-2a): зеркальный чекер команд в точке исполнения.
 *
 * Проверяется единственная точка исполнения tool-call:
 * - `deny` → команда **не** выполнена, ровно одна запись аудита
 *   (`finished`, `decision:'deny'`, `decidedBy:'policy'`, `provider`,
 *   `durationMs:0`, `reason`);
 * - `allow` → команда выполнена, две записи с `decidedBy:'policy'` и
 *   `provider.action:'allow'`;
 * - провайдера нет → прежнее поведение (`decidedBy:'permission'`);
 * - `failMode: 'open'` при таймауте → выполнена, причина в записи;
 * - не-shell тулы чекером не проверяются.
 *
 * Harness — как в `orchestrator-command-audit.test.ts`: фейковый провайдер
 * (шаг 0 — вызов тула, шаг 1 — финальный текст) и настоящий реестр тулов.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
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
import { createCommandAuditLog } from './security/command-audit.js';
import type { CommandAuditLog } from './security/command-audit.js';
import {
  COMMAND_POLICY_UNAVAILABLE_OPEN_REASON,
  createCommandPolicyProvider,
  type CommandPolicyProvider,
  type CommandPolicyVerdict,
} from './security/command-policy.js';
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

/** Секция `security` для тестов: чекер/журнал — параметры теста, не конфига. */
const TEST_SECURITY: SecurityConfig = {
  promptInjection: { enabled: true, wrapContent: true, mode: 'flag' },
  protectedPaths: { enabled: true },
  secretKey: '',
  commandAudit: { enabled: false, retentionDays: 30, path: '' },
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
class PolicyScriptProvider extends BaseProvider {
  static calls = 0;
  static toolCall: { name: string; args: Record<string, unknown> } = { name: '', args: {} };

  private _next(): { content: string; toolCalls?: Record<string, unknown>[] } {
    if (PolicyScriptProvider.calls++ === 0) {
      const { name, args } = PolicyScriptProvider.toolCall;
      return {
        content: '',
        toolCalls: [{ id: 'call_policy_0', function: { name, arguments: JSON.stringify(args) } }],
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
    return 'policyscript';
  }
}

/**
 * Фейковый чекер: отдаёт заданный вердикт и запоминает входы (проверка, что
 * спрашивали ровно один раз и с ожидаемыми полями).
 */
function fakeProvider(
  verdict: Partial<CommandPolicyVerdict> | (() => Promise<CommandPolicyVerdict>),
): CommandPolicyProvider & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    kind: 'http',
    calls,
    async check(input) {
      calls.push(input as unknown as Record<string, unknown>);
      if (typeof verdict === 'function') return verdict();
      return { action: 'allow', kind: 'http', latencyMs: 1, ...verdict };
    },
  };
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
  commandPolicy?: CommandPolicyProvider;
  toolName: string;
  toolArgs: Record<string, unknown>;
  prompt: string;
}): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-command-policy-orch-'));
  const workspace = join(tmpDir, 'ws');
  await mkdir(workspace, { recursive: true });

  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const project = projectStore.create('Policy', 'u1', { workspace });
  await projectStore.save(project);

  PolicyScriptProvider.toolCall = { name: opts.toolName, args: opts.toolArgs };
  const toolRegistry = createToolRegistry();

  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus: new EventBus(),
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) =>
      ({ name, type: 'policyscript', baseUrl: '', apiKey: '', defaultModel: 'm' }) as unknown as import('@itphx/synth-shared').ProviderConfig,
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
    ...(opts.commandPolicy ? { commandPolicy: opts.commandPolicy } : {}),
  });

  const session = await sessionManager.createSession({
    title: 'Command policy',
    projectId: project.id,
    settings: {
      provider: 'policyscript',
      model: 'm',
      systemPrompt: 'test',
      agentRole: 'fixer',
      language: 'ru',
    },
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

describe('PROP-136b (слайс 136b-2a): зеркальный чекер команд в оркестраторе', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-command-policy-store-'));
    ProviderFactory.register('policyscript', PolicyScriptProvider);
    PolicyScriptProvider.calls = 0;
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('policyscript');
    await rm(dir, { recursive: true, force: true });
  });

  it('deny → команда не выполнена, одна запись аудита с решением чекера', async () => {
    const log = createCommandAuditLog({ dataDir: dir, config: { enabled: true }, env: {} });
    const provider = fakeProvider({
      action: 'deny',
      reason: 'blocked by rule',
      ruleId: 'no-touch',
      latencyMs: 12,
    });
    const harness = await makeHarness({
      commandAudit: log,
      commandPolicy: provider,
      toolName: 'execute_shell',
      toolArgs: { command: 'touch policy-marker.txt' },
      prompt: 'создай маркер',
    });
    await runTurn(harness);

    // Команда не исполнялась: маркера нет.
    await expect(access(join(harness.workspace, 'policy-marker.txt'))).rejects.toThrow();
    // Чекер спросили один раз, с командой и каталогом.
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      command: 'touch policy-marker.txt',
      cwd: harness.workspace,
    });

    const entries = await log.list();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry!.phase).toBe('finished');
    expect(entry!.decision).toBe('deny');
    expect(entry!.decidedBy).toBe('policy');
    expect(entry!.matchedRule).toBe('no-touch');
    expect(entry!.durationMs).toBe(0);
    expect(entry!.reason).toBe('blocked by rule');
    expect(entry!.provider).toEqual({
      kind: 'http',
      ruleId: 'no-touch',
      latencyMs: 12,
      action: 'deny',
    });
    expect(entry!.exitCode).toBeUndefined();
  });

  it('allow → команда выполнена, две записи с decidedBy: policy и provider.action: allow', async () => {
    const log = createCommandAuditLog({ dataDir: dir, config: { enabled: true }, env: {} });
    const provider = fakeProvider({ action: 'allow', ruleId: 'ok-rule', latencyMs: 7 });
    const harness = await makeHarness({
      commandAudit: log,
      commandPolicy: provider,
      toolName: 'execute_shell',
      toolArgs: { command: 'touch policy-allowed.txt' },
      prompt: 'создай маркер',
    });
    await runTurn(harness);

    await expect(access(join(harness.workspace, 'policy-allowed.txt'))).resolves.toBeUndefined();
    expect(provider.calls).toHaveLength(1);

    const entries = await log.list();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.decidedBy).toBe('policy');
      expect(entry.decision).toBe('allow');
      expect(entry.provider).toEqual({
        kind: 'http',
        ruleId: 'ok-rule',
        latencyMs: 7,
        action: 'allow',
      });
    }
    expect(new Set(entries.map((e) => e.id)).size).toBe(1);
  });

  it('провайдера нет → прежнее поведение (decidedBy: permission)', async () => {
    const log = createCommandAuditLog({ dataDir: dir, config: { enabled: true }, env: {} });
    const harness = await makeHarness({
      commandAudit: log,
      toolName: 'execute_shell',
      toolArgs: { command: 'touch no-policy.txt' },
      prompt: 'создай маркер',
    });
    await runTurn(harness);

    await expect(access(join(harness.workspace, 'no-policy.txt'))).resolves.toBeUndefined();
    const entries = await log.list();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.decidedBy).toBe('permission');
      expect(entry.provider).toBeUndefined();
    }
  });

  it('failMode open при недоступности чекера → выполнена, причина в записи', async () => {
    const log = createCommandAuditLog({ dataDir: dir, config: { enabled: true }, env: {} });
    // Настоящий провайдер с падающим транспортом: `open` → allow + причина.
    const provider = createCommandPolicyProvider(
      {
        enabled: true,
        provider: 'http',
        url: 'http://policy.local',
        tokenSecret: '',
        failMode: 'open',
        timeoutMs: 20,
        opaPath: '/v1/data/synth/exec/decision',
      },
      {
        fetchImpl: (async () => {
          throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch,
        warn: () => {},
      },
    )!;
    const harness = await makeHarness({
      commandAudit: log,
      commandPolicy: provider,
      toolName: 'execute_shell',
      toolArgs: { command: 'touch fail-open.txt' },
      prompt: 'создай маркер',
    });
    await runTurn(harness);

    await expect(access(join(harness.workspace, 'fail-open.txt'))).resolves.toBeUndefined();
    const entries = await log.list();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.decidedBy).toBe('policy');
      expect(entry.provider?.action).toBe('allow');
      expect(entry.reason).toBe(COMMAND_POLICY_UNAVAILABLE_OPEN_REASON);
    }
  });

  it('не-shell тул чекером не проверяется', async () => {
    const log = createCommandAuditLog({ dataDir: dir, config: { enabled: true }, env: {} });
    const provider = fakeProvider({ action: 'deny', reason: 'never' });
    const harness = await makeHarness({
      commandAudit: log,
      commandPolicy: provider,
      toolName: 'list_directory',
      toolArgs: { path: '.' },
      prompt: 'покажи файлы',
    });
    await runTurn(harness);

    expect(provider.calls).toHaveLength(0);
    // Команда не из журналируемых — записей нет.
    expect(await log.list()).toEqual([]);
  });

  it('sandbox_exec: чекер получает join(" && ") и таймаут (секунды → мс)', async () => {
    const log = createCommandAuditLog({ dataDir: dir, config: { enabled: false }, env: {} });
    const provider = fakeProvider({ action: 'deny', reason: 'no' });
    const harness = await makeHarness({
      commandAudit: log,
      commandPolicy: provider,
      toolName: 'sandbox_exec',
      toolArgs: { profile: 'sandbox', commands: ['npm ci', 'npm test'], timeout: 60 },
      prompt: 'запусти в песочнице',
    });
    await runTurn(harness);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      command: 'npm ci && npm test',
      cwd: harness.workspace,
      timeoutMs: 60_000,
    });
  });
});
