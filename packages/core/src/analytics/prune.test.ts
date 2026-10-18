/**
 * PROP-102 §8: retention-очистка суточных роллапов — граница `utcDay(now - N)`,
 * ограничение `<= 0` и прогон на старте.
 */

import { describe, expect, it, vi } from 'vitest';
import { analyticsRetentionCutoff, startAnalyticsRollupPruner } from './prune.js';
import { MemoryAnalyticsRollupRepository } from '../storage/memory/analytics-rollup.js';
import type { AnalyticsRollupRepository } from '../storage/ports/analytics-rollup-repository.js';

const NOW = new Date('2026-10-18T12:00:00.000Z');

describe('analyticsRetentionCutoff', () => {
  it('граница — сутки UTC за retentionDays до now', () => {
    expect(analyticsRetentionCutoff(10, NOW)).toBe('2026-10-08');
    expect(analyticsRetentionCutoff(1, NOW)).toBe('2026-10-17');
    expect(analyticsRetentionCutoff(400, NOW)).toBe('2025-09-13');
  });

  it('retentionDays <= 0 — без ограничения (null)', () => {
    expect(analyticsRetentionCutoff(0, NOW)).toBeNull();
    expect(analyticsRetentionCutoff(-5, NOW)).toBeNull();
    expect(analyticsRetentionCutoff(Number.NaN, NOW)).toBeNull();
  });
});

describe('startAnalyticsRollupPruner', () => {
  it('на старте удаляет бакеты старше границы, свежие оставляет', async () => {
    const repo = new MemoryAnalyticsRollupRepository();
    for (const day of ['2026-09-01', '2026-10-08', '2026-10-18']) {
      await repo.increment({ family: 'usage', day, dimensions: {}, measures: { requests: 1 } });
    }

    const stop = startAnalyticsRollupPruner(repo, {
      getRetentionDays: () => 10,
      now: () => NOW,
    });

    await vi.waitFor(async () => {
      const rows = await repo.query({ family: 'usage', groupBy: ['day'] });
      expect(rows.map((row) => row.dimensions.day)).toEqual(['2026-10-08', '2026-10-18']);
    });
    stop();
  });

  it('retentionDays <= 0 — prune не вызывается', async () => {
    const prune = vi.fn<() => Promise<number>>(async () => 0);
    const repo: AnalyticsRollupRepository = {
      increment: async () => {},
      set: async () => {},
      query: async () => [],
      prune,
      clear: async () => 0,
    };

    const stop = startAnalyticsRollupPruner(repo, {
      getRetentionDays: () => 0,
      now: () => NOW,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(prune).not.toHaveBeenCalled();
    stop();
  });

  it('ошибка порта логируется warn-ом и не роняет процесс', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repo: AnalyticsRollupRepository = {
      increment: async () => {},
      set: async () => {},
      query: async () => [],
      prune: async () => {
        throw new Error('io error');
      },
      clear: async () => 0,
    };

    const stop = startAnalyticsRollupPruner(repo, {
      getRetentionDays: () => 30,
      now: () => NOW,
    });

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    expect(warn.mock.calls[0]![0]).toContain('io error');
    warn.mockRestore();
    stop();
  });
});
