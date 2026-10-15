// decision: домен API v2 (ADR-095) — объект `decisionApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

/**
 * ADR-084: runtime-настройки decision-слоя (`GET/PUT/DELETE /settings/decision`).
 * Тип объявлен локально: бизнес-тип в shared есть, но тянуть core/shared-конфиг
 * в браузерный бандл нельзя (см. `packages/ui/AGENTS.md`).
 */
export interface DecisionSettings {
  /** Мастер-выключатель decision-слоя. */
  enabled: boolean
  /** Имя провайдера decision-протокола (тип `decision`/`systemone`; пусто — не задан). */
  provider: string
  /** Модель decision-слоя (напр. `clef-flash`). */
  model: string
  /** Порог уверенности 0..1: ниже — fallback (fail-safe). */
  confidenceThreshold: number
  /**
   * ADR-084 Ф6: необязательный точный тир на эскалацию — провайдер (пусто —
   * без эскалации). Вторая пара provider/model: используется, когда основная
   * модель не дала уверенного валидного ответа (низкая уверенность/ошибка).
   */
  escalationProvider: string
  /** ADR-084 Ф6: необязательная модель эскалации (пусто — без эскалации). */
  escalationModel: string
}

/** ADR-084: ответ `GET/DELETE /settings/decision` — эффективные значения, дефолты и флаг override. */
export interface DecisionSettingsResponse {
  decision: DecisionSettings
  defaults: DecisionSettings
  isOverridden: boolean
}

/** ADR-084: статус попытки тира decision-каскада (см. `decision-cascade.ts` в core). */
export type DecisionAttemptStatus =
  | 'ok'
  | 'low_confidence'
  | 'invalid'
  | 'no_answer'
  | 'no_provider'
  | 'error'

/** ADR-084: разбивка метрик по модели `'<provider>/<model>'` (latency — по попыткам модели). */
export interface DecisionModelMetrics {
  calls: number
  handled: number
  latency_ms_avg: number
  latency_ms_max: number
}

/**
 * ADR-084: сериализуемый снимок агрегатных in-memory метрик decision-слоя
 * (`GET /settings/decision/metrics`). Форма повторяет
 * `DecisionMetricsSnapshot` из core (`engine/router/decision-metrics.ts`).
 */
export interface DecisionMetrics {
  /** Обращений к каскаду. */
  calls: number
  /** Принятых решений. */
  handled: number
  /** Отказов каскада. */
  fallback: number
  /** Принятых на тире `escalation`. */
  escalated: number
  /** Счётчики попыток по тирам. */
  attempts: { primary: number; escalation: number }
  /** Распределение статусов попыток. */
  rejected: Record<DecisionAttemptStatus, number>
  /** Разбивка по моделям `'<provider>/<model>'`. */
  by_model: Record<string, DecisionModelMetrics>
}

export const decisionApi = {
  // --- Decision-модели (ADR-084): runtime-настройки decision-слоя ---
  /** GET /settings/decision — эффективные настройки decision-слоя + дефолты + флаг override. */
  async getDecisionSettings(): Promise<DecisionSettingsResponse> {
    return fetchJSON<DecisionSettingsResponse>(`${BASE_URL}/settings/decision`)
  },

  /** PUT /settings/decision — сохранить runtime-настройки decision-слоя (live-применение). */
  async updateDecisionSettings(decision: DecisionSettings): Promise<{ decision: DecisionSettings }> {
    return fetchJSON<{ decision: DecisionSettings }>(`${BASE_URL}/settings/decision`, {
      method: 'PUT',
      body: JSON.stringify({ decision }),
    })
  },

  /** DELETE /settings/decision — сброс runtime-настроек к config.yaml-дефолту. */
  async resetDecisionSettings(): Promise<DecisionSettingsResponse> {
    return fetchJSON<DecisionSettingsResponse>(`${BASE_URL}/settings/decision`, { method: 'DELETE' })
  },

  /** GET /settings/decision/metrics — снимок in-memory метрик decision-слоя + время снятия. */
  async getDecisionMetrics(): Promise<{ metrics: DecisionMetrics; ts: string }> {
    return fetchJSON<{ metrics: DecisionMetrics; ts: string }>(`${BASE_URL}/settings/decision/metrics`)
  },

  /** DELETE /settings/decision/metrics — сброс накопителей метрик (под write-guard). */
  async resetDecisionMetrics(): Promise<{ metrics: DecisionMetrics }> {
    return fetchJSON<{ metrics: DecisionMetrics }>(`${BASE_URL}/settings/decision/metrics`, {
      method: 'DELETE',
    })
  },
}
