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
 */

import type { PoolState } from './protocol.js';

/** Тип метрики (гистограммы provisioner'у в 4b-2a не нужны). */
export type MetricType = 'counter' | 'gauge';

/** Значения лейблов: приводятся к строке. */
export type MetricLabels = Record<string, string | number | boolean | null | undefined>;

/** Снимок одной серии. */
export interface MetricSeriesSnapshot {
  labels: Record<string, string>;
  value: number;
}

/** Снимок метрики. */
export interface MetricSnapshot {
  name: string;
  help: string;
  type: MetricType;
  labelNames: readonly string[];
  series: MetricSeriesSnapshot[];
}

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

/** Одна метрика реестра. */
export class MiniMetric {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  readonly labelNames: readonly string[];

  private readonly _series = new Map<string, MetricSeriesSnapshot>();

  constructor(name: string, help: string, type: MetricType, labelNames: readonly string[] = []) {
    this.name = name;
    this.help = help;
    this.type = type;
    this.labelNames = [...labelNames];
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

  /** Снимок метрики (серии в порядке `labelNames` — детерминированный рендер). */
  snapshot(): MetricSnapshot {
    return {
      name: this.name,
      help: this.help,
      type: this.type,
      labelNames: this.labelNames,
      series: [...this._series.values()]
        .map((series) => ({ labels: { ...series.labels }, value: series.value }))
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

/** Метрики provisioner'а: реестр + обновление счётчиков. */
export class ProvisionerMetrics {
  /** Реестр (тот же рендер, что отдаёт `/metrics`). */
  readonly registry: ProvisionerRegistry;

  private readonly _pools: MiniMetric;
  private readonly _provision: MiniMetric;
  private readonly _release: MiniMetric;
  private readonly _idle: MiniMetric;
  private readonly _errors: MiniMetric;
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

    // Нули на старте: «нет данных» и «ноль» должны различаться.
    this._idle.set({}, 0);
    for (const outcome of PROVISION_OUTCOMES) this._provision.inc({ outcome }, 0);
    for (const outcome of RELEASE_OUTCOMES) this._release.inc({ outcome }, 0);
    for (const reason of ERROR_REASONS) this._errors.inc({ reason }, 0);
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
