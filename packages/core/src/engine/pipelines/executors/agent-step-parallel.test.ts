/**
 * PROP-127 (этап T4): параллельное исполнение вызовов инструментов в
 * агентском шаге пайплайна (`executors/agent-step.ts`).
 *
 * Проверяются инварианты:
 * - **конкурентность**: вызовы одного assistant-сообщения стартуют
 *   одновременно (барьером, без тайминговых допущений);
 * - **порядок в истории = порядок вызовов модели**: tool-сообщения и сводка
 *   вызовов идут в порядке вызовов модели, даже если вызовы завершились в
 *   обратном порядке;
 * - **изоляция ошибок**: исключение одного вызова не роняет остальные и не
 *   прерывает шаг — модель получает результат-ошибку и продолжает;
 * - **гейт до исполнения**: эскалация `ask` останавливает партию ДО
 *   исполнения любого вызова;
 * - **нет инфраструктуры инструментов**: шаг падает до исполнения.
 *
 * Без сети и без настоящего LLM: провайдер — подставной, Composer — заглушка.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { LLMResponse, PipelineNode, ToolDefinition } from '@itphx/synth-shared';

import type { BaseProvider, LLMMessage, SystemPromptInput } from '../../../providers/base.js';
import type { SystemPromptComposer } from '../../context/composer.js';
import { isStepGateOutcome, type StepExecutionContext } from '../types.js';
import { createAgentStepExecutor } from './agent-step.js';

/** Вызов провайдера, зафиксированный тестом. */
interface ProviderCall {
  messages: LLMMessage[];
  system?: SystemPromptInput;
  tools?: Record<string, unknown>[];
  stream?: boolean;
}

/** Провайдер-заглушка: без сети, без LLM. */
function makeProvider(
  respond: (call: ProviderCall) => Promise<LLMResponse> | LLMResponse,
): { provider: BaseProvider; calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  const provider = {
    model: 'mock-model',
    getProviderName: () => 'mock',
    withTemperature: () => provider,
    chat: async (
      messages: LLMMessage[],
      system?: SystemPromptInput,
      tools?: Record<string, unknown>[],
      stream?: boolean,
    ): Promise<LLMResponse> => {
      const call = { messages, system, tools, stream };
      calls.push(call);
      return respond(call);
    },
  } as unknown as BaseProvider;
  return { provider, calls };
}

/** Composer-заглушка: фиксирует контекст сборки и отдаёт маркер. */
function makeComposer(): SystemPromptComposer {
  return {
    compose: vi.fn(async (_ctx: unknown) => ({
      system: 'SYSTEM-MARKER',
      stablePrefix: 'SYSTEM-MARKER',
      blocks: [],
    })),
  } as unknown as SystemPromptComposer;
}

/** Инструмент шага. */
function makeTool(
  name: string,
  execute: ToolDefinition['execute'] = async () => ({ content: 'ок' }),
): ToolDefinition {
  return {
    name,
    description: `тул ${name}`,
    parameters: z.object({ value: z.string().optional() }),
    capabilities: [ToolCapability.SEARCH],
    execute,
  } as unknown as ToolDefinition;
}

/** Ответ модели с вызовами тулов (OpenAI-формат). */
function toolCallsResponse(
  calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>,
): LLMResponse {
  return {
    content: '',
    model: 'mock-model',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    toolCalls: calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    })),
  };
}

