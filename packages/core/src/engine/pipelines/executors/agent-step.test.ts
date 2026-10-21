/**
 * Тесты исполнителя шага вида `agent` (ADR-101 §4, Э4.3a).
 *
 * Проверяются: сборка системного промпта через Composer, состав тулов в
 * запросе, формат сообщения шага (задание + вход), успешный исход, ошибки
 * провайдера (восполнимая/невосполнимая) и отмена по `ctx.signal`.
 *
 * Без сети и без реального LLM: провайдер — подставной, Composer — заглушка
 * (плюс один тест с настоящим Composer'ом).
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { LLMResponse, PipelineNode, ToolContext, ToolDefinition } from '@itphx/synth-shared';

import type {
  BaseProvider,
  LLMMessage,
  SystemPromptInput,
} from '../../../providers/base.js';
import { stubContextFiles } from '../../../test-helpers/storage-stubs.js';
import { ContextBuilder } from '../../context/builder.js';
import { ContextConfig } from '../../context/config.js';
import type {
  ComposedPrompt,
  ComposerContext,
  SystemPromptComposer,
} from '../../context/composer.js';
import { SystemPromptComposer as RealSystemPromptComposer } from '../../context/composer.js';
import type { PipelineStepContext } from '../step-context.js';
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

/** Ответ провайдера по умолчанию. */
function okResponse(content: string): LLMResponse {
  return {
    content,
    model: 'mock-model',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}

/** Composer-заглушка: фиксирует контекст сборки и отдаёт маркер. */
function makeComposer(
  result: Partial<ComposedPrompt> = {},
): { composer: SystemPromptComposer; calls: ComposerContext[] } {
  const calls: ComposerContext[] = [];
  const composer = {
    compose: vi.fn(async (ctx: ComposerContext): Promise<ComposedPrompt> => {
      calls.push(ctx);
      return { system: 'SYSTEM-MARKER', stablePrefix: 'SYSTEM-MARKER', blocks: [], ...result };
    }),
  } as unknown as SystemPromptComposer;
  return { composer, calls };
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
  };
}

