/**
 * ADR-030 Этап 2b: эмиты жизненного цикла агента из оркестратора.
 *
 * Проверяем:
 * - `pre_tool_use` вызывается до исполнения тула, а `{block:true}` его отменяет
 *   (модель получает ошибку-результат `hook.blocked`, тул не исполняется);
 * - `post_tool_use` эмитится с `duration` и `output`;
 * - при отсутствии обработчиков поведение прежнее (тул исполняется, результат
 *   не содержит `hook.blocked`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ChatOrchestrator } from './orchestrator.js';
import { HookBus } from './hooks/hook-bus.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import { createToolRegistry } from './tools/index.js';
import { generateId, MessageRole, nowISO, makeTextPart, ToolCapability } from '@itphx/synth-shared';
import type { Message, ToolDefinition } from '@itphx/synth-shared';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeUserMessage(): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart('выполни hook_echo')],
    content: 'выполни hook_echo',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

/** Провайдер: шаг 0 — tool_call (имя/аргументы из статики), шаг 1+ — финальный текст. */
class HookScriptProvider extends BaseProvider {
  static calls = 0;
  static toolName = 'hook_echo';
  static toolArgs: Record<string, unknown> = { value: 'x' };
  static finalText = 'Готово';

  private _next(): { content: string; toolCalls?: Record<string, unknown>[] } {
    if (HookScriptProvider.calls++ === 0) {
      return {
        content: '',
        toolCalls: [{
          id: 'call_h0',
          function: {
            name: HookScriptProvider.toolName,
            arguments: JSON.stringify(HookScriptProvider.toolArgs),
          },
        }],
      };
    }
    return { content: HookScriptProvider.finalText };
  }

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    const next = this._next();
    return { content: next.content, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: next.toolCalls };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: unknown,
    _tools?: Array<Record<string, unknown>>,
    _debugCollector?: unknown,
    _ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const next = this._next();
    yield { content: next.content, isFinal: true, toolCalls: next.toolCalls, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'hookscript';
  }
}

let executed: number;

function makeEchoTool(): ToolDefinition {
  return {
    name: 'hook_echo',
    description: 'echo tool for hook tests',
    parameters: z.object({ value: z.string().optional() }),
    capabilities: [ToolCapability.RUNTIME],
    async execute(_args) {
      executed++;
      return { content: 'echo-result', metadata: { echoed: true } };
    },
  };
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  toolRegistry: ReturnType<typeof createToolRegistry>;
  tmpDir: string;
  sessionId: string;
}

interface HarnessOptions {
  /** Доп. поля/переопределения пользовательского сообщения сессии. */
  message?: Partial<Message>;
  /** Доп. инструменты (регистрируются поверх встроенных). */
  tools?: ToolDefinition[];
}

async function makeHarness(hooks: HookBus | undefined, opts: HarnessOptions = {}): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-hooks-'));
  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store, {});
  const toolRegistry = createToolRegistry();
  toolRegistry.register(makeEchoTool());
  for (const tool of opts.tools ?? []) toolRegistry.register(tool);
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus: new EventBus(),
    hooks,
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) => {
      return { name, type: 'hookscript', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
    },
    toolRegistry,
    defaultWorkingDir: tmpDir,
  });
  const session = await sessionManager.createSession({
    title: 'Hooks',
    settings: { provider: 'hookscript', model: 'm', systemPrompt: 'test' },
  });
  await sessionManager.addMessage(session.id, { ...makeUserMessage(), ...(opts.message ?? {}) });
  return { orchestrator, sessionManager, toolRegistry, tmpDir, sessionId: session.id };
}

async function run(h: Harness, attempt?: number): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
  const processMessage = h.orchestrator.createProcessMessage();
  const fresh = (await h.sessionManager.getSession(h.sessionId))!;
  const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
  await processMessage(fresh, userMsg, new AbortController().signal, (event, data) => chunks.push({ event, data }), attempt);
  return chunks;
}

function toolResults(chunks: Array<{ event: string; data: Record<string, unknown> }>): Array<{ content: string; isError?: boolean }> {
  return chunks.filter((c) => c.event === 'tool_call.result').map((c) => c.data.result as { content: string; isError?: boolean });
}

