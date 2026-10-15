import type {
  CreateWebhookSubscriptionInput,
  UpdateWebhookSubscriptionPatch,
  WebhookSubscription,
  WebhookSubscriptionCreated,
} from '@itphx/synth-shared';

/**
 * Порт реестра подписок на исходящие webhooks (ADR-052 этап II, реализация — `WebhookStore`).
 *
 * Signing-секрет хранится в реализации зашифрованным at-rest (AES-256-GCM);
 * наружу plaintext отдаётся только в `create`/`regenerateSecret`, а для доставки —
 * через `getSecret`. Метка `label` уникальна глобально (регистронезависимо).
 */
export interface WebhookRepository {
  list(): Promise<WebhookSubscription[]>;
  get(id: string): Promise<WebhookSubscription | null>;
  create(input: CreateWebhookSubscriptionInput, createdBy: string): Promise<WebhookSubscriptionCreated>;
  update(id: string, patch: UpdateWebhookSubscriptionPatch): Promise<WebhookSubscription | null>;
  /** Мягкое включение/отключение (`disabledAt`). */
  setEnabled(id: string, enabled: boolean): Promise<WebhookSubscription | null>;
  remove(id: string): Promise<boolean>;
  regenerateSecret(id: string): Promise<WebhookSubscriptionCreated | null>;
  /** Расшифрованный signing-секрет (только для доставки). */
  getSecret(id: string): Promise<string | null>;
  touchDelivery(id: string, status: 'ok' | 'failed'): Promise<void>;
}
