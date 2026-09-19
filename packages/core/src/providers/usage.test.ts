import { describe, it, expect } from 'vitest';
import { computeCacheHitRate } from './usage.js';

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
