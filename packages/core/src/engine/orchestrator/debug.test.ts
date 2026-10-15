/**
 * ADR-095 (шаг 6a): собственные тесты debug-системного сообщения (ADR-070 §2.6).
 *
 * Контракты:
 *  - провайдер недоступен → `provider_not_found` без стрима и сохранения;
 *  - успешный прогон: `stream.chunk` (agent_role=debug) → debug-сообщение
 *    (`role=debug`, `skipEvent`) → `stream.done` с `metadata.type`;
 *  - системный промпт и user-реплика зависят от языка сессии;
 *  - отмена на середине стрима → `stream.cancelled` без сохранения;
 *  - ошибка стрима → единый `handleLlmFailure` с контекстом `debug`;
 *  - cancel-токен всегда убирается из реестра (успех/отмена/ошибка).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { BusEvent, LLMChunk, Message, TokenUsage } from '@itphx/synth-shared';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { EventBus } from '../../events/bus.js';
import { DebugCollector } from '../../debug.js';
import { BaseProvider } from '../../providers/base.js';
import type { CancellationToken, LLMMessage, SystemPromptInput } from '../../providers/base.js';
import { saveAssistantMessage, type SaveAssistantMessageFn } from './persistence.js';
import { handleDebugSystemMessage, type DebugSystemMessageDeps } from './debug.js';

const USAGE: TokenUsage = { inputTokens: 11, outputTokens: 7, totalTokens: 18 };

class DebugProvider extends BaseProvider {
  static chunks: LLMChunk[] = [];
  static error: Error | null = null;
  static onChunk: (() => void) | null = null;
  /** Последний полученный запрос — чтобы проверять промпты без spyOn генератора. */
  static lastMessages: LLMMessage[] = [];
  static lastSystemPrompt: SystemPromptInput | undefined = undefined;

  async chat(): Promise<never> {
    throw new Error('chat не используется debug-путём');
  }

  async *chatAsync(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
  ): AsyncGenerator<LLMChunk> {
    DebugProvider.lastMessages = messages;
    DebugProvider.lastSystemPrompt = systemPrompt;
    for (const chunk of DebugProvider.chunks) {
      yield chunk;
      DebugProvider.onChunk?.();
    }
    if (DebugProvider.error) throw DebugProvider.error;
  }

  getProviderName(): string {
    return 'debug-provider';
  }
}

