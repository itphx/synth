/**
 * ADR-089 Этап 4a: ephemeral-сессии — TTL и авто-архивация.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseTtl, startEphemeralSweeper, DEFAULT_EPHEMERAL_SWEEP_INTERVAL_MS } from './ephemeral.js';
import type { SessionManager } from './manager.js';

describe('parseTtl', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('парсит секунды', () => {
    expect(parseTtl('30s', now)).toBe('2026-01-01T00:00:30.000Z');
  });

  it('парсит минуты', () => {
    expect(parseTtl('15m', now)).toBe('2026-01-01T00:15:00.000Z');
  });

  it('парсит часы', () => {
    expect(parseTtl('24h', now)).toBe('2026-01-02T00:00:00.000Z');
  });

  it('парсит дни', () => {
    expect(parseTtl('7d', now)).toBe('2026-01-08T00:00:00.000Z');
  });

  it('игнорирует обрамляющие пробелы', () => {
    expect(parseTtl(' 5m ', now)).toBe('2026-01-01T00:05:00.000Z');
  });

  it('бросает на невалидном формате', () => {
    for (const bad of ['', 'abc', '15', 'm15', '15x', '-5m', '1.5h', '15m30s']) {
      expect(() => parseTtl(bad, now), `ожидалась ошибка для "${bad}"`).toThrow(/невалидный TTL/);
    }
  });
});

describe('startEphemeralSweeper', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('периодически вызывает archiveExpired и останавливается', async () => {
    vi.useFakeTimers();
    const archiveExpired = vi.fn(async () => []);
    const manager = { archiveExpired } as unknown as SessionManager;

    const stop = startEphemeralSweeper(manager, 1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(archiveExpired).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(archiveExpired).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(archiveExpired).toHaveBeenCalledTimes(3);
  });

  it('логирует ошибку sweep, не роняя процесс', async () => {
    vi.useFakeTimers();
    const archiveExpired = vi.fn(async () => { throw new Error('boom'); });
    const manager = { archiveExpired } as unknown as SessionManager;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stop = startEphemeralSweeper(manager, 500);
    await vi.advanceTimersByTimeAsync(500);
    // Дать отработать .catch() внутри воркера.
    await vi.advanceTimersByTimeAsync(0);

    expect(warn).toHaveBeenCalledTimes(1);
    stop();
  });

  it('дефолтный интервал — 60 c', () => {
    expect(DEFAULT_EPHEMERAL_SWEEP_INTERVAL_MS).toBe(60_000);
  });
});
