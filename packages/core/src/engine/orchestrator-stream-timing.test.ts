/**
 * T14 (dogfooding): измеримость стриминга в модели ADR-118.
 *
 * `stream.chunk` с `seq`/`t_ms` и сводкой `stream.done` удалены (ADR-118 §4).
 * Теперь дельты текста идут `part.delta` (upsert по `{messageId, partId}`),
 * а тайминги шага — снимок в `step.finished.timings`
 * (`{chunks, firstChunkMs?, lastChunkMs?}`). По ним UI сравнивает момент
 * последнего чанка с приходом финала (где задержка — сервер или рендер).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, SystemPromptInput, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message, TokenUsage } from '@itphx/synth-shared';

const USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

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
    parts: [makeTextPart('Привет')],
    content: 'Привет',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'local',
    metadata: { stream_id: generateId() },
  };
}

/** Провайдер с несколькими чанками: нужен для проверки таймингов шага. */
class TimingProvider extends BaseProvider {
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'ответ', model: this.model, usage: USAGE };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: SystemPromptInput,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { content: 'От', isFinal: false };
    yield { content: 'вет', isFinal: false };
    // Финальный чанк несёт полный текст шага; дельтой он не публикуется.
    yield { content: 'ответ', isFinal: true, usage: USAGE, model: this.model };
  }

  getProviderName(): string {
    return 'timingprovider';
  }
}

describe('ChatOrchestrator — тайминги шага (T14 × ADR-118)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-timing-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    ProviderFactory.register('timingprovider', TimingProvider);
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('timingprovider');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function run(): Promise<{
    events: Array<{ type: string; data: Record<string, unknown> }>;
    sessionId: string;
  }> {
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) =>
        ({
          name,
          type: 'timingprovider',
          baseUrl: '',
          apiKey: '',
          defaultModel: 'm',
        }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
      modelPriceLoader: () => null,
    });

    const session = await sessionManager.createSession({
      title: 'Timing',
      settings: { provider: 'timingprovider', model: 'm', agentRole: 'fixer' },
    });
    const msg = makeUserMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    await orchestrator.createProcessMessage()(fresh, msg, new AbortController().signal, (type, data) => {
      events.push({ type, data });
    });
    return { events, sessionId: session.id };
  }

  it('дельты текста идут `part.delta` с детерминированным partId; финальный чанк дельтой не публикуется', async () => {
    const { events } = await run();
    const stepStarted = events.find((e) => e.type === 'step.started');
    expect(stepStarted).toBeTruthy();

    const deltas = events.filter((e) => e.type === 'part.delta');
    // Два непустых нефинальных чанка — две дельты ('От' + 'вет').
    expect(deltas).toHaveLength(2);
    expect(deltas.map((d) => d.data.delta)).toEqual(['От', 'вет']);
    // partId детерминирован (`msg:text:0`), сообщение — сообщение шага.
    deltas.forEach((delta) => {
      expect(delta.data.partId).toBe('msg:text:0');
      expect(delta.data.field).toBe('text');
      expect(delta.data.messageId).toBe(stepStarted!.data.messageId);
    });
    // Полный текст шага дельтой не идёт (его несёт сообщение шага).
    expect(deltas.some((d) => d.data.delta === 'ответ')).toBe(false);
  });

  it('`step.finished` несёт timings: chunks/firstChunkMs/lastChunkMs', async () => {
    const { events, sessionId } = await run();
    const finished = events.filter((e) => e.type === 'step.finished');
    expect(finished).toHaveLength(1);
    const timings = finished[0]!.data.timings as
      | { chunks: number; firstChunkMs?: number; lastChunkMs?: number }
      | undefined;
    expect(timings).toBeTruthy();

    // Чанков было три (два нефинальных + финальный).
    expect(timings!.chunks).toBe(3);
    expect(typeof timings!.firstChunkMs).toBe('number');
    expect(typeof timings!.lastChunkMs).toBe('number');
    expect(timings!.firstChunkMs!).toBeGreaterThanOrEqual(0);
    expect(timings!.lastChunkMs!).toBeGreaterThanOrEqual(timings!.firstChunkMs!);
    expect(finished[0]!.data.status).toBe('completed');
    expect(finished[0]!.data.usage).toBeTruthy();

    // Текст шага доступен в сообщении шага (не в событии): длина = длине ответа.
    const stored = (await sessionManager.getSession(sessionId))!;
    const assistant = [...stored.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT)!;
    expect(assistant.content).toBe('ответ');

    // Ход закрыт `turn.finished`.
    const turnFinished = events.find((e) => e.type === 'turn.finished');
    expect(turnFinished?.data.status).toBe('completed');
  });
});
