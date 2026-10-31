/**
 * ADR-118 §4 (аддитивно): `step.tools.started` / `step.tools.finished` —
 * исполнение инструментов шага.
 *
 * `step.finished` остаётся «вызов LLM завершён»; новые события явно говорят
 * UI, что шаг ещё работает (идут инструменты его вызовов), и снимают
 * смысловой разрыв «шаг `completed`, а тулы ещё работают».
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
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

type ScriptStep = { content: string; toolCalls?: Record<string, unknown>[] };

/** Провайдер со сценарием: каждый вызов `chatAsync` отдаёт один шаг. */
class ScriptProvider extends BaseProvider {
  static script: ScriptStep[] = [];
  static calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    const step = ScriptProvider.script[Math.min(ScriptProvider.calls, ScriptProvider.script.length - 1)]!;
    ScriptProvider.calls++;
    return {
      content: step.content,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: step.toolCalls,
    };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const step = ScriptProvider.script[Math.min(ScriptProvider.calls, ScriptProvider.script.length - 1)]!;
    ScriptProvider.calls++;
    yield {
      content: step.content,
      isFinal: true,
      toolCalls: step.toolCalls,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'step-tools-script';
  }
}

/** Тул, который «работает», пока его не прервут через ctx.abortSignal. */
function makeSlowAbortableTool(): ToolDefinition {
  return {
    name: 'slow_tool',
    description: 'тестовый долгий тул — завершается при отмене',
    parameters: z.object({}),
    capabilities: [ToolCapability.RUNTIME],
    async execute(_args: Record<string, unknown>, ctx: { abortSignal?: AbortSignal }) {
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal?.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { content: 'slow_tool: прерван отменой' };
    },
  } as unknown as ToolDefinition;
}

/** Мгновенный тул с заданным результатом. */
function makeEchoTool(name: string): ToolDefinition {
  return {
    name,
    description: `echo ${name}`,
    parameters: z.object({}).passthrough(),
    capabilities: [ToolCapability.RUNTIME],
    async execute() {
      return { content: `${name}: ok` };
    },
  } as unknown as ToolDefinition;
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  sessionId: string;
  tmpDir: string;
}

async function makeHarness(extraTools: ToolDefinition[] = []): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-step-tools-'));
  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store);
  const eventBus = new EventBus();
  const toolRegistry = createToolRegistry();
  for (const tool of extraTools) toolRegistry.register(tool);
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) => {
      return { name, type: 'step-tools-script', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
    },
    toolRegistry,
    permissionConfig: { rules: {}, askTimeoutMs: 1000 } as PermissionConfig,
    defaultWorkingDir: tmpDir,
    contextConfig: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
  });
  const session = await sessionManager.createSession({
    title: 'StepTools',
    settings: { provider: 'step-tools-script', model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
  });
  await sessionManager.addMessage(session.id, makeMessage());
  return { orchestrator, sessionManager, sessionId: session.id, tmpDir };
}

async function run(
  h: Harness,
  signal: AbortSignal,
  publishChunk: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const processMessage = h.orchestrator.createProcessMessage();
  const fresh = (await h.sessionManager.getSession(h.sessionId))!;
  const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
  await processMessage(fresh, userMsg, signal, publishChunk);
}

/** Счётчик успешных вызовов идемпотентной записи `metadata.tool_results`. */
function countPersistCalls(h: Harness): { count: () => number } {
  let count = 0;
  const target = h.orchestrator as unknown as {
    _persistStepToolResults: (...args: unknown[]) => Promise<unknown>;
  };
  const original = target._persistStepToolResults.bind(h.orchestrator);
  target._persistStepToolResults = async (...args: unknown[]) => {
    const result = await original(...args);
    count++;
    return result;
  };
  return { count: () => count };
}

function withIndex(
  chunks: Array<{ event: string; data: Record<string, unknown> }>,
  event: string,
): Array<{ index: number; data: Record<string, unknown> }> {
  return chunks
    .map((c, index) => ({ index, event: c.event, data: c.data }))
    .filter((c) => c.event === event)
    .map(({ index, data }) => ({ index, data }));
}