describe('handleDebugSystemMessage', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let events: BusEvent[];
  let unsubscribe: () => void;
  let published: Array<{ event: string; data: Record<string, unknown> }>;
  let debugCollector: DebugCollector;
  let cancellationTokens: Map<string, CancellationToken>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-debug-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    events = [];
    unsubscribe = eventBus.subscribeAll((e) => events.push(e));
    published = [];
    debugCollector = new DebugCollector(false);
    cancellationTokens = new Map();
    DebugProvider.chunks = [];
    DebugProvider.error = null;
    DebugProvider.onChunk = null;
    DebugProvider.lastMessages = [];
    DebugProvider.lastSystemPrompt = undefined;
  });

  afterEach(async () => {
    unsubscribe();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeSession(language?: string): Promise<string> {
    const session = await sessionManager.createSession({
      title: 'Dbg',
      settings: { provider: 'debug-provider', ...(language ? { language } : {}) } as never,
    });
    return session.id;
  }

  function makeMessage(): Message {
    return {
      id: generateId(),
      role: MessageRole.SYSTEM,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart('debug')],
      content: 'debug',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      metadata: { type: 'debug_system_message', stream_id: 'stream1' },
      provider: 'debug-provider',
    };
  }

  function publish() {
    return (event: string, data: Record<string, unknown>) => published.push({ event, data });
  }

  function makeDeps(overrides: Partial<DebugSystemMessageDeps> = {}): DebugSystemMessageDeps {
    return {
      getProvider: vi.fn(() => new DebugProvider({ url: '', apiKey: '', model: 'debug-model', type: 'debug-provider' })) as never,
      cancellationTokens,
      handleLlmFailure: vi.fn(async () => ({ error: 'stream failed', errorType: 'network_error', canRetry: true })) as never,
      estimatePromptChars: vi.fn(() => 321),
      computeMessageCost: vi.fn(() => null),
      saveAssistantMessage: vi.fn(async (...args: Parameters<SaveAssistantMessageFn>) => {
        return saveAssistantMessage(
          { sessionManager, eventBus, obfMapStore: null, modelPriceLoader: null },
          ...args,
        );
      }) as unknown as SaveAssistantMessageFn,
      sessionManager,
      ...overrides,
    };
  }

  it('провайдер недоступен → provider_not_found без стрима и сохранения', async () => {
    const sessionId = await makeSession();
    const session = (await sessionManager.getSession(sessionId))!;
    const deps = makeDeps({ getProvider: vi.fn(() => null) as never });

    const result = await handleDebugSystemMessage(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, undefined, deps,
    );

    expect(result).toMatchObject({ errorType: 'provider_not_found', canRetry: false });
    expect(result.error).toContain('debug-provider');
    expect(published).toHaveLength(0);
    expect(deps.saveAssistantMessage).not.toHaveBeenCalled();
    expect(cancellationTokens.has('stream1')).toBe(false);
  });

  it('провайдер не задан нигде → в ошибке «unspecified»', async () => {
    const session = await sessionManager.createSession({ title: 'NoProvider' });
    const message = { ...makeMessage(), provider: undefined } as unknown as Message;
    const deps = makeDeps({ getProvider: vi.fn(() => null) as never });

    const result = await handleDebugSystemMessage(
      session, message, new AbortController().signal, publish(), debugCollector, 'stream1', undefined, undefined, deps,
    );

    expect(result.error).toContain('unspecified');
  });

  it('успешный прогон: debug-сообщение, stream.done и уровень размышлений прокинут в провайдера', async () => {
    DebugProvider.chunks = [
      { content: 'подтверждаю ', isFinal: false, model: 'debug-model' },
      { content: 'отладочное сообщение получено', isFinal: true, usage: USAGE, model: 'debug-model', reasoning: 'r' },
    ];
    const sessionId = await makeSession('ru');
    const session = (await sessionManager.getSession(sessionId))!;
    const provider = new DebugProvider({ url: '', apiKey: '', model: 'debug-model', type: 'debug-provider' });
    const deps = makeDeps({ getProvider: vi.fn(() => provider) as never });

    const result = await handleDebugSystemMessage(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', 'high', undefined, deps,
    );

    expect(result).toEqual({});
    expect(deps.getProvider).toHaveBeenCalledWith('debug-provider', session, 'high');

    const chunks = published.filter((p) => p.event === 'stream.chunk');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.data).toMatchObject({ agent_role: 'debug', provider: 'debug-provider', is_final: false });
    expect(chunks[1]!.data).toMatchObject({ is_final: true, content: '' });

    const stored = (await sessionManager.getSession(sessionId))!;
    const debugMessage = stored.messages.find((m) => m.role === MessageRole.DEBUG)!;
    expect(debugMessage).toMatchObject({
      content: 'отладочное сообщение получено',
      agentRole: 'debug',
      reasoning: 'r',
      metadata: { status: 'completed' },
    });
    // UI получает сообщение через stream.done — message.added не публикуется
    expect(events.filter((e) => e.type === 'message.added')).toHaveLength(0);

    const done = published.find((p) => p.event === 'stream.done')!;
    expect(done.data).toMatchObject({
      stream_id: 'stream1',
      content: 'отладочное сообщение получено',
      status: 'completed',
      model: 'debug-model',
      provider: 'debug-provider',
      usage: USAGE,
      metadata: { type: 'debug_system_message' },
      message_index: 0,
      pending_count: 0,
    });
    expect(cancellationTokens.has('stream1')).toBe(false);
  });

  it('язык сессии: ru/en промпты и первая user-реплика различаются', async () => {
    DebugProvider.chunks = [{ content: 'ok', isFinal: true, model: 'debug-model' }];

    for (const [language, expectedFragment] of [['ru', 'Ты получил отладочное'], ['en', 'You received a debug']] as const) {
      const sessionId = await makeSession(language);
      const session = (await sessionManager.getSession(sessionId))!;
      const deps = makeDeps();

      await handleDebugSystemMessage(
        session, makeMessage(), new AbortController().signal, publish(), debugCollector, `stream-${language}`, undefined, undefined, deps,
      );

      expect(String(DebugProvider.lastSystemPrompt)).toContain(expectedFragment);
      expect(DebugProvider.lastMessages.map((m) => m.role)).toEqual(['system', 'user']);
      expect(DebugProvider.lastMessages[1]!.content).toBe(
        language === 'ru'
          ? 'Привет! Это отладочное системное сообщение. Как ты здесь оказался?'
          : 'Hi! This is a debug system message. How did you get here?',
      );
    }
  });

  it('отмена на середине стрима → stream.cancelled без сохранения и без stream.done', async () => {
    const sessionId = await makeSession();
    const session = (await sessionManager.getSession(sessionId))!;
    const deps = makeDeps();
    const controller = new AbortController();
    DebugProvider.chunks = [{ content: 'часть', isFinal: false, model: 'debug-model' }];
    DebugProvider.onChunk = () => controller.abort();

    const result = await handleDebugSystemMessage(
      session, makeMessage(), controller.signal, publish(), debugCollector, 'stream1', undefined, undefined, deps,
    );

    expect(result).toEqual({});
    expect(published.map((p) => p.event)).toEqual(['stream.chunk', 'stream.cancelled']);
    expect(published[1]!.data).toMatchObject({ stream_id: 'stream1', content: 'часть', status: 'cancelled' });
    expect(deps.saveAssistantMessage).not.toHaveBeenCalled();
    expect((await sessionManager.getSession(sessionId))!.messages).toHaveLength(0);
    expect(cancellationTokens.has('stream1')).toBe(false);
  });

  it('ошибка стрима → handleLlmFailure с контекстом debug', async () => {
    DebugProvider.chunks = [{ content: 'частично', isFinal: false, model: 'debug-model' }];
    DebugProvider.error = new Error('fetch failed');
    const sessionId = await makeSession();
    const session = (await sessionManager.getSession(sessionId))!;
    const deps = makeDeps();

    const result = await handleDebugSystemMessage(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, 3, deps,
    );

    expect(result).toMatchObject({ errorType: 'network_error' });
    const [, calledStreamId, error, attempt, ctx] = (deps.handleLlmFailure as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(calledStreamId).toBe('stream1');
    expect((error as Error).message).toBe('fetch failed');
    expect(attempt).toBe(3);
    expect(ctx).toMatchObject({ agentRole: 'debug', providerName: 'debug-provider', promptChars: 321 });
    expect(cancellationTokens.has('stream1')).toBe(false);
    expect(deps.saveAssistantMessage).not.toHaveBeenCalled();
  });

  it('стоимость и debug-контекст сессии попадают в событие и сообщение', async () => {
    DebugProvider.chunks = [{ content: 'ok', isFinal: true, usage: USAGE, model: 'debug-model' }];
    const sessionId = await makeSession();
    const session = (await sessionManager.getSession(sessionId))!;
    const collector = new DebugCollector(true);

    const deps = makeDeps({
      computeMessageCost: vi.fn(() => ({
        costUsd: 0.75, breakdown: { input: 0.5, output: 0.25, cacheRead: 0, cacheWrite: 0 }, currency: 'USD',
      })) as never,
    });

    await handleDebugSystemMessage(
      session, makeMessage(), new AbortController().signal, publish(), collector, 'stream1', undefined, undefined, deps,
    );

    const done = published.find((p) => p.event === 'stream.done')!;
    expect(done.data).toMatchObject({ cost_usd: 0.75, cost_currency: 'USD' });
    expect(collector.getDebugInfo()).toMatchObject({
      session: { session_id: sessionId, context_optimization: 'debug_system_message' },
    });
  });
});
