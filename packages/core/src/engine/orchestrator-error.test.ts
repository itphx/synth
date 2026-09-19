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

  async function run(providerType = 'mockfail'): Promise<{
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
    });

    const session = await sessionManager.createSession({
      title: 'Err',
      settings: { provider: providerType, model: 'm', systemPrompt: 'test', agentRole: 'developer' },
    });
    const msg = makeMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const processMessage = orchestrator.createProcessMessage();
    const result = await processMessage(fresh, msg, new AbortController().signal, (event, data) => {
      chunks.push({ event, data });
    });

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

  it('при ошибке стрима с частичным контентом НЕ создаёт assistant-сообщение', async () => {
    const { sessionId } = await run('mockpartial');
    const session = await sessionManager.getSession(sessionId);
    const assistants = session!.messages.filter((m) => m.role === MessageRole.ASSISTANT);
    expect(assistants).toHaveLength(0);
    const userMsg = session!.messages.find((m) => m.role === MessageRole.USER);
    expect(userMsg).toBeDefined();
    expect(userMsg!.metadata?.last_error).toContain('LLM provider');
  });
});
