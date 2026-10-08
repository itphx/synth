import { describe, it, expect } from 'vitest';
import { parseDurationMs, isValidDuration } from './duration.js';

describe('parseDurationMs (AD-051)', () => {
  it('поддерживаемые единицы s/m/h/d', () => {
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('15m')).toBe(900_000);
    expect(parseDurationMs('1h')).toBe(3_600_000);
    expect(parseDurationMs('24h')).toBe(86_400_000);
    expect(parseDurationMs('2d')).toBe(172_800_000);
  });

  it('обрезает пробелы вокруг', () => {
    expect(parseDurationMs('  5m  ')).toBe(300_000);
  });

  it('невалидные интервалы → Error', () => {
    for (const bad of ['1w', 'h', '', '1.5h', '1H', '-5m', '5 m', 'm5']) {
      expect(() => parseDurationMs(bad)).toThrow();
    }
  });
});

describe('isValidDuration (AD-051)', () => {
  it('валидные/невалидные', () => {
    expect(isValidDuration('10s')).toBe(true);
    expect(isValidDuration('3d')).toBe(true);
    expect(isValidDuration('1w')).toBe(false);
    expect(isValidDuration('')).toBe(false);
  });
});
