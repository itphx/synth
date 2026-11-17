/**
 * Тесты дренажа очереди дочерней сессии (PROP-142 §3):
 * `runSubagentWithQueueDrain` — прогон саб-агента + **ровно один** проход
 * продолжения, если в очереди ребёнка (`pendingMessages`) лежит доставленное
 * сообщение.
 *
 * Покрыто:
 *   • успешный прогон + сообщение в очереди → второй LLM-вызов, сообщение
 *     перенесено в историю, очередь пуста, итоговый результат — от второго
 *     прохода (ровно 2 вызова LLM);
 *   • пустая очередь → один вызов (поведение прежнее);
 *   • провал прогона (`isError`) и «Стоп» (`stopped_by: 'user'`) → очередь
 *     не трогаем, продолжения нет;
 *   • две сообщения в очереди → оба в истории, один повторный проход;
 *   • остаток очереди (сверх потолка) ждёт следующей доставки.
 *
 * Изолированно: фейковые провайдеры/реестры, реальный SessionManager в
 * tmp-каталоге; без сети и LLM.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { MessageRole, generateId, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { ToolContext, ToolDefinition, ToolResult, TokenUsage, Message } from '@itphx/synth-shared';
import type { BaseProvider, CancellationToken, ChatOptions, LLMMessage, SystemPromptInput } from '../../../providers/base.js';
import type { AgentRegistry } from '../../agents/registry.js';
import { FileStore } from '../../../storage/file-store.js';
import { SessionManager } from '../../../sessions/manager.js';
import { ToolRegistry } from '../registry.js';
import {
  runSubagentWithQueueDrain,
  MAX_CHILD_QUEUE_DRAIN,
  type SubagentRunConfig,
} from './run-cycle.js';
import type { TaskExtra } from './types.js';

interface Chunk {
  isFinal: boolean;
  content: string;
  toolCalls?: unknown[];
  usage?: TokenUsage;
  model?: string;
  reasoning?: string;
}

function userMessage(content: string): LLMMessage {
  return {
    id: '', role: 'user', content,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false, pinned: false, branchId: '',
  };
}

function toolCallChunk(name: string, args: Record<string, unknown> = {}, id = 'c1'): Chunk {
  return {
    isFinal: true,
    content: '',
    toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
  };
}

/** Провайдер с пошаговым сценарием: script[i] — чанки i-го вызова (последний повторяется). */
function scriptedProvider(script: Chunk[][]) {
  let calls = 0;
  // Снимок сообщений на момент вызова: массив `messages` в цикле мутируется
  // дальше (инъекции дописываются в него), поэтому смотреть нужно копию.
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

/** Провайдер, бросающий ошибку (счётчик вызовов — для проверки числа попыток). */
function throwingProvider(error: Error, prelude: Chunk[] = []) {
  let calls = 0;
  const chatAsync = vi.fn(() => {
    calls += 1;
    return (async function* () {
      for (const c of prelude) yield c;
      throw error;
    })();
  });
  const provider = { model: 'm', name: 'p', chatAsync } as unknown as BaseProvider;
  return { provider, calls: () => calls };
}

function makeAgentRegistry(): AgentRegistry {
  return {
    get: (id: string) => ({ id, agentMode: ['subagent'], capabilities: [] }),
    getSubagents: () => [],
    getToolsForAgent: () => [],
  } as unknown as AgentRegistry;
}

function makeRegistry(spec: Record<string, () => ToolResult | Promise<ToolResult>>): { registry: ToolRegistry; counters: Record<string, number> } {
  const registry = new ToolRegistry();
  const counters: Record<string, number> = {};
  for (const [name, exec] of Object.entries(spec)) {
    registry.register({
      name,
      description: name,
      parameters: z.object({}).passthrough(),
      capabilities: [],
      execute: async () => {
        counters[name] = (counters[name] ?? 0) + 1;
        return exec();
      },
    } as unknown as ToolDefinition);
  }
  return { registry, counters };
}

let tmpDir: string;
let sessionManager: SessionManager;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-task-queuedrain-'));
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

/** Сообщение обычной очереди ребёнка (`pendingMessages`) — user-реплика. */
function pendingUserMessage(content: string, streamId?: string): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    ...(streamId ? { metadata: { stream_id: streamId } } : {}),
  };
}

