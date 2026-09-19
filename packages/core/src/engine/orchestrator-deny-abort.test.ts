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

/**
 * Провайдер для теста deny + пустой финальный ответ:
 * вызовы 0..2 — execute_shell с опасной командой (deny по системной
 * shell-политике definitions/shell-policy.json), вызов 3 — пустой
 * контент без toolCalls (модель «сдалась» после серии deny).
 */
class MockDenyLoopProvider extends BaseProvider {
  static calls = 0;

  private _next(): { content: string; toolCalls?: Record<string, unknown>[] } {
    if (MockDenyLoopProvider.calls < 3) {
      const n = MockDenyLoopProvider.calls;
      return {
        content: '',
        toolCalls: [{
          id: `call_d${n}`,
          function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'rm -rf /' }) },
        }],
      };
    }
    return { content: '', toolCalls: undefined };
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    const next = this._next();
    MockDenyLoopProvider.calls++;
    return { content: next.content, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: next.toolCalls };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const next = this._next();
    MockDenyLoopProvider.calls++;
    yield { content: next.content, isFinal: true, toolCalls: next.toolCalls, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'mockdenyloop';
  }
}

/**
 * Провайдер для теста abort:
 * вызов 0 — завершённая итерация: текст + execute_shell (deny);
 * вызов 1 — медленный стрим текста, прерывается abort'ом.
 */
class MockAbortProvider extends BaseProvider {
  static calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'x', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const n = MockAbortProvider.calls++;
    if (n === 0) {
      yield {
        content: 'Шаг 1: анализ команды', isFinal: true,
        toolCalls: [{ id: 'call_a0', function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'rm -rf /' }) } }],
        model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      return;
    }
    const parts = ['Полный', ' частичный', ' ответ', ' — модель', ' уже', ' написала', ' это'];
    for (const p of parts) {
      if (ct?.cancelled) return;
      yield { content: p, isFinal: false, model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      await new Promise((r) => setTimeout(r, 10));
    }
    yield { content: 'Конец', isFinal: true, model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  getProviderName(): string {
    return 'mockabort';
  }
}

/**
 * Провайдер, который НЕ отдаёт `model` в промежуточных чанках (как реальные
 * openai/anthropic) — проверка fallback-цепочки модели при отмене (Bug 2):
 * иначе cost_usd не считается, а message.model = null.
 */
class MockAbortNoModelProvider extends BaseProvider {
  static calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'x', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const parts = ['Первая', ' часть', ' ответа'];
    for (const p of parts) {
      if (ct?.cancelled) return;
      yield { content: p, isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      await new Promise((r) => setTimeout(r, 10));
    }
    yield { content: 'конец', isFinal: true, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'mockabortnomodel';
  }
}

/** Провайдер: 3 одинаковых вызова read_file (НЕ deny), затем текст — для проверки сохранения doom loop. */
class MockDoomProvider extends BaseProvider {
  static calls = 0;

  private _next(): { content: string; toolCalls?: Record<string, unknown>[] } {
    if (MockDoomProvider.calls < 3) {
      const n = MockDoomProvider.calls;
      return {
        content: '',
        toolCalls: [{
          id: `call_r${n}`,
          function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'x.txt' }) },
        }],
      };
    }
    return { content: 'Готово' };
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    const next = this._next();
    MockDoomProvider.calls++;
    return { content: next.content, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: next.toolCalls };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const next = this._next();
    MockDoomProvider.calls++;
    yield { content: next.content, isFinal: true, toolCalls: next.toolCalls, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'mockdoom';
  }
}

/** Провайдер: всегда возвращает пустой контент без toolCalls (модель «не ответила»). */
class MockEmptyProvider extends BaseProvider {
  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: '', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { content: '', isFinal: true, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'mockempty';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  eventBus: EventBus;
  tmpDir: string;
  sessionId: string;
}

async function makeHarness(providerName: string): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-deny-abort-'));
  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store);
  const eventBus = new EventBus();
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) => {
      return { name, type: providerName, baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
    },
    toolRegistry: createToolRegistry(),
    permissionConfig: { rules: {}, askTimeoutMs: 1000 } as PermissionConfig,
    defaultWorkingDir: tmpDir,
    contextConfig: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
    // Цены модели 'm' — проверка cost_usd при отмене (Bug 2/3).
    modelPriceLoader: (model: string) => (model === 'm' ? { inputPrice: 1, outputPrice: 2 } : null),
  });
  const session = await sessionManager.createSession({
    title: 'DenyAbort',
    settings: { provider: providerName, model: 'm', systemPrompt: 'test', agentRole: 'developer' },
  });
  const msg = makeMessage();
  await sessionManager.addMessage(session.id, msg);
  return { orchestrator, sessionManager, eventBus, tmpDir, sessionId: session.id };
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

