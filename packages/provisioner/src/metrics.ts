/**
 * Метрики provisioner'а (ADR-094, PROP-135 Ф4b-2a) — собственный `/metrics`.
 *
 * Provisioner — отдельный процесс и **не зависит от core**, поэтому здесь
 * свой минимальный реестр (counter/gauge) и собственный рендер exposition
 * 0.0.4. Контракт ADR-094 соблюдается:
 *
 * - имена — только `synth_*`;
 * - лейблы — из закрытого набора (`profile`, `state`, `outcome`, `reason`);
 * - идентификаторов (ключей пулов, адресов, id проектов) в лейблах **нет**:
 *   `profile` — имя профиля из конфигурации, `state` — `ready`/`draining`;
 * - кардинальность ограничена: серии лейблов приводятся к известным наборам;
 * - сбой метрик не влияет на выдачу пула (вызовы обёрнуты в try/catch в
 *   `PoolService`).
 *
 * Каталог:
 *
 * | Метрика | Тип | Лейблы | Смысл |
 * |---|---|---|---|
 * | `synth_provisioner_pools` | gauge | `profile`, `state` | живые пулы |
 * | `synth_provisioner_provision_total` | counter | `outcome` | запросы обеспечения (`ok`/`error`/`capacity`) |
 * | `synth_provisioner_release_total` | counter | `outcome` | удаления (`ok`/`idle`/`lifetime`/`error`) |
 * | `synth_provisioner_idle_terminations_total` | counter | — | пулы, снятые по idle-таймауту |
 * | `synth_provisioner_errors_total` | counter | `reason` | ошибки HTTP-слоя |
 * | `synth_provisioner_ensure_seconds` | histogram | `provider` | время обеспечения пула у провайдера |
 * | `synth_provisioner_provider_errors_total` | counter | `reason` | ошибки провайдера ресурсов (Kubernetes) |
 */

import type { PoolState } from './protocol.js';

/** Тип метрики. */
export type MetricType = 'counter' | 'gauge' | 'histogram';

/** Значения лейблов: приводятся к строке. */
export type MetricLabels = Record<string, string | number | boolean | null | undefined>;

/** Снимок одной серии. */
export interface MetricSeriesSnapshot {
  labels: Record<string, string>;
  /** counter/gauge — значение; histogram — сумма наблюдений (`_sum`). */
  value: number;
  /** histogram: число наблюдений (`_count`). */
  count?: number;
  /** histogram: **кумулятивные** счётчики по корзинам (та же длина, что `buckets`). */
  buckets?: number[];
}

/** Снимок метрики. */
export interface MetricSnapshot {
  name: string;
  help: string;
  type: MetricType;
  labelNames: readonly string[];
  /** histogram: верхние границы корзин (последняя строка — всегда `+Inf`). */
  buckets?: readonly number[];
  series: MetricSeriesSnapshot[];
}

/**
 * Корзины `synth_provisioner_ensure_seconds` (секунды).
 *
 * Нижние — тёплый пул из кэша, верхние — холодный под с образу до 2 минут
 * (`startTimeoutMs`), последняя корзина совпадает с дефолтным таймаутом.
 */
export const ENSURE_SECONDS_BUCKETS: readonly number[] = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120,
];

/** Предел серий на метрику (страховка кардинальности). */
export const MAX_SERIES_PER_METRIC = 2000;

