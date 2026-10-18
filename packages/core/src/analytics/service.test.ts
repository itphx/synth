import { describe, it, expect } from 'vitest';
import { MemoryAnalyticsRollupRepository } from '../storage/memory/analytics-rollup.js';
import { AnalyticsService, AnalyticsValidationError } from './service.js';

/** Сервис поверх memory-репозитория с фиксированным «сегодня». */
function makeService(today = '2026-03-15T12:00:00Z') {
  const repo = new MemoryAnalyticsRollupRepository();
  const service = new AnalyticsService({ repo, now: () => new Date(today) });
  return { repo, service };
}

describe('AnalyticsService (PROP-102, волна 1)', () => {
  describe('resolvePeriod', () => {
    it('по умолчанию: to — сегодня UTC, from — to минус 29 суток (30 дней)', () => {
      const { service } = makeService();
      expect(service.resolvePeriod()).toEqual({ from: '2026-02-14', to: '2026-03-15' });
    });

    it('явные границы сохраняются как есть', () => {
      const { service } = makeService();
      expect(service.resolvePeriod('2026-01-01', '2026-01-31')).toEqual({
        from: '2026-01-01',
        to: '2026-01-31',
      });
    });

    it('некорректный формат → AnalyticsValidationError(period)', () => {
      const { service } = makeService();
      try {
        service.resolvePeriod('15-03-2026');
        throw new Error('ожидалась ошибка');
      } catch (err) {
        expect(err).toBeInstanceOf(AnalyticsValidationError);
        expect((err as AnalyticsValidationError).reason).toBe('period');
      }
    });

    it('нереальная дата (2026-02-30) → reason period', () => {
      const { service } = makeService();
      expect(() => service.resolvePeriod('2026-02-30')).toThrowError(AnalyticsValidationError);
    });

    it('from > to → reason range', () => {
      const { service } = makeService();
      try {
        service.resolvePeriod('2026-03-01', '2026-02-01');
        throw new Error('ожидалась ошибка');
      } catch (err) {
        expect((err as AnalyticsValidationError).reason).toBe('range');
      }
    });
  });

  describe('resolveGroupBy', () => {
    it('prompt без groupBy → [model, agent]; прочие → []', () => {
      const { service } = makeService();
      expect(service.resolveGroupBy('prompt')).toEqual(['model', 'agent']);
      expect(service.resolveGroupBy('usage')).toEqual([]);
    });

    it('дубликаты сохраняют первое вхождение', () => {
      const { service } = makeService();
      expect(service.resolveGroupBy('usage', ['model', 'agent', 'model'])).toEqual(['model', 'agent']);
    });

    it('неизвестная ось → reason groupBy', () => {
      const { service } = makeService();
      try {
        service.resolveGroupBy('usage', ['unknown' as never]);
        throw new Error('ожидалась ошибка');
      } catch (err) {
        expect((err as AnalyticsValidationError).reason).toBe('groupBy');
      }
    });

    it('provider — допустимая ось', () => {
      const { service } = makeService();
      expect(service.resolveGroupBy('usage', ['provider'])).toEqual(['provider']);
    });
  });

  describe('getReport', () => {
    it('usage по суткам: строки + дериваты на чтении', async () => {
      const { repo, service } = makeService();
      await repo.increment({
        family: 'usage',
        day: '2026-03-01',
        dimensions: { model: 'm1' },
        measures: { input_tokens: 100, output_tokens: 40, cache_read_tokens: 25, reasoning_tokens: 8, duration_ms: 2000 },
        costByCurrency: { USD: 0.5 },
      });
      await repo.increment({
        family: 'usage',
        day: '2026-03-02',
        dimensions: { model: 'm1' },
        measures: { input_tokens: 200, output_tokens: 60, duration_ms: 1000 },
      });

      const report = await service.getReport('usage', {
        from: '2026-03-01',
        to: '2026-03-02',
        groupBy: ['day'],
      });

      expect(report.report).toBe('usage');
      expect(report.groupBy).toEqual(['day']);
      expect(report.rows).toHaveLength(2);
      const first = report.rows[0]!;
      expect(first.dimensions).toEqual({ day: '2026-03-01' });
      expect(first.measures.input_tokens).toBe(100);
      expect(first.measures.total_tokens).toBe(140);
      expect(first.measures.cache_hit_rate).toBeCloseTo(0.25, 6);
      expect(first.measures.reasoning_ratio).toBeCloseTo(0.2, 6);
      expect(first.measures.output_tps).toBeCloseTo(20, 6);
      expect(first.costByCurrency).toEqual({ USD: 0.5 });
    });

    it('дериваты с нулевыми знаменателями → 0 (без NaN/Infinity)', async () => {
      const { repo, service } = makeService();
      await repo.increment({
        family: 'usage',
        day: '2026-03-01',
        dimensions: {},
        measures: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 5, duration_ms: 0 },
      });
      const report = await service.getReport('usage', { from: '2026-03-01', to: '2026-03-01' });
      expect(report.rows[0]!.measures).toMatchObject({
        total_tokens: 0,
        cache_hit_rate: 0,
        reasoning_ratio: 0,
        output_tps: 0,
      });
    });

    it('prompt читается из семейства usage, дефолтная группировка [model, agent]', async () => {
      const { repo, service } = makeService();
      await repo.increment({
        family: 'usage',
        day: '2026-03-01',
        dimensions: { model: 'm1', agent: 'assistant' },
        measures: { input_tokens: 10, output_tokens: 5 },
      });
      const report = await service.getReport('prompt', { from: '2026-03-01', to: '2026-03-01' });
      expect(report.report).toBe('prompt');
      expect(report.groupBy).toEqual(['model', 'agent']);
      expect(report.rows).toEqual([
        {
          dimensions: { model: 'm1', agent: 'assistant' },
          measures: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cache_hit_rate: 0, reasoning_ratio: 0, output_tps: 0 },
        },
      ]);
    });

    it('activity/decision — без дериватов', async () => {
      const { repo, service } = makeService();
      await repo.increment({ family: 'activity', day: '2026-03-01', dimensions: {}, measures: { tool_calls: 3 } });
      const report = await service.getReport('activity', { from: '2026-03-01', to: '2026-03-01' });
      expect(report.rows[0]!.measures).toEqual({ tool_calls: 3 });
    });

    it('фильтр оси user применяется до агрегации', async () => {
      const { repo, service } = makeService();
      await repo.increment({ family: 'usage', day: '2026-03-01', dimensions: { user: 'u1' }, measures: { requests: 1 } });
      await repo.increment({ family: 'usage', day: '2026-03-01', dimensions: { user: 'u2' }, measures: { requests: 5 } });
      const report = await service.getReport('usage', {
        from: '2026-03-01',
        to: '2026-03-01',
        userId: 'u1',
        groupBy: ['user'],
      });
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]!.dimensions).toEqual({ user: 'u1' });
      expect(report.rows[0]!.measures.requests).toBe(1);
    });
  });

  describe('getSummary', () => {
    it('агрегирует usage/activity/decision и стоимость по валютам', async () => {
      const { repo, service } = makeService();
      await repo.increment({
        family: 'usage',
        day: '2026-03-01',
        dimensions: {},
        measures: { input_tokens: 100, output_tokens: 50 },
        costByCurrency: { USD: 1, EUR: 0.5 },
      });
      await repo.increment({ family: 'activity', day: '2026-03-01', dimensions: {}, measures: { tool_calls: 4 } });
      await repo.increment({ family: 'decision', day: '2026-03-01', dimensions: {}, measures: { calls: 2 } });

      const summary = await service.getSummary({ from: '2026-03-01', to: '2026-03-01' });
      expect(summary.from).toBe('2026-03-01');
      expect(summary.usage).toMatchObject({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
      expect(summary.activity).toEqual({ tool_calls: 4 });
      expect(summary.decision).toEqual({ calls: 2 });
      expect(summary.costByCurrency).toEqual({ USD: 1, EUR: 0.5 });
    });

    it('пустой период → нулевые словари и дериваты 0', async () => {
      const { service } = makeService();
      const summary = await service.getSummary({ from: '2026-03-01', to: '2026-03-01' });
      expect(summary.usage).toEqual({ total_tokens: 0, cache_hit_rate: 0, reasoning_ratio: 0, output_tps: 0 });
      expect(summary.activity).toEqual({});
      expect(summary.decision).toEqual({});
      expect(summary.costByCurrency).toBeUndefined();
    });
  });
});
