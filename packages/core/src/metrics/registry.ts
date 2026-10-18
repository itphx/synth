/**
 * ADR-094: мини-реестр метрик (counter/gauge/histogram) без внешних зависимостей.
 *
 * Контракт:
 * - фиксированные `labelNames` на метрику (лейблы вне списка игнорируются —
 *   кардинальность ограничена контрактом, ADR-094 п. 5);
 * - серии по ключу значений лейблов, предел серий на метрику (по умолчанию 2000)
 *   + служебная метрика `synth_metrics_series_dropped_total{metric}`;
 * - `render()` отдаёт текст exposition 0.0.4 и число серий.
 */
import { renderMetrics } from './renderer.js';

/** Значения лейблов: приводятся к строке; `undefined`/`null` → пустая строка. */
export type MetricLabels = Record<string, string | number | boolean | null | undefined>;

export type MetricType = 'counter' | 'gauge' | 'histogram';

/** Предел серий на одну метрику по умолчанию (ADR-094 п. 5). */
export const DEFAULT_MAX_SERIES_PER_METRIC = 2000;

/** Корзины гистограммы по умолчанию (секунды — типичный HTTP-latency). */
export const DEFAULT_HISTOGRAM_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** Служебная метрика: сколько серий отброшено из-за предела. */
export const SERIES_DROPPED_METRIC = 'synth_metrics_series_dropped_total';

export interface MetricsRegistryOptions {
  /** Предел серий на метрику (положительное целое; по умолчанию 2000). */
  maxSeriesPerMetric?: number;
}

/** Снимок одной серии для рендера. */
export interface MetricSnapshotSeries {
  labels: Record<string, string>;
  /** counter/gauge — значение; histogram — сумма (`_sum`). */
  value: number;
  /** histogram: число наблюдений (`_count`). */
  count: number;
  /** histogram: сумма наблюдений. */
  sum: number;
  /** histogram: **кумулятивные** счётчики по корзинам (та же длина, что `buckets`). */
  buckets: number[];
}

/** Снимок метрики целиком (используется рендерером и тестами). */
export interface MetricSnapshot {
  name: string;
  help: string;
  type: MetricType;
  labelNames: readonly string[];
  buckets?: readonly number[];
  series: MetricSnapshotSeries[];
}

interface SeriesState {
  labels: Record<string, string>;
  value: number;
  count: number;
  sum: number;
  buckets: number[];
}

/** Разбор перегрузок `inc(value)` / `inc(labels, value?)`. */
function resolveArgs(
  labelsOrValue: MetricLabels | number | undefined,
  maybeValue: number | undefined,
  defaultValue: number,
): { labels: MetricLabels | undefined; value: number } {
  if (typeof labelsOrValue === 'number') return { labels: undefined, value: labelsOrValue };
  return { labels: labelsOrValue, value: maybeValue ?? defaultValue };
}

/** Нормализация корзин: только конечные положительные, по возрастанию, без дублей. */
function normalizeBuckets(buckets: readonly number[] | undefined): number[] {
  if (!buckets) return [...DEFAULT_HISTOGRAM_BUCKETS];
  const normalized = [...new Set(buckets.filter((b) => Number.isFinite(b) && b > 0))].sort((a, b) => a - b);
  return normalized.length > 0 ? normalized : [...DEFAULT_HISTOGRAM_BUCKETS];
}

abstract class BaseMetric {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  readonly labelNames: readonly string[];
  private readonly series = new Map<string, SeriesState>();
  private readonly bypassSeriesLimit: boolean;
  protected readonly registry: MetricsRegistry;

  constructor(
    registry: MetricsRegistry,
    type: MetricType,
    name: string,
    help: string,
    labelNames: readonly string[],
    bypassSeriesLimit: boolean,
  ) {
    this.registry = registry;
    this.type = type;
    this.name = name;
    this.help = help;
    this.labelNames = [...labelNames];
    this.bypassSeriesLimit = bypassSeriesLimit;
  }

  /** Число зарегистрированных серий (не считая служебных строк рендера). */
  get seriesCount(): number {
    return this.series.size;
  }