/** Экранирование help-строки (`\`, `"`, перевод строки). */
export function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Экранирование значения метки (`\`, `"`, перевод строки). */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Число в формате Prometheus: `NaN`, `+Inf`, `-Inf` либо обычная запись. */
export function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

/** `{name="value",...}` в порядке `labelNames`. */
function formatLabels(labelNames: readonly string[], labels: Record<string, string>): string {
  if (labelNames.length === 0) return '';
  const parts = labelNames.map((name) => `${name}="${escapeLabelValue(labels[name] ?? '')}"`);
  return `{${parts.join(',')}}`;
}

/** Стабильный ключ серии (порядок лейблов фиксирован `labelNames`). */
function seriesKey(labelNames: readonly string[], labels: Record<string, string>): string {
  return labelNames.map((name) => `${name}=${labels[name] ?? ''}`).join('\u001f');
}

/**
 * Корзины гистограммы: конечные числа по возрастанию, без дублей.
 *
 * Пустой список — гистограмма без явных корзин (только `+Inf`): так метрика
 * не раздувает кардинальность, если границы не заданы.
 */
function normalizeBuckets(buckets: readonly number[]): readonly number[] {
  const finite = buckets.filter((value) => Number.isFinite(value));
  const unique = [...new Set(finite)];
  unique.sort((a, b) => a - b);
  return unique;
}

/** Одна метрика реестра. */
export class MiniMetric {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  readonly labelNames: readonly string[];
  /** histogram: верхние границы корзин (отсортированы, без `+Inf`). */
  readonly buckets: readonly number[];

  private readonly _series = new Map<string, MetricSeriesSnapshot>();

  constructor(
    name: string,
    help: string,
    type: MetricType,
    labelNames: readonly string[] = [],
    buckets: readonly number[] = [],
  ) {
    this.name = name;
    this.help = help;
    this.type = type;
    this.labelNames = [...labelNames];
    this.buckets = type === 'histogram' ? normalizeBuckets(buckets) : [];
  }

  /** Значения только объявленных лейблов (кардинальность ограничена схемой). */
  private _normalize(labels: MetricLabels = {}): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const name of this.labelNames) {
      const value = labels[name];
      normalized[name] = value === undefined || value === null ? '' : String(value);
    }
    return normalized;
  }

  /** Прибавить значение (counter; для gauge то же, что `set` при первом вызове). */
  inc(labels: MetricLabels = {}, value = 1): void {
    const normalized = this._normalize(labels);
    const key = seriesKey(this.labelNames, normalized);
    const existing = this._series.get(key);
    if (existing) {
      existing.value += value;
      return;
    }
    if (this._series.size >= MAX_SERIES_PER_METRIC) return;
    this._series.set(key, { labels: normalized, value });
  }

  /** Установить значение (gauge; для counter — абсолютное значение). */
  set(labels: MetricLabels, value: number): void {
    const normalized = this._normalize(labels);
    const key = seriesKey(this.labelNames, normalized);
    const existing = this._series.get(key);
    if (existing) {
      existing.value = value;
      return;
    }
    if (this._series.size >= MAX_SERIES_PER_METRIC) return;
    this._series.set(key, { labels: normalized, value });
  }

  /** Очистить все серии (gauge пересчитывается по источнику перед рендером). */
  reset(): void {
    this._series.clear();
  }

  /**
   * Наблюдение гистограммы: значение попадает в `_sum`/`_count` и во все
   * корзины с верхней границей не меньше значения (счётчики кумулятивные).
   */
  observe(labels: MetricLabels, value: number): void {
    if (this.type !== 'histogram' || !Number.isFinite(value)) return;
    const normalized = this._normalize(labels);
    const key = seriesKey(this.labelNames, normalized);
    let existing = this._series.get(key);
    if (!existing) {
      if (this._series.size >= MAX_SERIES_PER_METRIC) return;
      existing = {
        labels: normalized,
        value: 0,
        count: 0,
        buckets: new Array(this.buckets.length).fill(0) as number[],
      };
      this._series.set(key, existing);
    }
    existing.count = (existing.count ?? 0) + 1;
    existing.value += value;
    const buckets = existing.buckets ?? [];
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]!) buckets[i] = (buckets[i] ?? 0) + 1;
    }
  }

  /** Снимок метрики (серии в порядке `labelNames` — детерминированный рендер). */
  snapshot(): MetricSnapshot {
    return {
      name: this.name,
      help: this.help,
      type: this.type,
      labelNames: this.labelNames,
      ...(this.type === 'histogram' ? { buckets: this.buckets } : {}),
      series: [...this._series.values()]
        .map((series) => ({
          labels: { ...series.labels },
          value: series.value,
          ...(series.count !== undefined ? { count: series.count } : {}),
          ...(series.buckets !== undefined ? { buckets: [...series.buckets] } : {}),
        }))
        .sort((a, b) =>
          seriesKey(this.labelNames, a.labels) < seriesKey(this.labelNames, b.labels) ? -1 : 1,
        ),
    };
  }
}

