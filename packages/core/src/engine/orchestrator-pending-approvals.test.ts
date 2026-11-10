/**
 * ADR-029: ожидание подтверждения прав **переживает рестарт инстанса**.
 *
 * Живой реестр ожиданий (`PermissionApprovalManager._pending`) живёт в памяти
 * процесса: после рестарта он пуст, карточка подтверждения пропадает, а счётчик
 * DTO снова `0`. Персистентная копия ожидания лежит в **отдельном хранилище
 * ожиданий** (`PendingApprovalRepository`, ADR-096) — не в документе сессии:
 * запись в документ сессии — полная замена истории, а результаты параллельных
 * тулов пишутся точечно (`appendMessage`, ADR-118 §4) → гонка lost update.
 *
 * Проверяем:
 * - запись ожидания попадает в хранилище ожиданий;
 * - ответ и таймаут снимают запись;
 * - после «рестарта» (новый оркестратор поверх того же хранилища) ожидание
 *   видно как **восстановленное** (`resolvePendingApproval → restored`), а
 *   ответ на него применяется как грант в сессии.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ContextConfig } from './context/config.js';
import { createToolRegistry } from './tools/index.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import type { PermissionConfig, ToolDefinition, Message } from '@itphx/synth-shared';
import { MemoryPendingApprovalRepository } from '../storage/memory/pending-approvals.js';
import type { PendingApprovalRepository } from '../storage/ports/pending-approval-repository.js';
import { generateId, MessageRole, nowISO, makeTextPart, ToolCapability } from '@itphx/synth-shared';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeMessage(): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart('выполни задачу')],
    content: 'выполни задачу',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

interface ScriptStep {
  content: string;
  toolCalls?: Array<{ id: string; name: string; args?: Record<string, unknown> }>;
}

class PendingScriptProvider extends BaseProvider {
  static script: ScriptStep[] = [];
  static calls = 0;

  private _next(): ScriptStep {
    const step = PendingScriptProvider.script[Math.min(PendingScriptProvider.calls, PendingScriptProvider.script.length - 1)]!;
    PendingScriptProvider.calls++;
    return step;
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    const step = this._next();
    return {
      content: step.content,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: step.toolCalls?.map((tc) => ({
        id: tc.id,
        function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
      })),
    };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const step = this._next();
    yield {
      content: step.content,
      isFinal: true,
      toolCalls: step.toolCalls?.map((tc) => ({
        id: tc.id,
        function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
      })),
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'pending-script';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  eventBus: EventBus;
  sessionId: string;
  repository: PendingApprovalRepository;
  tmpDir: string;
}

/**
 * Оркестратор над хранилищем сессий (`tmpDir`) — тот же конструктор, что в
 * проде; отличается только набором зависимостей (провайдер-заглушка).
 *
 * `repository` — хранилище ожиданий (ADR-029): отдельный стор, общий для
 * «процессов» до и после рестарта.
 */
async function makeHarness(
  permissionConfig: PermissionConfig,
  extraTools: ToolDefinition[],
  opts: { dataDir?: string; sessionId?: string; repository?: PendingApprovalRepository } = {},
): Promise<Harness> {
  const tmpDir = opts.dataDir ?? (await mkdtemp(join(tmpdir(), 'synth-pending-ask-')));
  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store);
  const eventBus = new EventBus();
  const toolRegistry = createToolRegistry();
  for (const tool of extraTools) toolRegistry.register(tool);
  const repository = opts.repository ?? new MemoryPendingApprovalRepository();
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) => {
      return { name, type: 'pending-script', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
    },
    toolRegistry,
    permissionConfig,
    defaultWorkingDir: tmpDir,
    contextConfig: new ContextConfig({ userDataDir: join(tmpdir(), 'context') }),
    pendingApprovalRepository: repository,
  });
  // `sessionId` задан — «процесс №2» работает с той же сессией (рестарт
  // инстанса не меняет id сессии).
  const session = opts.sessionId
    ? (await sessionManager.getSession(opts.sessionId))!
    : await sessionManager.createSession({
      title: 'Pending',
      userId: 'u1',
      settings: { provider: 'pending-script', model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
    });
  if (!opts.sessionId) {
    await sessionManager.addMessage(session.id, makeMessage());
  }
  return { orchestrator, sessionManager, eventBus, sessionId: session.id, repository, tmpDir };
}

async function run(
  h: Harness,
  signal: AbortSignal,
): Promise<import('./orchestrator.js').ProcessMessageResult> {
  const processMessage = h.orchestrator.createProcessMessage();
  const fresh = (await h.sessionManager.getSession(h.sessionId))!;
  const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
  return processMessage(fresh, userMsg, signal, () => {});
}

