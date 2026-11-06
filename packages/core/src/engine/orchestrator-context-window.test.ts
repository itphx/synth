/**
 * Политика ограничения контекстного окна в основном цикле оркестратора.
 *
 * `enforce` + оценка промпта больше окна → провайдер **не вызывается**, ход
 * завершается ошибкой `context_length` (`router.context_length_exceeded`);
 * assistant-сообщения нет — последствия фиксируются в `last_error`.
 * `warn`/`off`/неизвестное окно — вызов идёт как обычно.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextOptimizer } from './context/optimizer.js';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { ContextWindowPolicy, Message } from '@itphx/synth-shared';

/** Счётчик вызовов: политика `enforce` обязана не доводить дело до провайдера. */
let chatAsyncCalls = 0;

class CountingProvider extends BaseProvider {
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    chatAsyncCalls += 1;
    return {
      content: 'ok',
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    chatAsyncCalls += 1;
    yield {
      content: 'ok',
      isFinal: true,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'mockcounting';
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

/** Оптимизатор-заглушка: окно модели задаётся тестом, остальное — no-op. */
function makeOptimizer(windowTokens: number): ContextOptimizer {
  return {
    setGatewayHooks: () => {},
    getContextWindow: () => windowTokens,
    estimateTokens: () => 0,
    // Оркестратор берёт историю для LLM через оптимизатор — в тесте отдаём
    // сообщения сессии как есть.
    getMessagesForLlm: (session: { messages: unknown[] }) => session.messages,
    canSummarize: () => false,
  } as unknown as ContextOptimizer;
}

describe('ChatOrchestrator — политика контекстного окна', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    chatAsyncCalls = 0;
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-ctx-window-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
    ProviderFactory.register('mockcounting', CountingProvider);
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockcounting');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function run(options: {
    policy?: ContextWindowPolicy;
    windowTokens: number;
  }): Promise<{
    result: Awaited<ReturnType<ReturnType<ChatOrchestrator['createProcessMessage']>>>;
    sessionId: string;
  }> {
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      contextOptimizer: makeOptimizer(options.windowTokens),
      providerLoader: (name: string) => {
        return {
          name,
          type: 'mockcounting',
          baseUrl: '',
          apiKey: '',
          defaultModel: 'm',
        } as unknown as import('@itphx/synth-shared').ProviderConfig;
      },
      defaultWorkingDir: tmpDir,
      ...(options.policy ? { contextWindowPolicy: () => options.policy! } : {}),
    });

    const session = await sessionManager.createSession({
      title: 'ContextWindow',
      settings: {
        provider: 'mockcounting',
        model: 'm',
        systemPrompt: 'test',
        agentRole: 'fixer',
      },
    });
    const msg = makeMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const processMessage = orchestrator.createProcessMessage();
    const result = await processMessage(fresh, msg, new AbortController().signal, () => {});
    return { result, sessionId: session.id };
  }

  it('enforce + оценка больше окна → провайдер не вызван, ход завершён ошибкой context_length', async () => {
    const { result, sessionId } = await run({ policy: 'enforce', windowTokens: 100 });

    expect(chatAsyncCalls).toBe(0);
    expect(result.errorType).toBe('context_length');
    expect(result.canRetry).toBe(false);

    // Решение владельца 2026-11-06: assistant-сообщения об ошибке нет —
    // фиксируется только `last_error` user-реплики (пользователю — плашка).
    const session = await sessionManager.getSession(sessionId);
    expect(session!.messages.filter((m) => m.role === MessageRole.ASSISTANT)).toHaveLength(0);
    const userMsg = session!.messages.find((m) => m.role === MessageRole.USER);
    expect(userMsg).toBeDefined();
    expect(userMsg!.metadata?.last_error).toBeTruthy();
  });

  it('enforce + оценка влезает в окно → вызов идёт', async () => {
    const { result } = await run({ policy: 'enforce', windowTokens: 1_000_000 });
    expect(chatAsyncCalls).toBe(1);
    expect(result.errorType).toBeUndefined();
  });

  it('warn не блокирует даже при маленьком окне', async () => {
    const { result } = await run({ policy: 'warn', windowTokens: 100 });
    expect(chatAsyncCalls).toBe(1);
    expect(result.errorType).toBeUndefined();
  });

  it('off не блокирует', async () => {
    const { result } = await run({ policy: 'off', windowTokens: 100 });
    expect(chatAsyncCalls).toBe(1);
    expect(result.errorType).toBeUndefined();
  });

  it('неизвестное окно (0) не блокирует даже при enforce', async () => {
    const { result } = await run({ policy: 'enforce', windowTokens: 0 });
    expect(chatAsyncCalls).toBe(1);
    expect(result.errorType).toBeUndefined();
  });

  it('без резолвера политики действует дефолт warn', async () => {
    const { result } = await run({ windowTokens: 100 });
    expect(chatAsyncCalls).toBe(1);
    expect(result.errorType).toBeUndefined();
  });
});
