/**
 * PG-реализация портов привязок, правил маршрутизации и API-ключей привязок
 * (PROP-032, волна 3b): `eventBindings`/`eventRoutes`/`eventApiKeys`.
 *
 * Семантика повторяет файловые реализации core (`EventBindingStore`,
 * `RouteRuleStore`, `EventApiKeyStore`): upsert по `id`, приоритет `threadKey`
 * над `chatKey`, глобальная регистронезависимая уникальность `label`, резолв
 * секрета по sha256-хешу при отсутствии plaintext at-rest.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  type EventBinding,
  type EventBindingApiKey,
  type EventBindingApiKeyCreated,
  type EventRouteRule,
  generateId,
} from '@itphx/synth-shared';
import type {
  StorageContext,
  CreateEventApiKeyInput,
  UpdateEventApiKeyPatch,
  UpsertEventBindingInput,
  UpsertRouteRuleInput,
  EventApiKeyResolution,
  EventKeyCredential,
  EventApiKeyRecord,
} from '@itphx/synth-core';
import type { PortDeps } from './deps.js';
import { jsonbParam } from '../json-param.js';
import {
  compact,
  isUniqueViolation,
  loadCore,
  SECRET_PREFIX_VISIBLE,
  toIso,
  toIsoRequired,
} from './events-core.js';

/** Часть `StorageContext`, которой владеет под-группа привязок/ключей. */
export type EventBindingPorts = Pick<StorageContext, 'eventBindings' | 'eventRoutes' | 'eventApiKeys'>;

// ── eventBindings ────────────────────────────────────────────────────────────

type BindingRow = {
  id: string;
  source: string;
  chat_key: string | null;
  thread_key: string | null;
  session_id: string | null;
  mode: string;
  agent_template: string | null;
  project: string | null;
};

function toBinding(row: BindingRow): EventBinding {
  return compact({
    id: row.id,
    source: row.source,
    chatKey: row.chat_key ?? undefined,
    threadKey: row.thread_key ?? undefined,
    sessionId: row.session_id ?? undefined,
    mode: row.mode as EventBinding['mode'],
    agentTemplate: row.agent_template ?? undefined,
    project: row.project ?? undefined,
  });
}

/** ADR-089: реестр устойчивых привязок поверх `event_bindings`. */
export class PgEventBindingRepository {
  constructor(private readonly _deps: PortDeps) {}

  async list(): Promise<EventBinding[]> {
    const rows = await this._deps.connection.query<BindingRow>(
      'SELECT * FROM event_bindings ORDER BY id',
    );
    return rows.map(toBinding);
  }

  async get(id: string): Promise<EventBinding | null> {
    const rows = await this._deps.connection.query<BindingRow>(
      'SELECT * FROM event_bindings WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? toBinding(rows[0]) : null;
  }

  /** `threadKey` приоритетнее `chatKey`; матч по `source` + ключу. */
  async findByKey(input: {
    source: string;
    chatKey?: string;
    threadKey?: string;
  }): Promise<EventBinding | null> {
    if (input.threadKey) {
      const rows = await this._deps.connection.query<BindingRow>(
        'SELECT * FROM event_bindings WHERE source = $1 AND thread_key = $2 LIMIT 1',
        [input.source, input.threadKey],
      );
      if (rows[0]) return toBinding(rows[0]);
    }
    if (input.chatKey) {
      const rows = await this._deps.connection.query<BindingRow>(
        'SELECT * FROM event_bindings WHERE source = $1 AND chat_key = $2 LIMIT 1',
        [input.source, input.chatKey],
      );
      if (rows[0]) return toBinding(rows[0]);
    }
    return null;
  }

  /** Создаёт или заменяет биндинг по `id` (id отсутствует → `bnd_<uuid>`). */
  async upsert(input: UpsertEventBindingInput): Promise<EventBinding> {
    const id = input.id ?? `bnd_${generateId()}`;
    const rows = await this._deps.connection.query<BindingRow>(
      `INSERT INTO event_bindings
         (id, source, chat_key, thread_key, session_id, mode, agent_template, project)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         source = EXCLUDED.source,
         chat_key = EXCLUDED.chat_key,
         thread_key = EXCLUDED.thread_key,
         session_id = EXCLUDED.session_id,
         mode = EXCLUDED.mode,
         agent_template = EXCLUDED.agent_template,
         project = EXCLUDED.project
       RETURNING *`,
      [
        id,
        input.source,
        input.chatKey ?? null,
        input.threadKey ?? null,
        input.sessionId ?? null,
        input.mode,
        input.agentTemplate ?? null,
        input.project ?? null,
      ],
    );
    return toBinding(rows[0]!);
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this._deps.connection.query<{ id: string }>(
      'DELETE FROM event_bindings WHERE id = $1 RETURNING id',
      [id],
    );
    return rows.length > 0;
  }
}

// ── eventRoutes ──────────────────────────────────────────────────────────────

type RouteRow = {
  id: string;
  name: string | null;
  priority: number;
  enabled: boolean;
  match: unknown;
  target: unknown;
};

function toRoute(row: RouteRow): EventRouteRule {
  return compact({
    id: row.id,
    name: row.name ?? undefined,
    priority: row.priority,
    enabled: row.enabled,
    match: (row.match ?? {}) as EventRouteRule['match'],
    target: (row.target ?? { mode: 'ephemeral' }) as EventRouteRule['target'],
  });
}

/** ADR-089: реестр правил маршрутизации поверх `event_routes`. */
export class PgEventRouteRepository {
  constructor(private readonly _deps: PortDeps) {}

