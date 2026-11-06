import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import { RemoteAuthExpiredError } from '../providers/exceptions.js';
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';

/** Провайдер, у которого chatAsync падает, как при недоступном LLM-бэкенде. */
class FailingProvider extends BaseProvider {
  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    throw new Error('AbortError: This operation was aborted');
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { content: '', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, model: this.model };
    throw new Error('AbortError: This operation was aborted');
  }

  getProviderName(): string {
    return 'mockfail';
  }
}

/** Провайдер, который выдаёт частичный контент И потом падает — регрессия на
 * «разделение ответа на 2»: раньше частичный assistant сохранялся, затем
 * сохранялся ещё и полный после ретрая. */
class PartialContentFailingProvider extends BaseProvider {
  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    throw new Error('AbortError: This operation was aborted');
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { content: 'частичный ответ до обрыва', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, model: this.model };
    throw new Error('AbortError: This operation was aborted');
  }

  getProviderName(): string {
    return 'mockpartial';
  }
}

/** Провайдер с non-recoverable ошибкой авторизации (ретраи не выполняются). */
class AuthFailingProvider extends BaseProvider {
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    throw new RemoteAuthExpiredError();
  }

  async *chatAsync(): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { content: '', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    throw new RemoteAuthExpiredError();
  }

  getProviderName(): string {
    return 'mockauthfail';
  }
}

/** Провайдер с non-recoverable ошибкой «потерян исходный запрос» (обычно после tool-вызова). */
class NoUserQueryProvider extends BaseProvider {
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    throw new Error('Bad request: {"detail":"no user query found in messages"}');
  }

  async *chatAsync(): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { content: '', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    throw new Error('Bad request: {"detail":"no user query found in messages"}');
  }

  getProviderName(): string {
    return 'mocknoquery';
  }
}

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
    parts: [makeTextPart('Привет')],
    content: 'Привет',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

