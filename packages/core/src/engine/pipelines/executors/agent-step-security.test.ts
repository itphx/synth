/**
 * IPI в агенте пайплайна: результат инструмента шага проходит единый слой
 * фильтрации контента (`engine/security/tool-content.ts`), как в основном ходе
 * и цикле саб-агента.
 *
 * Зависимость `ctx.securityContentFilter` не передана — поведение прежнее
 * (фильтр не применяется, обратная совместимость).
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  LLMResponse,
  PipelineNode,
  SecurityConfig,
  ToolDefinition,
} from '@itphx/synth-shared';
import type { BaseProvider, LLMMessage, SystemPromptInput } from '../../../providers/base.js';
import { DictionaryStore } from '../../router/dictionary-store.js';
import { ToolRegistry } from '../../tools/registry.js';
import type { SystemPromptComposer } from '../../context/composer.js';
import type { PipelineStepContext } from '../step-context.js';
import { isStepGateOutcome, type StepExecutionContext } from '../types.js';
import { createAgentStepExecutor } from './agent-step.js';

function makeProvider(responses: LLMResponse[]): { provider: BaseProvider; calls: LLMMessage[][] } {
  const calls: LLMMessage[][] = [];
  let index = 0;
  return {
    calls,
    provider: {
      model: 'mock-model',
      getProviderName: () => 'mock',
      chat: async (messages: LLMMessage[], _system?: SystemPromptInput): Promise<LLMResponse> => {
        calls.push(messages.map((m) => ({ ...m })));
        const response = responses[Math.min(index, responses.length - 1)]!;
        index += 1;
        return response;
      },
    } as unknown as BaseProvider,
  };
}

function makeComposer(): SystemPromptComposer {
  return {
    compose: async () => ({ system: 'SYSTEM', stablePrefix: 'SYSTEM', blocks: [] }),
  } as unknown as SystemPromptComposer;
}

function makeTool(name: string, content: string): ToolDefinition {
  return {
    name,
    description: name,
    parameters: z.object({ url: z.string().optional() }),
    capabilities: [],
    execute: async () => ({ content }),
  } as unknown as ToolDefinition;
}

function makeNode(): PipelineNode {
  return { id: 'step1', kind: 'agent', agent: 'assistant' };
}

function makeCtx(
  workspace: string,
  overrides: Partial<StepExecutionContext> = {},
): StepExecutionContext {
  const node = makeNode();
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
    step: {
      workspaceReady: true,
      workspace,
      mode: 'act',
      language: 'ru',
      tools: [],
      availableTools: [],
      unavailableTools: [],
      mcpServers: [],
      mcpDecisions: [],
    } satisfies PipelineStepContext,
    ...overrides,
  };
}

const TOOL_CALL: LLMResponse = {
  content: '',
  model: 'mock-model',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  toolCalls: [{
    id: 'call_1',
    type: 'function',
    function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://evil.example' }) },
  }],
};

const FINAL: LLMResponse = {
  content: 'готово',
  model: 'mock-model',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

function security(over: Partial<SecurityConfig['promptInjection']> = {}): SecurityConfig {
  return {
    promptInjection: { enabled: true, wrapContent: true, mode: 'flag', ...over },
  } as unknown as SecurityConfig;
}

describe('IPI в агентском шаге пайплайна', () => {
  it('результат шага оборачивается при переданной зависимости', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-agent-step-security-'));
    try {
      const tool = makeTool('web_fetch', 'обычный ответ сервера');
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(tool);
      const { provider, calls } = makeProvider([TOOL_CALL, FINAL]);
      const executor = createAgentStepExecutor({ toolRegistry });

      const ctx = makeCtx(dir, {
        step: {
          ...makeCtx(dir).step!,
          tools: [tool],
          availableTools: [tool],
        },
        llm: { composer: makeComposer(), resolveProvider: () => provider },
        securityContentFilter: {
          getConfig: () => security(),
          dictionaryStore: new DictionaryStore(join(dir)),
        },
      });

      const outcome = await executor.execute(ctx);
      expect(isStepGateOutcome(outcome)).toBe(false);
      if (isStepGateOutcome(outcome)) return;
      expect(outcome.status).toBe('ok');

      // Второй вызов LLM получил tool-результат уже обёрнутым.
      const toolMessages = calls[1]!.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]!.content).toContain('[CONTENT | SOURCE: web');
      expect(toolMessages[0]!.content).toContain('[CONTENT END]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('без зависимости — контент как есть (поведение прежнее)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-agent-step-security-'));
    try {
      const tool = makeTool('web_fetch', 'обычный ответ сервера');
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(tool);
      const { provider, calls } = makeProvider([TOOL_CALL, FINAL]);
      const executor = createAgentStepExecutor({ toolRegistry });

      const ctx = makeCtx(dir, {
        step: {
          ...makeCtx(dir).step!,
          tools: [tool],
          availableTools: [tool],
        },
        llm: { composer: makeComposer(), resolveProvider: () => provider },
      });

      const outcome = await executor.execute(ctx);
      expect(isStepGateOutcome(outcome)).toBe(false);
      if (isStepGateOutcome(outcome)) return;
      expect(outcome.status).toBe('ok');
      const toolMessages = calls[1]!.filter((m) => m.role === 'tool');
      expect(toolMessages[0]!.content).toBe('обычный ответ сервера');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
