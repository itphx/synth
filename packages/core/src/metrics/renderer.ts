/**
 * ADR-094: рендер метрик в текстовый формат Prometheus (exposition 0.0.4).
 *
 * Без внешних зависимостей: `# HELP`/`# TYPE`, сортировка метрик и серий,
 * экранирование help/label, histogram `_bucket` (кумулятивные), `+Inf`, `_sum`,
 * `_count`, корректные числа (`NaN`/`+Inf`/`-Inf`).
 */
import type { MetricSnapshot, MetricSnapshotSeries } from './registry.js';

/** Предел `le`-корзины: последняя строка любого histogram. */
const INF_LABEL = '+Inf';

/** Детерминированное сравнение строк (не зависит от локали). */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Экранирование help-строки (`\`, `"`, перевод строки). */
export function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Экранирование значения метки (`\`, `"`, перевод строки). */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Число в формате Prometheus: `NaN`, `+Inf`, `-Inf` либо обычная запись JS. */
export function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

/** `{name="value",...}` в порядке `labelNames` (+ дополнительные метки в конце). */
function formatLabels(
  labelNames: readonly string[],
  labels: Record<string, string>,
  extra: Array<[string, string]> = [],
): string {
  const parts = labelNames.map((name) => `${name}="${escapeLabelValue(labels[name] ?? '')}"`);
  for (const [name, value] of extra) parts.push(`${name}="${escapeLabelValue(value)}"`);
  if (parts.length === 0) return '';
  return `{${parts.join(',')}}`;
}

/** Стабильный ключ серии — отрендеренные метки (порядок фиксирован `labelNames`). */
function seriesSortKey(labelNames: readonly string[], series: MetricSnapshotSeries): string {
  return labelNames.map((name) => `${name}=${series.labels[name] ?? ''}`).join('\u001f');
}

function renderCounterOrGauge(metric: MetricSnapshot, lines: string[]): void {
  const series = [...metric.series].sort((a, b) =>
    compareStrings(seriesSortKey(metric.labelNames, a), seriesSortKey(metric.labelNames, b)),
  );
  for (const s of series) {
    lines.push(`${metric.name}${formatLabels(metric.labelNames, s.labels)} ${formatNumber(s.value)}`);
  }
}

function renderHistogram(metric: MetricSnapshot, lines: string[]): void {
  const buckets = metric.buckets ?? [];
  const series = [...metric.series].sort((a, b) =>
    compareStrings(seriesSortKey(metric.labelNames, a), seriesSortKey(metric.labelNames, b)),
  );
  for (const s of series) {
    // `buckets` в снимке — уже кумулятивные счётчики.
    buckets.forEach((upperBound, index) => {
      const count = s.buckets[index] ?? 0;
      lines.push(
        `${metric.name}_bucket${formatLabels(metric.labelNames, s.labels, [['le', formatNumber(upperBound)]])} ${count}`,
      );
    });
    lines.push(
      `${metric.name}_bucket${formatLabels(metric.labelNames, s.labels, [['le', INF_LABEL]])} ${s.count}`,
    );
    lines.push(`${metric.name}_sum${formatLabels(metric.labelNames, s.labels)} ${formatNumber(s.sum)}`);
    lines.push(`${metric.name}_count${formatLabels(metric.labelNames, s.labels)} ${s.count}`);
  }
}

/**
 * Отрендерить снимок реестра. Метрики и серии сортируются лексикографически
 * (детерминированный вывод; golden-тесты закрепляют порядок).
 */
export function renderMetrics(metrics: readonly MetricSnapshot[]): string {
  const lines: string[] = [];
  const sorted = [...metrics].sort((a, b) => compareStrings(a.name, b.name));
  for (const metric of sorted) {
    lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);
    if (metric.type === 'histogram') renderHistogram(metric, lines);
    else renderCounterOrGauge(metric, lines);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
