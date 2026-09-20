/**
 * AD-071 §2.6: оценка токенов по символам и калибровка chars-per-token.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CHARS_PER_TOKEN,
  MAX_CHARS_PER_TOKEN,
  MIN_CALIBRATION_INPUT_TOKENS,
  MIN_CHARS_PER_TOKEN,
  RATIO_EWMA_ALPHA,
  calibrateCharsPerToken,
  estimateTokens,
} from './token-ratio.js';

describe('estimateTokens', () => {
  it('дефолтный ratio = 4', () => {
    expect(DEFAULT_CHARS_PER_TOKEN).toBe(4);
    expect(estimateTokens(400)).toBe(100);
    expect(estimateTokens(401)).toBe(101); // ceil
  });

  it('использует переданный ratio', () => {
    expect(estimateTokens(400, 8)).toBe(50);
    expect(estimateTokens(400, 2)).toBe(200);
  });

  it('нулевые/отрицательные/невалидные chars → 0', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(-10)).toBe(0);
    expect(estimateTokens(Number.NaN)).toBe(0);
  });

  it('невалидный ratio → дефолт', () => {
    expect(estimateTokens(400, 0)).toBe(100);
    expect(estimateTokens(400, Number.NaN)).toBe(100);
  });
});

describe('calibrateCharsPerToken', () => {
  it('первый семпл берётся как есть', () => {
    const ratio = calibrateCharsPerToken(4000, 1000);
    expect(ratio).toBe(4);
  });

  it('inputTokens ниже порога → null', () => {
    expect(MIN_CALIBRATION_INPUT_TOKENS).toBe(500);
    expect(calibrateCharsPerToken(4000, 499)).toBeNull();
  });

  it('аномально низкий/высокий ratio → null (границы 2..8)', () => {
    // 100 chars / 1000 tokens = 0.1 < 2
    expect(calibrateCharsPerToken(100, 1000)).toBeNull();
    // 10000 / 1000 = 10 > 8
    expect(calibrateCharsPerToken(10_000, 1000)).toBeNull();
    // ровно на границах — принимается
    expect(calibrateCharsPerToken(MIN_CHARS_PER_TOKEN * 1000, 1000)).toBeCloseTo(MIN_CHARS_PER_TOKEN);
    expect(calibrateCharsPerToken(MAX_CHARS_PER_TOKEN * 1000, 1000)).toBeCloseTo(MAX_CHARS_PER_TOKEN);
  });

  it('невалидные promptChars/inputTokens → null', () => {
    expect(calibrateCharsPerToken(0, 1000)).toBeNull();
    expect(calibrateCharsPerToken(-1, 1000)).toBeNull();
    expect(calibrateCharsPerToken(4000, 0)).toBeNull();
    expect(calibrateCharsPerToken(4000, Number.NaN)).toBeNull();
  });

  it('EWMA: новый семпл сглаживается с текущим (α = 0.3)', () => {
    // current=4, observed=8 → 4*0.7 + 8*0.3 = 5.2
    const next = calibrateCharsPerToken(8000, 1000, 4);
    expect(next).toBeCloseTo(4 * (1 - RATIO_EWMA_ALPHA) + 8 * RATIO_EWMA_ALPHA);
    expect(next).toBeCloseTo(5.2);
  });

  it('результат клампится в границы 2..8', () => {
    const next = calibrateCharsPerToken(8000, 1000, 7.9);
    expect(next).toBeLessThanOrEqual(MAX_CHARS_PER_TOKEN);
    expect(next).toBeGreaterThanOrEqual(MIN_CHARS_PER_TOKEN);
  });
});
