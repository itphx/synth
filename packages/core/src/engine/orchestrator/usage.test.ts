/**
 * ADR-095 (шаг 6a): собственные тесты usage/cost-хелперов оркестратора.
 *
 * Контракты: fallback-цепочка модели сообщения (ADR-070 §2.6), best-effort
 * оценка usage, стоимость только при известных ценах, live-событие
 * `stream.usage` (троттлинг + дедуп по подписи + снимок usage) и агрегация
 * статистики сабагентов из tool-результатов `task`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Session, TokenUsage } from '@itphx/synth-shared';
import {
  computeMessageCost,
  resolveMessageModel,
  estimateUsage,
  estimatePromptChars,
  publishLiveUsage,
  aggregateSubagentStats,
  STREAM_USAGE_THROTTLE_MS,
} from './usage.js';
import type { BaseProvider } from '../../providers/base.js';

const USAGE: TokenUsage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };

function makeSession(settings: Partial<Session['settings']> = {}): Session {
  return { id: 's1', settings: { ...settings } } as unknown as Session;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('computeMessageCost / resolveMessageModel', () => {
  it('без модели или без usage стоимость не считается', () => {
    const loader = vi.fn(() => ({ inputPrice: 1 }));
    expect(computeMessageCost(undefined, USAGE, loader)).toBeNull();
    expect(computeMessageCost('m', undefined, loader)).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it('нет загрузчика цен или цен модели → null (cost_usd не пишется)', () => {
    expect(computeMessageCost('m', USAGE, null)).toBeNull();
    expect(computeMessageCost('m', USAGE, () => null)).toBeNull();
    expect(computeMessageCost('m', USAGE, () => ({}))).toBeNull();
  });

  it('цены модели → стоимость и валюта из pricing', () => {
    const cost = computeMessageCost('m', USAGE, () => ({
      inputPrice: 2,
      outputPrice: 4,
      currency: 'RUB',
    }));
    expect(cost).not.toBeNull();
    expect(cost!.currency).toBe('RUB');
    expect(cost!.costUsd).toBeCloseTo((100 * 2 + 10 * 4) / 1_000_000, 12);
  });

  it('resolveMessageModel: chunk → final → provider → настройка сессии', () => {
    const provider = { model: 'p-model' } as unknown as BaseProvider;
    const session = makeSession({ model: 's-model' });

    expect(resolveMessageModel('chunk', 'final', provider, session)).toBe('chunk');
    expect(resolveMessageModel(undefined, 'final', provider, session)).toBe('final');
    expect(resolveMessageModel(undefined, undefined, provider, session)).toBe('p-model');
    expect(resolveMessageModel(undefined, undefined, undefined, session)).toBe('s-model');
    expect(resolveMessageModel(undefined, undefined, undefined, makeSession())).toBeUndefined();
  });
});

describe('estimateUsage / estimatePromptChars', () => {
  it('реальные значения не перетираются, estimated остаётся false', () => {
    const result = estimateUsage(USAGE, 4_000, 400);
    expect(result).toEqual({ usage: USAGE, estimated: false });
  });

  it('пустой usage оценивается эвристикой chars/4 (input и output)', () => {
    const result = estimateUsage(undefined, 8, 5);
    expect(result.estimated).toBe(true);
    expect(result.usage).toMatchObject({ inputTokens: 2, outputTokens: 2, totalTokens: 4 });
  });

  it('дозаполняется только отсутствующая часть, estimated=true при любой дооценке', () => {
    const result = estimateUsage({ inputTokens: 100, outputTokens: 0, totalTokens: 0 }, 4_000, 4);
    expect(result.estimated).toBe(true);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(1);
    expect(result.usage.totalTokens).toBe(101);
  });

  it('нулевые входы → ничего не оценивается, estimated=false', () => {
    const result = estimateUsage(undefined, 0, 0);
    expect(result.estimated).toBe(false);
    expect(result.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it('estimatePromptChars складывает content + toolUse + reasoning + system + tools', () => {
    const chars = estimatePromptChars(
      [
        { content: 'abc', toolUse: [{ a: 1 }], reasoning: 'rr' },
        { content: 'de' },
      ] as never,
      { text: 'sys' } as never,
      [{ name: 't' }],
    );
    expect(chars).toBe(3 + JSON.stringify([{ a: 1 }]).length + 2 + 2 + 3 + JSON.stringify([{ name: 't' }]).length);
  });

  it('estimatePromptChars: пустой system/tools ничего не добавляют', () => {
    expect(estimatePromptChars([] as never, undefined)).toBe(0);
    expect(estimatePromptChars([{ content: 'a' }] as never, '', [])).toBe(1);
  });
});

describe('publishLiveUsage — троттлинг, дедуп, контракт события', () => {
  function makeState() {
    return { lastPublishedAt: 0, lastSignature: '', exactPublished: false, inputExactPublished: false };
  }

  function call(
    state: ReturnType<typeof makeState>,
    publishChunk: (event: string, data: Record<string, unknown>) => void,
    overrides: Partial<Parameters<typeof publishLiveUsage>[0]> = {},
    computeCost = vi.fn(() => null),
  ) {
    publishLiveUsage(
      {
        publishChunk,
        state,
        sessionId: 's1',
        streamId: 'stream1',
        iteration: 2,
        usage: { ...USAGE },
        estimated: false,
        ...overrides,
      },
      computeCost as never,
    );
    return computeCost;
  }

  it('первая публикация несёт контрактные поля и снимок usage', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = makeState();
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const usage = { ...USAGE };

    call(state, (event, data) => events.push({ event, data }), {
      usage,
      agentRole: 'developer',
      model: 'm',
      provider: 'p',
      estimated: true,
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('stream.usage');
    expect(events[0]!.data).toMatchObject({
      session_id: 's1',
      stream_id: 'stream1',
      iteration: 2,
      agent_role: 'developer',
      model: 'm',
      provider: 'p',
      estimated: true,
      usage: USAGE,
    });

    // Снимок: провайдер мутирует running total in place — событие не должно «поехать»
    usage.inputTokens = 999;
    expect((events[0]!.data.usage as TokenUsage).inputTokens).toBe(100);
    expect(state.lastSignature).toBe('e:100:10:110:0:0:0');
  });

  it('повторная подпись usage не публикуется (дедуп), даже спустя окно троттлинга', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = makeState();
    const events: unknown[] = [];
    const publish = (_e: string, d: Record<string, unknown>) => events.push(d);

    call(state, publish);
    vi.setSystemTime(1_000_000 + STREAM_USAGE_THROTTLE_MS * 10);
    call(state, publish);

    expect(events).toHaveLength(1);
  });

  it('другая подпись внутри окна троттлинга не публикуется, после окна — публикуется', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = makeState();
    const events: Array<Record<string, unknown>> = [];
    const publish = (_e: string, d: Record<string, unknown>) => events.push(d);

    call(state, publish);
    vi.setSystemTime(1_000_000 + STREAM_USAGE_THROTTLE_MS - 1);
    call(state, publish, { usage: { inputTokens: 101, outputTokens: 10, totalTokens: 111 } });
    expect(events).toHaveLength(1);

    vi.setSystemTime(1_000_000 + STREAM_USAGE_THROTTLE_MS);
    call(state, publish, { usage: { inputTokens: 101, outputTokens: 10, totalTokens: 111 } });
    expect(events).toHaveLength(2);
  });

  it('force публикует даже ту же подпись внутри окна', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const state = makeState();
    const events: unknown[] = [];
    const publish = (_e: string, d: Record<string, unknown>) => events.push(d);

    call(state, publish);
    call(state, publish, { force: true });
    expect(events).toHaveLength(2);
  });

  it('cost не считается без модели; с моделью и ценами поля cost_* добавляются', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const events: Array<Record<string, unknown>> = [];
    const publish = (_e: string, d: Record<string, unknown>) => events.push(d);

    const costlessLoader = call(makeState(), publish, {});
    expect(costlessLoader).not.toHaveBeenCalled();
    expect(events[0]!.cost_usd).toBeUndefined();

    const withCost = call(makeState(), publish, { model: 'm' }, vi.fn(() => ({
      costUsd: 1.5,
      breakdown: { input: 1, output: 0.5, cacheRead: 0, cacheWrite: 0 },
      currency: 'USD',
    })) as never);
    expect(withCost).toHaveBeenCalledWith('m', expect.anything());
    expect(events[1]).toMatchObject({ cost_usd: 1.5, cost_currency: 'USD' });
    expect(events[1]!.cost_breakdown).toBeDefined();
  });

  it('пустые agentRole/model/provider не попадают в событие', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const events: Array<Record<string, unknown>> = [];
    call(makeState(), (_e, d) => events.push(d));

    expect(events[0]).not.toHaveProperty('agent_role');
    expect(events[0]).not.toHaveProperty('model');
    expect(events[0]).not.toHaveProperty('provider');
  });
});

describe('aggregateSubagentStats — статистика сабагентов из tool-результатов task', () => {
  const subagentResult = (
    metadata: Record<string, unknown> | undefined,
    name = 'task',
  ): Record<string, unknown> => ({ name, ...(metadata ? { result: { metadata } } : {}) });

  const costUsd = (model: string | undefined, usage: TokenUsage | undefined) =>
    model === 'sub' && usage
      ? { costUsd: 0.5, breakdown: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0 }, currency: 'USD' as const }
      : model === 'sub-rub' && usage
        ? { costUsd: 1, breakdown: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, currency: 'RUB' as const }
        : null;

  it('без task-результатов с usage/child_session_id → undefined', () => {
    expect(aggregateSubagentStats([], costUsd)).toBeUndefined();
    expect(aggregateSubagentStats([subagentResult(undefined)], costUsd)).toBeUndefined();
    expect(
      aggregateSubagentStats([subagentResult({ readonly: true })], costUsd),
    ).toBeUndefined();
    expect(
      aggregateSubagentStats([subagentResult({ child_session_id: 'c1' })], costUsd),
    ).toEqual({
      sessions: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      cost_usd: 0,
      cost_by_currency: {},
    });
  });

  it('игнорирует не-task тулы и не-объекты, суммирует usage и стоимость по валютам', () => {
    const stats = aggregateSubagentStats(
      [
        null as never,
        'строка' as never,
        { name: 'read_file', result: { metadata: { child_session_id: 'x', subagent_usage: USAGE } } },
        subagentResult({
          child_session_id: 'c1',
          subagent_usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11, cacheReadTokens: 2, cacheWriteTokens: 3, reasoningTokens: 4 },
          subagent_model: 'sub',
        }),
        subagentResult({
          child_session_id: 'c2',
          subagent_usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
          routing_model: 'sub-rub',
        }),
        subagentResult({
          child_session_id: 'c3',
          subagent_usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
          subagent_model: 'unknown-model',
        }),
      ],
      costUsd,
    );

    expect(stats).toEqual({
      sessions: 3,
      input_tokens: 35,
      output_tokens: 4,
      cache_read_tokens: 2,
      cache_write_tokens: 3,
      reasoning_tokens: 4,
      cost_usd: 1.5,
      cost_by_currency: { USD: 0.5, RUB: 1 },
    });
  });

  it('subagent_model приоритетнее routing_model', () => {
    const stats = aggregateSubagentStats(
      [
        subagentResult({
          child_session_id: 'c1',
          subagent_usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          subagent_model: 'sub',
          routing_model: 'sub-rub',
        }),
      ],
      costUsd,
    );
    expect(stats!.cost_by_currency).toEqual({ USD: 0.5 });
  });
});
