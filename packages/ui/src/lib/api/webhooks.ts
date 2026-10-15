// webhooks: домен API v2 (ADR-095) — объект `webhooksApi` и его DTO.

import type {
  CreateWebhookSubscriptionInput,
  UpdateWebhookSubscriptionPatch,
  WebhookDelivery,
  WebhookSubscription,
  WebhookSubscriptionCreated,
} from '@itphx/synth-shared'
import { BASE_URL, fetchJSON } from './base'

export const webhooksApi = {
  // --- Webhooks (ADR-052, этап II): исходящие подписки на события ---
  /** GET /webhooks — список подписок (без signing-секретов). */
  async getWebhookSubscriptions(): Promise<{ subscriptions: WebhookSubscription[] }> {
    return fetchJSON<{ subscriptions: WebhookSubscription[] }>(`${BASE_URL}/webhooks`)
  },

  /** GET /webhooks/:id — метаданные одной подписки. */
  async getWebhookSubscription(id: string): Promise<WebhookSubscription> {
    return fetchJSON<WebhookSubscription>(`${BASE_URL}/webhooks/${encodeURIComponent(id)}`)
  },

  /** POST /webhooks — создание подписки; signing-секрет (`secret`) возвращается один раз. */
  async createWebhookSubscription(
    input: CreateWebhookSubscriptionInput,
  ): Promise<WebhookSubscriptionCreated> {
    return fetchJSON<WebhookSubscriptionCreated>(`${BASE_URL}/webhooks`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /** PATCH /webhooks/:id — частичное обновление (`null` у `description` сбрасывает поле). */
  async updateWebhookSubscription(
    id: string,
    patch: UpdateWebhookSubscriptionPatch,
  ): Promise<WebhookSubscription> {
    return fetchJSON<WebhookSubscription>(`${BASE_URL}/webhooks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },

  /** DELETE /webhooks/:id — удаление подписки. */
  async deleteWebhookSubscription(id: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/webhooks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  /** POST /webhooks/:id/regenerate — ротация signing-секрета (новый отдаётся один раз). */
  async regenerateWebhookSecret(id: string): Promise<WebhookSubscriptionCreated> {
    return fetchJSON<WebhookSubscriptionCreated>(
      `${BASE_URL}/webhooks/${encodeURIComponent(id)}/regenerate`,
      { method: 'POST' },
    )
  },

  /** POST /webhooks/:id/test — тестовая доставка; возвращает запись журнала. */
  async testWebhookSubscription(id: string): Promise<WebhookDelivery> {
    return fetchJSON<WebhookDelivery>(`${BASE_URL}/webhooks/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    })
  },

  /** GET /webhooks/:id/deliveries?limit= — журнал доставок подписки. */
  async getWebhookDeliveries(id: string, limit = 50): Promise<{ deliveries: WebhookDelivery[] }> {
    return fetchJSON<{ deliveries: WebhookDelivery[] }>(
      `${BASE_URL}/webhooks/${encodeURIComponent(id)}/deliveries?limit=${encodeURIComponent(String(limit))}`,
    )
  },
}