describe('ChatOrchestrator: deny × doom loop + abort (баги фикса)', () => {
  beforeEach(() => {
    ProviderFactory.register('mockdenyloop', MockDenyLoopProvider);
    ProviderFactory.register('mockabort', MockAbortProvider);
    ProviderFactory.register('mockabortnomodel', MockAbortNoModelProvider);
    ProviderFactory.register('mockdoom', MockDoomProvider);
    ProviderFactory.register('mockempty', MockEmptyProvider);
    MockDenyLoopProvider.calls = 0;
    MockAbortProvider.calls = 0;
    MockAbortNoModelProvider.calls = 0;
    MockDoomProvider.calls = 0;
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockdenyloop');
    ProviderFactory['_providers'].delete('mockabort');
    ProviderFactory['_providers'].delete('mockabortnomodel');
    ProviderFactory['_providers'].delete('mockdoom');
    ProviderFactory['_providers'].delete('mockempty');
  });

  it('deny 3+ раза: каждый deny даёт tool_call.result с объяснением политики, без «Цикл прерван»; пустой ответ модели подставлен', async () => {
    const h = await makeHarness('mockdenyloop');
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, new AbortController().signal, (event, data) => chunks.push({ event, data }));
    expect(result.error).toBeUndefined();

    // Все 3 deny-вызова публикуют tool_call.result (в т.ч. 3-й — раньше его глушил doom loop)
    const denyResults = chunks
      .filter((c) => c.event === 'tool_call.result')
      .map((c) => c.data.result as { content: string; isError?: boolean });
    expect(denyResults).toHaveLength(3);
    for (const r of denyResults) {
      expect(r.isError).toBe(true);
      expect(r.content).toContain('Permission denied');
      // Инструкция модели для deny
      expect(r.content).toContain('The action is prohibited by the security policy');
      // Никаких «Цикл прерван» без объяснения
      expect(r.content).not.toContain('Цикл прерван');
    }
    // tool_call.started публикуется и для 3-го вызова
    const starts = chunks.filter((c) => c.event === 'tool_call.started');
    expect(starts).toHaveLength(3);

    // Пустой финальный ответ модели подставлен
    const done = chunks.find((c) => c.event === 'stream.done')!;
    expect(done.data.content).toBe('Could not proceed: the action was blocked by the security policy');
    // AD-070 §2.6: отказ в туле → status 'stopped'.
    expect(done.data.status).toBe('stopped');

    // В истории нет пустого assistant-сообщения
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistant = [...session.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT && !m.metadata?.tool_chain);
    expect(assistant).toBeDefined();
    expect(assistant!.content.length).toBeGreaterThan(0);
    expect(assistant!.content).toContain('Could not proceed');
    expect(assistant!.metadata?.status).toBe('stopped');
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('abort во время генерации после deny: в истории полный текст всех итераций + tool_results с deny', async () => {
    const h = await makeHarness('mockabort');
    const ac = new AbortController();
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    let textChunks = 0;

    const promise = run(h, ac.signal, (event, data) => {
      chunks.push({ event, data });
      // После 2-го текстового чанка незавершённой итерации — стоп
      if (event === 'stream.chunk' && (data as Record<string, unknown>).iteration === 1) {
        textChunks++;
        if (textChunks >= 2) setTimeout(() => ac.abort(), 5);
      }
    });

    const result = await promise;
    expect(result.error).toBeUndefined();

    // stream.cancelled несёт полный накопленный текст (завершённая + текущая итерация)
    const cancelled = chunks.find((c) => c.event === 'stream.cancelled')!;
    const cancelledContent = cancelled.data.content as string;
    expect(cancelledContent).toContain('Шаг 1: анализ команды');
    expect(cancelledContent).toContain('Полный');
    // AD-070 §2.6: отмена → status 'cancelled'.
    expect(cancelled.data.status).toBe('cancelled');

    // Финальное assistant-сообщение содержит полный текст (не обрывок последней итерации)
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistant = [...session.messages].reverse().find(
      (m) => m.role === MessageRole.ASSISTANT && !m.metadata?.tool_chain,
    );
    expect(assistant).toBeDefined();
    expect(assistant!.content).toContain('Шаг 1: анализ команды');
    expect(assistant!.content).toContain('Полный');
    expect(assistant!.content).not.toContain('Конец');
    expect(assistant!.metadata?.status).toBe('cancelled');

    // deny сохранился в tool_results финального сообщения
    const meta = assistant!.metadata as Record<string, unknown>;
    const toolResults = meta.tool_results as Array<{ name: string; result?: { content: string; isError?: boolean } }> | undefined;
    expect(toolResults).toBeDefined();
    expect(toolResults!.length).toBeGreaterThan(0);
    expect(toolResults![0]!.name).toBe('execute_shell');
    expect(toolResults![0]!.result?.isError).toBe(true);
    expect(toolResults![0]!.result?.content).toContain('Permission denied');

    // При отмене blocks НЕ дублируются: они уже вошли в content (иначе UI
    // режима 'bottom' склеил бы их с content повторно)
    expect(meta.intermediate_text_blocks).toBeUndefined();
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  // Bug 2/3/4: провайдер не отдаёт model/usage в промежуточных чанках, отмена
  // до финального чанка — модель берётся из fallback, usage оценивается,
  // stream.cancelled несёт usage/duration/cost.
  it('отмена без model/usage в чанках: fallback модели, оценка usage и cost в сообщении и stream.cancelled', async () => {
    const h = await makeHarness('mockabortnomodel');
    const ac = new AbortController();
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    let textChunks = 0;

    const promise = run(h, ac.signal, (event, data) => {
      chunks.push({ event, data });
      if (event === 'stream.chunk') {
        textChunks++;
        if (textChunks >= 2) setTimeout(() => ac.abort(), 5);
      }
    });

    const result = await promise;
    expect(result.error).toBeUndefined();

    // Bug 3: stream.cancelled несёт статистику, как stream.done.
    const cancelled = chunks.find((c) => c.event === 'stream.cancelled')!;
    expect(cancelled).toBeDefined();
    expect(cancelled.data.model).toBe('m');
    expect(typeof cancelled.data.duration_ms).toBe('number');
    expect(cancelled.data.usage_estimated).toBe(true);
    const eventUsage = cancelled.data.usage as { inputTokens: number; outputTokens: number };
    expect(eventUsage.inputTokens).toBeGreaterThan(0);
    expect(eventUsage.outputTokens).toBeGreaterThan(0);
    expect(typeof cancelled.data.cost_usd).toBe('number');
    expect(cancelled.data.cost_usd as number).toBeGreaterThan(0);

    // Bug 2: сохранённое сообщение получает модель (fallback) и cost_usd.
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistant = [...session.messages].reverse().find(
      (m) => m.role === MessageRole.ASSISTANT && !m.metadata?.tool_chain,
    )!;
    expect(assistant).toBeDefined();
    expect(assistant.model).toBe('m');
    expect(assistant.usage!.inputTokens).toBeGreaterThan(0);
    expect(assistant.metadata?.usage_estimated).toBe(true);
    expect(typeof assistant.metadata?.cost_usd).toBe('number');
    expect(assistant.metadata?.status).toBe('cancelled');

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('doom loop для НЕ-deny повторяющихся вызовов сохранён: 3-й одинаковый вызов не публикует tool_call.result', async () => {
    const h = await makeHarness('mockdoom');
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, new AbortController().signal, (event, data) => chunks.push({ event, data }));
    expect(result.error).toBeUndefined();

    // Первые два вызова read_file выполнились (tool_call.result), третий заглушён doom loop
    const toolResults = chunks.filter((c) => c.event === 'tool_call.result');
    expect(toolResults).toHaveLength(2);

    // Провайдер вызван 4 раза: 3 tool-итерации + финальный текст
    expect(MockDoomProvider.calls).toBe(4);

    // Нормальное завершение текстом
    const done = chunks.find((c) => c.event === 'stream.done')!;
    expect(done.data.content).toBe('Готово');
    expect(done.data.status).toBe('completed');
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('пустой ответ модели без deny — подставляется общий fallback, в истории нет пустого assistant-сообщения', async () => {
    const h = await makeHarness('mockempty');
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, new AbortController().signal, (event, data) => chunks.push({ event, data }));
    expect(result.error).toBeUndefined();

    const done = chunks.find((c) => c.event === 'stream.done')!;
    expect(done.data.content).toBe('Could not complete the request: the model response was empty');
    // AD-070 §2.6: пустой ответ модели → status 'error'.
    expect(done.data.status).toBe('error');

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistant = [...session.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT);
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe('Could not complete the request: the model response was empty');
    expect(assistant!.metadata?.status).toBe('error');
    await rm(h.tmpDir, { recursive: true, force: true });
  });
});

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

/**
 * Провайдер для теста отмены ВО ВРЕМЯ исполнения тула:
 * вызов 0 — текст + slow_tool; вызов 1 — не должен произойти
 * (если баг вернулся, провайдер повиснет до отмены — тест это детектирует).
 */
class MockToolCancelProvider extends BaseProvider {
  static calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: '', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const n = MockToolCancelProvider.calls++;
    if (n === 0) {
      yield {
        content: 'Запускаю долгий тул', isFinal: true,
        toolCalls: [{ id: 'call_slow', function: { name: 'slow_tool', arguments: '{}' } }],
        model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      return;
    }
    // Второй итерации быть не должно: до её начала отмена уже зафиксирована.
    // Если баг вернулся — цикл родителя дойдёт сюда и провайдер повиснет.
    while (!ct?.cancelled) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return;
  }

  getProviderName(): string {
    return 'mocktoolcancel';
  }
}

describe('ChatOrchestrator: отмена во время исполнения тула', () => {
  beforeEach(() => {
    ProviderFactory.register('mocktoolcancel', MockToolCancelProvider);
    MockToolCancelProvider.calls = 0;
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mocktoolcancel');
  });

  it('abort во время тулa: публикуется stream.cancelled (не «ответ модели пуст» через stream.done), tool-chain сохранён', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'synth-tool-cancel-'));
    const store = new FileStore({ dataDir: tmpDir });
    const sessionManager = new SessionManager(store);
    const eventBus = new EventBus();
    const toolRegistry = createToolRegistry();
    toolRegistry.register(makeSlowAbortableTool());
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => {
        return { name, type: 'mocktoolcancel', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
      },
      toolRegistry,
      permissionConfig: { rules: {}, askTimeoutMs: 1000 } as PermissionConfig,
      defaultWorkingDir: tmpDir,
      contextConfig: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
    });
    const session = await sessionManager.createSession({
      title: 'ToolCancel',
      settings: { provider: 'mocktoolcancel', model: 'm', systemPrompt: 'test', agentRole: 'developer' },
    });
    const msg = makeMessage();
    await sessionManager.addMessage(session.id, msg);

    const ac = new AbortController();
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const processMessage = orchestrator.createProcessMessage();
    const fresh = (await sessionManager.getSession(session.id))!;
    const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;

    const promise = processMessage(fresh, userMsg, ac.signal, (event, data) => {
      chunks.push({ event, data });
      // Тул запущен — жмём «Стоп»
      if (event === 'tool_call.started') {
        setTimeout(() => ac.abort(), 10);
      }
    });
    await promise;

    // Сабагент-тул прерван, вторая LLM-итерация не началась
    expect(MockToolCancelProvider.calls).toBe(1);

    // Завершение — как отмена: stream.cancelled, БЕЗ stream.done с «ответ модели пуст»
    const cancelled = chunks.find((c) => c.event === 'stream.cancelled');
    expect(cancelled).toBeDefined();
    expect((cancelled!.data as Record<string, unknown>).stream_id).toBe(
      (msg.metadata as Record<string, unknown>).stream_id,
    );
    expect((cancelled!.data as Record<string, unknown>).status).toBe('cancelled');
    const done = chunks.find((c) => c.event === 'stream.done');
    expect(done).toBeUndefined();

    // Результат тулa опубликован (UI видит, чем тул завершился)
    const toolResult = chunks.find((c) => c.event === 'tool_call.result');
    expect(toolResult).toBeDefined();
    expect(((toolResult!.data as Record<string, unknown>).result as { content: string }).content)
      .toContain('прерван отменой');

    // История: tool-chain сохранён (assistant с toolCalls + tool), без фейкового финала
    const updated = (await sessionManager.getSession(session.id))!;
    const toolMsg = updated.messages.find((m) => m.role === MessageRole.TOOL);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain('прерван отменой');
    const cancelledAssistant = [...updated.messages].reverse().find(
      (m) => m.role === MessageRole.ASSISTANT && !m.metadata?.tool_chain,
    );
    expect(cancelledAssistant).toBeDefined();
    expect(cancelledAssistant!.metadata?.tool_results).toBeDefined();
    expect(cancelledAssistant!.metadata?.status).toBe('cancelled');
    await rm(tmpDir, { recursive: true, force: true });
  });
});