describe('ChatOrchestrator — ADR-030 hooks (Этап 2b)', () => {
  beforeEach(() => {
    ProviderFactory.register('hookscript', HookScriptProvider);
    HookScriptProvider.calls = 0;
    HookScriptProvider.toolName = 'hook_echo';
    HookScriptProvider.toolArgs = { value: 'x' };
    HookScriptProvider.finalText = 'Готово';
    executed = 0;
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('hookscript');
  });

  it('pre_tool_use вызывается; {block:true} предотвращает исполнение тула и даёт hook.blocked', async () => {
    const hooks = new HookBus();
    const calls: Array<{ tool: string; agent?: string }> = [];
    const post: Array<{ tool: string }> = [];
    hooks.on('pre_tool_use', (ctx) => {
      calls.push({ tool: ctx.tool, agent: ctx.agent });
      return { block: true, reason: 'test-block' };
    });
    hooks.on('post_tool_use', (ctx) => { post.push({ tool: ctx.tool }); }, { mode: 'async' });

    const h = await makeHarness(hooks);
    const chunks = await run(h);

    // Хук вызван один раз до исполнения, с именем тула.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('hook_echo');

    // Тул не исполнен.
    expect(executed).toBe(0);

    // post_tool_use НЕ эмитится: тул не выполнялся.
    expect(post).toHaveLength(0);

    // Модель получила ошибку-результат с текстом hook.blocked.
    const results = toolResults(chunks);
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.content).toContain('pre_tool_use');
    expect(results[0]!.content).toContain('test-block');

    // Цикл продолжился — модель ответила финальным текстом.
    const done = chunks.find((c) => c.event === 'stream.done');
    expect(done?.data.content).toBe('Готово');

    // В истории — tool-сообщение с hook.blocked (обратная связь модели).
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const toolMsg = session.messages.find((m) => m.role === MessageRole.TOOL);
    expect(toolMsg?.content).toContain('test-block');

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('post_tool_use эмитится с duration и output', async () => {
    const hooks = new HookBus();
    const post: Array<{ tool: string; duration: number; output?: unknown }> = [];
    hooks.on('post_tool_use', (ctx) => {
      post.push({ tool: ctx.tool, duration: ctx.duration, output: ctx.output });
    }, { mode: 'async' });

    const h = await makeHarness(hooks);
    await run(h);
    // emitAsync — fire-and-forget: ждём наблюдаемого факта (post-хук выполнен),
    // а не фиксированную паузу.
    await vi.waitFor(() => {
      expect(post).toHaveLength(1);
    });

    expect(executed).toBe(1);
    expect(post).toHaveLength(1);
    expect(post[0]!.tool).toBe('hook_echo');
    expect(typeof post[0]!.duration).toBe('number');
    expect(post[0]!.duration).toBeGreaterThanOrEqual(0);
    expect(post[0]!.output).toBeDefined();

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('deny прав не эмитит post_tool_use, но эмитит permission_denied', async () => {
    HookScriptProvider.toolName = 'execute_shell';
    HookScriptProvider.toolArgs = { command: 'rm -rf /' };
    const hooks = new HookBus();
    const post: string[] = [];
    const denied: string[] = [];
    hooks.on('post_tool_use', (ctx) => { post.push(ctx.tool); }, { mode: 'async' });
    hooks.on('permission_denied', (ctx) => { denied.push(ctx.tool); }, { mode: 'async' });

    const h = await makeHarness(hooks);
    const chunks = await run(h);
    // Ждём наблюдаемого факта: permission_denied эмитится (post_tool_use — нет).
    await vi.waitFor(() => {
      expect(denied).toHaveLength(1);
    });

    const results = toolResults(chunks);
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    // Тул не исполнялся — post_tool_use молчит; отказ фиксирует permission_denied.
    expect(post).toHaveLength(0);
    expect(denied[0]).toBe('execute_shell');

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('при отсутствии обработчиков поведение прежнее: тул исполняется, hook.blocked нет', async () => {
    const h = await makeHarness(new HookBus());
    const chunks = await run(h);

    expect(executed).toBe(1);
    const results = toolResults(chunks);
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBeFalsy();
    expect(results[0]!.content).not.toContain('Hook "pre_tool_use" blocked');

    const done = chunks.find((c) => c.event === 'stream.done');
    expect(done?.data.content).toBe('Готово');

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('без переданного hooks (undefined) поведение прежнее', async () => {
    const h = await makeHarness(undefined);
    const chunks = await run(h);
    expect(executed).toBe(1);
    expect(toolResults(chunks)).toHaveLength(1);
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  // --- ADR-030 (Ф0 ADR-090): message_received ---

  it('message_received: один эмит на сообщение, payload без текста сообщения', async () => {
    const hooks = new HookBus();
    const received: Array<Record<string, unknown>> = [];
    hooks.on('message_received', (ctx) => { received.push(ctx as unknown as Record<string, unknown>); }, { mode: 'async' });

    const h = await makeHarness(hooks);
    await run(h);

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]).toMatchObject({ sessionId: h.sessionId, kind: 'user', mode: 'act' });
    // Текст диалога в хук не уходит (риск утечки) — только метаданные.
    expect(received[0]).not.toHaveProperty('text');
    expect(received[0]).not.toHaveProperty('content');
    expect(JSON.stringify(received[0])).not.toContain('выполни hook_echo');

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('message_received: ретрай (attempt > 1) не дублирует эмит', async () => {
    const hooks = new HookBus();
    const received: Array<Record<string, unknown>> = [];
    hooks.on('message_received', (ctx) => { received.push(ctx as unknown as Record<string, unknown>); }, { mode: 'async' });

    const h = await makeHarness(hooks);
    await run(h);
    await run(h, 2);

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    // Даём микротаскам второй попытки выполниться — второго эмита нет.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('message_received не эмитится без подписчиков', async () => {
    const hooks = new HookBus();
    const spy = vi.spyOn(hooks, 'emitAsync');

    const h = await makeHarness(hooks);
    await run(h);

    expect(spy.mock.calls.some(([name]) => name === 'message_received')).toBe(false);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('message_received: внешнее событие → kind external + source', async () => {
    const hooks = new HookBus();
    const received: Array<Record<string, unknown>> = [];
    hooks.on('message_received', (ctx) => { received.push(ctx as unknown as Record<string, unknown>); }, { mode: 'async' });

    const h = await makeHarness(hooks, {
      message: { metadata: { stream_id: generateId(), source: 'webhook', event_id: 'evt_1' } },
    });
    await run(h);

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]).toMatchObject({ sessionId: h.sessionId, kind: 'external', source: 'webhook' });

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('message_received: сообщение Scheduler → kind scheduler', async () => {
    const hooks = new HookBus();
    const received: Array<Record<string, unknown>> = [];
    hooks.on('message_received', (ctx) => { received.push(ctx as unknown as Record<string, unknown>); }, { mode: 'async' });

    const h = await makeHarness(hooks, {
      message: {
        author: 'Scheduler',
        metadata: { stream_id: generateId(), scheduler: true, schedule_id: 'sch_1', schedule_name: 'nightly' },
      },
    });
    await run(h);

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]).toMatchObject({ kind: 'scheduler' });

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  // --- ADR-030 (Ф0 ADR-090): plan_rejected ---

  it('plan_rejected: неудачный plan_exit эмитит план-отклонение и не эмитит plan_approved', async () => {
    ProviderFactory.register('hookscript', HookScriptProvider);
    HookScriptProvider.calls = 0;
    HookScriptProvider.toolName = 'plan_exit';
    HookScriptProvider.toolArgs = {};

    const hooks = new HookBus();
    const rejected: Array<{ sessionId: string; reason?: string }> = [];
    const approved: unknown[] = [];
    hooks.on('plan_rejected', (ctx) => { rejected.push(ctx); }, { mode: 'async' });
    hooks.on('plan_approved', (ctx) => { approved.push(ctx); }, { mode: 'async' });

    const failingPlanExit: ToolDefinition = {
      name: 'plan_exit',
      description: 'plan_exit, всегда падающий (тест ветки отказа)',
      parameters: z.object({}),
      capabilities: [ToolCapability.RUNTIME],
      async execute() {
        throw new Error('plan not ready');
      },
    };

    const h = await makeHarness(hooks, { tools: [failingPlanExit] });
    await run(h);

    await vi.waitFor(() => {
      expect(rejected).toHaveLength(1);
    });
    expect(rejected[0]).toMatchObject({ sessionId: h.sessionId, reason: 'plan_exit_failed' });
    expect(approved).toHaveLength(0);

    await rm(h.tmpDir, { recursive: true, force: true });
  });
});
