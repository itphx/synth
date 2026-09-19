/**
 * AD-070 §2.6: per-message duration_ms/cost_usd в metadata финального
 * assistant-сообщения и в событии `stream.done`.
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

const USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 10,
  totalTokens: 110,
  cacheReadTokens: 40,
  cacheWriteTokens: 20,
  reasoningTokens: 5,
};

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

class StatsProvider extends BaseProvider {
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'ok', model: this.model, usage: USAGE };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: SystemPromptInput,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { content: 'ok', isFinal: true, usage: USAGE, model: this.model };
  }

  getProviderName(): string {
    return 'statsprovider';
  }
}

describe('ChatOrchestrator — per-message stats (AD-070 §2.6)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-stats-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    ProviderFactory.register('statsprovider', StatsProvider);
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('statsprovider');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function run(): Promise<{ session: import('@itphx/synth-shared').Session; events: Array<{ type: string; data: Record<string, unknown> }> }> {
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) =>
        ({
          name,
          type: 'statsprovider',
          baseUrl: '',
          apiKey: '',
          defaultModel: 'm',
        }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
      modelPriceLoader: (model: string) =>
        model === 'm'
          ? { inputPrice: 1, outputPrice: 2, cacheReadPrice: 0.5, cacheWritePrice: 1.5 }
          : null,
    });

    const session = await sessionManager.createSession({
      title: 'Stats',
      settings: { provider: 'statsprovider', model: 'm', agentRole: 'developer' },
    });
    const msg = makeUserMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    await orchestrator.createProcessMessage()(fresh, msg, new AbortController().signal, (type, data) => {
      events.push({ type, data });
    });
    return { session: (await sessionManager.getSession(session.id))!, events };
  }

  it('пишет metadata.duration_ms и metadata.cost_usd/cost_breakdown в финальное сообщение', async () => {
    const { session } = await run();

    const assistant = [...session.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT)!;
    expect(assistant).toBeTruthy();

    expect(typeof assistant.metadata?.duration_ms).toBe('number');
    expect(assistant.metadata!.duration_ms as number).toBeGreaterThanOrEqual(0);

    const div = 1_000_000;
    const expected = (100 * 1 + 10 * 2 + 40 * 0.5 + 20 * 1.5) / div;
    expect(assistant.metadata?.cost_usd).toBeCloseTo(expected, 12);
    expect(assistant.metadata?.cost_breakdown).toEqual({
      input: (100 * 1) / div,
      output: (10 * 2) / div,
      cacheRead: (40 * 0.5) / div,
      cacheWrite: (20 * 1.5) / div,
    });
    // AD-070 §2.6: нормальный ответ — status 'completed' (UI не рисует префикс).
    expect(assistant.metadata?.status).toBe('completed');
  });

  it('событие stream.done несёт duration_ms и cost_usd', async () => {
    const { events } = await run();
    const done = events.find((e) => e.type === 'stream.done');
    expect(done).toBeTruthy();

    expect(typeof done!.data.duration_ms).toBe('number');
    expect(done!.data.duration_ms as number).toBeGreaterThanOrEqual(0);

    const div = 1_000_000;
    expect(done!.data.cost_usd).toBeCloseTo((100 * 1 + 10 * 2 + 40 * 0.5 + 20 * 1.5) / div, 12);
    // usage сохранён для обратной совместимости.
    expect(done!.data.usage).toBeTruthy();
    // AD-070 §2.6: status доносится до UI в stream.done.
    expect(done!.data.status).toBe('completed');
  });
});
