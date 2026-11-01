import { describe, it, expect } from 'vitest';
import { checkContextWindowWindow } from './window-guard.js';

describe('checkContextWindowWindow', () => {
  it('off — не проверяет ничего (ни предупреждений, ни блокировки)', () => {
    const result = checkContextWindowWindow({
      policy: 'off',
      estimatedTokens: 1_000_000,
      windowTokens: 100,
      reserveTokens: 8192,
    });
    expect(result.action).toBe('allow');
    expect(result.reason).toBe('policy_off');
  });

  it('неизвестное окно (0/отрицательное) — не блокирует даже при enforce', () => {
    for (const windowTokens of [0, -1]) {
      const result = checkContextWindowWindow({
        policy: 'enforce',
        estimatedTokens: 500_000,
        windowTokens,
        reserveTokens: 8192,
      });
      expect(result.action).toBe('allow');
      expect(result.reason).toBe('unknown_window');
    }
  });

  it('warn — никогда не блокирует, даже если оценка выше окна', () => {
    const result = checkContextWindowWindow({
      policy: 'warn',
      estimatedTokens: 200,
      windowTokens: 100,
      reserveTokens: 0,
    });
    expect(result.action).toBe('allow');
    expect(result.reason).toBe('fits');
    expect(result.allowLimit).toBe(100);
  });

  it('enforce + превышение лимита (окно минус резерв) — block', () => {
    const result = checkContextWindowWindow({
      policy: 'enforce',
      estimatedTokens: 900,
      windowTokens: 1000,
      reserveTokens: 200,
    });
    expect(result.action).toBe('block');
    expect(result.reason).toBe('exceeded');
    expect(result.allowLimit).toBe(800);
  });

  it('enforce + ровно на границе — allow (строго больше блокирует)', () => {
    const result = checkContextWindowWindow({
      policy: 'enforce',
      estimatedTokens: 800,
      windowTokens: 1000,
      reserveTokens: 200,
    });
    expect(result.action).toBe('allow');
    expect(result.reason).toBe('fits');
  });

  it('отрицательный резерв трактуется как 0', () => {
    const result = checkContextWindowWindow({
      policy: 'enforce',
      estimatedTokens: 1001,
      windowTokens: 1000,
      reserveTokens: -500,
    });
    expect(result.action).toBe('block');
    expect(result.allowLimit).toBe(1000);
  });

  it('без резерва лимит равен окну', () => {
    const result = checkContextWindowWindow({
      policy: 'enforce',
      estimatedTokens: 1001,
      windowTokens: 1000,
    });
    expect(result.action).toBe('block');
    expect(result.allowLimit).toBe(1000);
  });
});
