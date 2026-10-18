/**
 * PROP-102 §4/§7: HTTP-фабрика отчётов аналитики — **только чтение**.
 *
 * Единая реализация для core (standalone) и backend (managed): RBAC/скоуп
 * задаются через `opts` (`resolveElevated`/`resolveAuditor`/`resolveUserId`),
 * локализация — через `opts.messages`. Мутирующих ручек нет.
 *
 * Поверхность:
 * - `GET /summary?from&to`;
 * - `GET /usage|/activity|/decision|/prompt?from&to&groupBy=day,user,…&userId&projectId&model&agent`;
 * - `GET /export?report=usage|activity|decision|prompt&format=csv|json&…`.
 *
 * Скоуп (PROP-102 §7): `ADMIN`/`LEAD` — сквозной обзор; `AUDITOR` — чтение всех
 * отчётов; обычный пользователь — принудительный фильтр оси `user` по себе, а
 * для сквозных отчётов (`decision`, `summary`) — 403 `FORBIDDEN`.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { ANALYTICS_EXPORT_FORMATS, ANALYTICS_FAMILIES } from '@itphx/synth-shared';
import type { AnalyticsDimension, AnalyticsExportFormat, AnalyticsReportKind } from '@itphx/synth-shared';
import { AnalyticsValidationError } from '../../analytics/service.js';
import type { AnalyticsReportQuery, AnalyticsService } from '../../analytics/service.js';
import { toCsv, toJson } from '../../analytics/export.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface AnalyticsRoutesAuth {
  requireAuth: Middleware;
}

export interface AnalyticsRoutesDeps {
  service: AnalyticsService;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы. */
export interface AnalyticsRouteMessages {
  invalidPeriod: (c: Context) => string;
  invalidRange: (c: Context) => string;
  invalidGroupBy: (c: Context) => string;
  invalidOption: (c: Context) => string;
  forbidden: (c: Context) => string;
}

export interface AnalyticsRoutesOptions {
  messages?: Partial<AnalyticsRouteMessages>;
  /** Сквозной обзор (ADMIN/LEAD) — все отчёты без фильтра по себе. Core — всегда true. */
  resolveElevated?: (c: Context) => boolean | Promise<boolean>;
  /** Роль-аудитор (AUDITOR) — чтение всех отчётов. Core — нет. */
  resolveAuditor?: (c: Context) => boolean | Promise<boolean>;
  /** userId текущего пользователя (для принудительного скоупа). Core — 'local'. */
  resolveUserId?: (c: Context) => string | Promise<string>;
}

const DEFAULT_MESSAGES: AnalyticsRouteMessages = {
  invalidPeriod: () => 'Некорректный период: ожидается дата YYYY-MM-DD (UTC)',
  invalidRange: () => 'Начало периода позже конца периода',
  invalidGroupBy: () => 'Некорректная ось группировки (groupBy)',
  invalidOption: () => 'Некорректный параметр отчёта (report/format)',
  forbidden: () => 'Недостаточно прав для отчёта',
};

const REPORT_KINDS: ReadonlySet<string> = new Set(ANALYTICS_FAMILIES);
const EXPORT_FORMATS: ReadonlySet<string> = new Set(ANALYTICS_EXPORT_FORMATS);

/** Непустое значение query-параметра (пустая строка — как «не задано»). */
function queryParam(c: Context, name: string): string | undefined {
  const value = c.req.query(name);
  return value !== undefined && value !== '' ? value : undefined;
}

/**
 * `groupBy=a,b` → оси. Пустые значения отбрасываются; допустимость осей
 * проверяет сервис (`resolveGroupBy`, единственная точка валидации → 400).
 */
function parseGroupBy(raw: string | undefined): AnalyticsDimension[] | undefined {
  if (raw === undefined) return undefined;
  const axes = raw
    .split(',')
    .map((axis) => axis.trim())
    .filter((axis) => axis.length > 0);
  return axes.length > 0 ? (axes as AnalyticsDimension[]) : undefined;
}

/**
 * PROP-102: фабрика роутов отчётов аналитики (только чтение). Денорализованный
 * фильтр оси `user` для обычного пользователя применяется здесь — обработчик не
 * доверяет query-параметру `userId`.
 */
