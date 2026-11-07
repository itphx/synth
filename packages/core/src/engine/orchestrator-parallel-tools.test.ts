/**
 * PROP-127 (этап T2): параллельное исполнение вызовов инструментов в шаге
 * основной сессии (`ChatOrchestrator`).
 *
 * Цикл шага разбит на три фазы (подготовка → исполнение → фиксация) и на
 * сегменты по барьерам смены состояния. Проверяем инварианты:
 * - **конкурентность**: вызовы одного assistant-сообщения стартуют одновременно
 *   (барьером, без тайминговых допущений);
 * - **порядок в истории = порядок вызовов модели** (`currentMessages`,
 *   `metadata.tool_results`, tool-сообщения сессии) — даже если вызовы
 *   завершились в обратном порядке;
 * - **изоляция ошибок**: исключение одного вызова не роняет остальные и шаг;
 * - **барьер смены режима**: `plan_enter` виден следующему вызову того же
 *   сообщения (как в последовательном цикле);
 * - **отмена**: ход завершается как отмена, результаты исполненных вызовов
 *   остаются в истории.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
import type { PermissionConfig, ToolDefinition, Message } from '@itphx/synth-shared';
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

/** Шаг сценария провайдера: вызовы инструментов одного assistant-сообщения. */
interface ScriptStep {
  content: string;
  toolCalls?: Array<{ id: string; name: string; args?: Record<string, unknown> }>;
}

/** Провайдер-сценарий: первый шаг — вызовы инструментов, дальше — текст. */
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

