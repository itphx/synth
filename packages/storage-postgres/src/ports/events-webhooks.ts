/**
 * PG-реализация портов исходящих webhooks (PROP-032, волна 3b):
 * `webhooks`/`webhookDeliveries`.
 *
 * Семантика повторяет файловые реализации core (`WebhookStore`,
 * `WebhookDeliveryStore`): `label` уникальна глобально (регистронезависимо) →
 * доменная `WebhookConflictError`; signing-секрет `whsec_…` хранится
 * **зашифрованным** at-rest (`secret_enc bytea`, AES-256-GCM мастер-ключом,
 * ADR-052/ADR-076) и отдаётся plaintext только при `create`/`regenerateSecret`
 * (и расшифрованным — через `getSecret` для доставки); журнал доставок —
 * append-only, `list(limit)` → последние N.
 */

import { randomBytes } from 'node:crypto';
import {
  type CreateWebhookSubscriptionInput,
  type UpdateWebhookSubscriptionPatch,
  type WebhookDelivery,
  type WebhookSubscription,
  type WebhookSubscriptionCreated,
  WEBHOOK_SECRET_PREFIX,
  generateId,
} from '@itphx/synth-shared';
import type { StorageContext } from '@itphx/synth-core';
import type { PortDeps } from './deps.js';
import { jsonbParam } from '../json-param.js';
import {
  compact,
  isUniqueViolation,
  loadCore,
  SECRET_PREFIX_VISIBLE,
  toInt,
  toIso,
  toIsoRequired,
} from './events-core.js';

/** Часть `StorageContext`, которой владеет под-группа webhooks. */
export type EventWebhookPorts = Pick<StorageContext, 'webhooks' | 'webhookDeliveries'>;

// ── webhooks ─────────────────────────────────────────────────────────────────

type WebhookRow = {
  id: string;
  label: string;
  description: string | null;
  url: string;
  events: unknown;
  enabled: boolean;
  secret_enc: Buffer | Uint8Array;
  secret_prefix: string;
  created_by: string;
  created_at: Date | string;
  last_delivery_at: Date | string | null;
  last_status: string | null;
  disabled_at: Date | string | null;
};

function toPublicWebhook(row: WebhookRow): WebhookSubscription {
  return compact({
    id: row.id,
    label: row.label,
    description: row.description ?? undefined,
    url: row.url,
    events: (row.events ?? []) as string[],
    enabled: row.enabled,
    secretPrefix: row.secret_prefix,
    createdBy: row.created_by,
    createdAt: toIsoRequired(row.created_at),
    lastDeliveryAt: toIso(row.last_delivery_at),
    lastStatus: (row.last_status ?? undefined) as WebhookSubscription['lastStatus'],
    disabledAt: toIso(row.disabled_at),
  });
}

/**
 * ADR-052 (этап II): реестр подписок на исходящие события поверх `webhooks`.
 *
 * Signing-секрет шифруется мастер-ключом (core `encryptSecret`; ключ резолвится
 * лениво — `resolveMasterKey`), поэтому HMAC-подпись доставки возможна, но
 * plaintext at-rest не хранится. Конфликт метки (`lower(label)`) → доменная
 * `WebhookConflictError` (роуты маппят в 409).
 */
export class PgWebhookRepository {
  private _masterKeyPromise?: Promise<Buffer>;

  constructor(private readonly _deps: PortDeps) {}

  async list(): Promise<WebhookSubscription[]> {
    const rows = await this._deps.connection.query<WebhookRow>(
      'SELECT * FROM webhooks ORDER BY created_at, id',
    );
    return rows.map(toPublicWebhook);
  }