describe('ChatOrchestrator — ошибка LLM-стрима (провайдер недоступен)', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-err-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
    ProviderFactory.register('mockfail', FailingProvider);
    ProviderFactory.register('mockpartial', PartialContentFailingProvider);
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockfail');
    ProviderFactory['_providers'].delete('mockpartial');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function run(
    providerType = 'mockfail',
    opts: { attempt?: number; debug?: boolean } = {},
  ): Promise<{
    result: Awaited<ReturnType<ReturnType<ChatOrchestrator['createProcessMessage']>>>;
    chunks: Array<{ event: string; data: Record<string, unknown> }>;
    sessionId: string;
    streamId: string;
  }> {
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => {
        return { name, type: providerType, baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
      },
      defaultWorkingDir: tmpDir,
      // Цены модели 'm' — чтобы проверить cost_usd у сообщения об ошибке.
      modelPriceLoader: (model: string) =>
        model === 'm' ? { inputPrice: 1, outputPrice: 2 } : null,
    });

    const session = await sessionManager.createSession({
      title: 'Err',
      settings: {
        provider: providerType,
        model: 'm',
        systemPrompt: 'test',
        agentRole: 'fixer',
        debugEnabled: opts.debug ?? false,
      },
    });
    const msg = makeMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const processMessage = orchestrator.createProcessMessage();
    const result = await processMessage(fresh, msg, new AbortController().signal, (event, data) => {
      chunks.push({ event, data });
    }, opts.attempt);

    return {
      result,
      chunks,
      sessionId: session.id,
      streamId: msg.metadata?.stream_id as string,
    };
  }

  it('возвращает человекочитаемую ошибку вместо сырого AbortError', async () => {
    const { result } = await run();
    expect(result.error).toBeDefined();
    expect(result.error).toContain('LLM provider');
    expect(result.error).not.toContain('aborted');
    expect(result.errorType).toBe('timeout');
  });

  it('НЕ публикует stream.error из оркестратора (единый источник — QueueProcessor)', async () => {
    const { chunks } = await run();
    const err = chunks.find((c) => c.event === 'stream.error');
    expect(err).toBeUndefined();
  });

  it('записывает last_error в user-сообщение сессии', async () => {
    const { sessionId } = await run();
    const session = await sessionManager.getSession(sessionId);
    const userMsg = session!.messages.find((m) => m.role === MessageRole.USER);
    expect(userMsg).toBeDefined();
    expect(userMsg!.metadata?.last_error).toContain('LLM provider');
  });

  // Решение владельца 2026-11-06: терминальная ошибка основной сессии не
  // создаёт assistant-сообщение. В истории остаётся только частичный ответ
  // (прерванный черновик), расход пишется aux-вызовом `llm-error`, а
  // пользователю показывается плашка `stream.error`.
  it('при сбое сообщения об ошибке нет: остаётся частичный ответ, расход — aux, last_error записан', async () => {
    const { sessionId } = await run('mockpartial');
    const session = await sessionManager.getSession(sessionId);
    const assistants = session!.messages.filter((m) => m.role === MessageRole.ASSISTANT);
    expect(assistants).toHaveLength(1);

    const interrupted = assistants[0]!;
    expect(interrupted.metadata?.interrupted).toBe(true);
    expect(interrupted.metadata?.status).toBe('error');
    expect(interrupted.content).toContain('частичный ответ до обрыва');

    // Расход неудавшегося вызова не потерян: счётчики сессии обновлены
    // aux-учётом (`llm-error`), стоимость — по цене модели.
    expect(session!.inputTokens).toBeGreaterThan(0);
    expect(session!.outputTokens).toBeGreaterThan(0);
    expect(session!.inputCost).toBeGreaterThan(0);

    const userMsg = session!.messages.find((m) => m.role === MessageRole.USER);
    expect(userMsg).toBeDefined();
    expect(userMsg!.metadata?.last_error).toContain('LLM provider');
  });

  it('при сбое debug-данные не персистятся (сообщения нет)', async () => {
    const { sessionId } = await run('mockpartial', { debug: true });
    const session = await sessionManager.getSession(sessionId);
    const assistant = session!.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && m.metadata?.interrupted !== true,
    );
    expect(assistant).toBeUndefined();
  });

  // Не допускаем дублей: на промежуточной recoverable-попытке QueueProcessor
  // сделает ретрай, поэтому расход не пишется и сообщения нет.
  it('НЕ сохраняет сообщение об ошибке на промежуточной попытке', async () => {
    const { sessionId } = await run('mockfail', { attempt: 1 });
    const session = await sessionManager.getSession(sessionId);
    expect(session!.messages.filter((m) => m.role === MessageRole.ASSISTANT)).toHaveLength(0);
  });

  it('на последней попытке сообщения об ошибке тоже нет, но last_error записан', async () => {
    const { sessionId } = await run('mockfail', { attempt: 4 });
    const session = await sessionManager.getSession(sessionId);
    expect(session!.messages.filter((m) => m.role === MessageRole.ASSISTANT)).toHaveLength(0);
    const userMsg = session!.messages.find((m) => m.role === MessageRole.USER);
    expect(userMsg!.metadata?.last_error).toContain('LLM provider');
    // Оценённый расход всё равно учтён (aux `llm-error`).
    expect(session!.inputTokens).toBeGreaterThan(0);
  });

  // non-recoverable сбой терминален даже на первой попытке.
  it('non-recoverable сбой: сообщения нет, errorType/canRetry прежние', async () => {
    ProviderFactory.register('mockauthfail', AuthFailingProvider);
    const { result, sessionId } = await run('mockauthfail', { attempt: 1 });
    ProviderFactory['_providers'].delete('mockauthfail');
    // Истёкшая сессия гибрида — отдельный тип (не общий auth_error).
    expect(result.errorType).toBe('remote_auth_expired');
    expect(result.canRetry).toBe(false);
    const session = await sessionManager.getSession(sessionId);
    expect(session!.messages.filter((m) => m.role === MessageRole.ASSISTANT)).toHaveLength(0);
    const userMsg = session!.messages.find((m) => m.role === MessageRole.USER);
    expect(userMsg!.metadata?.last_error).toBe(result.error);
  });

  // Потеря исходного запроса в tool-цепочке: пользователю показывается
  // понятный i18n-текст, а не сырой JSON; в историю ошибка не пишется.
  it('no_user_query: сообщения нет, текст last_error — человекочитаемый', async () => {
    ProviderFactory.register('mocknoquery', NoUserQueryProvider);
    const { result, sessionId } = await run('mocknoquery', { attempt: 1 });
    ProviderFactory['_providers'].delete('mocknoquery');

    expect(result.errorType).toBe('no_user_query');
    expect(result.canRetry).toBe(false);

    const session = await sessionManager.getSession(sessionId);
    expect(session!.messages.filter((m) => m.role === MessageRole.ASSISTANT)).toHaveLength(0);
    const userMsg = session!.messages.find((m) => m.role === MessageRole.USER);
    expect(userMsg!.metadata?.last_error).toBeTruthy();
  });

  // P2: провайдер не найден — терминальная ошибка конфигурации. После
  // reload сессия не должна выглядеть как «агент думает»: last_error на
  // user-реплике фиксирует сбой, assistant-сообщения нет.
  it('provider_not_found: сообщения нет, last_error записан, в LLM-контекст ошибка не попадает', async () => {
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: () => undefined as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
    });
    const session = await sessionManager.createSession({
      title: 'NoProvider',
      settings: { provider: 'ghost', model: 'm', systemPrompt: 'test', agentRole: 'fixer' },
    });
    const msg = makeMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const result = await orchestrator.createProcessMessage()(
      fresh, msg, new AbortController().signal, () => {}, 1,
    );

    expect(result.errorType).toBe('provider_not_found');
    expect(result.canRetry).toBe(false);

    const after = (await sessionManager.getSession(session.id))!;
    expect(after.messages.filter((m) => m.role === MessageRole.ASSISTANT)).toHaveLength(0);

    const userMsg = after.messages.find((m) => m.role === MessageRole.USER);
    expect(userMsg!.metadata?.last_error).toBeTruthy();

    // История для LLM не содержит персистентную ошибку как реплику assistant.
    const llm = ChatOrchestrator._sessionMessagesToLlm(after.messages, 'fixer', 'user');
    expect(llm.some((m) => m.role === 'assistant' && m.content.includes('not found'))).toBe(false);
  });

  it('_sessionMessagesToLlm исключает assistant-сообщение со status=error', () => {
    const errorMsg: Message = {
      ...makeMessage(),
      role: MessageRole.ASSISTANT,
      content: 'Provider ghost not found or not configured',
      agentRole: 'fixer',
      metadata: { stream_id: 's-x', status: 'error' },
    };
    const normalMsg: Message = {
      ...makeMessage(),
      role: MessageRole.ASSISTANT,
      content: 'обычный ответ',
      agentRole: 'fixer',
      metadata: { stream_id: 's-y', status: 'completed' },
    };

    const llm = ChatOrchestrator._sessionMessagesToLlm([errorMsg, normalMsg], 'fixer', 'user');

    expect(llm.some((m) => m.content.includes('not found'))).toBe(false);
    expect(llm.some((m) => m.content === 'обычный ответ')).toBe(true);
  });
});
