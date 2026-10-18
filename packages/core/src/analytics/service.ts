/**
 * PROP-102: сервис аналитики — производное чтение отчётов/сводки из
 * пред-агрегированных суточных роллапов (`AnalyticsRollupRepository`).
 *
 * Единственная точка доступа домена к роллапам — порт слоя хранения (ADR-096,
 * инвариант 2). Сервис не пишет: волна 1 — только чтение; запись (сборщики) и
 * бэкфилл — отдельные шаги.
 *
 * Единица периода — **сутки UTC** (`YYYY-MM-DD`, сравнение по строке); дериваты
 * (`total_tokens`, `cache_hit_rate`, `reasoning_ratio`, `output_tps`) считаются
 * на чтении, не персистятся.
 */

import type {
  AnalyticsDimension,
  AnalyticsFamily,
  AnalyticsReport,
  AnalyticsReportKind,
  AnalyticsReportRow,
  AnalyticsRollupRow,
  AnalyticsSummary,
} from '@itphx/synth-shared';
import { ANALYTICS_DIMENSIONS } from '@itphx/synth-shared';
import type { AnalyticsRollupRepository } from '../storage/ports/index.js';
import { deriveMeasures, isUsageDerivedFamily } from './derive.js';

/** Период отчёта (включительно, `YYYY-MM-DD`, UTC). */
export interface AnalyticsPeriod {
  from: string;
  to: string;
}

/** Запрос отчёта по семейству (значения query-параметров, необязательны). */
export interface AnalyticsReportQuery {
  from?: string;
  to?: string;
  groupBy?: readonly AnalyticsDimension[];
  /** Ось `user` (query `userId`). */
  userId?: string;
  /** Ось `project` (query `projectId`). */
  projectId?: string;
  /** Ось `model` (query `model`). */
  model?: string;
  /** Ось `agent` (query `agent`). */
  agent?: string;
}

/** Запрос сводки инстанса за период. */
export interface AnalyticsSummaryQuery {
  from?: string;
  to?: string;
}

export interface AnalyticsServiceOptions {
  /** Порт роллапов (единственная точка доступа к хранилищу). */
  repo: AnalyticsRollupRepository;
  /** Источник текущего времени; по умолчанию `new Date()`. */
  now?: () => Date;
  /** Длина периода по умолчанию (дней, включительно). По умолчанию 30. */
  defaultPeriodDays?: number;
}

/** Причина ошибки валидации — для маппинга в локализуемое сообщение роута. */
export type AnalyticsValidationReason = 'period' | 'range' | 'groupBy';

/** Ошибка валидации запроса отчёта → HTTP 400 `VALIDATION_ERROR`. */
export class AnalyticsValidationError extends Error {
  readonly reason: AnalyticsValidationReason;

