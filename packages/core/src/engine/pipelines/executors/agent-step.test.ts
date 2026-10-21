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
import type { LLMResponse, PipelineNode, ToolDefinition } from '@itphx/synth-shared';

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
function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `тул ${name}`,
    parameters: z.object({ value: z.string().optional() }),
    capabilities: [ToolCapability.SEARCH],
    execute: async () => ({ content: 'ок' }),
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