/** Реестр метрик: метрики + коллекторы, обновляющие состояние перед рендером. */
export class ProvisionerRegistry {
  private readonly _metrics: MiniMetric[] = [];
  private readonly _collectors: Array<() => void> = [];

  counter(name: string, help: string, labelNames: readonly string[] = []): MiniMetric {
    const metric = new MiniMetric(name, help, 'counter', labelNames);
    this._metrics.push(metric);
    return metric;
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): MiniMetric {
    const metric = new MiniMetric(name, help, 'gauge', labelNames);
    this._metrics.push(metric);
    return metric;
  }

  /** Гистограмма: кумулятивные `_bucket`, `_sum`, `_count`. */
  histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets: readonly number[] = [],
  ): MiniMetric {
    const metric = new MiniMetric(name, help, 'histogram', labelNames, buckets);
    this._metrics.push(metric);
    return metric;
  }

  /** Коллектор выполняется перед каждым рендером (gauge по текущему состоянию). */
  addCollector(collector: () => void): void {
    this._collectors.push(collector);
  }

  /** Снимок реестра (коллекторы уже выполнены). */
  snapshot(): MetricSnapshot[] {
    for (const collector of this._collectors) {
      try {
        collector();
      } catch {
        // Метрики не должны ломать рендер.
      }
    }
    return this._metrics.map((metric) => metric.snapshot());
  }

  /** Отрендерить exposition 0.0.4 (детерминированный порядок). */
  render(): { text: string; series: number } {
    const metrics = [...this.snapshot()].sort((a, b) => (a.name < b.name ? -1 : 1));
    const lines: string[] = [];
    let series = 0;
    for (const metric of metrics) {
      lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      if (metric.type === 'histogram') {
        series += renderHistogram(metric, lines);
        continue;
      }
      for (const item of metric.series) {
        series += 1;
        lines.push(
          `${metric.name}${formatLabels(metric.labelNames, item.labels)} ${formatNumber(item.value)}`,
        );
      }
    }
    return { text: lines.length > 0 ? `${lines.join('\n')}\n` : '', series };
  }
}

/** `{…,le="…"}`: `le` идёт последним (как в exposition 0.0.4). */
function formatBucketLabels(
  labelNames: readonly string[],
  labels: Record<string, string>,
  le: string,
): string {
  const parts = labelNames.map((name) => `${name}="${escapeLabelValue(labels[name] ?? '')}"`);
  parts.push(`le="${escapeLabelValue(le)}"`);
  return `{${parts.join(',')}}`;
}

/**
 * Отрендерить гистограмму: кумулятивные `_bucket` (явные корзины + `+Inf`),
 * `_sum`, `_count`. Серия гистограммы считается один раз (не по строкам).
 *
 * @returns число серий (для общего счётчика `/metrics`)
 */
function renderHistogram(metric: MetricSnapshot, lines: string[]): number {
  const buckets = metric.buckets ?? [];
  let series = 0;
  for (const item of metric.series) {
    series += 1;
    buckets.forEach((upperBound, index) => {
      const count = item.buckets?.[index] ?? 0;
      lines.push(
        `${metric.name}_bucket${formatBucketLabels(metric.labelNames, item.labels, formatNumber(upperBound))} ${count}`,
      );
    });
    lines.push(
      `${metric.name}_bucket${formatBucketLabels(metric.labelNames, item.labels, '+Inf')} ${item.count ?? 0}`,
    );
    lines.push(
      `${metric.name}_sum${formatLabels(metric.labelNames, item.labels)} ${formatNumber(item.value)}`,
    );
    lines.push(
      `${metric.name}_count${formatLabels(metric.labelNames, item.labels)} ${item.count ?? 0}`,
    );
  }
  return series;
}

