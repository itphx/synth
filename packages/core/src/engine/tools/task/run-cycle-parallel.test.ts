/**
 * PROP-127 (этап T3): параллельное исполнение вызовов инструментов в цикле
 * саб-агента (`task/run-cycle.ts`).
 *
 * Цикл саб-агента разбит на те же три фазы, что и цикл основной сессии
 * (подготовка → исполнение → фиксация), и на сегменты по барьерам. Проверяем
 * инварианты:
 * - **конкурентность**: вызовы одного assistant-сообщения ребёнка стартуют
 *   одновременно (барьером, без тайминговых допущений);
 * - **порядок в истории = порядок вызовов модели**: LLM-контекст ребёнка,
 *   история дочерней сессии, `metadata.tool_calls` и события
 *   `tool_call.result` — в порядке вызовов модели, даже если вызовы
 *   завершились в обратном порядке;
 * - **изоляция ошибок**: исключение одного вызова не роняет остальные и не
 *   прерывает прогон, пара assistant(tool_calls) → tool не рвётся;
 * - **барьер прав**: «Разрешить в сессии» виден следующему вызову того же
 *   сообщения (вызов, получивший грант, завершает сегмент);
 * - **прежние ветки без изменений**: «кривой» вызов пропускается целиком,
 *   шаг-лимит публикует результат **без** `tool_call.started`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { MessageRole } from '@itphx/synth-shared';
import type { ToolContext, ToolDefinition, ToolResult, ToolForLLM, TokenUsage } from '@itphx/synth-shared';
import type { BaseProvider, CancellationToken, ChatOptions, LLMMessage, SystemPromptInput } from '../../../providers/base.js';
import type { AgentRegistry } from '../../agents/registry.js';
import { FileStore } from '../../../storage/file-store.js';
import { SessionManager } from '../../../sessions/manager.js';
import { EventBus } from '../../../events/bus.js';
import { ToolRegistry } from '../registry.js';
import { runSubagent, type SubagentRunConfig } from './run-cycle.js';
import type { TaskExtra } from './types.js';

interface Chunk {
  isFinal: boolean;
  content: string;
  toolCalls?: unknown[];
  usage?: TokenUsage;
  model?: string;
}

function userMessage(content: string): LLMMessage {
  return {
    id: '', role: 'user', content,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false, pinned: false, branchId: '',
  };
}

/** Один вызов инструмента в сценарии провайдера. */
interface ScriptToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

/** Провайдер с пошаговым сценарием: script[i] — чанки i-го вызова. */
function scriptedProvider(script: Chunk[][]) {
  let calls = 0;
  // Снимок сообщений на момент вызова: массив `messages` в цикле мутируется
  // дальше, поэтому смотреть нужно копию.
  const snapshots: LLMMessage[][] = [];
  const chatAsync = vi.fn((
    messages: LLMMessage[],
    _systemPrompt?: SystemPromptInput,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
    _options?: ChatOptions,
  ) => {
    const idx = Math.min(calls, script.length - 1);
    calls += 1;
    snapshots.push(messages.map((m) => ({ ...m })));
    return (async function* () {
      for (const c of script[idx]!) yield c;
    })();
  });
  const provider = { model: 'test-model', name: 'test-provider', chatAsync } as unknown as BaseProvider;
  return { provider, calls: () => calls, chatAsync, snapshots };
}

/** Чанк с несколькими вызовами инструментов одного assistant-сообщения. */
function toolCallsChunk(calls: ScriptToolCall[]): Chunk {
  return {
    isFinal: true,
    content: '',
    toolCalls: calls.map((tc) => ({
      id: tc.id,
      function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
    })),
  };
}

function llmTools(): ToolForLLM[] {
  return [{ type: 'function', function: { name: 'noop', description: 'noop', parameters: {} } }];
}

function makeAgentRegistry(): AgentRegistry {
  return {
    get: (id: string) => ({ id, agentMode: ['subagent'], capabilities: [] }),
    getSubagents: () => [],
    getToolsForAgent: () => [],
  } as unknown as AgentRegistry;
}

let tmpDir: string;
let sessionManager: SessionManager;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-task-parallel-'));
  sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'parent-1',
    messageId: 'm1',
    abortSignal: new AbortController().signal,
    workingDir: tmpDir,
    ...over,
  };
}

function makeExtra(over: Record<string, unknown>): TaskExtra {
  return {
    agentRegistry: makeAgentRegistry(),
    ...over,
  } as unknown as TaskExtra;
}

