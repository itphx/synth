import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
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
    throw new Error('401 Unauthorized');
  }

  async *chatAsync(): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { content: '', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    throw new Error('401 Unauthorized');
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
        agentRole: 'developer',
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

  // Баг 1 (ADR-070 §2.6): при сбое провайдера сохраняется assistant-сообщение
  // об ошибке — иначе нет записи в истории, агрегаты сессии 0, debug теряется.
  // Шаг 2б: частичный текст до обрыва теперь сохраняется отдельным
  // прерванным сообщением (`interrupted/status='error'`), поэтому в истории
  // два assistant: прерванный черновик и сообщение об ошибке.
  it('при сбое сохраняет assistant-сообщение об ошибке со status/usage/duration/cost/i18n', async () => {
    const { sessionId } = await run('mockpartial');
    const session = await sessionManager.getSession(sessionId);
    const assistants = session!.messages.filter((m) => m.role === MessageRole.ASSISTANT);
    expect(assistants).toHaveLength(2);

    const interrupted = assistants.find((m) => m.metadata?.interrupted === true)!;
    expect(interrupted).toBeDefined();
    expect(interrupted.content).toContain('частичный ответ до обрыва');

    const assistant = assistants.find((m) => m.metadata?.interrupted !== true)!;
    // content — человекочитаемая ошибка, а не частичный ответ.
    expect(assistant.content).toContain('LLM provider');
    expect(assistant.metadata?.status).toBe('error');
    expect((assistant.metadata?.i18n as { key?: string } | undefined)?.key).toBe('router.timeout');
    expect(typeof assistant.metadata?.duration_ms).toBe('number');

    // Bug 4: пустой usage оценён из промпта/контента, флаг обязателен.
    expect(assistant.usage).toBeDefined();
    expect(assistant.usage!.inputTokens).toBeGreaterThan(0);
    expect(assistant.usage!.outputTokens).toBeGreaterThan(0);
    expect(assistant.metadata?.usage_estimated).toBe(true);

    // cost_usd считается по цене модели (modelPriceLoader).
    expect(typeof assistant.metadata?.cost_usd).toBe('number');
    expect(assistant.metadata?.cost_usd as number).toBeGreaterThan(0);
    expect(assistant.metadata?.cost_breakdown).toBeDefined();

    // Агрегаты сессии обновлены через _saveAssistantMessage.
    expect(session!.inputTokens).toBeGreaterThan(0);
    expect(session!.outputTokens).toBeGreaterThan(0);

    // last_error по-прежнему пишется в user-сообщение.
    const userMsg = session!.messages.find((m) => m.role === MessageRole.USER);
    expect(userMsg).toBeDefined();
    expect(userMsg!.metadata?.last_error).toContain('LLM provider');
  });

  it('сохраняет debug_data при debugEnabled', async () => {
    const { sessionId } = await run('mockpartial', { debug: true });
    const session = await sessionManager.getSession(sessionId);
    const assistant = session!.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && m.metadata?.interrupted !== true,
    )!;
    expect(assistant).toBeDefined();
    expect(assistant.debugData).toBeDefined();
  });

  // Не допускаем дублей: на промежуточной recoverable-попытке QueueProcessor
  // сделает ретрай, поэтому сообщение об ошибке не сохраняется.
  it('НЕ сохраняет assistant-сообщение об ошибке на промежуточной попытке', async () => {
    const { sessionId } = await run('mockfail', { attempt: 1 });
    const session = await sessionManager.getSession(sessionId);
    expect(session!.messages.filter((m) => m.role === MessageRole.ASSISTANT)).toHaveLength(0);
  });

  it('сохраняет assistant-сообщение об ошибке на последней попытке', async () => {
    const { sessionId } = await run('mockfail', { attempt: 4 });
    const session = await sessionManager.getSession(sessionId);
    const assistants = session!.messages.filter((m) => m.role === MessageRole.ASSISTANT);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.metadata?.status).toBe('error');
  });

  // non-recoverable сбой терминален даже на первой попытке.
  it('сохраняет сообщение об ошибке для non-recoverable сбоя на первой попытке', async () => {
    ProviderFactory.register('mockauthfail', AuthFailingProvider);
    const { sessionId } = await run('mockauthfail', { attempt: 1 });
    ProviderFactory['_providers'].delete('mockauthfail');
    const session = await sessionManager.getSession(sessionId);
    const assistants = session!.messages.filter((m) => m.role === MessageRole.ASSISTANT);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.metadata?.status).toBe('error');
    expect((assistants[0]!.metadata?.i18n as { key?: string } | undefined)).toBeUndefined();
  });

  // Потеря исходного запроса в tool-цепочке: провайдер отвергает запрос,
  // пользователю показывается понятный i18n-ключ, а не сырой JSON.
  it('no_user_query: assistant-сообщение несёт i18n-ключ router.no_user_query', async () => {
    ProviderFactory.register('mocknoquery', NoUserQueryProvider);
    const { result, sessionId } = await run('mocknoquery', { attempt: 1 });
    ProviderFactory['_providers'].delete('mocknoquery');

    expect(result.errorType).toBe('no_user_query');
    expect(result.canRetry).toBe(false);

    const session = await sessionManager.getSession(sessionId);
    const assistant = session!.messages.find((m) => m.role === MessageRole.ASSISTANT)!;
    expect(assistant).toBeDefined();
    expect(assistant.metadata?.status).toBe('error');
    expect((assistant.metadata?.i18n as { key?: string } | undefined)?.key).toBe('router.no_user_query');
  });

  // P2: провайдер не найден — терминальная ошибка конфигурации. Раньше
  // возвращалась без персистентности, и после перезагрузки сессия выглядела
  // как «агент думает». Теперь пишется assistant-сообщение с metadata.status
  // 'error'/i18n + last_error, а в LLM-контекст ошибка не уходит.
  it('provider_not_found: персистится assistant-сообщение об ошибке и не попадает в LLM-контекст', async () => {
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: () => undefined as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
    });
    const session = await sessionManager.createSession({
      title: 'NoProvider',
      settings: { provider: 'ghost', model: 'm', systemPrompt: 'test', agentRole: 'developer' },
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
    const assistant = after.messages.find((m) => m.role === MessageRole.ASSISTANT);
    expect(assistant).toBeDefined();
    expect(assistant!.metadata?.status).toBe('error');
    expect((assistant!.metadata?.i18n as { key?: string } | undefined)?.key).toBe('router.provider_not_found');

    const userMsg = after.messages.find((m) => m.role === MessageRole.USER);
    expect(userMsg!.metadata?.last_error).toBeTruthy();

    // История для LLM не содержит персистентную ошибку как реплику assistant.
    const llm = ChatOrchestrator._sessionMessagesToLlm(after.messages, 'developer', 'user');
    expect(llm.some((m) => m.role === 'assistant' && m.content.includes('not found'))).toBe(false);
  });

  it('_sessionMessagesToLlm исключает assistant-сообщение со status=error', () => {
    const errorMsg: Message = {
      ...makeMessage(),
      role: MessageRole.ASSISTANT,
      content: 'Provider ghost not found or not configured',
      agentRole: 'developer',
      metadata: { stream_id: 's-x', status: 'error' },
    };
    const normalMsg: Message = {
      ...makeMessage(),
      role: MessageRole.ASSISTANT,
      content: 'обычный ответ',
      agentRole: 'developer',
      metadata: { stream_id: 's-y', status: 'completed' },
    };

    const llm = ChatOrchestrator._sessionMessagesToLlm([errorMsg, normalMsg], 'developer', 'user');

    expect(llm.some((m) => m.content.includes('not found'))).toBe(false);
    expect(llm.some((m) => m.content === 'обычный ответ')).toBe(true);
  });
});
