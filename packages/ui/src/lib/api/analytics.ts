// analytics: домен API v2 (ADR-095) — объект `analyticsApi` и его DTO.
//
// ADR-102 §4: отчёты аналитики инстанса — **только чтение**. Поверхность:
// `GET /analytics/summary`, `GET /analytics/{usage,activity,decision,prompt}` и
// `GET /analytics/export?report&format`. Типы — общий контракт shared
// (`@itphx/synth-shared/types`); локальных дубликатов DTO нет.
//
// RBAC серверный (ADR-102 §7): обычному пользователю `decision` и `summary`
// отдают 403 `FORBIDDEN`, а `usage`/`activity`/`prompt` сервер фильтрует по его
// оси `user` сам. UI только показывает понятное сообщение — права не дублируются.

import type {
  AnalyticsDimension,
  AnalyticsExportFormat,
  AnalyticsReport,
  AnalyticsReportKind,
  AnalyticsSummary,
} from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

export type {
  AnalyticsDimension,
  AnalyticsExportFormat,
  AnalyticsReport,
  AnalyticsReportKind,
  AnalyticsSummary,
}

/** Query-параметры отчёта (пустые значения не отправляются). */
export interface AnalyticsQuery {
  /** Начало периода включительно (`YYYY-MM-DD`, UTC). */
  from?: string
  /** Конец периода включительно (`YYYY-MM-DD`, UTC). */
  to?: string
  /** Оси группировки; пусто — итог (`prompt` — дефолт `model,agent` на сервере). */
  groupBy?: readonly AnalyticsDimension[]
  /** Ось `user` (обычному пользователю сервер подставляет себя). */
  userId?: string
  /** Ось `project`. */
  projectId?: string
  /** Ось `model`. */
  model?: string
  /** Ось `agent`. */
  agent?: string
}

/** Запрос выгрузки: отчёт + формат (CSV/JSON, сервер отдаёт данные). */
export interface AnalyticsExportQuery extends AnalyticsQuery {
  report: AnalyticsReportKind
  format: AnalyticsExportFormat
}

/** Полученный файл выгрузки: содержимое + имя из `Content-Disposition`. */
export interface AnalyticsExportFile {
  blob: Blob
  filename: string
}

/** Непустые query-параметры в строку запроса (без `?`, если пусто). */
function encodeQuery(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value)
  }
  const qs = search.toString()
  return qs.length > 0 ? `?${qs}` : ''
}

/** Общие параметры отчёта (groupBy — через запятую, как принимает роут). */
function reportParams(query: AnalyticsQuery): Record<string, string | undefined> {
  return {
    from: query.from,
    to: query.to,
    groupBy: query.groupBy && query.groupBy.length > 0 ? query.groupBy.join(',') : undefined,
    userId: query.userId,
    projectId: query.projectId,
    model: query.model,
    agent: query.agent,
  }
}

/** Имя файла из `Content-Disposition` (`filename*=UTF-8''…` приоритетнее). */
export function filenameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (encoded?.[1]) {
    const raw = encoded[1].trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain?.[1]?.trim()
}

/** Ошибка выгрузки в том же контракте, что у `fetchJSON` (`status`/`code`). */
async function throwExportError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null) as
    | { detail?: string; error?: { code?: string; message?: string } }
    | null
  const message =
    body?.detail || body?.error?.message || body?.error?.code || `HTTP ${response.status}`
  throw Object.assign(new Error(message), {
    status: response.status,
    code: body?.error?.code,
  })
}

export const analyticsApi = {
  // --- ADR-102 §4: сводка инстанса за период (сквозная → elevated/auditor) ---
  /** GET /analytics/summary — итоги usage/activity/decision + стоимость. */
  async getAnalyticsSummary(params: Pick<AnalyticsQuery, 'from' | 'to'> = {}): Promise<AnalyticsSummary> {
    return fetchJSON<AnalyticsSummary>(
      `${BASE_URL}/analytics/summary${encodeQuery({ from: params.from, to: params.to })}`,
    )
  },

  /** GET /analytics/usage — токены, стоимость и дериваты по осям. */
  async getAnalyticsUsage(params: AnalyticsQuery = {}): Promise<AnalyticsReport> {
    return fetchJSON<AnalyticsReport>(`${BASE_URL}/analytics/usage${encodeQuery(reportParams(params))}`)
  },

  /** GET /analytics/activity — сессии/сообщения/инструменты/ошибки по осям. */
  async getAnalyticsActivity(params: AnalyticsQuery = {}): Promise<AnalyticsReport> {
    return fetchJSON<AnalyticsReport>(`${BASE_URL}/analytics/activity${encodeQuery(reportParams(params))}`)
  },

  /** GET /analytics/decision — персистентные метрики decision-слоя (сквозной отчёт). */
  async getAnalyticsDecision(params: AnalyticsQuery = {}): Promise<AnalyticsReport> {
    return fetchJSON<AnalyticsReport>(`${BASE_URL}/analytics/decision${encodeQuery(reportParams(params))}`)
  },

  /** GET /analytics/prompt — производные `usage`: кэш, reasoning, output tps. */
  async getAnalyticsPrompt(params: AnalyticsQuery = {}): Promise<AnalyticsReport> {
    return fetchJSON<AnalyticsReport>(`${BASE_URL}/analytics/prompt${encodeQuery(reportParams(params))}`)
  },

  /**
   * GET /analytics/export — CSV/JSON с `Content-Disposition: attachment`.
   * Возвращает blob и имя файла: скачивание инициирует вызывающий (UI-слой).
   */
  async getAnalyticsExport(query: AnalyticsExportQuery): Promise<AnalyticsExportFile> {
    const url = `${BASE_URL}/analytics/export${encodeQuery({
      ...reportParams(query),
      report: query.report,
      format: query.format,
    })}`
    const response = await fetch(url, { credentials: 'include' })
    if (!response.ok) return throwExportError(response)
    const filename =
      filenameFromContentDisposition(response.headers.get('Content-Disposition')) ??
      `analytics-${query.report}-${query.from ?? ''}_${query.to ?? ''}.${query.format}`
    return { blob: await response.blob(), filename }
  },
}
