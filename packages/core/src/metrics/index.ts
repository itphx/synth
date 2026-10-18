/**
 * ADR-094: реестр метрик и служебная обвязка (HTTP/процесс/токен/рендер).
 *
 * Публичная точка входа подсистемы: `MetricsRegistry`, middleware и
 * процессные метрики. Доменные коллекторы (очередь/LLM/хранилище/события/…)
 * подключаются отдельной задачей.
 */
export {
  MetricsRegistry,
  CounterMetric,
  GaugeMetric,
  HistogramMetric,
  DEFAULT_HISTOGRAM_BUCKETS,
  DEFAULT_MAX_SERIES_PER_METRIC,
  SERIES_DROPPED_METRIC,
} from './registry.js';
export type {
  MetricLabels,
  MetricSnapshot,
  MetricSnapshotSeries,
  MetricType,
  MetricsRegistryOptions,
} from './registry.js';
export {
  renderMetrics,
  escapeHelp,
  escapeLabelValue,
  formatNumber,
} from './renderer.js';
export {
  createHttpMetricsMiddleware,
  normalizeRouteTemplate,
} from './http.js';
export type { HttpMetricsOptions } from './http.js';
export { registerProcessMetrics } from './process.js';
export type { ProcessMetricsHandle } from './process.js';
export { resolveMetricsToken, metricsTokenPath } from './token.js';
export * from './collectors/index.js';