/** Ответ модели с вызовом тула (OpenAI-формат). */
function toolCallResponse(
  id: string,
  name: string,
  args: Record<string, unknown>,
): LLMResponse {
  return {
    content: '',
    model: 'mock-model',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    toolCalls: [
      {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

/** Узел agent-шага. */
function makeNode(overrides: Partial<PipelineNode> = {}): PipelineNode {
  return { id: 'step1', kind: 'agent', agent: 'assistant', ...overrides };
}

/** Контекст шага (проект/тулы/режим). */
function makeStepContext(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  return {
    workspaceReady: true,
    mode: 'act',
    language: 'ru',
    tools: [],
    availableTools: [],
    unavailableTools: [],
    mcpServers: [],
    mcpDecisions: [],
    ...overrides,
  };
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

describe('исполнитель agent-шага (ADR-101 §4, Э4.3a)', () => {
  it('простой ответ без тулов → ok, output.text = ответ', async () => {
    const { provider, calls } = makeProvider(() => okResponse('готово'));
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor();

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');
    expect(outcome.output?.text).toBe('готово');
    expect(outcome.output?.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    // Ровно один LLM-вызов, без стрима.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.stream).toBe(false);
  });

  it('системный промпт собран через Composer и ушёл в вызов непустым', async () => {
    const { provider, calls } = makeProvider(() => okResponse('ок'));
    const { composer, calls: composeCalls } = makeComposer();
    const executor = createAgentStepExecutor();

    await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    // Composer вызван ровно один раз (сборка идемпотентна и кешируется в пределах шага).
    expect(composeCalls).toHaveLength(1);
    // В вызов ушёл непустой system и ровно один пользовательский запрос.
    const system = calls[0]?.system;
    expect(typeof system === 'string' ? system : system?.text).toBe('SYSTEM-MARKER');
    expect(calls[0]?.messages).toHaveLength(1);
    expect(calls[0]?.messages[0]?.role).toBe('user');
  });

  it('в запрос уходят только доступные тулы', async () => {
    const available = makeTool('read_file');
    const unavailable = makeTool('write_file');
    const { provider, calls } = makeProvider(() => okResponse('ок'));
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor();

    await executor.execute(
      makeCtx(makeNode(), {
        step: makeStepContext({
          tools: [available, unavailable],
          availableTools: [available],
        }),
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    const tools = calls[0]?.tools ?? [];
    expect(tools).toHaveLength(1);
    expect((tools[0] as { function: { name: string } }).function.name).toBe('read_file');
  });

  it('вход шага и node.prompt попали в пользовательское сообщение', async () => {
    const { provider, calls } = makeProvider(() => okResponse('ок'));
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor();

    await executor.execute(
      makeCtx(makeNode({ prompt: 'Собери отчёт' }), {
        input: { 'prev.output.report': 'готов', 'trigger.payload.issue': 'ABC-1' },
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    const content = calls[0]?.messages[0]?.content ?? '';
    expect(content).toContain('[TASK]');
    expect(content).toContain('Собери отчёт');
    expect(content).toContain('[INPUT]');
    expect(content).toContain('- prev.output.report: готов');
    expect(content).toContain('- trigger.payload.issue: ABC-1');
    // Порядок входа детерминирован (по алфавиту путей).
    expect(content.indexOf('prev.output.report')).toBeLessThan(content.indexOf('trigger.payload.issue'));
  });

  it('ошибка провайдера → шаг failed с pipeline.llm_failed (ошибка восполнимая)', async () => {
    const { provider } = makeProvider(() => {
      throw new Error('fetch failed');
    });
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor();

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.llm_failed');
    expect(outcome.error?.message).toBeTruthy();
  });

  it('невосполнимая ошибка провайдера → pipeline.llm_unrecoverable', async () => {
    const { provider } = makeProvider(() => {
      throw new Error('401 Unauthorized');
    });
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor();

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.llm_unrecoverable');
  });

  it('провайдер не настроен → шаг failed с pipeline.provider_not_found', async () => {
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor();

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => null },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.provider_not_found');
  });

  it('LLM-контур не настроен → шаг failed с pipeline.agent_unavailable', async () => {
    const executor = createAgentStepExecutor();

    const outcome = await executor.execute(makeCtx(makeNode()));

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.agent_unavailable');
  });

  it('отмена по ctx.signal прерывает шаг (без зависания)', async () => {
    const controller = new AbortController();
    // Провайдер «висит» — ответ не приходит никогда.
    const { provider } = makeProvider(() => new Promise<LLMResponse>(() => undefined));
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor();

    const pending = executor.execute(
      makeCtx(makeNode(), {
        signal: controller.signal,
        llm: { composer, resolveProvider: () => provider },
      }),
    );
    controller.abort();

    const outcome = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('шаг не прервался')), 2000),
      ),
    ]);

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.cancelled');
  });

  it('уже отменённый шаг не вызывает провайдера', async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, calls } = makeProvider(() => okResponse('ок'));
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor();

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        signal: controller.signal,
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.cancelled');
    expect(calls).toHaveLength(0);
  });

  it('в output нет ничего лишнего (секретов/сырых internals)', async () => {
    const { provider } = makeProvider(() => ({
      ...okResponse('ответ модели'),
      debugInfo: { raw: 'internal' },
    }));
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor();

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');
    // В выходе шага — только текст ответа и расход токенов.
    expect(Object.keys(outcome.output ?? {}).sort()).toEqual(['text', 'usage']);
    const serialized = JSON.stringify(outcome.output);
    expect(serialized).not.toContain('SYSTEM-MARKER');
    expect(serialized).not.toContain('internal');
    expect(serialized).not.toContain('mock-model');
  });

  it('настоящий Composer собирает непустой системный промпт шага', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'synth-agent-step-'));
    await mkdir(join(userDataDir, 'user'), { recursive: true });
    await mkdir(join(userDataDir, 'roles'), { recursive: true });
    await writeFile(join(userDataDir, 'roles', 'ASSISTANT.md'), 'ROLE-MARKER', 'utf-8');

    try {
      const builder = new ContextBuilder(new ContextConfig({ userDataDir }));
      const composer = new RealSystemPromptComposer({
        contextBuilder: builder,
        contextConfig: stubContextFiles({
          getGatewayInstructions: () => '[GATEWAY]',
          getPlanGuide: () => '[PLAN GUIDE]',
          getModePolicy: () => '[MODE POLICY]',
        }),
        projectStore: null,
      });
      const { provider, calls } = makeProvider(() => okResponse('ок'));
      const executor = createAgentStepExecutor();

      const outcome = await executor.execute(
        makeCtx(makeNode(), {
          llm: { composer, resolveProvider: () => provider },
        }),
      );

      expect(isStepGateOutcome(outcome)).toBe(false);
      if (isStepGateOutcome(outcome)) return;
      expect(outcome.status).toBe('ok');

      const system = calls[0]?.system;
      const text = typeof system === 'string' ? system : (system?.text ?? '');
      expect(text.length).toBeGreaterThan(0);
      // Ролевой промпт агента шага попал в системный промпт.
      expect(text).toContain('ROLE-MARKER');
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});

/**
 * Tool-Use-цикл агентского шага (ADR-101 §4, Э4.3b).
 *
 * Проверяются: исполнение вызова тула и результат в локальной истории,
 * отказ по правам (`deny`) — модель видит отказ и цикл продолжается,
 * эскалация `ask` → гейт и её закрытие решением оператора (одобрение →
 * вызов с выданным правом, отказ → вызов не исполняется), лимит итераций,
 * отмена и отсутствие полных выводов тулов в выходе шага.
 */
describe('Tool-Use-цикл agent-шага (ADR-101 §4, Э4.3b)', () => {
  /** Провайдер: первый ответ — с вызовом тула, дальше — финальный ответ. */
  function makeToolThenFinal(
    toolCall: LLMResponse,
    finalText = 'готово',
  ): { provider: BaseProvider; calls: ProviderCall[] } {
    let n = 0;
    return makeProvider(() => {
      n += 1;
      return n === 1 ? toolCall : okResponse(finalText);
    });
  }

  it('ответ с вызовом тула → тул выполнен, результат в локальной истории, второй вызов LLM даёт финал', async () => {
    const execute = vi.fn(async (_args: unknown, _ctx: ToolContext) => ({ content: 'результат тула' }));
    const tool = makeTool('noop', execute);
    const { provider, calls } = makeToolThenFinal(
      toolCallResponse('call_1', 'noop', { value: 'x' }),
    );
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor({ toolRegistry: { get: () => tool } });

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');
    expect(outcome.output?.text).toBe('готово');
    // Тул вызван один раз, с аргументами модели.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ value: 'x' });
    // Два LLM-вызова: первый — с вызовом, второй — с результатом в истории.
    expect(calls).toHaveLength(2);
    const toolMessages = (calls[1]?.messages ?? []).filter((msg) => msg.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toBe('результат тула');
    // Результат парный к вызову (по id) — провайдеры требуют пару.
    expect(toolMessages[0]?.toolCallId).toBe('call_1');
    // Сводка вызовов — имя и признак ошибки.
    expect(outcome.output?.toolCalls).toEqual([{ name: 'noop', isError: false }]);
  });

  it('deny → тул не выполняется, модель видит отказ, цикл продолжается', async () => {
    const execute = vi.fn(async (_args: unknown, _ctx: ToolContext) => ({ content: 'ок' }));
    const tool = makeTool('noop', execute);
    const { provider, calls } = makeToolThenFinal(
      toolCallResponse('call_1', 'noop', { value: 'x' }),
    );
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor({
      toolRegistry: { get: () => tool },
      permissions: { permissionConfig: { rules: { noop: 'deny' }, askTimeoutMs: 1000 } },
    });

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    // Отказ не валит шаг: модель увидела отказ и продолжила.
    expect(outcome.status).toBe('ok');
    expect(outcome.output?.text).toBe('готово');
    expect(execute).not.toHaveBeenCalled();
    // Отказ виден модели в истории.
    const toolMessages = (calls[1]?.messages ?? []).filter((msg) => msg.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain('Permission denied');
    expect(outcome.output?.toolCalls).toEqual([{ name: 'noop', isError: true }]);
  });

  it('ask → пауза-гейт с именем тула и аргументами; после одобрения тул исполняется с выданным правом', async () => {
    const execute = vi.fn(async (_args: unknown, _ctx: ToolContext) => ({ content: 'результат тула' }));
    const tool = makeTool('noop', execute);
    const { provider } = makeToolThenFinal(toolCallResponse('call_1', 'noop', { value: 'x' }));
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor({
      toolRegistry: { get: () => tool },
      permissions: { permissionConfig: { rules: { noop: 'ask' }, askTimeoutMs: 1000 } },
    });

    // Первый проход — эскалация: пауза-гейт.
    const paused = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    expect(isStepGateOutcome(paused)).toBe(true);
    if (!isStepGateOutcome(paused)) return;
    expect(paused.gate.kind).toBe('tool_approval');
    expect(paused.gate.nodeId).toBe('step1');
    expect(paused.gate.toolName).toBe('noop');
    expect(paused.gate.args).toEqual({ value: 'x' });
    expect(paused.gate.question).toContain('noop');
    // До одобрения тул не вызывается.
    expect(execute).not.toHaveBeenCalled();

    // Возобновление: одобрение оператора — вызов исполняется с правом.
    // Узел исполняется заново (ADR-101 §2.13) — модель снова просит тул.
    const { provider: providerResumed } = makeToolThenFinal(
      toolCallResponse('call_1', 'noop', { value: 'x' }),
    );
    const resumed = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => providerResumed },
        gateDecision: { approved: true },
        gate: {
          kind: 'tool_approval',
          nodeId: 'step1',
          toolName: 'noop',
          args: { value: 'x' },
        },
      }),
    );

    expect(isStepGateOutcome(resumed)).toBe(false);
    if (isStepGateOutcome(resumed)) return;
    expect(resumed.status).toBe('ok');
    expect(execute).toHaveBeenCalledTimes(1);
    // Повторная эскалация `ask` не блокирует: право выдано оператором.
    expect(resumed.output?.text).toBe('готово');
  });

  it('одобрение без данных гейта закрывает первую эскалацию ask', async () => {
    const execute = vi.fn(async (_args: unknown, _ctx: ToolContext) => ({ content: 'ок' }));
    const tool = makeTool('noop', execute);
    const { provider } = makeToolThenFinal(toolCallResponse('call_1', 'noop', { value: 'x' }));
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor({
      toolRegistry: { get: () => tool },
      permissions: { permissionConfig: { rules: { noop: 'ask' }, askTimeoutMs: 1000 } },
    });

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => provider },
        gateDecision: { approved: true },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('resume с отклонением → тул не выполняется, цикл продолжается', async () => {
    const execute = vi.fn(async (_args: unknown, _ctx: ToolContext) => ({ content: 'ок' }));
    const tool = makeTool('noop', execute);
    const { provider, calls } = makeToolThenFinal(
      toolCallResponse('call_1', 'noop', { value: 'x' }),
    );
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor({
      toolRegistry: { get: () => tool },
      permissions: { permissionConfig: { rules: { noop: 'ask' }, askTimeoutMs: 1000 } },
    });

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => provider },
        gateDecision: { approved: false, comment: 'не надо' },
        gate: {
          kind: 'tool_approval',
          nodeId: 'step1',
          toolName: 'noop',
          args: { value: 'x' },
        },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    // Отказ оператора не валит шаг: модель видит отказ и отвечает.
    expect(outcome.status).toBe('ok');
    expect(execute).not.toHaveBeenCalled();
    const toolMessages = (calls[1]?.messages ?? []).filter((msg) => msg.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content.length).toBeGreaterThan(0);
    expect(outcome.output?.toolCalls).toEqual([{ name: 'noop', isError: true }]);
  });

  it('одобрение оператора не обходит deny-политику, если данные гейта неизвестны', async () => {
    const execute = vi.fn(async (_args: unknown, _ctx: ToolContext) => ({ content: 'ок' }));
    const tool = makeTool('noop', execute);
    const { provider } = makeToolThenFinal(toolCallResponse('call_1', 'noop', { value: 'x' }));
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor({
      toolRegistry: { get: () => tool },
      permissions: { permissionConfig: { rules: { noop: 'deny' }, askTimeoutMs: 1000 } },
    });

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => provider },
        // Решение оператора есть, данных гейта нет — отказ по политике прав
        // всё равно действует.
        gateDecision: { approved: true },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');
    expect(execute).not.toHaveBeenCalled();
  });

  it('одобрение относится только к одобренному вызову: другие аргументы — новая эскалация', async () => {
    const execute = vi.fn(async (_args: unknown, _ctx: ToolContext) => ({ content: 'ок' }));
    const tool = makeTool('noop', execute);
    const { provider } = makeProvider(() => toolCallResponse('call_1', 'noop', { value: 'other' }));
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor({
      toolRegistry: { get: () => tool },
      permissions: { permissionConfig: { rules: { noop: 'ask' }, askTimeoutMs: 1000 } },
    });

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => provider },
        gateDecision: { approved: true },
        gate: {
          kind: 'tool_approval',
          nodeId: 'step1',
          toolName: 'noop',
          args: { value: 'x' },
        },
      }),
    );

    // Одобрение было на другой вызов — нужен новый гейт.
    expect(isStepGateOutcome(outcome)).toBe(true);
    if (!isStepGateOutcome(outcome)) return;
    expect(outcome.gate.toolName).toBe('noop');
    expect(execute).not.toHaveBeenCalled();
  });

  it('превышение лимита итераций → шаг failed с pipeline.agent_iterations', async () => {
    const execute = vi.fn(async (_args: unknown, _ctx: ToolContext) => ({ content: 'ок' }));
    const tool = makeTool('noop', execute);
    // Модель бесконечно просит один и тот же тул.
    const { provider, calls } = makeProvider(() => toolCallResponse('call_1', 'noop', {}));
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor({
      toolRegistry: { get: () => tool },
      maxIterations: 3,
    });

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.agent_iterations');
    expect(outcome.error?.message).toBeTruthy();
    // Ровно по лимиту итераций.
    expect(calls).toHaveLength(3);
  });

  it('отмена в ходе цикла прерывает шаг (без зависания)', async () => {
    const controller = new AbortController();
    const tool = makeTool('noop', async () => {
      controller.abort();
      return { content: 'ок' };
    });
    const { provider } = makeProvider(() => toolCallResponse('call_1', 'noop', {}));
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor({ toolRegistry: { get: () => tool } });

    const pending = executor.execute(
      makeCtx(makeNode(), {
        signal: controller.signal,
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    const outcome = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('шаг не прервался')), 2000),
      ),
    ]);

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.cancelled');
  });

  it('в output нет полных выводов тулов и секретов', async () => {
    const secret = 'SUPER-SECRET-VALUE';
    const tool = makeTool('noop', async () => ({ content: `вывод тула: ${secret}` }));
    const { provider } = makeToolThenFinal(toolCallResponse('call_1', 'noop', {}));
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor({ toolRegistry: { get: () => tool } });

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');
    const serialized = JSON.stringify(outcome.output);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('вывод тула');
    // В выходе — текст, расход и сводка вызовов (имя + признак ошибки).
    expect(Object.keys(outcome.output ?? {}).sort()).toEqual(['text', 'toolCalls', 'usage']);
    expect(outcome.output?.toolCalls).toEqual([{ name: 'noop', isError: false }]);
  });

  it('без инфраструктуры инструментов шаг падает с pipeline.agent_unavailable (без падения процесса)', async () => {
    const { provider } = makeToolThenFinal(toolCallResponse('call_1', 'noop', {}));
    const { composer } = makeComposer();
    // Ни реестра инструментов, ни контекста шага — исполнять вызовы нечем.
    const executor = createAgentStepExecutor();

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.agent_unavailable');
  });

  it('тул, которого нет в реестре, не роняет шаг: модель получает отказ и продолжает', async () => {
    const { provider, calls } = makeToolThenFinal(
      toolCallResponse('call_1', 'unknown_tool', {}),
    );
    const { composer } = makeComposer();
    const executor = createAgentStepExecutor({
      toolRegistry: { get: () => undefined },
      permissions: { permissionConfig: { rules: {}, askTimeoutMs: 1000 } },
    });

    const outcome = await executor.execute(
      makeCtx(makeNode(), {
        step: makeStepContext(),
        llm: { composer, resolveProvider: () => provider },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');
    const toolMessages = (calls[1]?.messages ?? []).filter((msg) => msg.role === 'tool');
    expect(toolMessages).toHaveLength(1);
  });
});