  /** Серия по значениям лейблов; `null` — предел серий исчерпан (серия отброшена). */
  protected _series(labels?: MetricLabels): SeriesState | null {
    const values: Record<string, string> = {};
    for (const name of this.labelNames) {
      const raw = labels?.[name];
      values[name] = raw === undefined || raw === null ? '' : String(raw);
    }
    const key = JSON.stringify(this.labelNames.map((name) => values[name] ?? ''));
    const existing = this.series.get(key);
    if (existing) return existing;

    if (!this.bypassSeriesLimit && this.series.size >= this.registry.maxSeriesPerMetric) {
      this.registry._onSeriesDropped(this.name);
      return null;
    }
    const created: SeriesState = { labels: values, value: 0, count: 0, sum: 0, buckets: [] };
    this.series.set(key, created);
    return created;
  }

  /** Снимок для рендера (копии массивов — рендер не мутирует состояние). */
  _snapshot(): MetricSnapshot {
    const series = [...this.series.values()].map((s) => ({
      labels: { ...s.labels },
      value: s.value,
      count: s.count,
      sum: s.sum,
      buckets: [...s.buckets],
    }));
    return {
      name: this.name,
      help: this.help,
      type: this.type,
      labelNames: this.labelNames,
      ...(this.type === 'histogram' ? { buckets: this._buckets() } : {}),
      series,
    };
  }

  protected _buckets(): readonly number[] {
    return [];
  }
}

/** Счётчик (монотонно возрастает). */
export class CounterMetric extends BaseMetric {
  constructor(registry: MetricsRegistry, name: string, help: string, labelNames: readonly string[], bypass = false) {
    super(registry, 'counter', name, help, labelNames, bypass);
  }

  inc(value?: number): void;
  inc(labels: MetricLabels, value?: number): void;
  inc(labelsOrValue?: MetricLabels | number, maybeValue?: number): void {
    const { labels, value } = resolveArgs(labelsOrValue, maybeValue, 1);
    const series = this._series(labels);
    if (series) series.value += value;
  }
}

/** Gauge (произвольное значение: `set`/`inc`/`dec`). */
export class GaugeMetric extends BaseMetric {
  constructor(registry: MetricsRegistry, name: string, help: string, labelNames: readonly string[]) {
    super(registry, 'gauge', name, help, labelNames, false);
  }

  set(value: number): void;
  set(labels: MetricLabels, value: number): void;
  set(labelsOrValue: MetricLabels | number, maybeValue?: number): void {
    const { labels, value } = resolveArgs(labelsOrValue, maybeValue, 0);
    const series = this._series(labels);
    if (series) series.value = value;
  }

  inc(value?: number): void;
  inc(labels: MetricLabels, value?: number): void;
  inc(labelsOrValue?: MetricLabels | number, maybeValue?: number): void {
    const { labels, value } = resolveArgs(labelsOrValue, maybeValue, 1);
    const series = this._series(labels);
    if (series) series.value += value;
  }

  dec(value?: number): void;
  dec(labels: MetricLabels, value?: number): void;
  dec(labelsOrValue?: MetricLabels | number, maybeValue?: number): void {
    const { labels, value } = resolveArgs(labelsOrValue, maybeValue, 1);
    const series = this._series(labels);
    if (series) series.value -= value;
  }
}

/** Гистограмма: кумулятивные `_bucket`, `_sum`, `_count`. */
export class HistogramMetric extends BaseMetric {
  private readonly buckets: readonly number[];

  constructor(
    registry: MetricsRegistry,
    name: string,
    help: string,
    labelNames: readonly string[],
    buckets?: readonly number[],
  ) {
    super(registry, 'histogram', name, help, labelNames, false);
    this.buckets = normalizeBuckets(buckets);
  }

  observe(value: number): void;
  observe(labels: MetricLabels, value: number): void;
  observe(labelsOrValue: MetricLabels | number, maybeValue?: number): void {
    const { labels, value } = resolveArgs(labelsOrValue, maybeValue, 0);
    if (!Number.isFinite(value)) return;
    const series = this._series(labels);
    if (!series) return;
    if (series.buckets.length === 0) series.buckets = new Array(this.buckets.length).fill(0);
    series.count += 1;
    series.sum += value;
    // Храним кумулятивные счётчики: наблюдение попадает во все корзины ≥ значения.
    for (let i = 0; i < this.buckets.length; i += 1) {
      const upperBound = this.buckets[i]!;
      if (value <= upperBound) series.buckets[i] = (series.buckets[i] ?? 0) + 1;
    }
  }