/** Финальный ответ модели (без вызовов тулов). */
function finalResponse(text = 'готово'): LLMResponse {
  return {
    content: text,
    model: 'mock-model',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}

/** Узел agent-шага. */
function makeNode(overrides: Partial<PipelineNode> = {}): PipelineNode {
  return { id: 'step1', kind: 'agent', agent: 'assistant', ...overrides };
}

/** Контекст исполнения шага. */
function makeCtx(
  node: PipelineNode,
  overrides: Partial<StepExecutionContext> = {},
): StepExecutionContext {
  return {
    runId: 'prun_1',
    pipelineId: 'p1',
    version: 1,
    node,
    spec: {
      id: 'p1',
      name: 'Пайплайн',
      version: 1,
      status: 'published',
      mode: 'act',
      nodes: [node],
      exits: [{ kind: 'none' }],
    },
    trigger: { kind: 'manual' },
    input: {},
    vars: {},
    signal: new AbortController().signal,
    attempt: 1,
    mode: 'act',
    ...overrides,
  };
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

/** tool-сообщения локальной истории шага (по порядку). */
function toolMessages(calls: ProviderCall[]): LLMMessage[] {
  const last = calls[calls.length - 1];
  return (last?.messages ?? []).filter((msg) => msg.role === 'tool');
}

describe('PROP-127 T4: параллельное исполнение вызовов инструментов (агентский шаг пайплайна)', () => {
  it('вызовы одного сообщения стартуют одновременно (оба — до завершения первого)', async () => {
    const started: string[] = [];
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });

    const barrierTool = (name: string): ToolDefinition => ({
      name,
      description: `барьерный тул ${name}`,
      parameters: z.object({}).passthrough(),
      capabilities: [ToolCapability.SEARCH],
      async execute() {
        started.push(name);
        if (started.length >= 2) release();
        // При последовательном исполнении первый вызов никогда не дождётся
        // второго — таймаут и есть признак отсутствия параллельности.
        const timedOut = await withTimeout(bothStarted, 3000);
        return { content: timedOut ? `${name}: timeout` : `${name}: ok` };
      },
    } as unknown as ToolDefinition);

    const tools = new Map([
      ['gate_a', barrierTool('gate_a')],
      ['gate_b', barrierTool('gate_b')],
    ]);
    let n = 0;
    const { provider, calls } = makeProvider(() => {
      n += 1;
      return n === 1
        ? toolCallsResponse([
            { id: 'call_a', name: 'gate_a' },
            { id: 'call_b', name: 'gate_b' },
          ])
        : finalResponse();
    });

    const outcome = await createAgentStepExecutor({
      toolRegistry: { get: (name) => tools.get(name) },
    }).execute(makeCtx(makeNode(), { llm: { composer: makeComposer(), resolveProvider: () => provider } }));

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');

    // Оба вызова стартовали (порядок старта — по порядку вызовов модели).
    expect(started.sort()).toEqual(['gate_a', 'gate_b']);
    // Ни один вызов не уперся в таймаут — параллельность есть.
    expect(toolMessages(calls).map((msg) => msg.content)).toEqual(['gate_a: ok', 'gate_b: ok']);
  });

  it('порядок в истории = порядок вызовов модели, даже если второй завершился первым', async () => {
    const execOrder: string[] = [];
    let bFinished!: () => void;
    const bDone = new Promise<void>((resolve) => { bFinished = resolve; });

    const toolA: ToolDefinition = {
      name: 'slow_a',
      description: 'ждёт завершения второго вызова',
      parameters: z.object({}).passthrough(),
      capabilities: [ToolCapability.SEARCH],
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
      capabilities: [ToolCapability.SEARCH],
      async execute() {
        execOrder.push('b');
        bFinished();
        return { content: 'b: ok' };
      },
    } as unknown as ToolDefinition;

    const tools = new Map([
      ['slow_a', toolA],
      ['fast_b', toolB],
    ]);
    let n = 0;
    const { provider, calls } = makeProvider(() => {
      n += 1;
      return n === 1
        ? toolCallsResponse([
            { id: 'call_a', name: 'slow_a' },
            { id: 'call_b', name: 'fast_b' },
          ])
        : finalResponse();
    });

    const outcome = await createAgentStepExecutor({
      toolRegistry: { get: (name) => tools.get(name) },
    }).execute(makeCtx(makeNode(), { llm: { composer: makeComposer(), resolveProvider: () => provider } }));

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');

    // Исполнение шло параллельно: второй вызов завершился первым.
    expect(execOrder).toEqual(['b', 'a']);

    // Порядок в истории — по вызовам модели, не по порядку завершения.
    const messages = toolMessages(calls);
    expect(messages.map((msg) => msg.toolCallId)).toEqual(['call_a', 'call_b']);
    expect(messages.map((msg) => msg.content)).toEqual(['a: ok', 'b: ok']);

    // Сводка вызовов в выходе шага — тоже в порядке вызовов модели.
    expect(outcome.output?.toolCalls).toEqual([
      { name: 'slow_a', isError: false },
      { name: 'fast_b', isError: false },
    ]);
  });

  it('исключение одного вызова не роняет остальные и не прерывает шаг', async () => {
    const boomTool: ToolDefinition = {
      name: 'boom_tool',
      description: 'падает с исключением',
      parameters: z.object({}).passthrough(),
      capabilities: [ToolCapability.SEARCH],
      async execute() {
        throw new Error('boom');
      },
    } as unknown as ToolDefinition;
    const okTool: ToolDefinition = {
      name: 'ok_tool',
      description: 'отрабатывает нормально',
      parameters: z.object({}).passthrough(),
      capabilities: [ToolCapability.SEARCH],
      async execute() {
        return { content: 'ok_tool: ok' };
      },
    } as unknown as ToolDefinition;

    const tools = new Map([
      ['boom_tool', boomTool],
      ['ok_tool', okTool],
    ]);
    let n = 0;
    const { provider, calls } = makeProvider(() => {
      n += 1;
      return n === 1
        ? toolCallsResponse([
            { id: 'call_boom', name: 'boom_tool' },
            { id: 'call_ok', name: 'ok_tool' },
          ])
        : finalResponse();
    });

    const outcome = await createAgentStepExecutor({
      toolRegistry: { get: (name) => tools.get(name) },
    }).execute(makeCtx(makeNode(), { llm: { composer: makeComposer(), resolveProvider: () => provider } }));

    // Шаг не прерван ошибкой.
    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');
    expect(outcome.output?.text).toBe('готово');

    // Пара assistant(tool_calls) → tool не разорвана: оба результата в истории,
    // в порядке вызовов модели.
    const messages = toolMessages(calls);
    expect(messages.map((msg) => msg.toolCallId)).toEqual(['call_boom', 'call_ok']);
    expect(messages[0]?.content).toContain('boom');
    expect(messages[1]?.content).toBe('ok_tool: ok');

    // Сводка вызовов: упавший — с признаком ошибки, второй — обычный.
    expect(outcome.output?.toolCalls).toEqual([
      { name: 'boom_tool', isError: true },
      { name: 'ok_tool', isError: false },
    ]);
  });

  it('отказ по правам (deny) сохраняет порядок вызовов модели и не исполняется', async () => {
    const deniedExecute = vi.fn(async () => ({ content: 'не должно быть вызвано' }));
    const deniedTool = makeTool('denied_tool', deniedExecute);
    const okTool = makeTool('ok_tool', async () => ({ content: 'ok_tool: ok' }));

    const tools = new Map([
      ['denied_tool', deniedTool],
      ['ok_tool', okTool],
    ]);
    let n = 0;
    const { provider, calls } = makeProvider(() => {
      n += 1;
      return n === 1
        ? toolCallsResponse([
            { id: 'call_denied', name: 'denied_tool' },
            { id: 'call_ok', name: 'ok_tool' },
          ])
        : finalResponse();
    });

    const outcome = await createAgentStepExecutor({
      toolRegistry: { get: (name) => tools.get(name) },
      permissions: {
        permissionConfig: { rules: { denied_tool: 'deny' }, askTimeoutMs: 1000 },
      },
    }).execute(makeCtx(makeNode(), { llm: { composer: makeComposer(), resolveProvider: () => provider } }));

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');
    expect(deniedExecute).not.toHaveBeenCalled();

    // Отказ виден модели в истории, порядок — по вызовам модели.
    const messages = toolMessages(calls);
    expect(messages.map((msg) => msg.toolCallId)).toEqual(['call_denied', 'call_ok']);
    expect(messages[0]?.content).toContain('Permission denied');
    expect(messages[1]?.content).toBe('ok_tool: ok');
    expect(outcome.output?.toolCalls).toEqual([
      { name: 'denied_tool', isError: true },
      { name: 'ok_tool', isError: false },
    ]);
  });

  it('гейт (ask) останавливает партию ДО исполнения любого вызова', async () => {
    const first = vi.fn(async () => ({ content: 'не должно быть вызвано' }));
    const second = vi.fn(async () => ({ content: 'не должно быть вызвано' }));
    const tools = new Map([
      ['tool_one', makeTool('tool_one', first)],
      ['tool_two', makeTool('tool_two', second)],
    ]);
    const { provider } = makeProvider(() =>
      toolCallsResponse([
        { id: 'call_one', name: 'tool_one' },
        { id: 'call_two', name: 'tool_two' },
      ]),
    );

    const outcome = await createAgentStepExecutor({
      toolRegistry: { get: (name) => tools.get(name) },
      permissions: {
        permissionConfig: { rules: { tool_two: 'ask' }, askTimeoutMs: 1000 },
      },
    }).execute(makeCtx(makeNode(), { llm: { composer: makeComposer(), resolveProvider: () => provider } }));

    expect(isStepGateOutcome(outcome)).toBe(true);
    if (!isStepGateOutcome(outcome)) return;
    expect(outcome.gate.kind).toBe('tool_approval');
    expect(outcome.gate.toolName).toBe('tool_two');
    // Ни один вызов партии не исполнен (иначе после `resume` они повторились бы).
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('нет инфраструктуры инструментов → шаг падает до исполнения', async () => {
    const execute = vi.fn(async () => ({ content: 'ок' }));
    const { provider } = makeProvider(() => toolCallsResponse([{ id: 'call_1', name: 'noop' }]));

    // Реестра инструментов нет и контекста шага нет — исполнять нечем.
    const outcome = await createAgentStepExecutor().execute(
      makeCtx(makeNode(), { llm: { composer: makeComposer(), resolveProvider: () => provider } }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.agent_unavailable');
    expect(execute).not.toHaveBeenCalled();
  });

  it('вызов, которого нет в реестре, не роняет шаг: модель получает отказ и продолжает', async () => {
    let n = 0;
    const { provider, calls } = makeProvider(() => {
      n += 1;
      return n === 1
        ? toolCallsResponse([
            { id: 'call_unknown', name: 'unknown_tool' },
            { id: 'call_ok', name: 'ok_tool' },
          ])
        : finalResponse();
    });

    const outcome = await createAgentStepExecutor({
      toolRegistry: { get: (name) => (name === 'ok_tool' ? makeTool('ok_tool') : undefined) },
    }).execute(makeCtx(makeNode(), { llm: { composer: makeComposer(), resolveProvider: () => provider } }));

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');

    const messages = toolMessages(calls);
    expect(messages.map((msg) => msg.toolCallId)).toEqual(['call_unknown', 'call_ok']);
    expect(messages[0]?.content.length).toBeGreaterThan(0);
    expect(messages[1]?.content).toBe('ок');
  });
});