  async get(id: string): Promise<WebhookSubscription | null> {
    const rows = await this._deps.connection.query<WebhookRow>(
      'SELECT * FROM webhooks WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? toPublicWebhook(rows[0]) : null;
  }

  async create(
    input: CreateWebhookSubscriptionInput,
    createdBy: string,
  ): Promise<WebhookSubscriptionCreated> {
    const label = (input.label ?? '').trim();
    if (!label) throw new Error('label обязателен');

    const { secret, enc } = await this._newSecret();
    let rows: WebhookRow[];
    try {
      rows = await this._deps.connection.query<WebhookRow>(
        `INSERT INTO webhooks
           (id, label, description, url, events, enabled, secret_enc, secret_prefix,
            created_by, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          `whk_${generateId()}`,
          label,
          input.description ?? null,
          input.url,
          jsonbParam(input.events ?? []),
          input.enabled ?? true,
          enc,
          `${secret.slice(0, SECRET_PREFIX_VISIBLE)}…`,
          createdBy,
          new Date().toISOString(),
        ],
      );
    } catch (err) {
      if (isUniqueViolation(err)) await this._throwConflict(label);
      throw err;
    }
    return { ...toPublicWebhook(rows[0]!), secret };
  }

  /** Патч: `undefined` — не трогать, `null` — сбросить (`description`). */
  async update(
    id: string,
    patch: UpdateWebhookSubscriptionPatch,
  ): Promise<WebhookSubscription | null> {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.label !== undefined) {
      const label = patch.label.trim();
      if (!label) throw new Error('label обязателен');
      params.push(label);
      sets.push(`label = $${params.length}`);
    }
    if (patch.description !== undefined) {
      params.push(patch.description);
      sets.push(`description = $${params.length}`);
    }
    if (patch.url !== undefined) {
      params.push(patch.url);
      sets.push(`url = $${params.length}`);
    }
    if (patch.events !== undefined) {
      params.push(jsonbParam(patch.events));
      sets.push(`events = $${params.length}::jsonb`);
    }
    if (patch.enabled !== undefined) {
      params.push(patch.enabled);
      const idx = params.length;
      sets.push(`enabled = $${idx}`);
      sets.push(`disabled_at = CASE WHEN $${idx} THEN NULL ELSE now() END`);
    }

    if (sets.length === 0) return this.get(id);

    params.push(id);
    try {
      const rows = await this._deps.connection.query<WebhookRow>(
        `UPDATE webhooks SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      return rows[0] ? toPublicWebhook(rows[0]) : null;
    } catch (err) {
      if (isUniqueViolation(err)) await this._throwConflict(patch.label ?? id);
      throw err;
    }
  }

  /** Мягкое включение/отключение (`disabledAt`). */
  async setEnabled(id: string, enabled: boolean): Promise<WebhookSubscription | null> {
    const rows = await this._deps.connection.query<WebhookRow>(
      `UPDATE webhooks
         SET enabled = $2,
             disabled_at = CASE WHEN $2 THEN NULL ELSE now() END
       WHERE id = $1
       RETURNING *`,
      [id, enabled],
    );
    return rows[0] ? toPublicWebhook(rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    // FK на `webhooks` нет — каскад чистим явно (паритет с файловой реализацией,
    // где `remove` снимает подписку из реестра).
    return this._deps.connection.withTransaction(async (tx) => {
      await tx.query('DELETE FROM webhook_deliveries WHERE subscription_id = $1', [id]);
      const rows = await tx.query<{ id: string }>(
        'DELETE FROM webhooks WHERE id = $1 RETURNING id',
        [id],
      );
      return rows.length > 0;
    });
  }

  /** Ротация signing-секрета: новый `whsec_…` (шифруется), plaintext — один раз. */
  async regenerateSecret(id: string): Promise<WebhookSubscriptionCreated | null> {
    const { secret, enc } = await this._newSecret();
    const rows = await this._deps.connection.query<WebhookRow>(
      `UPDATE webhooks SET secret_enc = $2, secret_prefix = $3 WHERE id = $1 RETURNING *`,
      [id, enc, `${secret.slice(0, SECRET_PREFIX_VISIBLE)}…`],
    );
    return rows[0] ? { ...toPublicWebhook(rows[0]), secret } : null;
  }

  /** Расшифрованный signing-секрет (только для доставки); неизвестный id — null. */
  async getSecret(id: string): Promise<string | null> {
    const rows = await this._deps.connection.query<{ secret_enc: Buffer | Uint8Array }>(
      'SELECT secret_enc FROM webhooks WHERE id = $1 LIMIT 1',
      [id],
    );
    const stored = rows[0]?.secret_enc;
    if (stored === undefined) return null;
    const key = await this._masterKey();
    const { decryptSecret } = await loadCore();
    return decryptSecret(Buffer.from(stored).toString('utf8'), key);
  }

  /** Best-effort отметка последней доставки (`lastDeliveryAt`/`lastStatus`). */
  async touchDelivery(id: string, status: 'ok' | 'failed'): Promise<void> {
    await this._deps.connection.query(
      'UPDATE webhooks SET last_delivery_at = now(), last_status = $2 WHERE id = $1',
      [id, status],
    );
  }

  /** Новый signing-секрет + его зашифрованное представление (bytea). */
  private async _newSecret(): Promise<{ secret: string; enc: Buffer }> {
    const key = await this._masterKey();
    const { encryptSecret } = await loadCore();
    const secret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(24).toString('base64url')}`;
    return { secret, enc: Buffer.from(encryptSecret(secret, key), 'utf8') };
  }

  private async _throwConflict(label: string): Promise<never> {
    const { WebhookConflictError } = await loadCore();
    throw new WebhookConflictError(label);
  }

  /** Мастер-ключ секретов at-rest (env > `secretKey` > файл `{dataDir}/secrets`). */
  private _masterKey(): Promise<Buffer> {
    if (!this._masterKeyPromise) {
      this._masterKeyPromise = (async () => {
        const { resolveMasterKey } = await loadCore();
        const result = await resolveMasterKey({
          dataDir: this._deps.dataDir,
          secretKey: this._deps.secretKey,
          env: this._deps.env,
        });
        return result.key;
      })().catch((err: unknown) => {
        this._masterKeyPromise = undefined;
        throw err;
      });
    }
    return this._masterKeyPromise;
  }
}

// ── webhookDeliveries ────────────────────────────────────────────────────────

type DeliveryRow = {
  seq: string;
  id: string;
  subscription_id: string;
  event_type: string;
  status: string;
  attempts: number;
  response_status: number | null;
  error: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
};

function toDelivery(row: DeliveryRow): WebhookDelivery {
  return compact({
    id: row.id,
    subscriptionId: row.subscription_id,
    eventType: row.event_type,
    status: row.status as WebhookDelivery['status'],
    attempts: toInt(row.attempts) ?? 0,
    responseStatus: toInt(row.response_status),
    error: row.error ?? undefined,
    createdAt: toIsoRequired(row.created_at),
    completedAt: toIso(row.completed_at),
  });
}

/** ADR-052 (этап II): append-only журнал доставок поверх `webhook_deliveries`. */
export class PgWebhookDeliveryRepository {
  constructor(private readonly _deps: PortDeps) {}

  async record(delivery: WebhookDelivery): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO webhook_deliveries
         (id, subscription_id, event_type, status, attempts, response_status, error,
          created_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        delivery.id,
        delivery.subscriptionId,
        delivery.eventType,
        delivery.status,
        delivery.attempts,
        delivery.responseStatus ?? null,
        delivery.error ?? null,
        delivery.createdAt,
        delivery.completedAt ?? null,
      ],
    );
  }

  /** Все записи журнала (старые → новые), опционально последние `limit`. */
  async list(limit?: number): Promise<WebhookDelivery[]> {
    const rows = this._isLimited(limit)
      ? await this._deps.connection.query<DeliveryRow>(
          `SELECT * FROM (
             SELECT * FROM webhook_deliveries ORDER BY seq DESC LIMIT $1
           ) t ORDER BY seq ASC`,
          [Math.floor(limit as number)],
        )
      : await this._deps.connection.query<DeliveryRow>(
          'SELECT * FROM webhook_deliveries ORDER BY seq ASC',
        );
    return rows.map(toDelivery);
  }

  /** Последние записи конкретной подписки (`limit` — последние N). */
  async listBySubscription(subscriptionId: string, limit?: number): Promise<WebhookDelivery[]> {
    const rows = this._isLimited(limit)
      ? await this._deps.connection.query<DeliveryRow>(
          `SELECT * FROM (
             SELECT * FROM webhook_deliveries WHERE subscription_id = $1 ORDER BY seq DESC LIMIT $2
           ) t ORDER BY seq ASC`,
          [subscriptionId, Math.floor(limit as number)],
        )
      : await this._deps.connection.query<DeliveryRow>(
          'SELECT * FROM webhook_deliveries WHERE subscription_id = $1 ORDER BY seq ASC',
          [subscriptionId],
        );
    return rows.map(toDelivery);
  }

  /** Retention: удаляет старше `retentionDays` (по `createdAt`); `0`/≤0 — no-op. */
  async prune(retentionDays: number): Promise<number> {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const rows = await this._deps.connection.query<{ seq: string }>(
      `DELETE FROM webhook_deliveries
       WHERE created_at < now() - interval '1 day' * $1::double precision
       RETURNING seq`,
      [retentionDays],
    );
    return rows.length;
  }

  private _isLimited(limit?: number): boolean {
    return limit !== undefined && Number.isFinite(limit) && limit > 0;
  }
}

/** Собрать под-группу портов webhooks. */
export function buildEventWebhookPorts(deps: PortDeps): EventWebhookPorts {
  return {
    webhooks: new PgWebhookRepository(deps),
    webhookDeliveries: new PgWebhookDeliveryRepository(deps),
  };
}
