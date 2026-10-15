import type { WebhookDelivery } from '@itphx/synth-shared';

/**
 * Порт append-only журнала доставок webhooks
 * (ADR-052 этап II, реализация — `WebhookDeliveryStore`).
 */
export interface WebhookDeliveryRepository {
  record(delivery: WebhookDelivery): Promise<void>;
  /**
   * Записи в порядке добавления (старые → новые); `limit` — последние N.
   * @future-backend — `ORDER BY created_at DESC LIMIT`.
   */
  list(limit?: number): Promise<WebhookDelivery[]>;
  /** Последние записи конкретной подписки. @future-backend — фильтр в SQL. */
  listBySubscription(subscriptionId: string, limit?: number): Promise<WebhookDelivery[]>;
  /** Retention-очистка по `createdAt`; `0`/отрицательное — без ограничения. */
  prune(retentionDays: number): Promise<number>;
}
