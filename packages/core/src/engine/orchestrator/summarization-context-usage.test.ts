/**
 * ADR-119: наблюдаемость занятости контекста после компактизации.
 *
 * Служебный ход сжатия — не ответ агента:
 *  - `usage` в `context.summarization_applied` — расход **вызова сжатия**
 *    (весь транскрипт на входе), а не занятость окна;
 *  - `context_tokens`/`context_limit` — оценка занятости **после** сжатия
 *    (покрытые сообщения отключены), то есть тот же счётчик, что триггерит
 *    авто-компактизацию;
 *  - `step.started`/`step.finished` служебного шага несут `kind: 'compression'`
 *    — по нему клиент понимает, что это резюме, а не ответ ассистента.
 *
 * Стенд — тот же, что в `summarization.test.ts` (тот же провайдер-стаб, тот же
 * реальный `SessionManager`/`EventBus`, тот же мок оптимизатора).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { BusEvent, LLMChunk, Message, Session, TokenUsage } from '@itphx/synth-shared';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { EventBus } from '../../events/bus.js';
import { DebugCollector } from '../../debug.js';
import { BaseProvider } from '../../providers/base.js';
import type { CancellationToken, LLMMessage, SystemPromptInput } from '../../providers/base.js';
import type { ContextOptimizer } from '../context/optimizer.js';
import { saveAssistantMessage, type SaveAssistantMessageFn } from './persistence.js';
import { handleSummarization, type SummarizationDeps } from './summarization.js';

const USAGE: TokenUsage = { inputTokens: 20, outputTokens: 8, totalTokens: 28 };

class SummaryProvider extends BaseProvider {
  static chunks: LLMChunk[] = [];

  async chat(): Promise<never> {
    throw new Error('chat не используется суммаризацией');
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: SystemPromptInput,
  ): AsyncGenerator<LLMChunk> {
    for (const chunk of SummaryProvider.chunks) {
      yield chunk;
    }
  }

  getProviderName(): string {
    return 'summary-provider';
  }
}

describe('handleSummarization — занятость контекста и вид шага (ADR-119)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let events: BusEvent[];
  let unsubscribe: () => void;
  let published: Array<{ event: string; data: Record<string, unknown> }>;
  let debugCollector: DebugCollector;
  let cancellationTokens: Map<string, CancellationToken>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-summary-ctx-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    events = [];
    unsubscribe = eventBus.subscribeAll((e) => events.push(e));
    published = [];
    debugCollector = new DebugCollector(false);
    cancellationTokens = new Map();
    SummaryProvider.chunks = [];
  });

  afterEach(async () => {
    unsubscribe();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeSession(messages: Message[] = []): Promise<string> {
    const session = await sessionManager.createSession({ title: 'Sum', settings: { language: 'ru' } as never });
    for (const message of messages) await sessionManager.addMessage(session.id, message);
    return session.id;
  }

  function userMessage(content: string): Message {
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
    };
  }

  /** Assistant-сообщение с замером usage (покрытое сжатием — «до-сжатый» замер). */
  function assistantMessage(content: string, totalTokens: number): Message {
    return {
      id: generateId(),
      role: MessageRole.ASSISTANT,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(content)],
      content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      usage: { inputTokens: totalTokens - 1_000, outputTokens: 1_000, totalTokens },
    };
  }

  function makeOptimizer(): ContextOptimizer {
    return {
      prepareSummarizationForOrchestrator: vi.fn(() => ({
        provider: new SummaryProvider({ url: '', apiKey: '', model: 'summary-model', type: 'summary-provider' }),
        llmMessages: [{ id: '', role: 'user', content: 'история', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, disabled: false, pinned: false, branchId: '' }] as LLMMessage[],
        summarizerPrompt: 'SUMMARIZER',
        messagesToSummarize: [],
        indices: [0, 1],
      })),
      canSummarize: vi.fn(() => true),
    } as unknown as ContextOptimizer;
  }

  function makeDeps(overrides: Partial<SummarizationDeps> = {}): SummarizationDeps {
    return {
      optimizer: makeOptimizer(),
      cancellationTokens,
      handleLlmFailure: vi.fn(async () => ({ error: 'stream failed', errorType: 'network_error', canRetry: true })) as never,
      estimatePromptChars: vi.fn(() => 1234),
      computeMessageCost: vi.fn(() => null),
      saveAssistantMessage: vi.fn(async (...args: Parameters<SaveAssistantMessageFn>) => {
        return saveAssistantMessage(
          { sessionManager, eventBus, obfMapStore: null, modelPriceLoader: null },
          ...args,
        );
      }) as unknown as SaveAssistantMessageFn,
      sessionManager,
      eventBus,
      ...overrides,
    };
  }

  function makeMessage(): Message {
    return {
      id: generateId(),
      role: MessageRole.SYSTEM,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart('sum')],
      content: 'sum',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      metadata: { type: 'summarization_request', stream_id: 'stream1' },
      provider: 'summary-provider',
    };
  }

  function publish() {
    return (event: string, data: Record<string, unknown>) => published.push({ event, data });
  }

  /**
   * Оптимизатор с оценкой занятости: считает **только неотключённые**
   * сообщения — как реальный `estimatePromptTokens` после сжатия.
   * `seen` фиксирует состояние сессии на момент оценки.
   */
  function makeUsageOptimizer(seen: Array<{ active: number; disabled: number }>): ContextOptimizer {
    return {
      ...makeOptimizer(),
      estimatePromptTokens: vi.fn((s: Session) => {
        seen.push({
          active: s.messages.filter((m) => !m.disabled).length,
          disabled: s.messages.filter((m) => m.disabled).length,
        });
        return s.messages.filter((m) => !m.disabled).length * 1000;
      }),
      getContextWindow: vi.fn(() => 100_000),
    } as unknown as ContextOptimizer;
  }

  /** Прогон суммаризации с оценкой занятости; возвращает payload события. */
  async function runWithUsage(): Promise<{
    data: Record<string, unknown>;
    seen: Array<{ active: number; disabled: number }>;
    stored: Session;
  }> {
    SummaryProvider.chunks = [
      { content: 'итог всей истории диалога', isFinal: true, usage: USAGE, model: 'summary-model' },
    ];
    const sessionId = await makeSession([
      userMessage('a'),
      assistantMessage('ответ до сжатия', 91_000),
      userMessage('c'),
    ]);
    const session = (await sessionManager.getSession(sessionId))!;
    const seen: Array<{ active: number; disabled: number }> = [];
    const deps = makeDeps({ optimizer: makeUsageOptimizer(seen) });

    await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    const applied = events.find((e) => e.type === 'context.summarization_applied');
    expect(applied).toBeDefined();
    const stored = (await sessionManager.getSession(sessionId))!;
    return { data: applied!.data, seen, stored };
  }

  it('context_tokens/context_limit посчитаны ПОСЛЕ отключения покрытых сообщений', async () => {
    const { data, seen, stored } = await runWithUsage();

    // Оценка выполнена уже после сжатия: покрытые сообщения отключены.
    expect(seen.length).toBeGreaterThan(0);
    const last = seen[seen.length - 1]!;
    expect(last.disabled).toBe(2);
    expect(last.active).toBe(2);

    expect(data.context_tokens).toBe(2_000);
    expect(data.context_limit).toBe(100_000);

    // Не сумма usage всех сообщений: замеры покрытых сообщений неактуальны.
    const sumOfUsage = stored.messages.reduce((sum, m) => sum + (m.usage?.totalTokens ?? 0), 0);
    expect(sumOfUsage).toBeGreaterThan(data.context_tokens as number);
  });

  it('usage в событии — расход вызова сжатия, а не занятость окна', async () => {
    const { data } = await runWithUsage();

    expect(data.usage).toMatchObject({
      inputTokens: USAGE.inputTokens,
      outputTokens: USAGE.outputTokens,
      totalTokens: USAGE.totalTokens,
    });
    // Расход вызова сжатия (весь транскрипт на входе) ≠ занятость контекста.
    expect(data.context_tokens).not.toBe(data.usage && (data.usage as { totalTokens: number }).totalTokens);
  });

  it('служебный шаг сжатия помечен kind: compression (step.started/step.finished)', async () => {
    SummaryProvider.chunks = [
      { content: 'итог всей истории диалога', isFinal: true, usage: USAGE, model: 'summary-model' },
    ];
    const sessionId = await makeSession([userMessage('a'), userMessage('b'), userMessage('c')]);
    const session = (await sessionManager.getSession(sessionId))!;
    const deps = makeDeps();

    await handleSummarization(
      session, makeMessage(), new AbortController().signal, publish(), debugCollector, 'stream1', undefined, deps,
    );

    const started = published.find((p) => p.event === 'step.started')!;
    expect(started.data).toMatchObject({ kind: 'compression', stepIndex: 0 });

    const finished = published.find((p) => p.event === 'step.finished')!;
    expect(finished.data).toMatchObject({ kind: 'compression', agentRole: 'summary' });
  });
});