function makeConfig(over: Partial<SubagentRunConfig> & { extra: TaskExtra }): SubagentRunConfig {
  return {
    subagentType: 'explore',
    description: 'do it',
    contextMode: 'none',
    maxSteps: 5,
    llmSystemPrompt: 'SYS',
    initialMessages: [userMessage('hello')],
    provider: over.extra.provider,
    parentSessionId: 'parent-1',
    ctx: makeCtx(),
    ...over,
  } as SubagentRunConfig;
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

/** Реестр тулов с общим журналом вызовов (старт/финиш — по порядку). */
function makeRegistry(
  spec: Record<string, (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>>,
  journal?: string[],
): { registry: ToolRegistry; counters: Record<string, number> } {
  const registry = new ToolRegistry();
  const counters: Record<string, number> = {};
  for (const [name, exec] of Object.entries(spec)) {
    registry.register({
      name,
      description: name,
      parameters: z.object({}).passthrough(),
      capabilities: [],
      execute: async (args: Record<string, unknown>) => {
        counters[name] = (counters[name] ?? 0) + 1;
        journal?.push(`${name}:start`);
        const result = await exec(args);
        journal?.push(`${name}:end`);
        return result;
      },
    } as unknown as ToolDefinition);
  }
  return { registry, counters };
}

/** Tool-сообщения дочерней сессии в порядке истории. */
async function childToolMessages(sessionId: string): Promise<Array<{ toolCallId?: string; content: string }>> {
  const session = (await sessionManager.getSession(sessionId))!;
  return session.messages
    .filter((m) => m.role === MessageRole.TOOL)
    .map((m) => ({ toolCallId: m.toolCallId, content: m.content }));
}

describe('PROP-127 T3: параллельное исполнение вызовов инструментов (цикл саб-агента)', () => {
  it('вызовы одного сообщения стартуют одновременно (оба — до завершения первого)', async () => {
    const started: string[] = [];
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });

    const barrierTool = (name: string): ToolDefinition => ({
      name,
      description: `барьерный тул ${name}`,
      parameters: z.object({}).passthrough(),
      capabilities: [],
      async execute() {
        started.push(name);
        if (started.length >= 2) release();
        // При последовательном исполнении первый вызов никогда не дождётся
        // второго — таймаут и есть признак отсутствия параллельности.
        const timedOut = await withTimeout(bothStarted, 3000);
        return { content: timedOut ? `${name}: timeout` : `${name}: ok` };
      },
    } as unknown as ToolDefinition);

    const registry = new ToolRegistry();
    registry.register(barrierTool('gate_a'));
    registry.register(barrierTool('gate_b'));

    const { provider } = scriptedProvider([
      [toolCallsChunk([{ id: 'call_a', name: 'gate_a' }, { id: 'call_b', name: 'gate_b' }])],
      [{ isFinal: true, content: 'готово', model: 'test-model' }],
    ]);

    const result = await runSubagent(makeConfig({
      tools: llmTools(),
      extra: makeExtra({ provider, toolRegistry: registry }),
    }));

    expect(result.isError).toBeFalsy();
    expect(started.sort()).toEqual(['gate_a', 'gate_b']);

    // Порядок результатов — по вызовам модели.
    const toolCalls = result.metadata!.tool_calls as Array<{ id?: string; result?: { content: string } }>;
    expect(toolCalls.map((t) => t.id)).toEqual(['call_a', 'call_b']);
    expect(toolCalls.map((t) => t.result?.content)).toEqual(['gate_a: ok', 'gate_b: ok']);
  });

  it('порядок в истории = порядок вызовов модели, даже если второй завершился первым', async () => {
    const journal: string[] = [];
    let bFinished!: () => void;
    const bDone = new Promise<void>((resolve) => { bFinished = resolve; });

    const { registry } = makeRegistry({
      slow_a: async () => {
        const timedOut = await withTimeout(bDone, 3000);
        return { content: timedOut ? 'a: timeout' : 'a: ok' };
      },
      fast_b: async () => {
        bFinished();
        return { content: 'b: ok' };
      },
    }, journal);

    const { provider, snapshots } = scriptedProvider([
      [toolCallsChunk([{ id: 'call_a', name: 'slow_a' }, { id: 'call_b', name: 'fast_b' }])],
      [{ isFinal: true, content: 'готово', model: 'test-model' }],
    ]);
    const published: Array<{ type: string; data: Record<string, unknown> }> = [];

    const result = await runSubagent(makeConfig({
      tools: llmTools(),
      extra: makeExtra({
        provider, toolRegistry: registry,
        publish: (type: string, data: Record<string, unknown>) => published.push({ type, data }),
      }),
    }));
    expect(result.isError).toBeFalsy();

    // Исполнение шло параллельно: второй вызов завершился первым.
    expect(journal).toEqual(['slow_a:start', 'fast_b:start', 'fast_b:end', 'slow_a:end']);

    // Порядок в истории — по вызовам модели, не по порядку завершения.
    const toolCalls = result.metadata!.tool_calls as Array<{ id?: string; result?: { content: string } }>;
    expect(toolCalls.map((t) => t.id)).toEqual(['call_a', 'call_b']);
    expect(toolCalls.map((t) => t.result?.content)).toEqual(['a: ok', 'b: ok']);

    // LLM-контекст ребёнка: tool-результаты в порядке вызовов модели.
    const toolMessages = snapshots[1]!.filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.toolCallId)).toEqual(['call_a', 'call_b']);
    expect(toolMessages.map((m) => m.content)).toEqual(['a: ok', 'b: ok']);

    // `tool_call.result` публикуется в порядке вызовов модели (фаза фиксации).
    const results = published
      .filter((p) => p.type === 'tool_call.result')
      .map((p) => p.data.call_id);
    expect(results).toEqual(['call_a', 'call_b']);
  });

  it('исключение одного вызова не роняет остальные и не прерывает прогон', async () => {
    const { registry } = makeRegistry({
      boom_tool: async () => {
        throw new Error('boom');
      },
      ok_tool: async () => ({ content: 'ok_tool: ok' }),
    });

    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
    const { provider } = scriptedProvider([
      [toolCallsChunk([{ id: 'call_boom', name: 'boom_tool' }, { id: 'call_ok', name: 'ok_tool' }])],
      [{ isFinal: true, content: 'готово', model: 'test-model' }],
    ]);

    const result = await runSubagent(makeConfig({
      tools: llmTools(),
      extra: makeExtra({
        provider, sessionManager, sessionId: parent.id, toolRegistry: registry,
      }),
      childSessionId: child.id,
      parentSessionId: parent.id,
    }));

    // Прогон не прерван ошибкой.
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('готово');

    const toolCalls = result.metadata!.tool_calls as Array<{ id?: string; result?: { content: string; isError?: boolean } }>;
    expect(toolCalls.map((t) => t.id)).toEqual(['call_boom', 'call_ok']);
    // Упавший вызов — error-результат, второй — обычный.
    expect(toolCalls[0]!.result?.isError).toBe(true);
    expect(toolCalls[0]!.result?.content).toContain('boom');
    expect(toolCalls[1]!.result?.content).toBe('ok_tool: ok');

    // Пара assistant(tool_calls) → tool не разорвана: оба результата в истории
    // дочерней сессии, в порядке вызовов модели.
    const saved = await childToolMessages(child.id);
    expect(saved.map((m) => m.toolCallId)).toEqual(['call_boom', 'call_ok']);
  });

  it('барьер прав: «Разрешить в сессии» виден следующему вызову того же сообщения', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
    const bus = new EventBus();
    let asks = 0;
    // Подписчик «UI»: отвечает на permission.asked в родительской сессии.
    bus.subscribe(parent.id, (e) => {
      if (e.type === 'permission.asked') {
        asks += 1;
        bus.publish(parent.id, 'permission.replied', {
          approval_id: (e.data as Record<string, unknown>).approval_id,
          action: 'allow',
          once: false,
        });
      }
    });

    const journal: string[] = [];
    const { registry, counters } = makeRegistry({
      gated: async () => ({ content: 'gated: ok' }),
    }, journal);
    const { provider } = scriptedProvider([
      [toolCallsChunk([{ id: 'call_1', name: 'gated' }, { id: 'call_2', name: 'gated' }])],
      [{ isFinal: true, content: 'готово', model: 'test-model' }],
    ]);

    const result = await runSubagent(makeConfig({
      tools: llmTools(),
      extra: makeExtra({
        provider, eventBus: bus, sessionManager, sessionId: parent.id, toolRegistry: registry,
        permissionConfig: { rules: { gated: 'ask' }, askTimeoutMs: 1000 },
      }),
      childSessionId: child.id,
      parentSessionId: parent.id,
    }));

    expect(result.isError).toBeFalsy();
    // PROP-127 (этап T5): оба вызова одного шага висят **одновременно** —
    // пользователь видит две карточки подтверждения сразу (паритет с
    // opencode). Второй вызов НЕ ждёт нового ответа: его запрос уже покрыт
    // грантом «Разрешить в сессии» (переоценка соседей — ветка `always`).
    expect(asks).toBe(2);
    expect(counters.gated).toBe(2);

    // Барьер: вызов, получивший грант, завершает батч — второй вызов
    // исполняется уже после фиксации первого.
    expect(journal).toEqual(['gated:start', 'gated:end', 'gated:start', 'gated:end']);

    // Грант записан в permissions дочерней сессии.
    const saved = (await sessionManager.getSession(child.id))!;
    expect(saved.settings.permission!.rules.gated).toBe('allow');
  });

  it('«кривой» вызов (без имени тула) пропускается целиком — как и раньше', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
    const { registry, counters } = makeRegistry({ ok_tool: async () => ({ content: 'ok' }) });
    const published: Array<{ type: string; data: Record<string, unknown> }> = [];

    const { provider } = scriptedProvider([
      [{
        isFinal: true,
        content: '',
        toolCalls: [
          { id: 'call_bad' },
          { id: 'call_ok', function: { name: 'ok_tool', arguments: '{}' } },
        ],
      }],
      [{ isFinal: true, content: 'готово', model: 'test-model' }],
    ]);

    const result = await runSubagent(makeConfig({
      tools: llmTools(),
      extra: makeExtra({
        provider, sessionManager, sessionId: parent.id, toolRegistry: registry,
        publish: (type: string, data: Record<string, unknown>) => published.push({ type, data }),
      }),
      childSessionId: child.id,
      parentSessionId: parent.id,
    }));

    expect(result.isError).toBeFalsy();
    expect(counters.ok_tool).toBe(1);

    // Ни одного события по «кривому» вызову: у нормального — started и result.
    expect(published.filter((p) => p.type === 'tool_call.started').map((p) => p.data.call_id))
      .toEqual(['call_ok']);
    expect(published.filter((p) => p.type === 'tool_call.result').map((p) => p.data.call_id))
      .toEqual(['call_ok']);

    // В истории ребёнка — только результат нормального вызова.
    const saved = await childToolMessages(child.id);
    expect(saved.map((m) => m.toolCallId)).toEqual(['call_ok']);
  });

  it('шаг-лимит: результат публикуется, `tool_call.started` — нет (поведение прежнее)', async () => {
    const parent = await sessionManager.createSession({ title: 'P' });
    const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
    const { registry, counters } = makeRegistry({ noop: async () => ({ content: 'ok' }) });
    const published: Array<{ type: string; data: Record<string, unknown> }> = [];

    const { provider } = scriptedProvider([
      [toolCallsChunk([{ id: 'call_1', name: 'noop' }, { id: 'call_2', name: 'noop' }])],
    ]);

    const result = await runSubagent(makeConfig({
      maxSteps: 1,
      tools: llmTools(),
      extra: makeExtra({
        provider, sessionManager, sessionId: parent.id, toolRegistry: registry,
        publish: (type: string, data: Record<string, unknown>) => published.push({ type, data }),
      }),
      childSessionId: child.id,
      parentSessionId: parent.id,
    }));

    // Вызовы не исполнялись.
    expect(counters.noop).toBeUndefined();
    expect(result.metadata!.step_limit_reached).toBe(true);

    // `tool_call.started` не публиковался ни разу, `tool_call.result` — для обоих.
    expect(published.filter((p) => p.type === 'tool_call.started')).toHaveLength(0);
    expect(published.filter((p) => p.type === 'tool_call.result').map((p) => p.data.call_id))
      .toEqual(['call_1', 'call_2']);

    // Парные tool-результаты в истории ребёнка (в порядке вызовов модели).
    const saved = await childToolMessages(child.id);
    expect(saved.map((m) => m.toolCallId)).toEqual(['call_1', 'call_2']);
  });

  it('doom-loop: блокировка остаётся по порядку вызовов модели, лишних событий нет', async () => {
    const { registry, counters } = makeRegistry({ noop: async () => ({ content: 'ok' }) });
    const published: Array<{ type: string; data: Record<string, unknown> }> = [];

    // Три одинаковых вызова подряд → на третьем срабатывает doom-защита.
    const { provider } = scriptedProvider([
      [toolCallsChunk([{ id: 'call_1', name: 'noop' }])],
      [toolCallsChunk([{ id: 'call_2', name: 'noop' }])],
      [toolCallsChunk([{ id: 'call_3', name: 'noop' }])],
      [{ isFinal: true, content: 'готово', model: 'test-model' }],
    ]);

    const result = await runSubagent(makeConfig({
      tools: llmTools(),
      extra: makeExtra({
        provider, toolRegistry: registry,
        publish: (type: string, data: Record<string, unknown>) => published.push({ type, data }),
      }),
    }));

    // Первые MAX_DOOM_LOOP_COUNT-1 вызовов исполнились, третий — заблокирован.
    expect(counters.noop).toBe(2);
    // Doom-вызов не публикует ни started, ни result.
    expect(published.filter((p) => p.type === 'tool_call.started').map((p) => p.data.call_id))
      .toEqual(['call_1', 'call_2']);
    expect(published.filter((p) => p.type === 'tool_call.result').map((p) => p.data.call_id))
      .toEqual(['call_1', 'call_2']);
    // В `tool_calls` doom-вызов не попадает.
    const toolCalls = result.metadata!.tool_calls as Array<{ id?: string }>;
    expect(toolCalls.map((t) => t.id)).toEqual(['call_1', 'call_2']);
  });
});
