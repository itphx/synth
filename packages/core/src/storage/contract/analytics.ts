import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { AnalyticsRollupBucket } from '@itphx/synth-shared';
import type { AnalyticsRollupRepository } from '../ports/index.js';

/** Минимальный бакет роллапа с переопределениями. */
function bucket(over: Partial<AnalyticsRollupBucket> = {}): AnalyticsRollupBucket {
  return {
    family: 'usage',
    day: '2026-01-15',
    dimensions: {},
    measures: {},
    ...over,
  };
}

/**
 * Паспорт порта `AnalyticsRollupRepository` (ADR-102): пред-агрегированные
 * суточные роллапы. Ключ бакета `(family, day, dimensions)`; `increment` —
 * upsert с суммированием мер, `set` — точная перезапись; `query` фильтрует
 * (семейство/период включительно/оси) и агрегирует по `groupBy` (пусто — одна
 * итоговая строка); `prune`/`clear` возвращают число удалённых. `filePath` —
 * только для файловой реализации (повреждённый файл/невалидные бакеты).
 */
export function describeAnalyticsRollupRepository(
  name: string,
  make: () => Promise<{
    repo: AnalyticsRollupRepository;
    dispose?: () => Promise<void>;
    filePath?: string;
  }>,
): void {
  describe(name, () => {
    it('пустой стор: query — [], prune/clear — 0', async () => {
      const { repo } = await make();
      expect(await repo.query({ family: 'usage' })).toEqual([]);
      expect(await repo.prune('2026-01-01')).toBe(0);
      expect(await repo.clear()).toBe(0);
    });

    it('increment — upsert по ключу с суммированием мер и разбивки по валютам', async () => {
      const { repo } = await make();
      await repo.increment(
        bucket({
          dimensions: { user: 'u1' },
          measures: { input_tokens: 10, requests: 1 },
          costByCurrency: { usd: 0.5 },
        }),
      );
      await repo.increment(
        bucket({
          dimensions: { user: 'u1' },
          measures: { input_tokens: 5, output_tokens: 2 },
          costByCurrency: { usd: 0.25, eur: 1 },
        }),
      );

      const rows = await repo.query({ family: 'usage' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dimensions).toEqual({});
      expect(rows[0]!.measures).toEqual({ input_tokens: 15, requests: 1, output_tokens: 2 });
      expect(rows[0]!.costByCurrency).toEqual({ usd: 0.75, eur: 1 });
    });

    it('set — точная перезапись бакета по ключу (в т.ч. до пустых мер)', async () => {
      const { repo } = await make();
      await repo.increment(bucket({ dimensions: { user: 'u1' }, measures: { requests: 9 } }));
      await repo.set(bucket({ dimensions: { user: 'u1' }, measures: {} }));

      const rows = await repo.query({ family: 'usage' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.measures).toEqual({});

      // Новый ключ — новый бакет, старый не затрагивается.
      await repo.set(bucket({ dimensions: { user: 'u2' }, measures: { requests: 1 } }));
      expect((await repo.query({ family: 'usage' }))[0]!.measures.requests).toBe(1);
    });

    it('бакеты изолированы по семейству, дню и осям', async () => {
      const { repo } = await make();
      await repo.increment(bucket({ family: 'usage', day: '2026-01-15', dimensions: { user: 'u1' }, measures: { requests: 1 } }));
      await repo.increment(bucket({ family: 'usage', day: '2026-01-16', dimensions: { user: 'u1' }, measures: { requests: 1 } }));
      await repo.increment(bucket({ family: 'usage', day: '2026-01-15', dimensions: { user: 'u2' }, measures: { requests: 1 } }));
      await repo.increment(bucket({ family: 'activity', day: '2026-01-15', dimensions: { user: 'u1' }, measures: { turns: 1 } }));

      expect((await repo.query({ family: 'usage' }))[0]!.measures.requests).toBe(3);
      expect((await repo.query({ family: 'activity' }))[0]!.measures.turns).toBe(1);
      expect((await repo.query({ family: 'usage', dimensions: { day: '2026-01-15' } }))[0]!.measures.requests).toBe(2);
      expect((await repo.query({ family: 'usage', dimensions: { user: 'u1' } }))[0]!.measures.requests).toBe(2);
    });

    it('query: период from/to включительно и фильтр по осям', async () => {
      const { repo } = await make();
      for (const day of ['2026-01-14', '2026-01-15', '2026-01-16']) {
        await repo.increment(bucket({ day, measures: { requests: 1 } }));
      }

      const period = await repo.query({ family: 'usage', from: '2026-01-15', to: '2026-01-16' });
      expect(period).toHaveLength(1);
      expect(period[0]!.measures.requests).toBe(2);

      const exact = await repo.query({ family: 'usage', dimensions: { day: '2026-01-15' } });
      expect(exact).toHaveLength(1);
      expect(exact[0]!.measures.requests).toBe(1);
    });

    it('query: groupBy — пусто (итог), одна ось и две оси (лексикографический порядок)', async () => {
      const { repo } = await make();
      await repo.increment(bucket({ day: '2026-01-15', dimensions: { user: 'bob' }, measures: { requests: 1 } }));
      await repo.increment(bucket({ day: '2026-01-15', dimensions: { user: 'alice' }, measures: { requests: 2 } }));
      await repo.increment(bucket({ day: '2026-01-16', dimensions: { user: 'alice' }, measures: { requests: 3 } }));

      const total = await repo.query({ family: 'usage' });
      expect(total).toHaveLength(1);
      expect(total[0]!.dimensions).toEqual({});
      expect(total[0]!.measures.requests).toBe(6);

      const byDay = await repo.query({ family: 'usage', groupBy: ['day'] });
      expect(byDay.map((row) => row.dimensions.day)).toEqual(['2026-01-15', '2026-01-16']);
      expect(byDay.map((row) => row.measures.requests)).toEqual([3, 3]);

      const byUserDay = await repo.query({ family: 'usage', groupBy: ['user', 'day'] });
      expect(byUserDay.map((row) => `${row.dimensions.user}/${row.dimensions.day}`)).toEqual([
        'alice/2026-01-15',
        'alice/2026-01-16',
        'bob/2026-01-15',
      ]);
    });

    it('prune: строгая граница (день = порог остаётся), идемпотентность', async () => {
      const { repo } = await make();
      await repo.increment(bucket({ day: '2026-01-14', measures: { requests: 1 } }));
      await repo.increment(bucket({ day: '2026-01-15', measures: { requests: 1 } }));

      expect(await repo.prune('2026-01-15')).toBe(1);
      expect(await repo.prune('2026-01-15')).toBe(0);
      const rows = await repo.query({ family: 'usage' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.measures.requests).toBe(1);
    });

    it('clear: число удалённых, опустошение и повторный вызов — 0', async () => {
      const { repo } = await make();
      await repo.increment(bucket({ measures: { requests: 1 } }));
      await repo.increment(bucket({ day: '2026-01-16', measures: { requests: 1 } }));

      expect(await repo.clear()).toBe(2);
      expect(await repo.query({ family: 'usage' })).toEqual([]);
      expect(await repo.clear()).toBe(0);
    });

    it('неизвестные числовые меры сохраняются, non-finite — отбрасываются', async () => {
      const { repo } = await make();
      await repo.increment(
        bucket({
          measures: { custom_metric: 7, bad: Number.NaN, inf: Number.POSITIVE_INFINITY },
          costByCurrency: { usd: 1, broken: Number.NaN },
        }),
      );

      const rows = await repo.query({ family: 'usage' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.measures).toEqual({ custom_metric: 7 });
      expect(rows[0]!.costByCurrency).toEqual({ usd: 1 });
    });

    it('файловая реализация: повреждённый JSON не ломает query', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;
      await repo.increment(bucket({ measures: { requests: 3 } }));
      await writeFile(filePath, '{ это не json', 'utf-8');
      expect(await repo.query({ family: 'usage' })).toEqual([]);
    });

    it('файловая реализация: невалидные бакеты отбрасываются при чтении', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;
      await repo.increment(bucket({ day: '2026-01-15', measures: { requests: 1 } }));

      const raw = JSON.parse(await readFile(filePath, 'utf-8')) as {
        buckets: unknown[];
      };
      raw.buckets.push({ family: 'unknown', day: '2026-01-15', dimensions: {}, measures: {} });
      raw.buckets.push({ family: 'usage', day: 42, dimensions: {}, measures: {} });
      await writeFile(filePath, JSON.stringify(raw), 'utf-8');

      const rows = await repo.query({ family: 'usage' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.measures.requests).toBe(1);
    });
  });
}
