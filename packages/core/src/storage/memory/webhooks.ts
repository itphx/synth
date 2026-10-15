/**
 * In-memory реализации портов исходящих webhooks (PROP-032, шаг W2.2).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`). Семантика повторяет файловую
 * (`WebhookStore`/`WebhookDeliveryStore`): уникальность `label`
 * (регистронезависимо) → `WebhookConflictError`, signing-секрет `whsec_…`
 * отдаётся единожды при `create`/`regenerateSecret`, append-журнал доставок в
 * порядке добавления с `slice(-N)` и retention-prune по `createdAt`.
 *
 * Расхождение с файловой реализацией: секрет в памяти хранится как есть (без
 * шифрования at-rest — шифровать нечего, состояние живёт в процессе),
 * `getSecret` возвращает его напрямую. Имя доменного конфликта
 * (`WebhookConflictError`) совпадает — импортируется из файлового стора.
 */

import { randomBytes } from 'node:crypto';
import type {
  CreateWebhookSubscriptionInput,
  UpdateWebhookSubscriptionPatch,
  WebhookDelivery,
  WebhookSubscription,
  WebhookSubscriptionCreated,
} from '@itphx/synth-shared';
import { WEBHOOK_SECRET_PREFIX, generateId, nowISO } from '@itphx/synth-shared';
import type { WebhookDeliveryRepository, WebhookRepository } from '../ports/index.js';
import { WebhookConflictError } from '../webhook-store.js';

const SECRET_PREFIX_VISIBLE = 12;

/** Внутренняя запись подписки: публичные поля + signing-секрет (в памяти — plaintext). */
interface MemoryWebhookRecord extends WebhookSubscription {
  secret: string;
}

/** Порт реестра подписок webhooks поверх `Map` (семантика `WebhookStore`). */
export class MemoryWebhookRepository implements WebhookRepository {
  private readonly _subscriptions = new Map<string, MemoryWebhookRecord>();

  private _toPublic(record: MemoryWebhookRecord): WebhookSubscription {
    const { secret, ...pub } = record;
    void secret;
    return structuredClone(pub);
  }

  private _assertLabelUnique(label: string, excludeId?: string): void {
    const target = label.trim().toLowerCase();
    for (const record of this._subscriptions.values()) {
      if (record.id !== excludeId && (record.label ?? '').trim().toLowerCase() === target) {
        throw new WebhookConflictError(label);
      }
    }
  }

  private _applyEnabled(record: MemoryWebhookRecord, enabled: boolean): void {
    record.enabled = enabled;
    if (enabled) delete record.disabledAt;
    else record.disabledAt = nowISO();
  }

  async list(): Promise<WebhookSubscription[]> {
    return [...this._subscriptions.values()].map((s) => this._toPublic(s));
  }

  async get(id: string): Promise<WebhookSubscription | null> {
    const record = this._subscriptions.get(id);
    return record ? this._toPublic(record) : null;
  }

  async create(input: CreateWebhookSubscriptionInput, createdBy: string): Promise<WebhookSubscriptionCreated> {
    const label = (input.label ?? '').trim();
    if (!label) throw new Error('label обязателен');
    const secret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(24).toString('base64url')}`;
    const record: MemoryWebhookRecord = {
      id: `whk_${generateId()}`,
      label,
      ...(input.description !== undefined ? { description: input.description } : {}),
      url: input.url,
      events: [...(input.events ?? [])],
      enabled: input.enabled ?? true,
      secretPrefix: `${secret.slice(0, SECRET_PREFIX_VISIBLE)}…`,
      createdBy,
      createdAt: nowISO(),
      secret,
    };
    this._assertLabelUnique(label);
    this._subscriptions.set(record.id, record);
    return { ...this._toPublic(record), secret };
  }

  async update(id: string, patch: UpdateWebhookSubscriptionPatch): Promise<WebhookSubscription | null> {
    const record = this._subscriptions.get(id);
    if (!record) return null;

    if (patch.label !== undefined) {
      const label = patch.label.trim();
      if (!label) throw new Error('label обязателен');
      this._assertLabelUnique(label, id);
      record.label = label;
    }
    if (patch.description !== undefined) {
      if (patch.description === null) delete record.description;
      else record.description = patch.description;
    }
    if (patch.url !== undefined) record.url = patch.url;
    if (patch.events !== undefined) record.events = [...patch.events];
    if (patch.enabled !== undefined) this._applyEnabled(record, patch.enabled);
    return this._toPublic(record);
  }

  async setEnabled(id: string, enabled: boolean): Promise<WebhookSubscription | null> {
    const record = this._subscriptions.get(id);
    if (!record) return null;
    this._applyEnabled(record, enabled);
    return this._toPublic(record);
  }

  async remove(id: string): Promise<boolean> {
    return this._subscriptions.delete(id);
  }

  async regenerateSecret(id: string): Promise<WebhookSubscriptionCreated | null> {
    const record = this._subscriptions.get(id);
    if (!record) return null;
    const secret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(24).toString('base64url')}`;
    record.secret = secret;
    record.secretPrefix = `${secret.slice(0, SECRET_PREFIX_VISIBLE)}…`;
    return { ...this._toPublic(record), secret };
  }

  async getSecret(id: string): Promise<string | null> {
    const record = this._subscriptions.get(id);
    return record ? record.secret : null;
  }

  async touchDelivery(id: string, status: 'ok' | 'failed'): Promise<void> {
    const record = this._subscriptions.get(id);
    if (!record) return;
    record.lastDeliveryAt = nowISO();
    record.lastStatus = status;
  }
}

/** Порт append-журнала доставок webhooks поверх массива (семантика `WebhookDeliveryStore`). */
export class MemoryWebhookDeliveryRepository implements WebhookDeliveryRepository {
  private _deliveries: WebhookDelivery[] = [];

  async record(delivery: WebhookDelivery): Promise<void> {
    this._deliveries.push(structuredClone(delivery));
  }

  async list(limit?: number): Promise<WebhookDelivery[]> {
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
      return this._deliveries.map((d) => structuredClone(d));
    }
    return this._deliveries.slice(-Math.floor(limit)).map((d) => structuredClone(d));
  }

  async listBySubscription(subscriptionId: string, limit?: number): Promise<WebhookDelivery[]> {
    const entries = this._deliveries.filter((d) => d.subscriptionId === subscriptionId);
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
      return entries.map((d) => structuredClone(d));
    }
    return entries.slice(-Math.floor(limit)).map((d) => structuredClone(d));
  }

  async prune(retentionDays: number): Promise<number> {
    if (this._deliveries.length === 0) return 0;
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const kept = this._deliveries.filter((d) => {
      const t = Date.parse(d.createdAt);
      return Number.isNaN(t) ? true : t >= cutoff;
    });
    const removed = this._deliveries.length - kept.length;
    if (removed === 0) return 0;
    this._deliveries = kept;
    return removed;
  }
}
