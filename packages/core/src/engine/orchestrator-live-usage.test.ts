/**
 * ADR-118 §4: live-статистика стрима (`stream.usage` с троттлингом ~300 мс и
 * best-effort оценкой) **удалена** — расход шага учитывается один раз, в
 * `step.finished` (`usage`, `provider`, `model`, `costUsd`/`costCurrency`,
 * `agentRole`). Один шаг = один вызов LLM, поэтому сумма по шагам равна
 * расходу хода (ADR-094: из этих полей считаются ретраи и стоимость).
 *
 * Смысл прежних проверок сохранён: точный/нулевой usage, отсутствие цен —
 * нет стоимости, валюта pricing, изоляция оценок от агрегатов сессии.
 * Проверки именно троттлинга и промежуточных оценок переформулированы —
 * функций больше нет: вместо них «на шаг ровно одно событие» и «usage шага
 * отдаётся провайдером как есть» (оценка осталась только в ветке отмены,
 * `usage_estimated` в `stream.cancelled`).
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

describe('ChatOrchestrator — учёт usage по шагу (`step.finished`, ADR-118)', () => {
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
  ): Promise<{ events: Published[]; sessionId: string }> {
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
      settings: { provider: 'liveusage', model: 'm', agentRole: 'fixer' },
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

    return { events, sessionId: session.id };
  }

  /** События закрытия шага — замена удалённому `stream.usage`. */
  function stepEvents(events: Published[]): Published[] {
    return events.filter((e) => e.event === 'step.finished');
  }

  it('публикует step.finished с контрактными полями расхода шага', async () => {
    const { events } = await run([
      { content: 'ok', isFinal: true, usage: EXACT_USAGE, model: 'm' },
    ]);

    const steps = stepEvents(events);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.data).toMatchObject({
      turnId: expect.any(String),
      stepIndex: 0,
      messageId: expect.any(String),
      status: 'completed',
      usage: EXACT_USAGE,
      provider: 'liveusage',
      model: 'm',
      agentRole: 'fixer',
    });
    // ADR-118 §4: live-событие `stream.usage` удалено без dual-emit.
    expect(events.some((e) => e.event === 'stream.usage')).toBe(false);
  });

  it('точный usage чанка → `usage` шага без полей оценки', async () => {
    const { events } = await run([
      { content: 'ok', isFinal: true, usage: EXACT_USAGE, model: 'm' },
    ]);

    const step = stepEvents(events)[0]!;
    expect(step.data.usage).toEqual(EXACT_USAGE);
    // Live-оценки/троттлинга больше нет — в событии нет `estimated`.
    expect(step.data).not.toHaveProperty('estimated');
    expect(step.data).not.toHaveProperty('usage_estimated');
  });

  it('Anthropic: usage шага — из финального чанка (промежуточных снимков нет)', async () => {
    const { events } = await run([
      { content: 'Hello', isFinal: false, usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 } },
      { content: 'Hello world', isFinal: true, usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 }, model: 'm' },
    ]);

    const steps = stepEvents(events);
    expect(steps).toHaveLength(1);
    // Промежуточный снимок (input=100/output=0) и live-оценка output
    // (`estimated: true` в `stream.usage`) больше не публикуются: в шаге —
    // фактические числа финального чанка.
    expect(steps[0]!.data.usage).toEqual({ inputTokens: 100, outputTokens: 5, totalTokens: 105 });
    expect(events.filter((e) => e.event === 'stream.usage')).toHaveLength(0);
  });

  it('нулевой input не «понижает» точный output: usage шага как есть', async () => {
    const { events } = await run([
      { content: 'ok', isFinal: true, usage: { inputTokens: 0, outputTokens: 9, totalTokens: 9 }, model: 'm' },
    ]);
    const step = stepEvents(events)[0]!;
    expect(step.data.usage).toEqual({ inputTokens: 0, outputTokens: 9, totalTokens: 9 });
  });

  it('нулевой usage: на шаг ровно одно событие (live-троттлинга больше нет)', async () => {
    const chunks: LLMChunk[] = [];
    for (let i = 0; i < 5; i++) {
      chunks.push({ content: `часть${i} `, isFinal: false, usage: ZERO_USAGE });
    }
    chunks.push({ content: 'итог', isFinal: true, usage: ZERO_USAGE, model: 'm' });

    const { events } = await run(chunks);

    // Один шаг = один вызов LLM = одно `step.finished`; текст идёт дельтами
    // (`part.delta`), статистика промежуточных чанков не публикуется вовсе.
    const steps = stepEvents(events);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.data.usage).toEqual(ZERO_USAGE);
    expect(events.some((e) => e.event === 'stream.usage')).toBe(false);
    expect(events.filter((e) => e.event === 'part.delta').length).toBeGreaterThan(0);
  });

  it('без цен модели стоимость шага не пишется', async () => {
    const { events } = await run([
      { content: 'ok', isFinal: true, usage: EXACT_USAGE, model: 'm' },
    ]);
    const step = stepEvents(events)[0]!;
    expect(step.data.costUsd).toBeUndefined();
    expect(step.data.costCurrency).toBeUndefined();
  });

  it('с ценами модели costUsd/costCurrency в шаге, breakdown — в сообщении', async () => {
    const { events, sessionId } = await run(
      [{ content: 'ok', isFinal: true, usage: EXACT_USAGE, model: 'm' }],
      (model) => (model === 'm' ? { inputPrice: 1, outputPrice: 2 } : null),
    );
    const step = stepEvents(events)[0]!;
    // 100*1/1e6 + 10*2/1e6 = 0.00012
    expect(step.data.costUsd as number).toBeCloseTo(0.00012, 12);
    expect(step.data.costCurrency).toBe('USD');

    // Разбивка стоимости осталась в metadata сохранённого сообщения
    // (в событии шага её нет — перенос из удалённого `stream.usage`).
    const session = (await sessionManager.getSession(sessionId))!;
    const assistant = [...session.messages]
      .reverse()
      .find((m) => m.role === MessageRole.ASSISTANT && !m.metadata?.tool_chain)!;
    expect(assistant.metadata!.cost_usd as number).toBeCloseTo(0.00012, 12);
    const breakdown = assistant.metadata!.cost_breakdown as Record<string, number>;
    expect(breakdown.input).toBeCloseTo(0.0001, 12);
    expect(breakdown.output).toBeCloseTo(0.00002, 12);
  });

  it('валюта pricing (RUB) прокидывается в step.finished', async () => {
    const { events } = await run(
      [{ content: 'ok', isFinal: true, usage: EXACT_USAGE, model: 'm' }],
      (model) => (model === 'm' ? { inputPrice: 1, outputPrice: 2, currency: 'RUB' } : null),
    );
    expect(stepEvents(events)[0]!.data.costCurrency).toBe('RUB');
  });

  it('в агрегаты сессии попадает только usage шага (live-оценок больше нет)', async () => {
    const { sessionId } = await run([
      { content: 'ok', isFinal: false, usage: ZERO_USAGE },
      { content: 'итог', isFinal: true, usage: ZERO_USAGE, model: 'm' },
    ]);
    const session = (await sessionManager.getSession(sessionId))!;
    // Промежуточных оценок > 0 не существует — в сессию идут только цифры шага.
    expect(session.inputTokens).toBe(0);
    expect(session.outputTokens).toBe(0);
    expect(session.totalTokens).toBe(0);
  });
});