  constructor(reason: AnalyticsValidationReason, message: string) {
    super(message);
    this.name = 'AnalyticsValidationError';
    this.reason = reason;
  }
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Сутки UTC даты в формате `YYYY-MM-DD`. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Дата `day` (`YYYY-MM-DD`), прошедшая строгую проверку (реальная дата UTC).
 * Экспортируется для бэкфилла (`analytics/rebuild.ts`, валидация `--from`).
 */
export function isValidDay(day: string): boolean {
  if (!DAY_PATTERN.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && utcDay(parsed) === day;
}

/** Сдвинуть `YYYY-MM-DD` на `delta` суток (UTC). */
function addDays(day: string, delta: number): string {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return utcDay(new Date(parsed.getTime() + delta * MS_PER_DAY));
}

/** Фильтры осей из query-полей (пустые игнорируются). */
function dimensionFilters(query: AnalyticsReportQuery): Partial<Record<AnalyticsDimension, string>> | undefined {
  const filters: Partial<Record<AnalyticsDimension, string>> = {};
  if (query.userId) filters.user = query.userId;
  if (query.projectId) filters.project = query.projectId;
  if (query.model) filters.model = query.model;
  if (query.agent) filters.agent = query.agent;
  return Object.keys(filters).length > 0 ? filters : undefined;
}

/** Сумма разбивок стоимости набора строк; пусто — `undefined`. */
function sumCosts(rows: Array<AnalyticsRollupRow | undefined>): Record<string, number> | undefined {
  const merged: Record<string, number> = {};
  for (const row of rows) {
    for (const [currency, value] of Object.entries(row?.costByCurrency ?? {})) {
      merged[currency] = (merged[currency] ?? 0) + value;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Сервис аналитики: разрешает период и группировку, читает роллапы через порт,
 * накладывает дериваты. Никаких строк/локализации — только данные (PROP-102 §6).
 */
export class AnalyticsService {
  private readonly _repo: AnalyticsRollupRepository;
  private readonly _now: () => Date;
  private readonly _defaultPeriodDays: number;

  constructor(opts: AnalyticsServiceOptions) {
    this._repo = opts.repo;
    this._now = opts.now ?? (() => new Date());
    this._defaultPeriodDays = opts.defaultPeriodDays ?? 30;
  }

  /**
   * Разрешить период отчёта: `to` по умолчанию — сегодня (UTC), `from` по
   * умолчанию — `to` минус `defaultPeriodDays - 1` (включительно). Обе границы
   * валидируются (`YYYY-MM-DD`), `from <= to` обязателен.
   */
  resolvePeriod(fromRaw?: string, toRaw?: string): AnalyticsPeriod {
    const today = utcDay(this._now());
    const to = toRaw ?? today;
    if (!isValidDay(to)) {
      throw new AnalyticsValidationError('period', `to: ожидается дата YYYY-MM-DD (UTC), получено "${to}"`);
    }
    const from = fromRaw === undefined ? addDays(to, -(this._defaultPeriodDays - 1)) : fromRaw;
    if (!isValidDay(from)) {
      throw new AnalyticsValidationError('period', `from: ожидается дата YYYY-MM-DD (UTC), получено "${from}"`);
    }
    if (from > to) {
      throw new AnalyticsValidationError('range', `from ("${from}") позже to ("${to}")`);
    }
    return { from, to };
  }

  /**
   * Разрешить оси группировки: пусто/не задано — итоговая строка (для `prompt` —
   * дефолт `['model', 'agent']`); неизвестная ось → ошибка; дубликаты
   * сохраняют первое вхождение.
   */
  resolveGroupBy(kind: AnalyticsReportKind, groupBy?: readonly AnalyticsDimension[]): AnalyticsDimension[] {
    if (!groupBy || groupBy.length === 0) {
      return kind === 'prompt' ? ['model', 'agent'] : [];
    }
    const seen = new Set<AnalyticsDimension>();
    const resolved: AnalyticsDimension[] = [];
    for (const axis of groupBy) {
      if (!(ANALYTICS_DIMENSIONS as readonly string[]).includes(axis)) {
        throw new AnalyticsValidationError('groupBy', `groupBy: неизвестная ось "${axis}"`);
      }
      if (seen.has(axis)) continue;
      seen.add(axis);
      resolved.push(axis);
    }
    return resolved;
  }

  /**
   * Отчёт по семейству за период: чтение роллапов + дериваты (для
   * usage-производных семейств). `prompt` читается из семейства `usage`.
   */
  async getReport(kind: AnalyticsReportKind, query: AnalyticsReportQuery = {}): Promise<AnalyticsReport> {
    const period = this.resolvePeriod(query.from, query.to);
    const groupBy = this.resolveGroupBy(kind, query.groupBy);
    const family: AnalyticsFamily = kind === 'prompt' ? 'usage' : kind;
    const rows = await this._repo.query({
      family,
      from: period.from,
      to: period.to,
      dimensions: dimensionFilters(query),
      groupBy,
    });
    return {
      report: kind,
      from: period.from,
      to: period.to,
      groupBy,
      rows: rows.map((row) => this._decorate(kind, row)),
    };
  }

  /**
   * Сводка инстанса за период: итоги по `usage` (с дериватами), `activity`,
   * `decision` и разбивка стоимости по валютам. Строки отчётов сервер не
   * сочиняет — только данные.
   */
  async getSummary(query: AnalyticsSummaryQuery = {}): Promise<AnalyticsSummary> {
    const period = this.resolvePeriod(query.from, query.to);
    const [usageResult, activityResult, decisionResult] = await Promise.all([
      this._repo.query({ family: 'usage', from: period.from, to: period.to }),
      this._repo.query({ family: 'activity', from: period.from, to: period.to }),
      this._repo.query({ family: 'decision', from: period.from, to: period.to }),
    ]);
    const usageRow = usageResult[0];
    const activityRow = activityResult[0];
    const decisionRow = decisionResult[0];
    const usageMeasures = usageRow?.measures ?? {};
    const costByCurrency = sumCosts([usageRow, activityRow, decisionRow]);
    return {
      from: period.from,
      to: period.to,
      usage: { ...usageMeasures, ...deriveMeasures(usageMeasures) },
      activity: { ...(activityRow?.measures ?? {}) },
      decision: { ...(decisionRow?.measures ?? {}) },
      ...(costByCurrency ? { costByCurrency } : {}),
    };
  }

  /** Наложить дериваты поверх сырых мер (только usage-производные семейства). */
  private _decorate(kind: AnalyticsReportKind, row: AnalyticsRollupRow): AnalyticsReportRow {
    if (!isUsageDerivedFamily(kind)) return row;
    return { ...row, measures: { ...row.measures, ...deriveMeasures(row.measures) } };
  }
}
