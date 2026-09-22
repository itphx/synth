import { describe, it, expect } from 'vitest';
import { computeCacheHitRate, computeUsageCost } from './usage.js';
import type { TokenUsage } from '@itphx/synth-shared';

const USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 10,
  totalTokens: 110,
  cacheReadTokens: 40,
  cacheWriteTokens: 20,
};

describe('computeCacheHitRate (AD-070 §2.3)', () => {
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

describe('computeUsageCost (AD-070 §2.6)', () => {
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
});