async function makeHarness(extraTools: ToolDefinition[] = []): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-parallel-'));
  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store);
  const eventBus = new EventBus();
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  // Проект с workspace: иначе file-тулы недоступны (гейт `workspace`).
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
    permissionConfig: { rules: {}, askTimeoutMs: 1000 } as PermissionConfig,
    defaultWorkingDir: tmpDir,
    contextConfig: new ContextConfig({ userDataDir: join(tmpdir(), 'context') }),
  });
  const session = await sessionManager.createSession({
    title: 'Parallel',
    projectId: project.id,
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

/**
 * Ожидание промиса с пределом: `true` — промис не разрешился вовремя
 * (значит, параллельности не было и второй вызов не стартовал).
 */
async function withTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), ms);
  });
  try {
    return await Promise.race([promise.then(() => false), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Результаты вызовов шага (`metadata.tool_results` сообщения шага). */
async function stepToolResults(
  h: Harness,
): Promise<Array<{ id: string; name: string; result?: { content?: string; isError?: boolean } }>> {
  const session = (await h.sessionManager.getSession(h.sessionId))!;
  const stepMessage = session.messages.find(
    (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) > 0,
  );
  return (stepMessage?.metadata?.tool_results ?? []) as Array<{
    id: string;
    name: string;
    result?: { content?: string; isError?: boolean };
  }>;
}

/** Tool-сообщения сессии в порядке истории. */
async function sessionToolMessages(h: Harness): Promise<Array<{ toolCallId?: string; content: string }>> {
  const session = (await h.sessionManager.getSession(h.sessionId))!;
  return session.messages
    .filter((m) => m.role === MessageRole.TOOL)
    .map((m) => ({ toolCallId: m.toolCallId, content: m.content }));
}

describe('PROP-127 T2: параллельное исполнение вызовов инструментов (шаг сессии)', () => {
  beforeEach(() => {
    ProviderFactory.register('parallel-script', ParallelScriptProvider);
    ParallelScriptProvider.calls = 0;
    ParallelScriptProvider.script = [];
  });

  afterEach(() => {
    ProviderFactory['_providers'].delete('parallel-script');
  });

  it('вызовы одного сообщения стартуют одновременно (оба — до завершения первого)', async () => {
    const started: string[] = [];
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });

    const barrierTool = (name: string): ToolDefinition => ({
      name,
      description: `барьерный тул ${name}`,
      parameters: z.object({}).passthrough(),
      capabilities: [ToolCapability.RUNTIME],
      async execute() {
        started.push(name);
        if (started.length >= 2) release();
        // При последовательном исполнении первый вызов никогда не дождётся
        // второго — таймаут и есть признак отсутствия параллельности.
        const timedOut = await withTimeout(bothStarted, 3000);
        return { content: timedOut ? `${name}: timeout` : `${name}: ok` };
      },
    } as unknown as ToolDefinition);

    ParallelScriptProvider.script = [
      {
        content: 'Шаг 1: два вызова',
        toolCalls: [{ id: 'call_a', name: 'gate_a' }, { id: 'call_b', name: 'gate_b' }],
      },
      { content: 'Готово' },
    ];
    const h = await makeHarness([barrierTool('gate_a'), barrierTool('gate_b')]);

    const result = await run(h, new AbortController().signal, () => {});
    expect(result.error).toBeUndefined();

    // Оба вызова стартовали (порядок старта — по порядку вызовов модели).
    expect(started.sort()).toEqual(['gate_a', 'gate_b']);
    const results = await stepToolResults(h);
    expect(results.map((r) => r.result?.content)).toEqual(['gate_a: ok', 'gate_b: ok']);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('точечная дозапись и полная перезапись сессии в одном батче не теряют сообщения', async () => {
    // PROP-127 (этап T6): тул может переписать сессию целиком (`withLock` +
    // `saveSession` — так пишут `todo_write`/`plan_enter`), а результаты
    // вызовов пишутся **точечной** дозаписью (`appendMessage`). Снимок сессии
    // у перезаписи — устаревший, поэтому порядок важен: перезапись сессии
    // внутри фазы исполнения затерела бы точечно дописанные сообщения.
    //
    // Трёхфазный цикл (подготовка → исполнение → фиксация) это исключает:
    // все перезаписи сессии happen в фазе исполнения, все дозаписи — в фазе
    // фиксации, а фазы не пересекаются. Тест — охрана этого порядка: если
    // персистентность результатов вернётся в фазу исполнения, перезапись
    // сессии затрёт чужое сообщение, и тест упадёт.
    let plainDone!: () => void;
    const plainFinished = new Promise<void>((resolve) => { plainDone = resolve; });

    const rewriteTool: ToolDefinition = {
      name: 'rewrite_session',
      description: 'переписывает сессию целиком',
      parameters: z.object({}).passthrough(),
      capabilities: [ToolCapability.RUNTIME],
      async execute(_args: Record<string, unknown>, ctx: { extra?: { sessionManager?: SessionManager; sessionId?: string } }) {
        const manager = ctx.extra?.sessionManager;
        const sessionId = ctx.extra?.sessionId;
        if (!manager || !sessionId) return { content: 'rewrite_session: нет доступа к сессии' };
        await manager.withLock(sessionId, async (s) => {
          // Ожидание ВНУТРИ лока: снимок сессии уже загружен, а сохранение
          // ещё не выполнено — окно устаревшего снимка. Именно в нём
          // полная перезапись теряет точечно дописанное сообщение.
          await plainFinished;
          s.todos = [{ id: 'todo_1', content: 'заметка', status: 'pending', priority: 'medium' }];
          await manager.saveSession(s);
        });
        return { content: 'rewrite_session: ok' };
      },
    } as unknown as ToolDefinition;

    const plainTool: ToolDefinition = {
      name: 'plain_tool',
      description: 'обычный тул без записи в сессию',
      parameters: z.object({}).passthrough(),
      capabilities: [ToolCapability.RUNTIME],
      async execute() {
        plainDone();
        return { content: 'plain_tool: ok' };
      },
    } as unknown as ToolDefinition;

    ParallelScriptProvider.script = [
      {
        content: 'Шаг 1: перезапись сессии и обычный вызов',
        toolCalls: [{ id: 'call_a', name: 'rewrite_session' }, { id: 'call_b', name: 'plain_tool' }],
      },
      { content: 'Готово' },
    ];
    const h = await makeHarness([rewriteTool, plainTool]);

    const result = await run(h, new AbortController().signal, () => {});
    expect(result.error).toBeUndefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;

    // Перезапись сессии уцелела (точечная дозапись её не затёрла).
    expect(session.todos).toHaveLength(1);
    expect(session.todos?.[0]?.content).toBe('заметка');

    // Оба результата вызовов на месте — ни один не потерян.
    const toolMessages = await sessionToolMessages(h);
    expect(toolMessages.map((m) => m.toolCallId)).toEqual(['call_a', 'call_b']);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('порядок в истории = порядок вызовов модели, даже если второй завершился первым', async () => {
    const execOrder: string[] = [];
    let bFinished!: () => void;
    const bDone = new Promise<void>((resolve) => { bFinished = resolve; });

    const toolA: ToolDefinition = {
      name: 'slow_a',
      description: 'ждёт завершения второго вызова',
      parameters: z.object({}).passthrough(),
      capabilities: [ToolCapability.RUNTIME],
      async execute() {
        const timedOut = await withTimeout(bDone, 3000);
        execOrder.push('a');
        return { content: timedOut ? 'a: timeout' : 'a: ok' };
      },
    } as unknown as ToolDefinition;
    const toolB: ToolDefinition = {
      name: 'fast_b',
      description: 'завершается сразу',
      parameters: z.object({}).passthrough(),
      capabilities: [ToolCapability.RUNTIME],
      async execute() {
        execOrder.push('b');
        bFinished();
        return { content: 'b: ok' };
      },
    } as unknown as ToolDefinition;

    ParallelScriptProvider.script = [
      {
        content: 'Шаг 1: два вызова',
        toolCalls: [{ id: 'call_a', name: 'slow_a' }, { id: 'call_b', name: 'fast_b' }],
      },
      { content: 'Готово' },
    ];
    const h = await makeHarness([toolA, toolB]);

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, new AbortController().signal, (event, data) => chunks.push({ event, data }));
    expect(result.error).toBeUndefined();

    // Исполнение шло параллельно: второй вызов завершился первым.
    expect(execOrder).toEqual(['b', 'a']);

    // Порядок в истории — по вызовам модели, не по порядку завершения.
    const results = await stepToolResults(h);
    expect(results.map((r) => r.id)).toEqual(['call_a', 'call_b']);
    expect(results.map((r) => r.result?.content)).toEqual(['a: ok', 'b: ok']);

    const toolMessages = await sessionToolMessages(h);
    expect(toolMessages.map((m) => m.toolCallId)).toEqual(['call_a', 'call_b']);

    // `tool_call.result` публикуется в порядке вызовов модели (фаза фиксации).
    const published = chunks
      .filter((c) => c.event === 'tool_call.result')
      .map((c) => c.data.call_id);
    expect(published).toEqual(['call_a', 'call_b']);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('исключение одного вызова не роняет остальные и не прерывает шаг', async () => {
    const boomTool: ToolDefinition = {
      name: 'boom_tool',
      description: 'падает с исключением',
      parameters: z.object({}).passthrough(),
      capabilities: [ToolCapability.RUNTIME],
      async execute() {
        throw new Error('boom');
      },
    } as unknown as ToolDefinition;
    const okTool: ToolDefinition = {
      name: 'ok_tool',
      description: 'отрабатывает нормально',
      parameters: z.object({}).passthrough(),
      capabilities: [ToolCapability.RUNTIME],
      async execute() {
        return { content: 'ok_tool: ok' };
      },
    } as unknown as ToolDefinition;

    ParallelScriptProvider.script = [
      {
        content: 'Шаг 1: падающий и нормальный вызовы',
        toolCalls: [{ id: 'call_boom', name: 'boom_tool' }, { id: 'call_ok', name: 'ok_tool' }],
      },
      { content: 'Готово' },
    ];
    const h = await makeHarness([boomTool, okTool]);

    const result = await run(h, new AbortController().signal, () => {});
    // Шаг не прерван ошибкой.
    expect(result.error).toBeUndefined();

    const results = await stepToolResults(h);
    expect(results.map((r) => r.id)).toEqual(['call_boom', 'call_ok']);
    // Упавший вызов — error-результат, второй — обычный.
    expect(results[0]!.result?.isError).toBe(true);
    expect(results[0]!.result?.content).toContain('boom');
    expect(results[1]!.result?.content).toBe('ok_tool: ok');

    // Пара assistant(tool_calls) → tool не разорвана: оба результата в истории.
    const toolMessages = await sessionToolMessages(h);
    expect(toolMessages.map((m) => m.toolCallId)).toEqual(['call_boom', 'call_ok']);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('барьер: plan_enter виден следующему вызову того же сообщения (режим меняется)', async () => {
    ParallelScriptProvider.script = [
      {
        content: 'Шаг 1: план и запись',
        toolCalls: [
          { id: 'call_plan', name: 'plan_enter' },
          { id: 'call_write', name: 'write_file' },
        ],
      },
      { content: 'Готово' },
    ];
    const h = await makeHarness();
    const target = join(h.tmpDir, 'must-not-exist.txt');
    ParallelScriptProvider.script[0]!.toolCalls![1]!.args = { file_path: target, content: 'не должно быть записано' };

    const denied: Array<Record<string, unknown>> = [];
    h.eventBus.subscribe(h.sessionId, (event) => {
      if (event.type === 'permission.denied') denied.push(event.data as Record<string, unknown>);
    });

    const result = await run(h, new AbortController().signal, () => {});
    expect(result.error).toBeUndefined();

    // Смена режима видна следующему вызову: запись в plan-режиме запрещена.
    expect(existsSync(target)).toBe(false);
    const writeDeny = denied.find((d) => d.tool === 'write_file');
    expect(writeDeny).toBeDefined();
    expect(writeDeny!.matched_rule).toBe('plan.deny');

    // Оба результата — в порядке вызовов модели.
    const toolMessages = await sessionToolMessages(h);
    expect(toolMessages.map((m) => m.toolCallId)).toEqual(['call_plan', 'call_write']);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('отмена во время параллельного батча: ход — отмена, результаты в истории', async () => {
    // Отмена инициируется ИЗ вызова, а не по таймеру: таймер — предположение
    // о времени, и под нагрузкой он успевал сработать до фазы вызовов (тогда
    // шаг обрывался ещё на стриме LLM и тест падал). Здесь отмена приходит
    // ровно тогда, когда быстрый вызов уже отработал, а долгий — ещё ждёт.
    const ac = new AbortController();
    let fastDone!: () => void;
    const fastFinished = new Promise<void>((resolve) => { fastDone = resolve; });

    const slowTool: ToolDefinition = {
      name: 'slow_abortable',
      description: 'завершается по отмене',
      parameters: z.object({}).passthrough(),
      capabilities: [ToolCapability.RUNTIME],
      async execute(_args: Record<string, unknown>, ctx: { abortSignal?: AbortSignal }) {
        // Ждём завершения быстрого вызова, затем отменяем ход.
        await fastFinished;
        ac.abort();
        await new Promise<void>((resolve) => {
          if (ctx.abortSignal?.aborted) {
            resolve();
            return;
          }
          ctx.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return { content: 'slow_abortable: прерван' };
      },
    } as unknown as ToolDefinition;
    const fastTool: ToolDefinition = {
      name: 'fast_ok',
      description: 'отрабатывает сразу',
      parameters: z.object({}).passthrough(),
      capabilities: [ToolCapability.RUNTIME],
      async execute() {
        fastDone();
        return { content: 'fast_ok: ok' };
      },
    } as unknown as ToolDefinition;

    ParallelScriptProvider.script = [
      {
        content: 'Шаг 1: долгий и быстрый вызовы',
        toolCalls: [{ id: 'call_slow', name: 'slow_abortable' }, { id: 'call_fast', name: 'fast_ok' }],
      },
      { content: 'не должно выполниться' },
    ];
    const h = await makeHarness([slowTool, fastTool]);

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];

    await run(h, ac.signal, (event, data) => chunks.push({ event, data }));

    // Ход завершён как отмена, а не «пустой ответ модели».
    expect(chunks.some((c) => c.event === 'stream.cancelled')).toBe(true);

    // Результаты исполненных вызовов остались в истории (пары не разорваны).
    const toolMessages = await sessionToolMessages(h);
    expect(toolMessages.map((m) => m.toolCallId)).toEqual(['call_slow', 'call_fast']);

    await rm(h.tmpDir, { recursive: true, force: true });
  });
});
