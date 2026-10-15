/**
 * Тесты фасада `task.ts` (ADR-095, шаг 5) и определения тула `task/tool.ts`:
 * публичный API фасада и делегирование в вынесенные модули.
 *
 * Изолированно: фейковый провайдер, tmp-каталог для промптов; без сети и LLM.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolContext } from '@itphx/synth-shared';
import type { BaseProvider } from '../../../providers/base.js';
import type { AgentRegistry } from '../../agents/registry.js';
import * as facade from '../task.js';
import { taskTool } from './tool.js';
import { runSubagent, SUBAGENT_MAX_ATTEMPTS, SUBAGENT_RETRY_DELAYS_MS } from './run-cycle.js';
import {
  buildSubagentUnavailableToolsSection,
  messageToLLMMessage,
  resolveSubagentPrompt,
} from './prompt.js';
import { publishMessageAdded } from './child-session.js';
import { LLM_MAX_ATTEMPTS, LLM_RETRY_DELAYS_MS } from '../../llm-error.js';
import type { TaskExtra } from './types.js';

function makeAgentRegistry(subagents: string[] = ['explore']): AgentRegistry {
  return {
    get: (id: string) => (subagents.includes(id)
      ? { id, agentMode: ['subagent'], subagentPrompt: 'You are a test subagent.', maxSteps: 1 }
      : undefined),
    getSubagents: () => subagents.map((id) => ({ id })),
    getToolsForAgent: () => [],
  } as unknown as AgentRegistry;
}

function makeProvider(content = 'mock response') {
  const chatAsync = vi.fn(() => (async function* () {
    yield { isFinal: true, content, toolCalls: [] };
  })());
  return {
    provider: { model: 'test-model', name: 'test-provider', chatAsync } as unknown as BaseProvider,
    chatAsync,
  };
}

function makeCtx(extra: Partial<TaskExtra>): ToolContext {
  return {
    sessionId: 'parent-1',
    messageId: 'm1',
    abortSignal: new AbortController().signal,
    workingDir: '/tmp',
    extra: extra as unknown as Record<string, unknown>,
  };
}

describe('task.ts — фасад сохраняет публичный контракт (ADR-095, шаг 5)', () => {
  it('реэкспортирует те же функции/константы, что и модули (импортёры task-resume/index не ломаются)', () => {
    expect(facade.taskTool).toBe(taskTool);
    expect(facade.runSubagent).toBe(runSubagent);
    expect(facade.buildSubagentUnavailableToolsSection).toBe(buildSubagentUnavailableToolsSection);
    expect(facade.messageToLLMMessage).toBe(messageToLLMMessage);
    expect(facade.resolveSubagentPrompt).toBe(resolveSubagentPrompt);
    expect(facade.publishMessageAdded).toBe(publishMessageAdded);
  });

  it('SUBAGENT_MAX_ATTEMPTS / SUBAGENT_RETRY_DELAYS_MS остаются единой LLM-политикой', () => {
    expect(facade.SUBAGENT_MAX_ATTEMPTS).toBe(LLM_MAX_ATTEMPTS);
    expect(facade.SUBAGENT_RETRY_DELAYS_MS).toEqual(LLM_RETRY_DELAYS_MS);
    expect(SUBAGENT_MAX_ATTEMPTS).toBe(3);
    expect(SUBAGENT_RETRY_DELAYS_MS).toEqual([5000, 15000, 30000]);
  });
});

describe('task/tool.ts — определение и ранние отказы', () => {
  it('определение тула: имя, capability TASK, параметры-схема', () => {
    expect(taskTool.name).toBe('task');
    expect(taskTool.capabilities).toContain(ToolCapability.TASK);
    expect(taskTool.parameters.safeParse({ description: 'd', prompt: 'p', subagent_type: 'explore' }).success).toBe(true);
  });

  it('невалидные аргументы → isError с tool.args_error', async () => {
    const result = await taskTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'explore', context_mode: 'bad' },
      makeCtx({}),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('task');
    expect(result.metadata!.i18n).toBeDefined();
  });

  it('нет provider/agentRegistry → task.deps_unavailable', async () => {
    const result = await taskTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      makeCtx({}),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('provider or agent registry unavailable');
  });

  it('неизвестный subagent_type → task.subagent_not_found со списком доступных', async () => {
    const { provider } = makeProvider();
    const result = await taskTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'nope' },
      makeCtx({ provider, agentRegistry: makeAgentRegistry(['explore']) }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"nope"');
    expect(result.content).toContain('explore');
  });

  it('агент без класса subagent → task.subagent_not_allowed', async () => {
    const { provider } = makeProvider();
    const registry = {
      get: () => ({ id: 'main', agentMode: ['primary'], subagentPrompt: '' }),
      getSubagents: () => [],
      getToolsForAgent: () => [],
    } as unknown as AgentRegistry;
    const result = await taskTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'main' },
      makeCtx({ provider, agentRegistry: registry }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('cannot be used as a subagent');
  });
});

describe('task/tool.ts — делегирование в prompt.ts', () => {
  let promptsDir: string;

  beforeEach(async () => {
    promptsDir = await mkdtemp(join(tmpdir(), 'synth-task-tool-'));
    await mkdir(join(promptsDir, 'subagents'), { recursive: true });
    await writeFile(join(promptsDir, 'subagents', 'explore.ru.md'), 'SUBAGENT ROLE PROMPT');
  });

  afterEach(async () => {
    await rm(promptsDir, { recursive: true, force: true });
  });

  it('системный промпт резолвится через prompt.resolveSubagentPrompt и идёт 2-м аргументом chatAsync', async () => {
    const { provider, chatAsync } = makeProvider('ok');
    const result = await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', context_mode: 'none' },
      makeCtx({
        provider,
        agentRegistry: makeAgentRegistry(),
        contextConfig: { systemPromptsDir: promptsDir } as never,
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(chatAsync).toHaveBeenCalledTimes(1);
    const [messages, systemPrompt] = chatAsync.mock.calls[0] as unknown as [Array<{ role: string }>, string];
    expect(systemPrompt).toContain('SUBAGENT ROLE PROMPT');
    // ADR-070 §1.5: system-сообщения в messages нет — только user-промпт.
    expect(messages.map((m) => m.role)).toEqual(['user']);
  });

  it('skip_context_files=true: проектные инструкции не добавляются в промпт', async () => {
    const { provider, chatAsync } = makeProvider('ok');
    await taskTool.execute(
      { description: 'd', prompt: 'go', subagent_type: 'explore', skip_context_files: true },
      makeCtx({
        provider,
        agentRegistry: makeAgentRegistry(),
        projectInstructions: '[PROJECT INSTRUCTIONS]\nSECRET RULES',
      }),
    );

    const [, systemPrompt] = chatAsync.mock.calls[0] as unknown as [unknown, string];
    expect(systemPrompt).not.toContain('SECRET RULES');
  });
});
