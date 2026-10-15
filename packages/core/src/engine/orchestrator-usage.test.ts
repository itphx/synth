/**
 * ADR-070 §2.3 (Ф3): агрегация нормализованного usage в сессию и расчёт
 * стоимости cache read/write по modelPriceLoader; cache hit rate.
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
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

/** Мок-провайдер: отдаёт нормализованный usage с cache-полями. */
class UsageProvider extends BaseProvider {
  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: SystemPromptInput,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
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
    return 'usageprovider';
  }
}

describe('ChatOrchestrator — usage/стоимость (ADR-070 §2.3)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-usage-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    ProviderFactory.register('usageprovider', UsageProvider);
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('usageprovider');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function run() {
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) =>
        ({
          name,
          type: 'usageprovider',
          baseUrl: '',
          apiKey: '',
          defaultModel: 'm',
        }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
      // Цены за 1M токенов.
      modelPriceLoader: (model: string) =>
        model === 'm'
          ? { inputPrice: 1, outputPrice: 2, cacheReadPrice: 0.5, cacheWritePrice: 1.5 }
          : null,
    });

    const session = await sessionManager.createSession({
      title: 'Usage',
      settings: { provider: 'usageprovider', model: 'm', agentRole: 'developer' },
    });
    const msg = makeUserMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    await orchestrator.createProcessMessage()(fresh, msg, new AbortController().signal, () => {});
    return (await sessionManager.getSession(session.id))!;
  }

  it('накапливает cache/reasoning токены и считает стоимость по ценам модели', async () => {
    const session = await run();

    expect(session.inputTokens).toBe(100);
    expect(session.outputTokens).toBe(10);
    expect(session.totalTokens).toBe(110);
    expect(session.cacheReadTokens).toBe(40);
    expect(session.cacheWriteTokens).toBe(20);
    expect(session.reasoningTokens).toBe(5);

    const div = 1_000_000;
    expect(session.inputCost).toBeCloseTo((100 * 1) / div, 12);
    expect(session.outputCost).toBeCloseTo((10 * 2) / div, 12);
    expect(session.cacheReadCost).toBeCloseTo((40 * 0.5) / div, 12);
    expect(session.cacheWriteCost).toBeCloseTo((20 * 1.5) / div, 12);
  });

  it('cache hit rate = cacheReadTokens / inputTokens', async () => {
    const session = await run();
    expect(session.cacheHitRate).toBeCloseTo(0.4, 12);
  });
});
