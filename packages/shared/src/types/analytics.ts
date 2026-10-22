/**
 * ADR-102: аналитика и отчётность инстанса — контракт пред-агрегированных
 * суточных роллапов.
 *
 * Единица роллапа — **сутки в UTC**. Хранилище держит **сырые счётчики**
 * (`measures` + `costByCurrency`); дериваты (`cache_hit_rate`, `output_tps`,
 * итоги по валютам) считает сервис на чтении. Роллапы агрегированы: текстов
 * сообщений, содержимого промптов, ключей и PII в значениях нет.
 */

/** Семейства роллапов (ADR-102 §2). */
export const ANALYTICS_FAMILIES = ['usage', 'activity', 'decision', 'prompt'] as const;
export type AnalyticsFamily = (typeof ANALYTICS_FAMILIES)[number];

/**
 * Оси измерений роллапа. Короткие ключи `dimensions`; `day` — отдельное поле
 * бакета (`AnalyticsRollupBucket.day`), но участвует в фильтрах и группировке.
 */
export const ANALYTICS_DIMENSIONS = ['day', 'user', 'project', 'model', 'agent', 'provider'] as const;
export type AnalyticsDimension = (typeof ANALYTICS_DIMENSIONS)[number];

/**
 * Известные меры по семействам. Имена — snake_case (как в `sessions/stats.ts`:
 * `input_tokens`/`output_tokens`/`cost_usd`/…). Список — подсказка/валидация
 * уровня домена: хранилище неизвестные числовые меры не отбрасывает.
 */
export const ANALYTICS_MEASURES_BY_FAMILY = {
  usage: [
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
    'requests',
    'messages',
    'duration_ms',
  ],
  activity: [
    'sessions_created',
    'sessions_archived',
    'messages_user',
    'messages_assistant',
    'messages_tool',
    'tool_calls',
    'errors',
    'aborts',
    'turns',
  ],
  // Персистентная замена in-memory снимка `decisionMetrics` (ADR-084); модель — ось, `by_model` не дублируется.
  decision: ['calls', 'handled', 'fallback', 'escalated', 'attempts', 'rejected'],
  // `prompt` — производные от `usage` (`cache_hit_rate`, доля reasoning, output tps): отдельной записи не требует.
  prompt: [],
} as const satisfies Record<AnalyticsFamily, readonly string[]>;

/**
 * Пред-агрегированный бакет роллапа. Ключ — `(family, day, dimensions)`
 * (измерения в отсортированном порядке). `increment` — upsert с суммированием,
 * `set` — точная перезапись.
 */
export interface AnalyticsRollupBucket {
  family: AnalyticsFamily;
  /** Сутки UTC в формате `YYYY-MM-DD`. */
  day: string;
  /** Значения осей (короткие ключи `AnalyticsDimension`); `day` — отдельное поле. */
  dimensions: Record<string, string>;
  /** Сырые счётчики (snake_case); неизвестные меры сохраняются как есть. */
  measures: Record<string, number>;
  /** Разбивка стоимости по валютам; пустая — поле опускается. */
  costByCurrency?: Record<string, number>;
}

/** Запрос среза/серии роллапов: фильтры (семейство/период/оси) + группировка. */
export interface AnalyticsRollupQuery {
  family: AnalyticsFamily;
  /** Начало периода включительно (`YYYY-MM-DD`, сравнение по строке). */
  from?: string;
  /** Конец периода включительно (`YYYY-MM-DD`). */
  to?: string;
  /** Фильтр по равенству значений осей; для `day` — сравнение с `bucket.day`. */
  dimensions?: Partial<Record<AnalyticsDimension, string>>;
  /** Оси группировки; пусто/не задано — одна итоговая строка (`dimensions: {}`). */
  groupBy?: AnalyticsDimension[];
}

/** Строка агрегированного ответа: значения осей группировки + суммы мер. */
export interface AnalyticsRollupRow {
  /** Значения осей группировки (пусто — итог). */
  dimensions: Record<string, string>;
  measures: Record<string, number>;
  /** Разбивка стоимости по валютам; пустая — поле опускается. */
  costByCurrency?: Record<string, number>;
}

/**
 * Дериваты, которые сервис считает **на чтении** из сырых счётчиков (не
 * персистятся, ADR-102 §2). В строке отчёта лежат рядом с сырыми мерами; при
 * экспорте выносятся отдельными колонками после сырых мер.
 */
export const ANALYTICS_DERIVED_MEASURES = [
  'total_tokens',
  'cache_hit_rate',
  'reasoning_ratio',
  'output_tps',
] as const;
export type AnalyticsDerivedMeasure = (typeof ANALYTICS_DERIVED_MEASURES)[number];

/** Идентификатор отчёта — совпадает с семейством роллапов (ADR-102 §4). */
export type AnalyticsReportKind = AnalyticsFamily;

/** Строка отчёта: оси группировки + меры (в т.ч. дериваты) + стоимость. */
export interface AnalyticsReportRow {
  /** Значения осей группировки (пусто — итог). */
  dimensions: Record<string, string>;
  /** Меры: сырые счётчики + дериваты (`ANALYTICS_DERIVED_MEASURES`). */
  measures: Record<string, number>;
  /** Разбивка стоимости по валютам; пустая — поле опускается. */
  costByCurrency?: Record<string, number>;
}

/** Отчёт по семейству за период (только чтение, ADR-102 §4). */
export interface AnalyticsReport {
  report: AnalyticsReportKind;
  /** Начало периода включительно (`YYYY-MM-DD`, UTC). */
  from: string;
  /** Конец периода включительно (`YYYY-MM-DD`, UTC). */
  to: string;
  /** Оси группировки (порядок важен для экспорта). */
  groupBy: AnalyticsDimension[];
  rows: AnalyticsReportRow[];
}

/** Формат выгрузки отчёта (server-side, только данные — ADR-102 §6). */
export const ANALYTICS_EXPORT_FORMATS = ['csv', 'json'] as const;
export type AnalyticsExportFormat = (typeof ANALYTICS_EXPORT_FORMATS)[number];

/**
 * Сводка инстанса за период: агрегаты по семействам (меры usage с дериватами,
 * меры activity и decision — своими словарями). Без персональных данных.
 */
export interface AnalyticsSummary {
  from: string;
  to: string;
  /** Меры `usage` (в т.ч. дериваты) — итог по периоду. */
  usage: Record<string, number>;
  /** Меры `activity` — итог по периоду. */
  activity: Record<string, number>;
  /** Меры `decision` — итог по периоду. */
  decision: Record<string, number>;
  /** Итоговая стоимость по валютам; пустая — поле опускается. */
  costByCurrency?: Record<string, number>;
}