/** Исход запроса обеспечения пула (лейбл `outcome`). */
export type ProvisionOutcome = 'ok' | 'error' | 'capacity';

/** Исход удаления пула (лейбл `outcome`). */
export type ReleaseOutcome = 'ok' | 'idle' | 'lifetime' | 'error';

/** Причина ошибки HTTP-слоя (лейбл `reason`) — закрытый набор. */
export type ProvisionerErrorMetricReason =
  | 'invalid_request'
  | 'unauthorized'
  | 'not_found'
  | 'pool_not_found'
  | 'capacity'
  | 'internal_error';

/**
 * Причина ошибки провайдера ресурсов (лейбл `reason`) — закрытый набор.
 *
 * Набор намеренно грубый: `create` (создание секрета/пода), `lookup` (поиск
 * существующего пула), `wait` (ожидание Running/Ready), `delete` (drain/
 * release), `other`. Детали — в тексте ошибки и логах, не в метке.
 */
export type ProviderErrorMetricReason = 'create' | 'lookup' | 'wait' | 'delete' | 'other';

/** Запись реестра пулов, нужная gauge `synth_provisioner_pools`. */
export interface PoolMetricRecord {
  profile: string;
  state: PoolState;
}

/** Источник текущего состояния пулов (привязывается сервисом). */
export type PoolMetricSource = () => ReadonlyArray<PoolMetricRecord>;

const STATES: readonly PoolState[] = ['ready', 'draining'];
const PROVISION_OUTCOMES: readonly ProvisionOutcome[] = ['ok', 'error', 'capacity'];
const RELEASE_OUTCOMES: readonly ReleaseOutcome[] = ['ok', 'idle', 'lifetime', 'error'];
const ERROR_REASONS: readonly ProvisionerErrorMetricReason[] = [
  'invalid_request',
  'unauthorized',
  'not_found',
  'pool_not_found',
  'capacity',
  'internal_error',
];
const PROVIDER_ERROR_REASONS: readonly ProviderErrorMetricReason[] = [
  'create',
  'lookup',
  'wait',
  'delete',
  'other',
];

/** Метрики provisioner'а: реестр + обновление счётчиков. */
export class ProvisionerMetrics {
  /** Реестр (тот же рендер, что отдаёт `/metrics`). */
  readonly registry: ProvisionerRegistry;

  private readonly _pools: MiniMetric;
  private readonly _provision: MiniMetric;
  private readonly _release: MiniMetric;
  private readonly _idle: MiniMetric;
  private readonly _errors: MiniMetric;
  private readonly _ensureSeconds: MiniMetric;
  private readonly _providerErrors: MiniMetric;
  private readonly _profiles: readonly string[];
  /** Профили, для которых серии gauge уже заводились (нули после исчезновения). */
  private readonly _seenProfiles: Set<string>;
  private _poolSource: PoolMetricSource | undefined;

