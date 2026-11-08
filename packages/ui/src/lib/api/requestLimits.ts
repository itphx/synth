// request-limits: лимит тяжёлых операций с сессиями (импорт/экспорт/форк/merge)
// на креденту, запросов в минуту. `0` — без лимита.
//
// `GET/PUT/DELETE /api/v2/settings/limits`: чтение, runtime-override
// (применяется сразу, без рестарта) и сброс к env/config/default.
// При env-фиксации сервер отвечает 409.

import { BASE_URL, fetchJSON } from './base'

/** Источник эффективного значения (env > runtime > config > default). */
export type RequestLimitsSource = 'env' | 'runtime' | 'config' | 'default'

export interface RequestLimitsSettings {
  /** Эффективный лимит запросов в минуту (0 — без лимита). */
  sessionOpsPerMinute: number
  /** Сохранённое runtime-значение (`null` — не задано). */
  saved: number | null
  /** База без runtime/env. */
  defaults: number
  source: RequestLimitsSource
  envLocked: boolean
  restartRequired: boolean
}

const SOURCES: readonly RequestLimitsSource[] = ['env', 'runtime', 'config', 'default']

function isSource(value: unknown): value is RequestLimitsSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

function isLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function normalize(raw: unknown): RequestLimitsSettings {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const value = isLimit(body.sessionOpsPerMinute) ? body.sessionOpsPerMinute : 0
  return {
    sessionOpsPerMinute: value,
    saved: isLimit(body.saved) ? body.saved : null,
    defaults: isLimit(body.defaults) ? body.defaults : 0,
    source: isSource(body.source) ? body.source : 'default',
    envLocked: body.envLocked === true,
    restartRequired: body.restartRequired === true,
  }
}

export const requestLimitsApi = {
  async getRequestLimits(): Promise<RequestLimitsSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/limits`)
    return normalize(raw)
  },

  async setRequestLimits(sessionOpsPerMinute: number): Promise<RequestLimitsSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/limits`, {
      method: 'PUT',
      body: JSON.stringify({ sessionOpsPerMinute }),
    })
    return normalize(raw)
  },

  async resetRequestLimits(): Promise<RequestLimitsSettings> {
    const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/limits`, {
      method: 'DELETE',
    })
    return normalize(raw)
  },
}