/** Родитель + дочерняя сессия (ребёнок) — как их создаёт тул `task`. */
async function makeParentAndChild(): Promise<{ parentId: string; childId: string }> {
  const parent = await sessionManager.createSession({ title: 'P' });
  const child = await sessionManager.createSession({ title: 'C', parentId: parent.id, sessionOrigin: 'subagent' });
  return { parentId: parent.id, childId: child.id };
}

describe('run-cycle — дренаж очереди дочерней сессии (PROP-142 §3)', () => {
  it('успешный прогон + сообщение в очереди: ровно один проход продолжения', async () => {
    const { parentId, childId } = await makeParentAndChild();
    await sessionManager.addPendingMessage(childId, pendingUserMessage('уточнение'));

    const { provider, calls, snapshots } = scriptedProvider([
      [{ isFinal: true, content: 'первый проход', model: 'test-model' }],
      [{ isFinal: true, content: 'второй проход', model: 'test-model' }],
    ]);

    const result = await runSubagentWithQueueDrain(makeConfig({
      extra: makeExtra({ provider, sessionManager, sessionId: parentId }),
      childSessionId: childId,
      parentSessionId: parentId,
    }));

    // Ровно два вызова LLM: первый прогон + один проход продолжения.
    expect(calls()).toBe(2);
    expect(result.isError).toBeFalsy();
    // Итоговый tool_result — от второго прохода.
    expect(result.content).toContain('второй проход');
    expect(result.content).not.toContain('первый проход');

    // Доставленное сообщение ушло в историю ребёнка, очередь пуста.
    const saved = (await sessionManager.getSession(childId))!;
    expect(saved.pendingMessages).toHaveLength(0);
    const delivered = saved.messages.find(
      (m) => m.role === MessageRole.USER && m.content === 'уточнение',
    );
    expect(delivered).toBeDefined();
    expect(delivered!.seq).toBeGreaterThan(0);
    expect(typeof delivered!.ord).toBe('number');

    // Во втором проходе ребёнок видит доставленное сообщение.
    expect(snapshots[1]!.some((m) => m.content === 'уточнение')).toBe(true);
  });

  it('очередь пуста → один вызов LLM (поведение прежнее)', async () => {
    const { parentId, childId } = await makeParentAndChild();
    const { provider, calls } = scriptedProvider([
      [{ isFinal: true, content: 'первый проход', model: 'test-model' }],
      [{ isFinal: true, content: 'второй проход', model: 'test-model' }],
    ]);

    const result = await runSubagentWithQueueDrain(makeConfig({
      extra: makeExtra({ provider, sessionManager, sessionId: parentId }),
      childSessionId: childId,
      parentSessionId: parentId,
    }));

    expect(calls()).toBe(1);
    expect(result.content).toContain('первый проход');
    const saved = (await sessionManager.getSession(childId))!;
    expect(saved.pendingMessages).toHaveLength(0);
  });

  it('провал прогона (isError): очередь не трогаем, продолжения нет', async () => {
    const { parentId, childId } = await makeParentAndChild();
    await sessionManager.addPendingMessage(childId, pendingUserMessage('уточнение'));

    const { provider, calls } = throwingProvider(new Error('401 Unauthorized: invalid api key'));

    const result = await runSubagentWithQueueDrain(makeConfig({
      extra: makeExtra({ provider, sessionManager, sessionId: parentId }),
      childSessionId: childId,
      parentSessionId: parentId,
      retry: { maxRetries: 1, delaysMs: [0] },
    }));

    expect(result.isError).toBe(true);
    expect(calls()).toBe(1);
    const saved = (await sessionManager.getSession(childId))!;
    expect(saved.pendingMessages).toHaveLength(1);
    expect(saved.messages.some((m) => m.role === MessageRole.USER && m.content === 'уточнение')).toBe(false);
  });

  it('«Стоп» (stopped_by=user): очередь не трогаем, продолжения нет', async () => {
    const { parentId, childId } = await makeParentAndChild();
    await sessionManager.addPendingMessage(childId, pendingUserMessage('уточнение'));

    const ac = new AbortController();
    const { provider, calls } = scriptedProvider([[toolCallChunk('noop')]]);
    const { registry } = makeRegistry({
      noop: () => {
        ac.abort();
        return { content: 'ok' };
      },
    });

    const result = await runSubagentWithQueueDrain(makeConfig({
      maxSteps: 2,
      extra: makeExtra({ provider, sessionManager, sessionId: parentId, toolRegistry: registry }),
      childSessionId: childId,
      parentSessionId: parentId,
      ctx: makeCtx({ abortSignal: ac.signal }),
    }));

    expect(calls()).toBe(1);
    expect(result.metadata!.stopped_by).toBe('user');
    const saved = (await sessionManager.getSession(childId))!;
    expect(saved.pendingMessages).toHaveLength(1);
    expect(saved.messages.some((m) => m.role === MessageRole.USER && m.content === 'уточнение')).toBe(false);
  });

  it('две сообщения в очереди → оба в истории, один повторный проход', async () => {
    const { parentId, childId } = await makeParentAndChild();
    await sessionManager.addPendingMessage(childId, pendingUserMessage('первое уточнение'));
    await sessionManager.addPendingMessage(childId, pendingUserMessage('второе уточнение'));

    const { provider, calls } = scriptedProvider([
      [{ isFinal: true, content: 'первый проход', model: 'test-model' }],
      [{ isFinal: true, content: 'второй проход', model: 'test-model' }],
    ]);

    const result = await runSubagentWithQueueDrain(makeConfig({
      extra: makeExtra({ provider, sessionManager, sessionId: parentId }),
      childSessionId: childId,
      parentSessionId: parentId,
    }));

    expect(calls()).toBe(2);
    expect(result.content).toContain('второй проход');
    const saved = (await sessionManager.getSession(childId))!;
    expect(saved.pendingMessages).toHaveLength(0);
    const delivered = saved.messages.filter((m) => m.role === MessageRole.USER);
    expect(delivered.map((m) => m.content)).toEqual(['первое уточнение', 'второе уточнение']);
  });

  it('остаток очереди (сверх потолка) ждёт следующей доставки', async () => {
    const { parentId, childId } = await makeParentAndChild();
    for (let i = 0; i < MAX_CHILD_QUEUE_DRAIN + 1; i++) {
      await sessionManager.addPendingMessage(childId, pendingUserMessage(`m-${i}`), MAX_CHILD_QUEUE_DRAIN + 1);
    }

    const { provider, calls } = scriptedProvider([
      [{ isFinal: true, content: 'первый проход', model: 'test-model' }],
      [{ isFinal: true, content: 'второй проход', model: 'test-model' }],
    ]);

    await runSubagentWithQueueDrain(makeConfig({
      extra: makeExtra({ provider, sessionManager, sessionId: parentId }),
      childSessionId: childId,
      parentSessionId: parentId,
    }));

    // Один проход продолжения, несмотря на остаток в очереди.
    expect(calls()).toBe(2);
    const saved = (await sessionManager.getSession(childId))!;
    expect(saved.pendingMessages).toHaveLength(1);
    expect(saved.pendingMessages[0]!.content).toBe(`m-${MAX_CHILD_QUEUE_DRAIN}`);
    const delivered = saved.messages.filter((m) => m.role === MessageRole.USER);
    expect(delivered).toHaveLength(MAX_CHILD_QUEUE_DRAIN);
  });

  it('без дочерней сессии дренажа нет (один вызов LLM)', async () => {
    const { provider, calls } = scriptedProvider([
      [{ isFinal: true, content: 'первый проход', model: 'test-model' }],
      [{ isFinal: true, content: 'второй проход', model: 'test-model' }],
    ]);

    const result = await runSubagentWithQueueDrain(makeConfig({
      extra: makeExtra({ provider }),
    }));

    expect(calls()).toBe(1);
    expect(result.content).toContain('первый проход');
  });
});