  async list(): Promise<EventRouteRule[]> {
    const rows = await this._deps.connection.query<RouteRow>(
      'SELECT * FROM event_routes ORDER BY priority DESC, id',
    );
    return rows.map(toRoute);
  }

  async listEnabled(): Promise<EventRouteRule[]> {
    const rows = await this._deps.connection.query<RouteRow>(
      'SELECT * FROM event_routes WHERE enabled = true ORDER BY priority DESC, id',
    );
    return rows.map(toRoute);
  }

  async get(id: string): Promise<EventRouteRule | null> {
    const rows = await this._deps.connection.query<RouteRow>(
      'SELECT * FROM event_routes WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? toRoute(rows[0]) : null;
  }

  /** Создаёт или заменяет правило по `id` (id отсутствует → `rule_<uuid>`). */
  async upsert(input: UpsertRouteRuleInput): Promise<EventRouteRule> {
    const id = input.id ?? `rule_${generateId()}`;
    const rows = await this._deps.connection.query<RouteRow>(
      `INSERT INTO event_routes (id, name, priority, enabled, match, target)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         priority = EXCLUDED.priority,
         enabled = EXCLUDED.enabled,
         match = EXCLUDED.match,
         target = EXCLUDED.target
       RETURNING *`,
      [
        id,
        input.name ?? null,
        input.priority,
        input.enabled,
        jsonbParam(input.match ?? {}),
        jsonbParam(input.target ?? {}),
      ],
    );
    return toRoute(rows[0]!);
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this._deps.connection.query<{ id: string }>(
      'DELETE FROM event_routes WHERE id = $1 RETURNING id',
      [id],
    );
    return rows.length > 0;
  }
}

// ── eventApiKeys ─────────────────────────────────────────────────────────────

type ApiKeyRow = {
  id: string;
  binding_id: string;
  label: string;
  description: string | null;
  secret_hash: string;
  prefix: string;
  rate_limit_per_minute: number | null;
  created_by: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
};

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function toPublicKey(row: ApiKeyRow): EventBindingApiKey {
  return compact({
    id: row.id,
    bindingId: row.binding_id,
    label: row.label,
    description: row.description ?? undefined,
    rateLimitPerMinute: row.rate_limit_per_minute ?? undefined,
    createdBy: row.created_by,
    createdAt: toIsoRequired(row.created_at),
    lastUsedAt: toIso(row.last_used_at),
    prefix: row.prefix,
    expiresAt: toIso(row.expires_at),
    revokedAt: toIso(row.revoked_at),
  });
}

/** Внутренняя запись для переноса между backend'ами: публичные поля + sha256-хеш. */
function toRecord(row: ApiKeyRow): EventApiKeyRecord {
  return { ...toPublicKey(row), hash: row.secret_hash };
}

/**
 * ADR-089/ADR-052: реестр API-ключей привязок поверх `event_api_keys`.
 *
 * Plaintext-секрет не сохраняется — только `secret_hash` (sha256 hex); секрет
 * отдаётся единственный раз в `create`. Метка уникальна глобально
 * (регистронезависимо, индекс `lower(label)`) — конфликт превращается в
 * доменную `EventApiKeyConflictError` (роуты маппят в 409).
 */
export class PgEventApiKeyRepository {
  constructor(private readonly _deps: PortDeps) {}

