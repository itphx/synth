/**
 * ADR-070: live-статистика стрима — событие `stream.usage` (кумулятивный usage,
 * точный либо best-effort оценка, стоимость по ценам модели).
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
import type { LLMChunk, LLMResponse, Message, TokenUsage } from '@itphx/synth-shared';
import type { ModelPricing } from './orchestrator.js';

const EXACT_USAGE: TokenUsage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

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

/** Фабрика мок-провайдера, отдающего заранее заданные чанки. */
function makeProviderClass(chunks: LLMChunk[]) {
  return class LiveUsageProvider extends BaseProvider {
    async chat(): Promise<LLMResponse> {
      return { content: '', model: this.model, usage: ZERO_USAGE };
    }

    async *chatAsync(
      _messages: LLMMessage[],
      _systemPrompt?: SystemPromptInput,
      _tools?: Record<string, unknown>[],
      _debugCollector?: unknown,
      _cancellationToken?: CancellationToken,
    ): AsyncGenerator<LLMChunk> {
      for (const chunk of chunks) yield chunk;
    }

    getProviderName(): string {
      return 'liveusage';
    }
  };
}

type Published = { event: string; data: Record<string, unknown> };

describe('ChatOrchestrator — live stream.usage (ADR-070)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-live-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('liveusage');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function run(
    chunks: LLMChunk[],
    modelPriceLoader?: (model: string) => ModelPricing | null,
  ): Promise<{ events: Published[]; sessionId: string; streamId: string }> {
    ProviderFactory.register('liveusage', makeProviderClass(chunks));

    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) =>
        ({
          name,
          type: 'liveusage',
          baseUrl: '',
          apiKey: '',
          defaultModel: 'm',
        }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
      ...(modelPriceLoader ? { modelPriceLoader } : {}),
    });

    const session = await sessionManager.createSession({
      title: 'LiveUsage',
      settings: { provider: 'liveusage', model: 'm', agentRole: 'developer' },
    });
    const msg = makeUserMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const events: Published[] = [];
    await orchestrator.createProcessMessage()(
      fresh,
      msg,
      new AbortController().signal,
      (event, data) => events.push({ event, data }),
    );

    return { events, sessionId: session.id, streamId: msg.metadata?.stream_id as string };
  }

  function usageEvents(events: Published[]): Published[] {
    return events.filter((e) => e.event === 'stream.usage');
  }

  it('публикует stream.usage с контрактными полями', async () => {
    const { events, sessionId, streamId } = await run([
      { content: 'ok', isFinal: true, usage: EXACT_USAGE, model: 'm' },
    ]);

    const usage = usageEvents(events);
    expect(usage.length).toBeGreaterThanOrEqual(1);
    const first = usage[0]!;
    expect(first.data.session_id).toBe(sessionId);
    expect(first.data.stream_id).toBe(streamId);
    expect(first.data.iteration).toBe(0);
    expect(first.data.usage).toBeDefined();
    expect(typeof first.data.estimated).toBe('boolean');
  });

  it('точный usage чанка → estimated: false; стартовая оценка → estimated: true', async () => {
    const { events } = await run([
      { content: 'ok', isFinal: true, usage: EXACT_USAGE, model: 'm' },
    ]);

    const usage = usageEvents(events);
    const exact = usage.find((e) => e.data.estimated === false);
    const estimated = usage.find((e) => e.data.estimated === true);
    expect(estimated).toBeDefined();
    expect(exact).toBeDefined();
    expect((exact!.data.usage as TokenUsage).inputTokens).toBe(100);
    expect((exact!.data.usage as TokenUsage).outputTokens).toBe(10);
  });

  it('Anthropic: input>0/output=0 → estimated:true с оценённым output, финал output>0 → estimated:false', async () => {
    const { events } = await run([
      { content: 'Hello', isFinal: false, usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 } },
      { content: 'Hello world', isFinal: true, usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 }, model: 'm' },
    ]);

    const usage = usageEvents(events);

    // Промежуточный снимок: точный input сохранён, output оценён (chars/4 = 5/4).
    const estimated = usage.find(
      (e) => e.data.estimated === true && (e.data.usage as TokenUsage).inputTokens === 100,
    );
    expect(estimated).toBeDefined();
    expect((estimated!.data.usage as TokenUsage).outputTokens).toBe(2);

    // Финал: точный output, estimated снят.
    const exact = usage.find((e) => e.data.estimated === false);
    expect(exact).toBeDefined();
    expect((exact!.data.usage as TokenUsage).inputTokens).toBe(100);
    expect((exact!.data.usage as TokenUsage).outputTokens).toBe(5);
  });

  it('точный output не понижается оценкой (input=0, output>0 → estimated:false)', async () => {
    const { events } = await run([
      { content: 'ok', isFinal: true, usage: { inputTokens: 0, outputTokens: 9, totalTokens: 9 }, model: 'm' },
    ]);
    const exact = usageEvents(events).find((e) => e.data.estimated === false);
    expect(exact).toBeDefined();
    expect((exact!.data.usage as TokenUsage).outputTokens).toBe(9);
    expect((exact!.data.usage as TokenUsage).inputTokens).toBe(0);
  });

  it('нулевой usage → только оценка (estimated: true), троттлинг не спамит', async () => {
    const chunks: LLMChunk[] = [];
    for (let i = 0; i < 5; i++) {
      chunks.push({ content: `часть${i} `, isFinal: false, usage: ZERO_USAGE });
    }
    chunks.push({ content: 'итог', isFinal: true, usage: ZERO_USAGE, model: 'm' });

    const { events } = await run(chunks);
    const usage = usageEvents(events);

    // Все чанки в одном окне троттлинга (~300 мс) → только стартовая оценка.
    expect(usage).toHaveLength(1);
    expect(usage[0]!.data.estimated).toBe(true);
    expect((usage[0]!.data.usage as TokenUsage).inputTokens).toBeGreaterThan(0);
  });

  it('без цен модели cost_usd/cost_breakdown не пишутся', async () => {
    const { events } = await run([
      { content: 'ok', isFinal: true, usage: EXACT_USAGE, model: 'm' },
    ]);
    const exact = usageEvents(events).find((e) => e.data.estimated === false)!;
    expect(exact.data.cost_usd).toBeUndefined();
    expect(exact.data.cost_breakdown).toBeUndefined();
  });

  it('с ценами модели cost_usd/cost_breakdown считаются', async () => {
    const { events } = await run(
      [{ content: 'ok', isFinal: true, usage: EXACT_USAGE, model: 'm' }],
      (model) => (model === 'm' ? { inputPrice: 1, outputPrice: 2 } : null),
    );
    const exact = usageEvents(events).find((e) => e.data.estimated === false)!;
    // 100*1/1e6 + 10*2/1e6 = 0.00012
    expect(exact.data.cost_usd).toBeCloseTo(0.00012, 12);
    expect(exact.data.cost_currency).toBe('USD');
    const breakdown = exact.data.cost_breakdown as Record<string, number>;
    expect(breakdown.input).toBeCloseTo(0.0001, 12);
    expect(breakdown.output).toBeCloseTo(0.00002, 12);
  });

  it('валюта pricing (RUB) прокидывается в stream.usage', async () => {
    const { events } = await run(
      [{ content: 'ok', isFinal: true, usage: EXACT_USAGE, model: 'm' }],
      (model) => (model === 'm' ? { inputPrice: 1, outputPrice: 2, currency: 'RUB' } : null),
    );
    const exact = usageEvents(events).find((e) => e.data.estimated === false)!;
    expect(exact.data.cost_currency).toBe('RUB');
  });

  it('live-оценки не попадают в сессию/агрегаты (только финальный usage)', async () => {
    const { sessionId } = await run([
      { content: 'ok', isFinal: false, usage: ZERO_USAGE },
      { content: 'итог', isFinal: true, usage: ZERO_USAGE, model: 'm' },
    ]);
    const session = (await sessionManager.getSession(sessionId))!;
    // Оценки были > 0, но в сессию не записались (точного usage не было).
    expect(session.inputTokens).toBe(0);
    expect(session.outputTokens).toBe(0);
    expect(session.totalTokens).toBe(0);
  });
});
