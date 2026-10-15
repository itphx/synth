/**
 * Юнит-тесты RateLimiter (ADR-036): in-memory sliding window 60s.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { RateLimiter } from './rate-limiter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RateLimiter', () => {
  it('userPerMinute=2: 2 вызова ок, 3-й false', () => {
    const rl = new RateLimiter(2, 100);
    expect(rl.checkUser('u1')).toBe(true);
    expect(rl.checkUser('u1')).toBe(true);
    expect(rl.checkUser('u1')).toBe(false);
  });

  it('providerPerMinute аналогично', () => {
    const rl = new RateLimiter(100, 2);
    expect(rl.checkProvider('p1')).toBe(true);
    expect(rl.checkProvider('p1')).toBe(true);
    expect(rl.checkProvider('p1')).toBe(false);
  });

  it('reset() сбрасывает счётчики', () => {
    const rl = new RateLimiter(1, 1);
    expect(rl.checkUser('u1')).toBe(true);
    expect(rl.checkUser('u1')).toBe(false);
    rl.reset();
    expect(rl.checkUser('u1')).toBe(true);
    expect(rl.checkProvider('p1')).toBe(true);
    expect(rl.checkProvider('p1')).toBe(false);
    rl.reset();
    expect(rl.checkProvider('p1')).toBe(true);
  });

  it('разные userId не влияют друг на друга', () => {
    const rl = new RateLimiter(1, 100);
    expect(rl.checkUser('u1')).toBe(true);
    expect(rl.checkUser('u2')).toBe(true); // u2 не затронут лимитом u1
    expect(rl.checkUser('u1')).toBe(false);
    expect(rl.checkUser('u2')).toBe(false); // лимит u2 тоже достигнут
  });

  it('пустой userId/provider → всегда true (без лимита)', () => {
    const rl = new RateLimiter(1, 1);
    expect(rl.checkUser('')).toBe(true);
    expect(rl.checkUser('')).toBe(true);
    expect(rl.checkProvider('')).toBe(true);
  });

  it('старые записи истекают после окна 60s', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const rl = new RateLimiter(1, 100);

    expect(rl.checkUser('u1')).toBe(true); // запись при t=1_000_000
    expect(rl.checkUser('u1')).toBe(false); // лимит 1 достигнут

    // окно (60_000 мс) истекло → запись становится старой
    nowSpy.mockReturnValue(1_000_000 + 60_001);
    expect(rl.checkUser('u1')).toBe(true);
  });

  it('лимит 0/отрицательный — каждый вызов отклоняется (нет записей в окне)', () => {
    const rl = new RateLimiter(0, 100);
    expect(rl.checkUser('u1')).toBe(false);
    expect(rl.checkUser('u1')).toBe(false);
  });
});
