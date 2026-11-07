/**
 * PROP-127 (этап T5): параллельные подтверждения прав в шаге основной сессии.
 *
 * Проверяем, что решения владельца из PROP-127 работают на уровне цикла шага:
 * - **одновременность**: два вызова, требующие подтверждения, публикуют оба
 *   `permission.asked` ДО того, как на любой из них ответили (пользователь
 *   видит очередь подтверждений, а не один вопрос за другим);
 * - **каскад отказа**: отказ по одному подтверждению гасит остальные ожидания
 *   шага — ход не ждёт ответов на вопросы, на которые пользователь отказал.
 *
 * Стиль — как в `orchestrator-parallel-tools.test.ts` (тот же harness, тот же
 * сценарный провайдер).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { EventBus } from '../events/bus.js';
import { createToolRegistry } from './tools/index.js';
import { ContextConfig } from './context/config.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import type { PermissionConfig, ToolDefinition, Message, AuthorityPolicy } from '@itphx/synth-shared';
import type { AuthorityGateHook } from './authority/hook.js';
import { AuthorityGuard } from './authority/guard.js';
import { MemoryAuthorityDecisionJournal } from '../storage/memory/authority-decision-journal.js';
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

class ParallelScriptProvider extends BaseProvider {
  static script: ScriptStep[] = [];
  static calls = 0;

  private _next(): ScriptStep {
    const step = ParallelScriptProvider.script[Math.min(ParallelScriptProvider.calls, ParallelScriptProvider.script.length - 1)]!;
    ParallelScriptProvider.calls++;
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
    return 'parallel-script';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  eventBus: EventBus;
  sessionId: string;
  tmpDir: string;
}

async function makeHarness(
  permissionConfig: PermissionConfig,
  extraTools: ToolDefinition[] = [],
  opts: { authorityGate?: AuthorityGateHook } = {},
): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-parallel-ask-'));
  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store);
  const eventBus = new EventBus();
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const project = projectStore.create('Parallel', 'u1', { workspace: tmpDir });
  await projectStore.save(project);
  const toolRegistry = createToolRegistry();
  for (const tool of extraTools) toolRegistry.register(tool);
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    projectStore,
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) => {
      return { name, type: 'parallel-script', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
    },
    toolRegistry,
    permissionConfig,
    defaultWorkingDir: tmpDir,
    contextConfig: new ContextConfig({ userDataDir: join(tmpdir(), 'context') }),
    ...(opts.authorityGate ? { authorityGate: opts.authorityGate } : {}),
  });
  const session = await sessionManager.createSession({
    title: 'Parallel',
    projectId: project.id,
    // Владелец сессии — как в проде: без него принципал хода пустой, а
    // Authority-слой трактует «принципал не участник» как `viewer`
    // (fail-closed, ADR-106 Ф4) и потолок становится read-only.
    userId: 'u1',
    settings: { provider: 'parallel-script', model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
  });
  await sessionManager.addMessage(session.id, makeMessage());
  return { orchestrator, sessionManager, eventBus, sessionId: session.id, tmpDir };
}

async function run(
  h: Harness,
  signal: AbortSignal,
  publishChunk: (event: string, data: Record<string, unknown>) => void,
): Promise<import('./orchestrator.js').ProcessMessageResult> {
  const processMessage = h.orchestrator.createProcessMessage();
  const fresh = (await h.sessionManager.getSession(h.sessionId))!;
  const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
  return processMessage(fresh, userMsg, signal, publishChunk);
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

describe('PROP-127 T5: параллельные подтверждения прав (шаг сессии)', () => {
  beforeEach(() => {
    ProviderFactory.register('parallel-script', ParallelScriptProvider);
    ParallelScriptProvider.calls = 0;
    ParallelScriptProvider.script = [];
  });

  afterEach(() => {
    ProviderFactory['_providers'].delete('parallel-script');
  });

  it('два ask висят одновременно: оба permission.asked опубликованы до любого ответа', async () => {
    ParallelScriptProvider.script = [
      {
        content: 'Шаг 1: два вызова с подтверждением',
        toolCalls: [
          { id: 'call_a', name: 'gated_a' },
          { id: 'call_b', name: 'gated_b' },
        ],
      },
      { content: 'Готово' },
    ];
    const h = await makeHarness(
      { rules: { gated_a: 'ask', gated_b: 'ask' }, askTimeoutMs: 5000 } as unknown as PermissionConfig,
      [gatedTool('gated_a'), gatedTool('gated_b')],
    );

    // «UI»: фиксируем запросы. Ответ — отдельным действием теста, иначе
    // первый ответ пришёл бы до публикации второго запроса.
    const asked: string[] = [];
    h.eventBus.subscribe(h.sessionId, (event) => {
      if (event.type === 'permission.asked') asked.push(event.data.approval_id as string);
    });

    const ac = new AbortController();
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];

    // Ответ на ПЕРВЫЙ запрос — до него оба уже должны быть опубликованы.
    const replyWhenBothAsked = (): void => {
      if (asked.length < 2) return;
      h.eventBus.publish(h.sessionId, 'permission.replied', {
        approval_id: asked[0],
        session_id: h.sessionId,
        approved: true,
        action: 'allow',
        once: true,
      });
    };
    const poll = setInterval(replyWhenBothAsked, 5);

    try {
      await run(h, ac.signal, (event, data) => {
        chunks.push({ event, data });
        replyWhenBothAsked();
      });
    } finally {
      clearInterval(poll);
    }

    // Оба подтверждения висели одновременно.
    expect(asked).toEqual(['approval_call_a', 'approval_call_b']);

    // Оба вызова отработали (второй — по каскаду/очереди ответов) и оба
    // результата в истории: пары assistant(tool_calls) → tool не разорваны.
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const toolMessages = session.messages
      .filter((m) => m.role === MessageRole.TOOL)
      .map((m) => m.toolCallId);
    expect(toolMessages).toEqual(['call_a', 'call_b']);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('отказ по одному подтверждению гасит остальные ожидания шага (каскад)', async () => {
    ParallelScriptProvider.script = [
      {
        content: 'Шаг 1: два вызова с подтверждением',
        toolCalls: [
          { id: 'call_a', name: 'gated_a' },
          { id: 'call_b', name: 'gated_b' },
        ],
      },
      { content: 'не должно выполняться' },
    ];
    const h = await makeHarness(
      { rules: { gated_a: 'ask', gated_b: 'ask' }, askTimeoutMs: 5000 } as unknown as PermissionConfig,
      [gatedTool('gated_a'), gatedTool('gated_b')],
    );

    const asked: string[] = [];
    h.eventBus.subscribe(h.sessionId, (event) => {
      if (event.type === 'permission.asked') asked.push(event.data.approval_id as string);
    });

    const ac = new AbortController();
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];

    const denyWhenBothAsked = (): void => {
      if (asked.length < 2) return;
      h.eventBus.publish(h.sessionId, 'permission.replied', {
        approval_id: asked[0],
        session_id: h.sessionId,
        approved: false,
        action: 'deny',
        once: true,
      });
    };
    const poll = setInterval(denyWhenBothAsked, 5);

    try {
      await run(h, ac.signal, (event, data) => {
        chunks.push({ event, data });
        denyWhenBothAsked();
      });
    } finally {
      clearInterval(poll);
    }

    // Каскад: отказ по первому погасил второй — ход не ждал ответа на него
    // до таймаута (иначе тест занял бы askTimeoutMs).
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const toolMessages = session.messages
      .filter((m) => m.role === MessageRole.TOOL)
      .map((m) => ({ id: m.toolCallId, error: m.content }));
    // Оба вызова получили парный результат (пары не разорваны) — второй
    // отказан по каскаду, а не ждал ответа.
    expect(toolMessages.map((m) => m.id)).toEqual(['call_a', 'call_b']);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('грант соседа НЕ одобряет вызов, который Authority-слой требует подтвердить (ADR-106 Ф4)', async () => {
    // Регресс: переоценка ожидающих подтверждений (PROP-127 T5) обязана идти
    // с ТЕМ ЖЕ контекстом Authority, что и исходная проверка. Без него терялась
    // ось агента (роли агента из политики) — и вызов, который слой требует
    // подтвердить, одобрялся грантом соседа БЕЗ нового вопроса пользователю.
    ParallelScriptProvider.script = [
      {
        content: 'Шаг 1: два вызова с подтверждением',
        toolCalls: [
          { id: 'call_a', name: 'gated_write' },
          { id: 'call_b', name: 'gated_write' },
        ],
      },
      { content: 'не должно выполняться' },
    ];

    // Политика: роль агента требует подтверждения на запись.
    const policy: AuthorityPolicy = {
      actions: [],
      roles: [
        {
          id: 'writer',
          domain: 'core',
          grants: [{ action: 'write', targetPattern: 'session:**', effect: 'ask' }],
        },
      ],
      targets: [],
      ceilings: [],
      agents: [{ id: 'fixer', roles: ['writer'], ceiling: [] }],
    };
    const journal = new MemoryAuthorityDecisionJournal();
    const guard = new AuthorityGuard({ enabled: true, shadow: false, journal, policy });

    const h = await makeHarness(
      { rules: { gated_write: 'ask' }, askTimeoutMs: 5000 } as unknown as PermissionConfig,
      [gatedTool('gated_write')],
      { authorityGate: guard.gate },
    );

    const asked: string[] = [];
    const autoApproved: string[] = [];
    // Сигнал «грант применён»: `session.updated` публикуется внутри выдачи
    // гранта, до переоценки ожидающих подтверждений. Один тик после него —
    // и переоценка уже выполнена (следующий шаг — микротаска).
    let grantApplied!: () => void;
    const grantAppliedPromise = new Promise<void>((resolve) => { grantApplied = resolve; });
    let firstAnswered = false;
    h.eventBus.subscribe(h.sessionId, (event) => {
      if (event.type === 'permission.asked') asked.push(event.data.approval_id as string);
      if (event.type === 'permission.replied' && event.data.auto_approved === true) {
        autoApproved.push(event.data.approval_id as string);
      }
      if (event.type === 'session.updated' && firstAnswered) grantApplied();
    });

    const ac = new AbortController();
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];

    // Отвечаем ТОЛЬКО на первый запрос («Разрешить в сессии»). Второй должен
    // остаться pending: если грант соседа одобряет его автоматически, второй
    // вызов исполнится без нового вопроса пользователю — это и ловим.
    const answerFirst = (): void => {
      if (firstAnswered || asked.length < 2) return;
      firstAnswered = true;
      h.eventBus.publish(h.sessionId, 'permission.replied', {
        approval_id: asked[0],
        session_id: h.sessionId,
        approved: true,
        action: 'allow',
        once: false,
      });
    };
    const poll = setInterval(answerFirst, 5);

    const runPromise = run(h, ac.signal, (event, data) => {
      chunks.push({ event, data });
      answerFirst();
    });

    try {
      // Ждём применения гранта и завершения переоценки.
      await grantAppliedPromise;
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Соседний запрос НЕ одобрен автоматически: ось агента требует
      // подтверждения — грант соседа его не снимает.
      expect(autoApproved).toEqual([]);

      // Второй запрос всё ещё ждёт ответа пользователя.
      const sessionMid = (await h.sessionManager.getSession(h.sessionId))!;
      expect(sessionMid.messages.filter((m) => m.role === MessageRole.TOOL)).toHaveLength(0);

      // Отвечаем и на второй запрос — ход завершается.
      h.eventBus.publish(h.sessionId, 'permission.replied', {
        approval_id: asked[1],
        session_id: h.sessionId,
        approved: true,
        action: 'allow',
        once: true,
      });
      await runPromise;
    } finally {
      clearInterval(poll);
    }

    // Оба запроса висели одновременно.
    expect(asked).toEqual(['approval_call_a', 'approval_call_b']);

    // Ни один вызов не одобрен автоматически: ось агента требует
    // подтверждения — грант соседа его не снимает.
    expect(autoApproved).toEqual([]);

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const toolMessages = session.messages
      .filter((m) => m.role === MessageRole.TOOL)
      .map((m) => m.toolCallId);
    expect(toolMessages).toEqual(['call_a', 'call_b']);

    await rm(h.tmpDir, { recursive: true, force: true });
  });
});
