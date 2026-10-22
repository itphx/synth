import { describe, it, expect } from 'vitest';
import type { AnalyticsReport } from '@itphx/synth-shared';
import { toCsv, toJson } from './export.js';

const CRLF = '\r\n';

/** Разобрать CSV в массив строк-массивов (BOM и хвостовой CRLF отбрасываются). */
function parseCsv(csv: string): string[][] {
  const body = csv.replace(/^\uFEFF/, '');
  const lines = body.split(CRLF).filter((line) => line.length > 0);
  return lines.map((line) => line.split(','));
}

const usageReport: AnalyticsReport = {
  report: 'usage',
  from: '2026-03-01',
  to: '2026-03-02',
  groupBy: ['day'],
  rows: [
    {
      dimensions: { day: '2026-03-01' },
      measures: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_tokens: 25,
        reasoning_tokens: 8,
        duration_ms: 2000,
        total_tokens: 140,
        cache_hit_rate: 0.25,
        reasoning_ratio: 0.2,
        output_tps: 20,
      },
      costByCurrency: { USD: 0.5 },
    },
    {
      dimensions: { day: '2026-03-02' },
      measures: {
        input_tokens: 200,
        output_tokens: 60,
        duration_ms: 1000,
        total_tokens: 260,
        cache_hit_rate: 0,
        reasoning_ratio: 0,
        output_tps: 60,
      },
      costByCurrency: { USD: 1 },
    },
  ],
};

describe('toCsv (ADR-102 §6)', () => {
  it('начинается с BOM UTF-8 и заканчивается CRLF', () => {
    const csv = toCsv(usageReport);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.endsWith(CRLF)).toBe(true);
  });

  it('колонки: оси → сырые меры → cost_<валюта> → дериваты', () => {
    const header = parseCsv(toCsv(usageReport))[0]!;
    expect(header).toEqual([
      'day',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'reasoning_tokens',
      'requests',
      'messages',
      'duration_ms',
      'cost_USD',
      'total_tokens',
      'cache_hit_rate',
      'reasoning_ratio',
      'output_tps',
    ]);
  });

  it('строки данных + итоговая строка TOTAL с пересчётом дериватов', () => {
    const rows = parseCsv(toCsv(usageReport));
    // header + 2 строки + TOTAL
    expect(rows).toHaveLength(4);
    const total = rows[3]!;
    const idx = (name: string) => rows[0]!.indexOf(name);

    expect(total[0]).toBe('TOTAL');
    expect(total[idx('input_tokens')]).toBe('300');
    expect(total[idx('output_tokens')]).toBe('100');
    expect(total[idx('cost_USD')]).toBe('1.5');
    expect(total[idx('total_tokens')]).toBe('400');
    // cache_hit_rate пересчитан из просуммированных счётчиков: 25 / 300.
    expect(Number(total[idx('cache_hit_rate')])).toBeCloseTo(25 / 300, 10);
    expect(Number(total[idx('reasoning_ratio')])).toBeCloseTo(8 / 100, 10);
    // output_tps = 100 / (3000 / 1000) = 33.333…
    expect(Number(total[idx('output_tps')])).toBeCloseTo(100 / 3, 10);
    // Во второй ячейке осей (если бы их было больше) — пусто; здесь одна ось.
  });

  it('пустая группировка → без колонок осей и без строки TOTAL', () => {
    const report: AnalyticsReport = {
      report: 'usage',
      from: '2026-03-01',
      to: '2026-03-01',
      groupBy: [],
      rows: [{ dimensions: {}, measures: { requests: 7 } }],
    };
    const rows = parseCsv(toCsv(report));
    expect(rows).toHaveLength(2);
    expect(rows[0]![0]).toBe('input_tokens');
    expect(rows.every((row) => row[0] !== 'TOTAL')).toBe(true);
  });

  it('пустой отчёт: только заголовок, без TOTAL', () => {
    const report: AnalyticsReport = {
      report: 'activity',
      from: '2026-03-01',
      to: '2026-03-01',
      groupBy: ['user'],
      rows: [],
    };
    const rows = parseCsv(toCsv(report));
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toBe('user');
  });

  it('экранирование RFC 4180: запятая и кавычка в значении оси', () => {
    const report: AnalyticsReport = {
      report: 'activity',
      from: '2026-03-01',
      to: '2026-03-01',
      groupBy: ['model'],
      rows: [{ dimensions: { model: 'a,"b"' }, measures: { tool_calls: 1 } }],
    };
    const csv = toCsv(report);
    expect(csv).toContain('"a,""b"""');
  });

  it('неизвестные встреченные меры попадают отдельными колонками (отсортированы)', () => {
    const report: AnalyticsReport = {
      report: 'activity',
      from: '2026-03-01',
      to: '2026-03-01',
      groupBy: [],
      rows: [{ dimensions: {}, measures: { tool_calls: 1, zeta: 2, alpha: 3 } }],
    };
    const header = parseCsv(toCsv(report))[0]!;
    const extra = header.filter((name) => ['alpha', 'zeta'].includes(name));
    expect(extra).toEqual(['alpha', 'zeta']);
  });
});

describe('toJson (ADR-102 §6)', () => {
  it('возвращает отчёт как есть (сырые данные без локализации)', () => {
    expect(JSON.parse(toJson(usageReport))).toEqual(usageReport);
  });
});
