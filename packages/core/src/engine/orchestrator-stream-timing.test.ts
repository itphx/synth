/**
 * T14 (dogfooding): измеримость стриминга — `seq`/`t_ms` у `stream.chunk` и
 * сводка `chunks`/`first_chunk_ms`/`last_chunk_ms`/`content_chars` в `stream.done`.
 *
 * Поля аддитивные: старые клиенты их не читают, а сервер по ним сравнивает
 * момент последнего чанка с моментом прихода `stream.done` в UI (где задержка —
 * сервер или рендер).
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

/** Провайдер с несколькими чанками: нужен для проверки `seq`/таймингов. */
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
    // Финальный чанк в UI уходит с пустым content (полный текст — в stream.done).
    yield { content: 'ответ', isFinal: true, usage: USAGE, model: this.model };
  }

  getProviderName(): string {
    return 'timingprovider';
  }
}

describe('ChatOrchestrator — тайминги стрима (T14)', () => {
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

  async function run(): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
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
    return events;
  }

  it('чанки несут монотонные seq (с 1) и t_ms', async () => {
    const events = await run();
    const chunks = events.filter((e) => e.type === 'stream.chunk');
    expect(chunks).toHaveLength(3);

    let prevT = -1;
    chunks.forEach((chunk, index) => {
      expect(chunk.data.seq).toBe(index + 1);
      expect(chunk.data.stream_id).toBeTruthy();
      expect(typeof chunk.data.t_ms).toBe('number');
      expect(chunk.data.t_ms as number).toBeGreaterThanOrEqual(0);
      // Время от старта стрима не убывает.
      expect(chunk.data.t_ms as number).toBeGreaterThanOrEqual(prevT);
      prevT = chunk.data.t_ms as number;
      // Прежние поля не изменились.
      expect(typeof chunk.data.content).toBe('string');
      expect(chunk.data.agent_role).toBe('fixer');
    });
    // Финальный чанк по-прежнему с пустым content.
    expect(chunks[2]!.data.content).toBe('');
  });

  it('stream.done несёт chunks/first_chunk_ms/last_chunk_ms/content_chars', async () => {
    const events = await run();
    const done = events.find((e) => e.type === 'stream.done');
    expect(done).toBeTruthy();

    expect(done!.data.chunks).toBe(3);
    expect(typeof done!.data.first_chunk_ms).toBe('number');
    expect(typeof done!.data.last_chunk_ms).toBe('number');
    expect(done!.data.first_chunk_ms as number).toBeGreaterThanOrEqual(0);
    expect(done!.data.last_chunk_ms as number).toBeGreaterThanOrEqual(done!.data.first_chunk_ms as number);
    expect(done!.data.content_chars).toBe((done!.data.content as string).length);
    expect(done!.data.content).toBe('ответ');

    // Прежние поля события не изменились.
    expect(done!.data.status).toBe('completed');
    expect(typeof done!.data.duration_ms).toBe('number');
    expect(done!.data.usage).toBeTruthy();
  });
});
