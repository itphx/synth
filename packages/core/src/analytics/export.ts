/**
 * PROP-102 §6: серверная выгрузка отчёта аналитики — **только данные** (CSV/JSON).
 *
 * Строки отчёта сервер не локализует: заголовки, форматирование и подписи делает
 * клиент. CSV — RFC 4180 (запятая, `\r\n`, экранирование кавычками), BOM UTF-8
 * для корректного открытия в Excel/LibreOffice. Колонки: оси группировки →
 * сырые меры семейства (стабильный порядок `ANALYTICS_MEASURES_BY_FAMILY`, для
 * производного `prompt` — список `usage`) → `cost_<валюта>` → дериваты
 * (`ANALYTICS_DERIVED_MEASURES`, только для usage-производных семейств).
 *
 * При непустой группировке последней строкой идёт итог `TOTAL`: суммы сырых
 * счётчиков и стоимостей, а дериваты **пересчитываются** из просуммированных
 * счётчиков (суммировать отношения нельзя — `sum(a/b) ≠ sum(a)/sum(b)`).
 */

import {
  ANALYTICS_DERIVED_MEASURES,
  ANALYTICS_MEASURES_BY_FAMILY,
} from '@itphx/synth-shared';
import type { AnalyticsReport, AnalyticsReportKind } from '@itphx/synth-shared';
import { deriveMeasures, isUsageDerivedFamily } from './derive.js';

const BOM = '\uFEFF';
const CRLF = '\r\n';
const TOTAL_LABEL = 'TOTAL';
const DERIVED_SET: ReadonlySet<string> = new Set(ANALYTICS_DERIVED_MEASURES);

/** Базовый список сырых мер семейства (`prompt` — производное чтение `usage`). */
function baseMeasures(kind: AnalyticsReportKind): readonly string[] {
  const list = ANALYTICS_MEASURES_BY_FAMILY[kind];
  return list.length > 0 ? list : ANALYTICS_MEASURES_BY_FAMILY.usage;
}

interface CsvColumns {
  /** Оси группировки (в порядке `report.groupBy`). */
  axes: readonly string[];
  /** Сырые меры: базовый список семейства + прочие встреченные меры (отсортированы). */
  measures: readonly string[];
  /** Валюты разбивки стоимости (отсортированы); колонка — `cost_<валюта>`. */
  currencies: readonly string[];
  /** Дериваты (только usage-производные семейства). */
  derived: readonly string[];
}

/** Собрать стабильный набор колонок по данным отчёта (пустые данные — тоже стабильны). */
function buildColumns(report: AnalyticsReport): CsvColumns {
  const base = [...baseMeasures(report.report)];
  const known = new Set(base);
  const extra = new Set<string>();
  const currencies = new Set<string>();
  for (const row of report.rows) {
    for (const key of Object.keys(row.measures)) {
      if (known.has(key) || DERIVED_SET.has(key)) continue;
      extra.add(key);
    }
    for (const currency of Object.keys(row.costByCurrency ?? {})) currencies.add(currency);
  }
  return {
    axes: report.groupBy,
    measures: [...base, ...[...extra].sort()],
    currencies: [...currencies].sort(),
    derived: isUsageDerivedFamily(report.report) ? [...ANALYTICS_DERIVED_MEASURES] : [],
  };
}

/** Экранировать поле по RFC 4180 (кавычка/запятая/перевод строки → в кавычки). */
function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Строка CSV без завершающего перевода строки. */
function joinRecord(fields: readonly string[]): string {
  return fields.map(escapeField).join(',');
}

/** Значения строки данных в порядке колонок. */
function rowFields(
  row: { dimensions: Record<string, string>; measures: Record<string, number>; costByCurrency?: Record<string, number> },
  columns: CsvColumns,
): string[] {
  const fields: string[] = [];
  for (const axis of columns.axes) fields.push(row.dimensions[axis] ?? '');
  for (const measure of columns.measures) fields.push(String(row.measures[measure] ?? 0));
  for (const currency of columns.currencies) fields.push(String(row.costByCurrency?.[currency] ?? 0));
  for (const derived of columns.derived) fields.push(String(row.measures[derived] ?? 0));
  return fields;
}

/**
 * Итоговая строка `TOTAL`: сумма сырых мер и стоимостей, дериваты — пересчёт из
 * просуммированных счётчиков. Метка — в первой ячейке осей.
 */
function totalFields(report: AnalyticsReport, columns: CsvColumns): string[] {
  const sums: Record<string, number> = {};
  const costs: Record<string, number> = {};
  for (const row of report.rows) {
    for (const measure of columns.measures) {
      sums[measure] = (sums[measure] ?? 0) + (row.measures[measure] ?? 0);
    }
    for (const currency of columns.currencies) {
      costs[currency] = (costs[currency] ?? 0) + (row.costByCurrency?.[currency] ?? 0);
    }
  }
  const derived = columns.derived.length > 0 ? deriveMeasures(sums) : {};
  const fields: string[] = [];
  columns.axes.forEach((_, index) => fields.push(index === 0 ? TOTAL_LABEL : ''));
  for (const measure of columns.measures) fields.push(String(sums[measure] ?? 0));
  for (const currency of columns.currencies) fields.push(String(costs[currency] ?? 0));
  for (const key of columns.derived) fields.push(String(derived[key] ?? 0));
  return fields;
}

/**
 * Сериализовать отчёт в CSV (RFC 4180, BOM UTF-8, `\r\n`). При непустой
 * группировке добавляет итоговую строку `TOTAL`.
 */
export function toCsv(report: AnalyticsReport): string {
  const columns = buildColumns(report);
  const header = [
    ...columns.axes,
    ...columns.measures,
    ...columns.currencies.map((currency) => `cost_${currency}`),
    ...columns.derived,
  ];
  const lines = [joinRecord(header)];
  for (const row of report.rows) lines.push(joinRecord(rowFields(row, columns)));
  if (columns.axes.length > 0 && report.rows.length > 0) {
    lines.push(joinRecord(totalFields(report, columns)));
  }
  return BOM + lines.join(CRLF) + CRLF;
}

/** Сериализовать отчёт в JSON (сырые счётчики + дериваты, без локализации). */
export function toJson(report: AnalyticsReport): string {
  return JSON.stringify(report, null, 2);
}