describe('ADR-118 §4: step.tools.started / step.tools.finished', () => {
  beforeEach(() => {
    ProviderFactory.register('step-tools-script', ScriptProvider);
    ScriptProvider.calls = 0;
    ScriptProvider.script = [];
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('step-tools-script');
  });

  it('шаг с двумя вызовами: started до первого tool_call.started, finished после metadata.tool_results, callIds совпадают', async () => {
    ScriptProvider.script = [
      {
        content: 'Шаг 1: два вызова',
        toolCalls: [
          { id: 'call_a', function: { name: 'echo_a', arguments: '{}' } },
          { id: 'call_b', function: { name: 'echo_b', arguments: '{}' } },
        ],
      },
      { content: 'Готово' },
    ];
    const h = await makeHarness([makeEchoTool('echo_a'), makeEchoTool('echo_b')]);
    const persisted = countPersistCalls(h);

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const persistedAtFinished: number[] = [];
    await run(h, new AbortController().signal, (event, data) => {
      chunks.push({ event, data });
      if (event === 'step.tools.finished') persistedAtFinished.push(persisted.count());
    });

    const started = withIndex(chunks, 'step.tools.started');
    const finished = withIndex(chunks, 'step.tools.finished');
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);

    // `callIds` — в порядке модели; шаг/ход/сообщение — те же, что у шага.
    expect(started[0]!.data.callIds).toEqual(['call_a', 'call_b']);
    expect(finished[0]!.data.callIds).toEqual(['call_a', 'call_b']);
    expect(started[0]!.data.stepIndex).toBe(0);
    expect(started[0]!.data.turnId).toBe(finished[0]!.data.turnId);
    expect(started[0]!.data.messageId).toBe(finished[0]!.data.messageId);

    // `started` — до исполнения (первый `tool_call.started` этого шага).
    const firstToolStarted = withIndex(chunks, 'tool_call.started')[0]!;
    expect(started[0]!.index).toBeLessThan(firstToolStarted.index);

    // `finished` — после записи `metadata.tool_results` и после результатов вызовов.
    expect(persistedAtFinished).toEqual([1]);
    const lastToolResult = withIndex(chunks, 'tool_call.result').at(-1)!;
    expect(finished[0]!.index).toBeGreaterThan(lastToolResult.index);

    // Запись действительно содержит оба вызова шага.
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const stepMessage = session.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) > 0,
    );
    const toolResults = stepMessage?.metadata?.tool_results as Array<{ id: string }> | undefined;
    expect(toolResults?.map((r) => r.id)).toEqual(['call_a', 'call_b']);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('отмена во время тула: step.tools.finished публикуется ровно один раз', async () => {
    ScriptProvider.script = [
      {
        content: 'Запускаю долгий тул',
        toolCalls: [{ id: 'call_slow', function: { name: 'slow_tool', arguments: '{}' } }],
      },
      { content: 'не должно выполниться' },
    ];
    const h = await makeHarness([makeSlowAbortableTool()]);
    const ac = new AbortController();
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];

    await run(h, ac.signal, (event, data) => {
      chunks.push({ event, data });
      if (event === 'tool_call.started') setTimeout(() => ac.abort(), 10);
    });

    const started = withIndex(chunks, 'step.tools.started');
    const finished = withIndex(chunks, 'step.tools.finished');
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(finished[0]!.data.callIds).toEqual(['call_slow']);
    // Отмена зафиксирована как отмена хода, а не «ответ модели пуст».
    expect(chunks.some((c) => c.event === 'stream.cancelled')).toBe(true);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('шаг без вызовов: событий step.tools.* нет', async () => {
    ScriptProvider.script = [{ content: 'Просто текст без вызовов' }];
    const h = await makeHarness();
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    await run(h, new AbortController().signal, (event, data) => chunks.push({ event, data }));

    expect(withIndex(chunks, 'step.tools.started')).toHaveLength(0);
    expect(withIndex(chunks, 'step.tools.finished')).toHaveLength(0);
    // Обычный шаг при этом полностью описан.
    expect(withIndex(chunks, 'step.started')).toHaveLength(1);
    expect(withIndex(chunks, 'step.finished')).toHaveLength(1);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('turn.finished публикуется после step.tools.finished', async () => {
    ScriptProvider.script = [
      {
        content: 'Шаг 1',
        toolCalls: [{ id: 'call_a', function: { name: 'echo_a', arguments: '{}' } }],
      },
      { content: 'Готово' },
    ];
    const h = await makeHarness([makeEchoTool('echo_a')]);
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    await run(h, new AbortController().signal, (event, data) => chunks.push({ event, data }));

    const finished = withIndex(chunks, 'step.tools.finished');
    expect(finished).toHaveLength(1);
    // Финальный шаг без вызовов событий инструментов не даёт; ход закрывается
    // позже — после завершения инструментов.
    expect(finished[0]!.data.stepIndex).toBe(0);
    const turnFinished = withIndex(chunks, 'turn.finished')[0]!;
    expect(turnFinished.index).toBeGreaterThan(finished[0]!.index);

    await rm(h.tmpDir, { recursive: true, force: true });
  });
});
