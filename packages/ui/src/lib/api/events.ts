// events: домен API v2 (ADR-095) — объект `eventsApi` и его DTO.

import type {
  EventBinding,
  EventBindingApiKey,
  EventBindingApiKeyCreated,
  EventBindingInputRequest,
  EventRouteRule,
  EventRouteRuleInputRequest,
  RouteDecision,
  SynthEvent,
} from '@itphx/synth-shared'
import { BASE_URL, fetchJSON } from './base'

/**
 * ADR-089/ADR-052: тело создания API-ключа привязки — обязательная уникальная
 * (в пределах инстанса) `label`; остальные поля опциональны.
 */
export interface CreateEventBindingKeyInput {
  label: string
  description?: string
  /** ISO-8601 срок действия; не задан — бессрочно. */
  expiresAt?: string
  /** Лимит запросов/мин; не задан — глобальный дефолт, `0` — без лимита. */
  rateLimitPerMinute?: number
}

/**
 * ADR-089/ADR-052: частичное обновление API-ключа. `null` у
 * `description`/`expiresAt`/`rateLimitPerMinute` сбрасывает поле.
 */
export interface UpdateEventBindingKeyPatch {
  label?: string
  description?: string | null
  expiresAt?: string | null
  rateLimitPerMinute?: number | null
}

/**
 * ADR-089: runtime-настройки раздела «События» (`GET/PUT/DELETE /settings/events`).
 * Тип объявлен локально: в shared его нет, а из core тянуть нельзя.
 */
export interface EventsSettings {
  enabled: boolean
  defaultMode: 'bound' | 'ephemeral'
  /** TTL ephemeral-сессий (напр. `30s`, `15m`, `1h`, `24h`, `7d`). */
  ephemeralTtl: string
  /** Срок хранения журнала событий в днях; `0` — без ограничения. */
  journalRetentionDays: number
  /** Белый список разрешённых источников; пусто — все. */
  allowedSources: string[]
  /** Поведение при неизвестном `agentTemplate`: `drop` или `default-agent`. */
  unknownAgentTemplate: 'drop' | 'default-agent'
  /** Глобальный дефолт лимита запросов/мин на API-ключ; `0` — без лимита. */
  keyRateLimitPerMinute: number
  /** ADR-084: decision-маршрутизация внешних событий (default `false`, opt-in). */
  decisionRouting: boolean
  /** ADR-089: auto-bind — фоллбек-закрепление события с chatKey/threadKey за сессией (default `false`). */
  autoBind: boolean
  /** ADR-089: шаблон агента auto-bind-сессий (пусто — агент по умолчанию). */
  autoBindAgentTemplate: string
  /**
   * ADR-089: маппинг идентичности внешнего отправителя (`identity.chatKey` /
   * `identity.principalId`) → id пользователя инстанса.
   */
  identityMap: Record<string, string>
}

/** ADR-089: ответ `GET/DELETE /settings/events` — эффективные значения, дефолты и флаг override. */
export interface EventsSettingsResponse {
  events: EventsSettings
  defaults: EventsSettings
  isOverridden: boolean
}

/**
 * ADR-089: запись журнала внешних событий. `EventJournalEntry` живёт в core и в
 * shared не экспортируется — локальный тип повторяет серверную форму.
 */
export interface EventJournalEntry {
  /** ISO-8601. */
  ts: string
  event: SynthEvent
  decision?: RouteDecision
  error?: string
  /** ADR-089/ADR-052: id API-ключа, которым принято событие (если применимо). */
  keyId?: string
  /** ADR-089: id принципала — внешней идентичности отправителя. */
  principalId?: string
}