/** Тул, всегда требующий подтверждения (правило `ask`). */
function gatedTool(name: string): ToolDefinition {
  return {
    name,
    description: `тул с подтверждением ${name}`,
    parameters: z.object({}).passthrough(),
    capabilities: [ToolCapability.RUNTIME],
    async execute() {
      return { content: `${name}: ok` };
    },
  } as unknown as ToolDefinition;
}

/** Текущие ожидания в хранилище ожиданий. */
async function pendingRecords(h: Harness): Promise<Array<{ approvalId: string }>> {
  return h.repository.list(h.sessionId);
}

describe('ADR-029: ожидание подтверждения живёт в отдельном хранилище', () => {
  beforeEach(() => {
    ProviderFactory.register('pending-script', PendingScriptProvider);
    PendingScriptProvider.calls = 0;
    PendingScriptProvider.script = [];
  });

  afterEach(() => {
    ProviderFactory['_providers'].delete('pending-script');
  });

  it('запись ожидания попадает в хранилище и снимается ответом', async () => {
    PendingScriptProvider.script = [
      { content: 'Шаг 1: вызов с подтверждением', toolCalls: [{ id: 'call_a', name: 'gated' }] },
      { content: 'Готово' },
    ];
    const h = await makeHarness(
      { rules: { gated: 'ask' }, askTimeoutMs: 5000 } as unknown as PermissionConfig,
      [gatedTool('gated')],
    );

    // Подписчик канала сессии — «пользователь на связи»: без него ask
    // отклоняется сразу («no connected user to approve»).
    h.eventBus.subscribe(h.sessionId, () => {});

    const ac = new AbortController();
    const runPromise = run(h, ac.signal);

    // Пока ожидание висит — запись есть в хранилище ожиданий.
    await vi.waitFor(async () => {
      expect((await pendingRecords(h)).length).toBe(1);
    });
    const [record] = await h.repository.list(h.sessionId);
    expect(record!.approvalId).toBe('approval_call_a');
    expect(record!.toolName).toBe('gated');
    expect(record!.askedAt).toBeTruthy();
    expect(record!.timeoutMs).toBe(5000);

    // Ответ — ожидание снимается и из хранилища.
    h.eventBus.publish(h.sessionId, 'permission.replied', {
      approval_id: 'approval_call_a',
      session_id: h.sessionId,
      approved: true,
      action: 'allow',
      once: true,
    });
    await runPromise;

    await vi.waitFor(async () => {
      expect((await pendingRecords(h)).length).toBe(0);
    });

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('таймаут снимает запись ожидания', async () => {
    PendingScriptProvider.script = [
      { content: 'Шаг 1: вызов с подтверждением', toolCalls: [{ id: 'call_a', name: 'gated' }] },
      { content: 'Готово' },
    ];
    const h = await makeHarness(
      { rules: { gated: 'ask' }, askTimeoutMs: 100 } as unknown as PermissionConfig,
      [gatedTool('gated')],
    );

    // Подписчик канала сессии — «пользователь на связи»: без него ask
    // отклоняется сразу («no connected user to approve»).
    h.eventBus.subscribe(h.sessionId, () => {});

    const ac = new AbortController();
    const runPromise = run(h, ac.signal);

    await vi.waitFor(async () => {
      expect((await pendingRecords(h)).length).toBe(1);
    });

    // Ждём авто-отклонения по таймауту: запись обязана исчезнуть, иначе после
    // рестарта «воскреснет» уже закрытый вопрос.
    await vi.waitFor(async () => {
      expect((await pendingRecords(h)).length).toBe(0);
    }, { timeout: 5000 });

    await runPromise;
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('документ сессии не содержит ожиданий (отдельный стор)', async () => {
    PendingScriptProvider.script = [
      { content: 'Шаг 1: вызов с подтверждением', toolCalls: [{ id: 'call_a', name: 'gated' }] },
      { content: 'Готово' },
    ];
    const h = await makeHarness(
      { rules: { gated: 'ask' }, askTimeoutMs: 0 } as unknown as PermissionConfig,
      [gatedTool('gated')],
    );

    h.eventBus.subscribe(h.sessionId, () => {});

    const ac = new AbortController();
    const runPromise = run(h, ac.signal);

    await vi.waitFor(async () => {
      expect((await pendingRecords(h)).length).toBe(1);
    });

    // Регресс (ADR-118 §4): запись ожидания не трогает документ сессии —
    // иначе полная запись документа затирала бы точечные записи результатов
    // параллельных тулов (гонка lost update).
    const raw = await readFile(
      join(h.tmpDir, 'sessions', `${h.sessionId}.json`),
      'utf-8',
    );
    expect(raw).not.toContain('pending_approvals');

    h.eventBus.publish(h.sessionId, 'permission.replied', {
      approval_id: 'approval_call_a',
      session_id: h.sessionId,
      approved: true,
      action: 'allow',
      once: true,
    });
    await runPromise;

    await rm(h.tmpDir, { recursive: true, force: true });
  });
});

/**
 * «После рестарта инстанса»: живой реестр пуст, ожидание осталось в
 * **хранилище ожиданий**. Новый оркестратор поверх того же хранилища
 * восстанавливает его как **restored** и применяет ответ как грант в сессии.
 */
describe('ADR-029: восстановленное ожидание после рестарта инстанса', () => {
  beforeEach(() => {
    ProviderFactory.register('pending-script', PendingScriptProvider);
    PendingScriptProvider.calls = 0;
    PendingScriptProvider.script = [];
  });

  afterEach(() => {
    ProviderFactory['_providers'].delete('pending-script');
  });

  it('ожидание из хранилища видно как restored, ответ — грант в сессии, запись снимается', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'synth-pending-restart-'));
    const repository = new MemoryPendingApprovalRepository();

    // Процесс №1: публикуем ожидание и «умираем» (ответ не приходит).
    PendingScriptProvider.script = [
      { content: 'Шаг 1: вызов с подтверждением', toolCalls: [{ id: 'call_a', name: 'gated' }] },
      { content: 'Готово' },
    ];
    const first = await makeHarness(
      { rules: { gated: 'ask' }, askTimeoutMs: 0 } as unknown as PermissionConfig,
      [gatedTool('gated')],
      { dataDir: tmpDir, repository },
    );

    first.eventBus.subscribe(first.sessionId, () => {});

    const ac = new AbortController();
    const firstRun = run(first, ac.signal);
    await vi.waitFor(async () => {
      expect((await pendingRecords(first)).length).toBe(1);
    });

    // «Рестарт инстанса»: процесс №1 не отвечает на вопрос и просто
    // исчезает (ход не прерываем — прерывание сняло бы ожидание, а это
    // другой сценарий). Процесс №2 — новый оркестратор поверх того же
    // хранилища: живой реестр у него пуст.
    const second = await makeHarness(
      { rules: { gated: 'ask' }, askTimeoutMs: 0 } as unknown as PermissionConfig,
      [gatedTool('gated')],
      { dataDir: tmpDir, sessionId: first.sessionId, repository },
    );

    const session = (await second.sessionManager.getSession(second.sessionId))!;
    // Живое ожидание отсутствует — реестр в памяти процесса.
    expect(second.orchestrator.listPendingApprovals(second.sessionId)).toHaveLength(0);

    // Восстановление при старте инстанса (`restorePendingApprovals`).
    expect(await second.orchestrator.restorePendingApprovals()).toBe(1);

    const pending = second.orchestrator.listPendingApprovals(second.sessionId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.restored).toBe(true);

    const resolution = second.orchestrator.resolvePendingApproval(session, 'approval_call_a');
    expect(resolution?.kind).toBe('restored');

    // Счётчик DTO учитывает восстановленное ожидание.
    expect(second.orchestrator.listPendingApprovalCounts().get(second.sessionId)).toBe(1);

    // Ответ «Разрешить» — грант в сессии (allow-правило) + снятие ожидания.
    await second.orchestrator.grantSessionToolAllow(session, 'gated', {});
    await second.orchestrator.clearPendingApproval(second.sessionId, 'approval_call_a');

    const after = (await second.sessionManager.getSession(second.sessionId))!;
    expect(after.settings.permission?.rules?.gated).toBe('allow');
    expect(await repository.list()).toEqual([]);
    expect(second.orchestrator.listPendingApprovals(second.sessionId)).toHaveLength(0);

    // Уборка: прерываем ход процесса №1 (ожидание уже снято — запись в
    // хранилище не меняется).
    ac.abort();
    await firstRun.catch(() => {});

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('ожидание, закрытое в этом процессе, не путается с восстановленным', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'synth-pending-settled-'));
    const h = await makeHarness(
      { rules: { gated: 'ask' }, askTimeoutMs: 0 } as unknown as PermissionConfig,
      [gatedTool('gated')],
      { dataDir: tmpDir },
    );

    // Публикуем и закрываем ожидание в этом процессе (id попадает в
    // `_published` менеджера) — но запись в хранилище уже снята.
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    expect(h.orchestrator.resolvePendingApproval(session, 'approval_unknown')).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });
});