export function createAnalyticsRoutes(
  auth: AnalyticsRoutesAuth,
  deps: AnalyticsRoutesDeps,
  opts: AnalyticsRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: AnalyticsRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const readGuard: Middleware = auth.requireAuth;
  const isElevated = opts.resolveElevated ?? (() => true);
  const isAuditor = opts.resolveAuditor ?? (() => false);
  const resolveUserId = opts.resolveUserId ?? (() => 'local');

  const forbidden = (c: Context) =>
    c.json({ error: { code: 'FORBIDDEN', message: messages.forbidden(c) } }, 403);

  const invalidOption = (c: Context) =>
    c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidOption(c) } }, 400);

  /** Ошибка валидации сервиса → 400 `VALIDATION_ERROR` с локализуемым сообщением. */
  const validationError = (c: Context, err: unknown): Response => {
    if (err instanceof AnalyticsValidationError) {
      const message = {
        period: messages.invalidPeriod,
        range: messages.invalidRange,
        groupBy: messages.invalidGroupBy,
      }[err.reason](c);
      return c.json({ error: { code: 'VALIDATION_ERROR', message } }, 400);
    }
    throw err;
  };

  /** Обычный пользователь (не elevated/auditor) — скоуп ограничен своими данными. */
  const isRestricted = async (c: Context): Promise<boolean> => {
    if (await isElevated(c)) return false;
    return !(await isAuditor(c));
  };

  const reportQuery = (c: Context): AnalyticsReportQuery => ({
    from: queryParam(c, 'from'),
    to: queryParam(c, 'to'),
    groupBy: parseGroupBy(queryParam(c, 'groupBy')),
    userId: queryParam(c, 'userId'),
    projectId: queryParam(c, 'projectId'),
    model: queryParam(c, 'model'),
    agent: queryParam(c, 'agent'),
  });

  // GET /api/v2/analytics/summary — сводка инстанса за период (сквозная → только elevated/auditor).
  app.get('/summary', readGuard, async (c) => {
    if (await isRestricted(c)) return forbidden(c);
    try {
      const summary = await deps.service.getSummary({
        from: queryParam(c, 'from'),
        to: queryParam(c, 'to'),
      });
      return c.json(summary);
    } catch (err) {
      return validationError(c, err);
    }
  });

  // GET /api/v2/analytics/:report — отчёт по семейству (usage/activity/decision/prompt).
  const reports: readonly AnalyticsReportKind[] = ['usage', 'activity', 'decision', 'prompt'];
  for (const kind of reports) {
    app.get(`/${kind}`, readGuard, async (c) => {
      const restricted = await isRestricted(c);
      // `decision` — сквозной отчёт (нет оси user) → обычному пользователю 403.
      if (restricted && kind === 'decision') return forbidden(c);
      const query = reportQuery(c);
      if (restricted) query.userId = await resolveUserId(c);
      try {
        const report = await deps.service.getReport(kind, query);
        return c.json(report);
      } catch (err) {
        return validationError(c, err);
      }
    });
  }

  // GET /api/v2/analytics/export — выгрузка отчёта CSV/JSON (только данные, PROP-102 §6).
  app.get('/export', readGuard, async (c) => {
    const reportRaw = queryParam(c, 'report');
    const formatRaw = queryParam(c, 'format');
    if (reportRaw === undefined || !REPORT_KINDS.has(reportRaw)) return invalidOption(c);
    if (formatRaw === undefined || !EXPORT_FORMATS.has(formatRaw)) return invalidOption(c);
    const kind = reportRaw as AnalyticsReportKind;
    const format = formatRaw as AnalyticsExportFormat;

    const restricted = await isRestricted(c);
    if (restricted && kind === 'decision') return forbidden(c);
    const query = reportQuery(c);
    if (restricted) query.userId = await resolveUserId(c);

    let report;
    try {
      report = await deps.service.getReport(kind, query);
    } catch (err) {
      return validationError(c, err);
    }

    const filename = `analytics-${kind}-${report.from}_${report.to}.${format}`;
    const headers = { 'Content-Disposition': `attachment; filename="${filename}"` };
    if (format === 'csv') {
      return c.body(toCsv(report), 200, { ...headers, 'Content-Type': 'text/csv; charset=utf-8' });
    }
    return c.body(toJson(report), 200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  });

  return app;
}
