import { describe, it, expect } from 'vitest';
import { parseTokenPricing, toNonNegativeNumber } from './base.js';

describe('toNonNegativeNumber', () => {
  it('принимает числа и числовые строки', () => {
    expect(toNonNegativeNumber(0)).toBe(0);
    expect(toNonNegativeNumber(12.5)).toBe(12.5);
    expect(toNonNegativeNumber('131072')).toBe(131072);
  });

  it('отбрасывает пустые/невалидные/отрицательные значения', () => {
    expect(toNonNegativeNumber(undefined)).toBeUndefined();
    expect(toNonNegativeNumber(null)).toBeUndefined();
    expect(toNonNegativeNumber('')).toBeUndefined();
    expect(toNonNegativeNumber('abc')).toBeUndefined();
    expect(toNonNegativeNumber(Infinity)).toBeUndefined();
    expect(toNonNegativeNumber(NaN)).toBeUndefined();
    expect(toNonNegativeNumber(-1)).toBeUndefined();
  });
});

describe('parseTokenPricing — нормировка к 1M токенов', () => {
  it('строки/числа умножаются на 1_000_000, priceUnit=token', () => {
    const result = parseTokenPricing(
      { prompt: '0.000001', completion: 0.000002 },
      undefined,
    );
    expect(result).toEqual({
      priceUnit: 'token',
      inputPrice: 1,
      outputPrice: 2,
    });
  });

  it('cache read/write из токенных ключей', () => {
    const result = parseTokenPricing(
      { input_cache_read: '0.0000001', input_cache_write: 0.0000002 },
      undefined,
    );
    expect(result?.priceUnit).toBe('token');
    expect(result?.cacheReadPrice).toBeCloseTo(0.1, 9);
    expect(result?.cacheWritePrice).toBeCloseTo(0.2, 9);
  });

  it('алиасы input/output/cache_read/cache_write', () => {
    const result = parseTokenPricing(
      { input: '0.000003', output: '0.000004', cached_input: '0.0000005', cache_write: '0.000001' },
      undefined,
    );
    expect(result).toEqual({
      priceUnit: 'token',
      inputPrice: 3,
      outputPrice: 4,
      cacheReadPrice: 0.5,
      cacheWritePrice: 1,
    });
  });
});

describe('parseTokenPricing — фильтр non-token тарифов', () => {
  it('units явно помечают completion как request — цена не попадает', () => {
    const result = parseTokenPricing(
      { prompt: '0.000001', completion: '0.000002', request: '0.01' },
      { prompt: 'token', completion: 'request', request: 'request' },
    );
    expect(result).toEqual({ priceUnit: 'token', inputPrice: 1 });
    expect(result).not.toHaveProperty('outputPrice');
    expect(result).not.toHaveProperty('cacheReadPrice');
  });

  it('pricing_units с web_search: request игнорируется', () => {
    const result = parseTokenPricing(
      { prompt: '0.000001', completion: '0.000002', web_search: '0.004' },
      { prompt: 'token', completion: 'token', web_search: 'request' },
    );
    expect(result).toEqual({ priceUnit: 'token', inputPrice: 1, outputPrice: 2 });
  });

  it('только non-token тарифы → undefined', () => {
    expect(parseTokenPricing(
      { request: '0.01', image: '0.04' },
      { request: 'request', image: 'image' },
    )).toBeUndefined();
  });

  it('отсутствие pricing → undefined', () => {
    expect(parseTokenPricing(undefined, undefined)).toBeUndefined();
  });

  it('невалидные значения пропускаются, валидный 0 сохраняется', () => {
    const result = parseTokenPricing({ prompt: 'abc', completion: 0 }, undefined);
    expect(result).toEqual({ priceUnit: 'token', outputPrice: 0 });
    expect(result).not.toHaveProperty('inputPrice');
  });

  it('отрицательные значения отбрасываются', () => {
    expect(parseTokenPricing({ prompt: -1 }, undefined)).toBeUndefined();
  });
});