  protected override _buckets(): readonly number[] {
    return this.buckets;
  }
}

type AnyMetric = CounterMetric | GaugeMetric | HistogramMetric;

/**
 * Реестр метрик. Один инстанс на процесс/приложение; `reset()` — для тестов
 * (удаляет и определения метрик, и коллекторы).
 */
export class MetricsRegistry {
  /** Предел серий на метрику (ADR-094 п. 5). */
  readonly maxSeriesPerMetric: number;

  private readonly metrics = new Map<string, AnyMetric>();
  private readonly collectors = new Set<() => void>();
  private droppedCounter: CounterMetric | null = null;

  constructor(options: MetricsRegistryOptions = {}) {
    const limit = options.maxSeriesPerMetric ?? DEFAULT_MAX_SERIES_PER_METRIC;
    this.maxSeriesPerMetric = Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : DEFAULT_MAX_SERIES_PER_METRIC;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): CounterMetric {
    return this._register('counter', name, help, labelNames) as CounterMetric;
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): GaugeMetric {
    return this._register('gauge', name, help, labelNames) as GaugeMetric;
  }

  histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets?: readonly number[],
  ): HistogramMetric {
    return this._register('histogram', name, help, labelNames, false, buckets) as HistogramMetric;
  }

  /**
   * Коллектор «перед рендером» (процессные метрики): вызывается в `render()`
   * до снятия снимка. Ошибка коллектора не ломает скрейп.
   */
  addCollector(collector: () => void): () => void {
    this.collectors.add(collector);
    return () => {
      this.collectors.delete(collector);
    };
  }

  /** Снимок всех метрик (порядок — сортировка по имени выполняется рендерером). */
  snapshot(): MetricSnapshot[] {
    return [...this.metrics.values()].map((metric) => metric._snapshot());
  }

  /**
   * Отрендерить все метрики в exposition 0.0.4.
   * `series` — суммарное число серий (histogram-серия считается один раз).
   */
  render(): { text: string; series: number } {
    for (const collect of this.collectors) {
      try {
        collect();
      } catch {
        // Метрики не должны ломать запрос/скрейп.
      }
    }
    const snapshot = this.snapshot();
    return {
      text: renderMetrics(snapshot),
      series: snapshot.reduce((sum, metric) => sum + metric.series.length, 0),
    };
  }

  /** Полный сброс реестра (для тестов): метрики, коллекторы, служебный счётчик. */
  reset(): void {
    this.metrics.clear();
    this.collectors.clear();
    this.droppedCounter = null;
  }

  /** @internal — вызывается метрикой при исчерпании предела серий. */
  _onSeriesDropped(metricName: string): void {
    if (metricName === SERIES_DROPPED_METRIC) return;
    if (!this.droppedCounter) {
      this.droppedCounter = this._register(
        'counter',
        SERIES_DROPPED_METRIC,
        'Total number of metric series dropped due to the per-metric series limit.',
        ['metric'],
        true,
      ) as CounterMetric;
    }
    this.droppedCounter.inc({ metric: metricName });
  }

  private _register(
    type: MetricType,
    name: string,
    help: string,
    labelNames: readonly string[],
    bypassSeriesLimit = false,
    buckets?: readonly number[],
  ): AnyMetric {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== type) {
        throw new Error(`Метрика ${name} уже зарегистрирована с типом ${existing.type} (запрошен ${type})`);
      }
      if (existing.labelNames.join('\u001f') !== labelNames.join('\u001f')) {
        throw new Error(
          `Метрика ${name} уже зарегистрирована с лейблами [${existing.labelNames.join(', ')}]`,
        );
      }
      return existing;
    }
    let metric: AnyMetric;
    if (type === 'counter') metric = new CounterMetric(this, name, help, labelNames, bypassSeriesLimit);
    else if (type === 'gauge') metric = new GaugeMetric(this, name, help, labelNames);
    else metric = new HistogramMetric(this, name, help, labelNames, buckets);
    this.metrics.set(name, metric);
    return metric;
  }
}
