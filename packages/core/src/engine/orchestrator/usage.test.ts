/**
 * ADR-095 (шаг 6a): собственные тесты usage/cost-хелперов оркестратора.
 *
 * Контракты: fallback-цепочка модели сообщения (ADR-070 §2.6), best-effort
 * оценка usage, стоимость только при известных ценах и агрегация статистики
 * сабагентов из tool-результатов `task`.
 *
 * ADR-118 §4: live-событие `stream.usage` удалено — расход шага едет в
 * `step.finished` (`usage`), поэтому отдельного теста на троттлинг/дедуп
 * публикации usage больше нет.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Session, TokenUsage } from '@itphx/synth-shared';
import {
  computeMessageCost,
  resolveMessageModel,
  estimateUsage,
  estimatePromptChars,
  aggregateSubagentStats,
} from './usage.js';
import type { BaseProvider } from '../../providers/base.js';

const USAGE: TokenUsage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };

function makeSession(settings: Partial<Session['settings']> = {}): Session {
  return { id: 's1', settings: { ...settings } } as unknown as Session;
}

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
