import { describe, it, expect } from 'vitest';
import { computeCacheHitRate, computeUsageCost, parseUsageCost } from './usage.js';
import type { TokenUsage } from '@itphx/synth-shared';

const USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 10,
  totalTokens: 110,
  cacheReadTokens: 40,
  cacheWriteTokens: 20,
};

describe('computeCacheHitRate (ADR-070 §2.3)', () => {
  it('считает долю кэшированных входных токенов', () => {
    expect(computeCacheHitRate(50, 100)).toBe(0.5);
    expect(computeCacheHitRate(100, 100)).toBe(1);
    expect(computeCacheHitRate(0, 100)).toBe(0);
  });

  it('возвращает 0 при inputTokens === 0 (граничный случай)', () => {
    expect(computeCacheHitRate(10, 0)).toBe(0);
    expect(computeCacheHitRate(0, 0)).toBe(0);
    expect(computeCacheHitRate(undefined, undefined)).toBe(0);
  });

  it('undefined cacheRead трактуется как 0', () => {
    expect(computeCacheHitRate(undefined, 100)).toBe(0);
  });
});

describe('computeUsageCost (ADR-070 §2.6)', () => {
  it('возвращает null без usage или без pricing', () => {
    expect(computeUsageCost(undefined, { inputPrice: 1 })).toBeNull();
    expect(computeUsageCost(USAGE, null)).toBeNull();
    expect(computeUsageCost(USAGE, undefined)).toBeNull();
  });

  it('возвращает null, если ни одна цена не задана (не путать с «бесплатно»)', () => {
    expect(computeUsageCost(USAGE, {})).toBeNull();
    expect(
      computeUsageCost(USAGE, {
        inputPrice: undefined,
        outputPrice: undefined,
        cacheReadPrice: undefined,
        cacheWritePrice: undefined,
      }),
    ).toBeNull();
  });

  it('считает стоимость, если задана хотя бы одна цена', () => {
    const onlyInput = computeUsageCost(USAGE, { inputPrice: 1 });
    expect(onlyInput).not.toBeNull();
    expect(onlyInput!.costUsd).toBeCloseTo(100 / 1_000_000, 12);
    expect(onlyInput!.breakdown).toEqual({
      input: 100 / 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('суммирует все заданные цены', () => {
    const cost = computeUsageCost(USAGE, {
      inputPrice: 1,
      outputPrice: 2,
      cacheReadPrice: 0.5,
      cacheWritePrice: 1.5,
    });
    expect(cost).not.toBeNull();
    const div = 1_000_000;
    expect(cost!.costUsd).toBeCloseTo((100 * 1 + 10 * 2 + 40 * 0.5 + 20 * 1.5) / div, 12);
  });

  it('цена 0 — валидная (задана), стоимость 0 сохраняется', () => {
    const cost = computeUsageCost(USAGE, { inputPrice: 0 });
    expect(cost).not.toBeNull();
    expect(cost!.costUsd).toBe(0);
  });

  it('валюта по умолчанию — USD (обратная совместимость)', () => {
    const cost = computeUsageCost(USAGE, { inputPrice: 1 });
    expect(cost!.currency).toBe('USD');
  });

  it('валюта pricing прокидывается в UsageCost', () => {
    const cost = computeUsageCost(USAGE, { inputPrice: 1, currency: 'RUB' });
    expect(cost!.currency).toBe('RUB');
  });

  it('стоимость провайдера приоритетнее каталога', () => {
    const cost = computeUsageCost(
      { ...USAGE, cost: { amount: 0.42, currency: 'CNY' } },
      { inputPrice: 1, outputPrice: 2, currency: 'USD' },
    );
    expect(cost).not.toBeNull();
    expect(cost!.costUsd).toBe(0.42);
    expect(cost!.currency).toBe('CNY');
    expect(cost!.breakdown).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('provider cost=0 достоверен (не проваливается в каталог)', () => {
    const cost = computeUsageCost(
      { ...USAGE, cost: { amount: 0, currency: 'USD' } },
      { inputPrice: 1 },
    );
    expect(cost!.costUsd).toBe(0);
  });

  it('provider cost работает и без pricing', () => {
    const cost = computeUsageCost(
      { ...USAGE, cost: { amount: 0.1, currency: 'RUB' } },
      null,
    );
    expect(cost!.costUsd).toBe(0.1);
    expect(cost!.currency).toBe('RUB');
  });
});

describe('parseUsageCost (provider usage)', () => {
  it('разбирает числовые поля cost/total_cost/cost_usd', () => {
    expect(parseUsageCost({ cost: 0.5 })).toEqual({ amount: 0.5, currency: 'USD' });
    expect(parseUsageCost({ total_cost: 1.5, currency: 'RUB' })).toEqual({ amount: 1.5, currency: 'RUB' });
    expect(parseUsageCost({ cost_usd: 2, currency: 'CNY' })).toEqual({ amount: 2, currency: 'CNY' });
  });

  it('разбирает объект cost {amount, currency}', () => {
    expect(parseUsageCost({ cost: { amount: 0.2, currency: 'RUB' } }))
      .toEqual({ amount: 0.2, currency: 'RUB' });
  });

  it('0 — достоверное значение; неизвестная валюта → USD', () => {
    expect(parseUsageCost({ cost: 0 })).toEqual({ amount: 0, currency: 'USD' });
    expect(parseUsageCost({ cost: 1, currency: 'EUR' })).toEqual({ amount: 1, currency: 'USD' });
  });

  it('нет поля/невалидное значение → undefined', () => {
    expect(parseUsageCost(undefined)).toBeUndefined();
    expect(parseUsageCost({ prompt_tokens: 1 })).toBeUndefined();
    expect(parseUsageCost({ cost: 'nope' })).toBeUndefined();
  });
});