  async listByBinding(bindingId: string): Promise<EventBindingApiKey[]> {
    const rows = await this._deps.connection.query<ApiKeyRow>(
      'SELECT * FROM event_api_keys WHERE binding_id = $1 ORDER BY created_at, id',
      [bindingId],
    );
    return rows.map(toPublicKey);
  }

  async get(bindingId: string, keyId: string): Promise<EventBindingApiKey | null> {
    const rows = await this._deps.connection.query<ApiKeyRow>(
      'SELECT * FROM event_api_keys WHERE id = $1 AND binding_id = $2 LIMIT 1',
      [keyId, bindingId],
    );
    return rows[0] ? toPublicKey(rows[0]) : null;
  }

  /** Полные записи (включая `secret_hash`) — только для переноса между backend'ами. */
  async exportAll(): Promise<EventApiKeyRecord[]> {
    const rows = await this._deps.connection.query<ApiKeyRow>(
      'SELECT * FROM event_api_keys ORDER BY created_at, id',
    );
    return rows.map(toRecord);
  }

  /**
   * Импорт готовой записи как есть (PROP-032): `id`/`bindingId`/`prefix`/
   * `secret_hash` сохраняются. `ON CONFLICT DO NOTHING` — идемпотентно; при
   * конфликте возвращается существующая строка (по `id`, метке или хешу).
   */
  async importExisting(record: EventApiKeyRecord): Promise<EventBindingApiKey> {
    const label = record.label?.trim() ?? '';
    if (!record.id) throw new Error('id обязателен');
    if (!record.bindingId) throw new Error('bindingId обязателен');
    if (!label) throw new Error('label обязателен');
    if (!record.hash) throw new Error('hash обязателен');

    const inserted = await this._deps.connection.query<ApiKeyRow>(
      `INSERT INTO event_api_keys
         (id, binding_id, label, description, secret_hash, prefix, rate_limit_per_minute,
          created_by, created_at, last_used_at, expires_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        record.id,
        record.bindingId,
        label,
        record.description ?? null,
        record.hash,
        record.prefix,
        record.rateLimitPerMinute ?? null,
        record.createdBy,
        record.createdAt,
        record.lastUsedAt ?? null,
        record.expiresAt ?? null,
        record.revokedAt ?? null,
      ],
    );
    if (inserted[0]) return toPublicKey(inserted[0]);

    const existing = await this._deps.connection.query<ApiKeyRow>(
      `SELECT * FROM event_api_keys
        WHERE id = $1 OR lower(label) = lower($2) OR secret_hash = $3
        ORDER BY CASE WHEN id = $1 THEN 0 WHEN lower(label) = lower($2) THEN 1 ELSE 2 END
        LIMIT 1`,
      [record.id, label, record.hash],
    );
    if (!existing[0]) throw new Error(`API-ключ ${record.id} не импортирован (конфликт без записи)`);
    return toPublicKey(existing[0]);
  }

  async create(input: CreateEventApiKeyInput): Promise<EventBindingApiKeyCreated> {
    const { EVENT_API_KEY_SECRET_PREFIX } = await loadCore();
    const label = input.label?.trim() ?? '';
    if (!label) throw new Error('label обязателен');

    const secret = `${EVENT_API_KEY_SECRET_PREFIX}${randomBytes(24).toString('base64url')}`;
    let rows: ApiKeyRow[];
    try {
      rows = await this._deps.connection.query<ApiKeyRow>(
        `INSERT INTO event_api_keys
           (id, binding_id, label, description, secret_hash, prefix, rate_limit_per_minute,
            created_by, created_at, last_used_at, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, NULL)
         RETURNING *`,
        [
          `eak_${generateId()}`,
          input.bindingId,
          label,
          input.description ?? null,
          hashSecret(secret),
          `${secret.slice(0, SECRET_PREFIX_VISIBLE)}…`,
          input.rateLimitPerMinute ?? null,
          input.createdBy,
          new Date().toISOString(),
          input.expiresAt ?? null,
        ],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        const { EventApiKeyConflictError } = await loadCore();
        throw new EventApiKeyConflictError(label);
      }
      throw err;
    }
    return { ...toPublicKey(rows[0]!), key: secret };
  }

  /** Патч: `undefined` — не трогать, `null` — сбросить поле. */
  async update(
    bindingId: string,
    keyId: string,
    patch: UpdateEventApiKeyPatch,
  ): Promise<EventBindingApiKey | null> {
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
    if (patch.expiresAt !== undefined) {
      params.push(patch.expiresAt);
      sets.push(`expires_at = $${params.length}`);
    }
    if (patch.rateLimitPerMinute !== undefined) {
      params.push(patch.rateLimitPerMinute);
      sets.push(`rate_limit_per_minute = $${params.length}`);
    }

    if (sets.length === 0) {
      return this.get(bindingId, keyId);
    }

    params.push(keyId, bindingId);
    const where = `id = $${params.length - 1} AND binding_id = $${params.length}`;
    try {
      const rows = await this._deps.connection.query<ApiKeyRow>(
        `UPDATE event_api_keys SET ${sets.join(', ')} WHERE ${where} RETURNING *`,
        params,
      );
      return rows[0] ? toPublicKey(rows[0]) : null;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const { EventApiKeyConflictError } = await loadCore();
        throw new EventApiKeyConflictError(patch.label ?? keyId);
      }
      throw err;
    }
  }

  async remove(bindingId: string, keyId: string): Promise<boolean> {
    const rows = await this._deps.connection.query<{ id: string }>(
      'DELETE FROM event_api_keys WHERE id = $1 AND binding_id = $2 RETURNING id',
      [keyId, bindingId],
    );
    return rows.length > 0;
  }

  /** Каскадное удаление ключей привязки; возвращает число удалённых. */
  async removeByBinding(bindingId: string): Promise<number> {
    const rows = await this._deps.connection.query<{ id: string }>(
      'DELETE FROM event_api_keys WHERE binding_id = $1 RETURNING id',
      [bindingId],
    );
    return rows.length;
  }

  /** Мягкий отзыв: `revokedAt = now()` (идемпотентно); `false`, если ключа нет. */
  async revoke(bindingId: string, keyId: string): Promise<boolean> {
    const rows = await this._deps.connection.query<{ id: string }>(
      `UPDATE event_api_keys
         SET revoked_at = COALESCE(revoked_at, now())
       WHERE id = $1 AND binding_id = $2
       RETURNING id`,
      [keyId, bindingId],
    );
    return rows.length > 0;
  }

  /** Резолв секрета по sha256-хешу; revoked/expired/unknown → `null`. */
  async resolveBySecret(rawSecret: string): Promise<EventApiKeyResolution | null> {
    if (!rawSecret) return null;
    const rows = await this._deps.connection.query<ApiKeyRow>(
      'SELECT * FROM event_api_keys WHERE secret_hash = $1 LIMIT 1',
      [hashSecret(rawSecret)],
    );
    const record = rows[0];
    if (!record) return null;
    if (record.revoked_at) return null;
    const expiresAt = toIso(record.expires_at);
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) return null;

    const key = toPublicKey(record);
    const credential: EventKeyCredential = compact({
      keyId: key.id,
      bindingId: key.bindingId,
      ownerId: key.createdBy || undefined,
      rateLimitPerMinute: key.rateLimitPerMinute,
    });
    return { key, credential };
  }

  /** Best-effort отметка использования (`lastUsedAt`). */
  async touch(id: string): Promise<void> {
    await this._deps.connection.query(
      'UPDATE event_api_keys SET last_used_at = now() WHERE id = $1',
      [id],
    );
  }
}

/** Собрать под-группу портов привязок/правил/ключей. */
export function buildEventBindingPorts(deps: PortDeps): EventBindingPorts {
  return {
    eventBindings: new PgEventBindingRepository(deps),
    eventRoutes: new PgEventRouteRepository(deps),
    eventApiKeys: new PgEventApiKeyRepository(deps),
  };
}
