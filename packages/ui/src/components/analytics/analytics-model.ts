/**
 * PROP-102 §6: клиентская модель отчёта аналитики — колонки, сортировка и
 * итоговая строка. Заголовки/форматирование делает клиент (сервер отдаёт
 * только данные), поэтому колонки собираются здесь по тому же порядку, что и в
 * серверном CSV-экспорте: оси → сырые меры семейства → `cost_<валюта>` →
 * дериваты (`usage`/`prompt`).
 */

import {
  ANALYTICS_DERIVED_MEASURES,
  ANALYTICS_MEASURES_BY_FAMILY,
} from '@itphx/synth-shared/types'
import type {
  AnalyticsReport,
  AnalyticsReportKind,
  AnalyticsReportRow,
} from '@itphx/synth-shared/types'
import { formatCost, formatDuration, formatTokens, formatTps } from '@/lib/formatStats'

/** Колонка таблицы отчёта. */
export type AnalyticsColumn =
  | { key: string; kind: 'axis'; axis: string }
  | { key: string; kind: 'measure'; measure: string }
  | { key: string; kind: 'derived'; measure: string }
  | { key: string; kind: 'cost'; currency: string }

/** Направление сортировки таблицы. */
export type AnalyticsSortDirection = 'asc' | 'desc'

/** `prompt` — производное чтение `usage`: дериваты применимы к обоим. */
export function isDerivedFamily(kind: AnalyticsReportKind): boolean {
  return kind === 'usage' || kind === 'prompt'
}

/** Базовый список сырых мер семейства (`prompt` — список `usage`). */
function baseMeasures(kind: AnalyticsReportKind): readonly string[] {
  const list = ANALYTICS_MEASURES_BY_FAMILY[kind]
  return list.length > 0 ? list : ANALYTICS_MEASURES_BY_FAMILY.usage
}

const DERIVED_SET: ReadonlySet<string> = new Set(ANALYTICS_DERIVED_MEASURES)

/** Стабильный набор колонок отчёта (пустые данные — тоже стабильны). */
export function buildAnalyticsColumns(report: AnalyticsReport): AnalyticsColumn[] {
  const base = baseMeasures(report.report)
  const known = new Set<string>(base)
  const extra = new Set<string>()
  const currencies = new Set<string>()

  for (const row of report.rows) {
    for (const key of Object.keys(row.measures)) {
      if (known.has(key) || DERIVED_SET.has(key)) continue
      extra.add(key)
    }
    for (const currency of Object.keys(row.costByCurrency ?? {})) currencies.add(currency)
  }

  const columns: AnalyticsColumn[] = report.groupBy.map((axis) => ({
    key: `axis:${axis}`,
    kind: 'axis',
    axis,
  }))
  for (const measure of [...base, ...[...extra].sort()]) {
    columns.push({ key: `measure:${measure}`, kind: 'measure', measure })
  }
  for (const currency of [...currencies].sort()) {
    columns.push({ key: `cost:${currency}`, kind: 'cost', currency })
  }
  if (isDerivedFamily(report.report)) {
    for (const measure of ANALYTICS_DERIVED_MEASURES) {
      columns.push({ key: `derived:${measure}`, kind: 'derived', measure })
    }
  }
  return columns
}

/** i18n-ключ подписи колонки. */
export function analyticsColumnLabelKey(column: AnalyticsColumn): string {
  switch (column.kind) {
    case 'axis':
      return `analytics.axis.${column.axis}`
    case 'cost':
      return 'analytics.column.cost'
    default:
      return `analytics.measure.${column.measure}`
  }
}

/** Значение ячейки строки: число для меры/стоимости, строка для оси. */
export function analyticsCellValue(
  row: AnalyticsReportRow,
  column: AnalyticsColumn,
): string | number {
  switch (column.kind) {
    case 'axis':
      return row.dimensions[column.axis] ?? ''
    case 'cost':
      return row.costByCurrency?.[column.currency] ?? 0
    default:
      return row.measures[column.measure] ?? 0
  }
}

/** Форматирование ячейки существующими утилитами проекта (ADR-070 §2.6). */
export function formatAnalyticsCell(column: AnalyticsColumn, value: string | number): string {
  if (column.kind === 'axis') return String(value) || '—'
  const numeric = typeof value === 'number' ? value : Number(value)
  if (column.kind === 'cost') return formatCost(numeric, column.currency)
  if (!Number.isFinite(numeric)) return '0'
  if (column.measure === 'duration_ms') return formatDuration(numeric)
  if (column.measure === 'output_tps') return formatTps(numeric)
  if (column.measure === 'cache_hit_rate' || column.measure === 'reasoning_ratio') {
    return `${(numeric * 100).toFixed(1)}%`
  }
  if (column.measure.endsWith('_tokens')) return formatTokens(numeric)
  return Number.isInteger(numeric) ? formatTokens(numeric) : numeric.toFixed(2)
}

/** Отсортированная копия строк (числа — по значению, оси — по строке). */
export function sortAnalyticsRows(
  rows: readonly AnalyticsReportRow[],
  column: AnalyticsColumn,
  direction: AnalyticsSortDirection,
): AnalyticsReportRow[] {
  const sorted = [...rows].sort((a, b) => {
    const left = analyticsCellValue(a, column)
    const right = analyticsCellValue(b, column)
    if (typeof left === 'number' && typeof right === 'number') return left - right
    return String(left).localeCompare(String(right))
  })
  return direction === 'desc' ? sorted.reverse() : sorted
}

/** Дериваты, пересчитанные из просуммированных счётчиков (суммировать отношения нельзя). */
function deriveFromSums(sums: Record<string, number>): Record<string, number> {
  const input = sums.input_tokens ?? 0
  const output = sums.output_tokens ?? 0
  const cacheRead = sums.cache_read_tokens ?? 0
  const reasoning = sums.reasoning_tokens ?? 0
  const durationMs = sums.duration_ms ?? 0
  return {
    total_tokens: input + output,
    cache_hit_rate: input > 0 ? cacheRead / input : 0,
    reasoning_ratio: output > 0 ? reasoning / output : 0,
    output_tps: durationMs > 0 ? output / (durationMs / 1000) : 0,
  }
}

export interface AnalyticsTotals {
  /** Суммы сырых мер (без дериватов). */
  measures: Record<string, number>
  /** Дериваты, пересчитанные из сумм. */
  derived: Record<string, number>
  /** Суммы по валютам. */
  costs: Record<string, number>
}

/** Итоги по строкам отчёта; `null` — строк нет. */
export function computeAnalyticsTotals(report: AnalyticsReport | null): AnalyticsTotals | null {
  if (!report || report.rows.length === 0) return null
  const measures: Record<string, number> = {}
  const costs: Record<string, number> = {}
  for (const row of report.rows) {
    for (const [key, value] of Object.entries(row.measures)) {
      if (DERIVED_SET.has(key)) continue
      measures[key] = (measures[key] ?? 0) + value
    }
    for (const [currency, value] of Object.entries(row.costByCurrency ?? {})) {
      costs[currency] = (costs[currency] ?? 0) + value
    }
  }
  return { measures, derived: deriveFromSums(measures), costs }
}

/** Значение итоговой строки для колонки; `undefined` — колонка не суммируется. */
export function analyticsTotalValue(
  totals: AnalyticsTotals,
  column: AnalyticsColumn,
): string | number | undefined {
  switch (column.kind) {
    case 'axis':
      return undefined
    case 'cost':
      return totals.costs[column.currency] ?? 0
    case 'derived':
      return totals.derived[column.measure] ?? 0
    case 'measure':
      return totals.measures[column.measure] ?? 0
  }
}