export const eventsApi = {
  // --- Внешние события (ADR-089): биндинги и журнал ---
  async listEventBindings(): Promise<{ bindings: EventBinding[] }> {
    return fetchJSON<{ bindings: EventBinding[] }>(`${BASE_URL}/events/bindings`)
  },

  /** Upsert привязки по `source` + `chatKey`/`threadKey` (id сохраняется на сервере). */
  async upsertEventBinding(input: EventBindingInputRequest): Promise<EventBinding> {
    return fetchJSON<EventBinding>(`${BASE_URL}/events/bindings`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  async deleteEventBinding(id: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/events/bindings/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  // --- Внешние события (ADR-089/ADR-052): API-ключи привязки ---
  /** GET /events/bindings/:id/keys — метаданные ключей привязки (без секретов). */
  async getEventBindingKeys(bindingId: string): Promise<{ keys: EventBindingApiKey[] }> {
    return fetchJSON<{ keys: EventBindingApiKey[] }>(
      `${BASE_URL}/events/bindings/${encodeURIComponent(bindingId)}/keys`,
    )
  },

  /** POST /events/bindings/:id/keys — создание ключа; секрет (`key`) возвращается один раз. */
  async createEventBindingKey(
    bindingId: string,
    input: CreateEventBindingKeyInput,
  ): Promise<EventBindingApiKeyCreated> {
    return fetchJSON<EventBindingApiKeyCreated>(
      `${BASE_URL}/events/bindings/${encodeURIComponent(bindingId)}/keys`,
      { method: 'POST', body: JSON.stringify(input) },
    )
  },

  /** PATCH /events/bindings/:id/keys/:keyId — частичное обновление (`null` сбрасывает поле). */
  async updateEventBindingKey(
    bindingId: string,
    keyId: string,
    patch: UpdateEventBindingKeyPatch,
  ): Promise<EventBindingApiKey> {
    return fetchJSON<EventBindingApiKey>(
      `${BASE_URL}/events/bindings/${encodeURIComponent(bindingId)}/keys/${encodeURIComponent(keyId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    )
  },

  /** POST /events/bindings/:id/keys/:keyId/revoke — мягкий отзыв ключа (идемпотентно). */
  async revokeEventBindingKey(bindingId: string, keyId: string): Promise<EventBindingApiKey> {
    return fetchJSON<EventBindingApiKey>(
      `${BASE_URL}/events/bindings/${encodeURIComponent(bindingId)}/keys/${encodeURIComponent(keyId)}/revoke`,
      { method: 'POST' },
    )
  },

  /** DELETE /events/bindings/:id/keys/:keyId — удаление ключа привязки. */
  async deleteEventBindingKey(bindingId: string, keyId: string): Promise<void> {
    return fetchJSON<void>(
      `${BASE_URL}/events/bindings/${encodeURIComponent(bindingId)}/keys/${encodeURIComponent(keyId)}`,
      { method: 'DELETE' },
    )
  },

  // --- Внешние события (ADR-089): runtime-настройки раздела «События» ---
  /** GET /events/settings — эффективные настройки событий + дефолты + флаг override. */
  async getEventsSettings(): Promise<EventsSettingsResponse> {
    return fetchJSON<EventsSettingsResponse>(`${BASE_URL}/settings/events`)
  },

  /** PUT /settings/events — сохранить runtime-настройки событий (live-применение). */
  async updateEventsSettings(events: EventsSettings): Promise<{ events: EventsSettings }> {
    return fetchJSON<{ events: EventsSettings }>(`${BASE_URL}/settings/events`, {
      method: 'PUT',
      body: JSON.stringify({ events }),
    })
  },

  /** DELETE /settings/events — сброс runtime-настроек к config.yaml-дефолту. */
  async resetEventsSettings(): Promise<EventsSettingsResponse> {
    return fetchJSON<EventsSettingsResponse>(`${BASE_URL}/settings/events`, { method: 'DELETE' })
  },

  /** Последние записи журнала обработки внешних событий (default 50, cap 500 на сервере). */
  async getEventJournal(limit?: number): Promise<{ entries: EventJournalEntry[] }> {
    const qs = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : ''
    return fetchJSON<{ entries: EventJournalEntry[] }>(`${BASE_URL}/events/journal${qs}`)
  },

  // --- Внешние события (ADR-089): правила маршрутизации ---
  /** GET /events/routes — список правил маршрутизации событий (ADMIN). */
  async getEventRoutes(): Promise<{ rules: EventRouteRule[] }> {
    return fetchJSON<{ rules: EventRouteRule[] }>(`${BASE_URL}/events/routes`)
  },

  /** POST /events/routes — upsert правила; `id` передаётся при обновлении. */
  async createEventRoute(
    input: EventRouteRuleInputRequest & { id?: string },
  ): Promise<EventRouteRule> {
    return fetchJSON<EventRouteRule>(`${BASE_URL}/events/routes`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  async deleteEventRoute(id: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/events/routes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },
}
