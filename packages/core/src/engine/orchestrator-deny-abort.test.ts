import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { createToolRegistry } from './tools/index.js';
import { ContextConfig } from './context/config.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import type { PermissionConfig } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
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
    ProviderFactory.register('mockdoom', MockDoomProvider);
    ProviderFactory.register('mockempty', MockEmptyProvider);
    MockDenyLoopProvider.calls = 0;
    MockAbortProvider.calls = 0;
    MockDoomProvider.calls = 0;
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockdenyloop');
    ProviderFactory['_providers'].delete('mockabort');
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
      expect(r.content).toContain('Действие запрещено политикой безопасности');
      // Никаких «Цикл прерван» без объяснения
      expect(r.content).not.toContain('Цикл прерван');
    }
    // tool_call.started публикуется и для 3-го вызова
    const starts = chunks.filter((c) => c.event === 'tool_call.started');
    expect(starts).toHaveLength(3);

    // Пустой финальный ответ модели подставлен
    const done = chunks.find((c) => c.event === 'stream.done')!;
    expect(done.data.content).toBe('Не удалось выполнить: действие заблокировано политикой безопасности');

    // В истории нет пустого assistant-сообщения
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistant = [...session.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT && !m.metadata?.tool_chain);
    expect(assistant).toBeDefined();
    expect(assistant!.content.length).toBeGreaterThan(0);
    expect(assistant!.content).toContain('Не удалось выполнить');
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

    // Финальное assistant-сообщение содержит полный текст (не обрывок последней итерации)
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistant = [...session.messages].reverse().find(
      (m) => m.role === MessageRole.ASSISTANT && !m.metadata?.tool_chain,
    );
    expect(assistant).toBeDefined();
    expect(assistant!.content).toContain('Шаг 1: анализ команды');
    expect(assistant!.content).toContain('Полный');
    expect(assistant!.content).not.toContain('Конец');

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
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('пустой ответ модели без deny — подставляется общий fallback, в истории нет пустого assistant-сообщения', async () => {
    const h = await makeHarness('mockempty');
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, new AbortController().signal, (event, data) => chunks.push({ event, data }));
    expect(result.error).toBeUndefined();

    const done = chunks.find((c) => c.event === 'stream.done')!;
    expect(done.data.content).toBe('Не удалось выполнить запрос: ответ модели пуст');

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistant = [...session.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT);
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe('Не удалось выполнить запрос: ответ модели пуст');
    await rm(h.tmpDir, { recursive: true, force: true });
  });
});