  constructor(opts: { profiles?: readonly string[] } = {}) {
    this.registry = new ProvisionerRegistry();
    this._profiles = [...(opts.profiles ?? [])];
    this._seenProfiles = new Set(this._profiles);

    this._pools = this.registry.gauge(
      'synth_provisioner_pools',
      'Number of execution pools managed by the provisioner, by profile and state.',
      ['profile', 'state'],
    );
    this._provision = this.registry.counter(
      'synth_provisioner_provision_total',
      'Total number of pool provisioning requests, by outcome.',
      ['outcome'],
    );
    this._release = this.registry.counter(
      'synth_provisioner_release_total',
      'Total number of pool releases, by outcome.',
      ['outcome'],
    );
    this._idle = this.registry.counter(
      'synth_provisioner_idle_terminations_total',
      'Total number of pools terminated by the idle timeout.',
    );
    this._errors = this.registry.counter(
      'synth_provisioner_errors_total',
      'Total number of provisioner HTTP errors, by reason.',
      ['reason'],
    );
    this._ensureSeconds = this.registry.histogram(
      'synth_provisioner_ensure_seconds',
      'Time spent ensuring an execution pool at the provider, in seconds.',
      ['provider'],
      ENSURE_SECONDS_BUCKETS,
    );
    this._providerErrors = this.registry.counter(
      'synth_provisioner_provider_errors_total',
      'Total number of pool provider errors, by reason.',
      ['reason'],
    );

    // Нули на старте: «нет данных» и «ноль» должны различаться.
    this._idle.set({}, 0);
    for (const outcome of PROVISION_OUTCOMES) this._provision.inc({ outcome }, 0);
    for (const outcome of RELEASE_OUTCOMES) this._release.inc({ outcome }, 0);
    for (const reason of ERROR_REASONS) this._errors.inc({ reason }, 0);
    for (const reason of PROVIDER_ERROR_REASONS) this._providerErrors.inc({ reason }, 0);
    this._updatePools();
    this.registry.addCollector(() => {
      this._updatePools();
    });
  }

  /** Привязать источник состояния пулов (сервис пулов). */
  setPoolSource(source: PoolMetricSource): void {
    this._poolSource = source;
    this._updatePools();
  }

  /** Запрос обеспечения пула завершился исходом. */
  provisioned(outcome: ProvisionOutcome): void {
    try {
      this._provision.inc({ outcome });
    } catch {
      // ignore
    }
  }

  /** Пул удалён (исход — ручной/по idle/по lifetime/ошибка). */
  released(outcome: ReleaseOutcome): void {
    try {
      this._release.inc({ outcome });
    } catch {
      // ignore
    }
  }

  /** Пул снят по idle-таймауту. */
  idleTerminated(): void {
    try {
      this._idle.inc();
    } catch {
      // ignore
    }
  }

  /** Ошибка HTTP-слоя (закрытый набор причин). */
  error(reason: ProvisionerErrorMetricReason): void {
    try {
      this._errors.inc({ reason });
    } catch {
      // ignore
    }
  }

  /** Время обеспечения пула у провайдера (секунды, лейбл — имя провайдера). */
  ensureObserved(provider: string, seconds: number): void {
    try {
      this._ensureSeconds.observe({ provider }, seconds);
    } catch {
      // ignore
    }
  }

  /** Ошибка провайдера ресурсов (закрытый набор причин). */
  providerError(reason: ProviderErrorMetricReason): void {
    try {
      this._providerErrors.inc({ reason });
    } catch {
      // ignore
    }
  }

  /** Отрендерить метрики (exposition 0.0.4). */
  render(): { text: string; series: number } {
    return this.registry.render();
  }

  /** Пересчитать gauge пулов по источнику (иначе — нули известных профилей). */
  private _updatePools(): void {
    this._pools.reset();
    const counts = new Map<string, number>();
    const profiles = new Set(this._seenProfiles);
    let records: ReadonlyArray<PoolMetricRecord> = [];
    try {
      records = this._poolSource?.() ?? [];
    } catch {
      records = [];
    }
    for (const record of records) {
      if (typeof record.profile !== 'string' || record.profile === '') continue;
      if (!STATES.includes(record.state)) continue;
      profiles.add(record.profile);
      this._seenProfiles.add(record.profile);
      const key = `${record.profile}\u001f${record.state}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const profile of profiles) {
      for (const state of STATES) {
        this._pools.set({ profile, state }, counts.get(`${profile}\u001f${state}`) ?? 0);
      }
    }
  }
}

/** Создать метрики provisioner'а (профили — для нулевых серий gauge). */
export function createProvisionerMetrics(opts?: {
  profiles?: readonly string[];
}): ProvisionerMetrics {
  return new ProvisionerMetrics(opts ?? {});
}
