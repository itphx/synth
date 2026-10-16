/**
 * PG-реализация append-журнала событий, одноразовых claim-кодов и дедупа
 * (PROP-032, волна 3b): `eventJournal`/`identityClaims`/`dedup`.
 *
 * Семантика повторяет файловые реализации core (`EventJournalStore`,
 * `IdentityClaimStore`, `FileDedupStore`): журнал — append-only (`seq bigserial`),
 * `list(limit)` → последние N в порядке добавления; claim-код одноразовый
 * (атомарный `UPDATE … WHERE consumed_at IS NULL`); дедуп — атомарный claim
 * (`INSERT … ON CONFLICT DO NOTHING RETURNING`).
 */

import { randomInt } from 'node:crypto';
import type { EventJournalEntry, IdentityClaimRecord, StorageContext } from '@itphx/synth-core';
import type { PortDeps } from './deps.js';
import { compact, loadCore, toIso, toIsoRequired } from './events-core.js';

type SynthEvent = EventJournalEntry['event'];

/** Часть `StorageContext`, которой владеет под-группа журнала/claim/дедупа. */
export type EventJournalPorts = Pick<StorageContext, 'eventJournal' | 'identityClaims' | 'dedup'>;

/** Нормализация вводимого кода: верхний регистр, удаление дефисов/пробелов. */
function normalizeClaimCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Канонический вид кода с дефисом: `ABCDEF` → `ABC-DEF`. */
function formatClaimCode(raw: string): string {
  const mid = Math.floor(raw.length / 2);
  return `${raw.slice(0, mid)}-${raw.slice(mid)}`;
}

/** Генерация одного «сырого» кода (без дефиса) из алфавита/длины core. */
function generateClaimRaw(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

// ── eventJournal ─────────────────────────────────────────────────────────────

type JournalRow = {
  seq: string;
  id: string;
  ts: Date | string;
  source: string | null;
  type: string | null;
  decision: unknown;
  key_id: string | null;
  identity: unknown;
  dedup_key: string | null;
  error: string | null;
  principal_id: string | null;
  payload: unknown;
};

/**
 * Восстановление записи журнала из колонок (полная запись больше не хранится
 * внутри `payload`): `event` собирается из `id/ts/source/type/payload/identity/
 * dedup_key`, остальные поля — из одноимённых колонок.
 */
function toJournalEntry(row: JournalRow): EventJournalEntry {
  const ts = toIsoRequired(row.ts);
  const event: SynthEvent = {
    id: row.id,
    source: row.source ?? '',
    type: row.type ?? 'message',
    payload: row.payload ?? null,
    identity: (row.identity ?? {}) as SynthEvent['identity'],
    dedupKey: row.dedup_key ?? row.id,
    ts,
  };
  return compact({
    ts,
    event,
    decision: row.decision ?? undefined,
    error: row.error ?? undefined,
    keyId: row.key_id ?? undefined,
    principalId: row.principal_id ?? undefined,
  }) as EventJournalEntry;
}

/**
 * ADR-089: журнал обработанных внешних событий и решений Router. Append-only
 * (`event_journal.seq`), `list(limit)` — последние N в порядке добавления.
 */
export class PgEventJournalRepository {
  constructor(private readonly _deps: PortDeps) {}

  async record(entry: EventJournalEntry): Promise<void> {
    await this._deps.connection.query(
      `INSERT INTO event_journal
         (id, ts, source, type, decision, key_id, identity, dedup_key, error, principal_id, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11::jsonb)`,
      [
        entry.event.id,
        entry.ts,
        entry.event.source,
        entry.event.type,
        entry.decision !== undefined ? JSON.stringify(entry.decision) : null,
        entry.keyId ?? null,
        JSON.stringify(entry.event.identity ?? {}),
        entry.event.dedupKey ?? null,
        entry.error ?? null,
        entry.principalId ?? null,
        entry.event.payload === undefined ? null : JSON.stringify(entry.event.payload),
      ],
    );
  }

  /** Записи в порядке добавления (старые → новые); `limit` — последние N. */
  async list(limit?: number): Promise<EventJournalEntry[]> {
    const rows =
      limit !== undefined && Number.isFinite(limit) && limit > 0
        ? await this._deps.connection.query<JournalRow>(
            `SELECT * FROM (
               SELECT * FROM event_journal ORDER BY seq DESC LIMIT $1
             ) t ORDER BY seq ASC`,
            [Math.floor(limit)],
          )
        : await this._deps.connection.query<JournalRow>(
            'SELECT * FROM event_journal ORDER BY seq ASC',
          );
    return rows.map(toJournalEntry);
  }

  /** Retention: удаляет записи старше `retentionDays` (по `ts`); число удалённых. */
  async prune(retentionDays: number): Promise<number> {
    const days = Number.isFinite(retentionDays) ? retentionDays : 0;
    const rows = await this._deps.connection.query<{ seq: string }>(
      `DELETE FROM event_journal WHERE ts < now() - interval '1 day' * $1::double precision RETURNING seq`,
      [days],
    );
    return rows.length;
  }
}

// ── identityClaims ───────────────────────────────────────────────────────────

type ClaimRow = {
  code: string;
  provider: string;
  external_id: string;
  chat_key: string | null;
  principal_id: string;
  created_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
};

/** Запись claim-кода из колонок (`principalId`/`chatKey` персистятся напрямую). */
function toClaim(row: ClaimRow): IdentityClaimRecord {
  return compact({
    code: row.code,
    provider: row.provider,
    externalId: row.external_id,
    chatKey: row.chat_key ?? undefined,
    principalId: row.principal_id,
    createdAt: toIsoRequired(row.created_at),
    expiresAt: toIsoRequired(row.expires_at),
    consumedAt: toIso(row.consumed_at),
  });
}

/**
 * ADR-089 (claim-flow): хранилище одноразовых claim-кодов поверх
 * `identity_claims`. `consume` — атомарный `UPDATE … WHERE consumed_at IS NULL
 * AND expires_at > now()` (гонка не «съест» код дважды).
 */
export class PgIdentityClaimRepository {
  constructor(private readonly _deps: PortDeps) {}

  async create(input: {
    provider: string;
    externalId: string;
    chatKey?: string;
    principalId: string;
    ttlSec?: number;
  }): Promise<IdentityClaimRecord> {
    const { IDENTITY_CLAIM_ALPHABET, IDENTITY_CLAIM_LENGTH, IDENTITY_CLAIM_TTL_SEC } =
      await loadCore();
    const ttlSec = input.ttlSec ?? IDENTITY_CLAIM_TTL_SEC;
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlSec * 1000).toISOString();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = formatClaimCode(generateClaimRaw(IDENTITY_CLAIM_ALPHABET, IDENTITY_CLAIM_LENGTH));
      const rows = await this._deps.connection.query<ClaimRow>(
        `INSERT INTO identity_claims
           (code, provider, external_id, chat_key, principal_id, created_at, expires_at, consumed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
         ON CONFLICT (code) DO NOTHING
         RETURNING *`,
        [code, input.provider, input.externalId, input.chatKey ?? null, input.principalId, createdAt, expiresAt],
      );
      if (rows[0]) return toClaim(rows[0]);
    }
    throw new Error('не удалось сгенерировать уникальный claim-код');
  }

  async consume(
    code: string,
    opts: { userId: string; provider?: string; externalId?: string },
  ): Promise<IdentityClaimRecord | null> {
    void opts.userId; // аудит подтвердившего — по `linkedBy` при linkIdentity
    const normalized = normalizeClaimCode(code);
    if (!normalized) return null;

    const params: unknown[] = [normalized];
    let sql = `UPDATE identity_claims SET consumed_at = now()
       WHERE regexp_replace(upper(code), '[^0-9A-Z]', '', 'g') = $1
         AND consumed_at IS NULL
         AND expires_at > now()`;
    if (opts.provider) {
      params.push(opts.provider);
      sql += ` AND provider = $${params.length}`;
    }
    if (opts.externalId) {
      params.push(opts.externalId);
      sql += ` AND external_id = $${params.length}`;
    }
    sql += ' RETURNING *';

    const rows = await this._deps.connection.query<ClaimRow>(sql, params);
    return rows[0] ? toClaim(rows[0]) : null;
  }

  /** Удаление мёртвых записей (истёкшие/потреблённые); число удалённых. */
  async cleanup(now: number = Date.now()): Promise<number> {
    const { IDENTITY_CLAIM_TTL_SEC } = await loadCore();
    const expiredBefore = new Date(now).toISOString();
    const consumedBefore = new Date(now - IDENTITY_CLAIM_TTL_SEC * 1000).toISOString();
    const rows = await this._deps.connection.query<{ code: string }>(
      `DELETE FROM identity_claims
       WHERE expires_at <= $1
          OR (consumed_at IS NOT NULL AND consumed_at < $2)
       RETURNING code`,
      [expiredBefore, consumedBefore],
    );
    return rows.length;
  }

  /** Все записи; `activeOnly` — только живые (не потреблённые и не истёкшие). */
  async list(activeOnly = false): Promise<IdentityClaimRecord[]> {
    const rows = activeOnly
      ? await this._deps.connection.query<ClaimRow>(
          `SELECT * FROM identity_claims
           WHERE consumed_at IS NULL AND expires_at > now()
           ORDER BY created_at, code`,
        )
      : await this._deps.connection.query<ClaimRow>(
          'SELECT * FROM identity_claims ORDER BY created_at, code',
        );
    return rows.map(toClaim);
  }
}

// ── dedup ────────────────────────────────────────────────────────────────────

/**
 * ADR-051/ADR-089: дедуп поверх `dedup(key text primary key)`.
 *
 * `tryClaim` — атомарный `INSERT … ON CONFLICT (key) DO NOTHING RETURNING key`:
 * строка вернулась → ключ наш (`true`), иначе он уже занят (`false`). `seed` —
 * no-op: durable-бэкенд хранит ключи сам (сигнатура порта синхронная, менять
 * нельзя). Retention-очистку см. в отчёте (остаток).
 */
export class PgDedupRepository {
  constructor(private readonly _deps: PortDeps) {}

  seed(_keys: Iterable<string>): void {
    // durable-бэкенд: предзаполнение кэша не требуется
  }

  async tryClaim(key: string): Promise<boolean> {
    const rows = await this._deps.connection.query<{ key: string }>(
      'INSERT INTO dedup (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key',
      [key],
    );
    return rows.length > 0;
  }
}

/** Собрать под-группу портов журнала/claim/дедупа. */
export function buildEventJournalPorts(deps: PortDeps): EventJournalPorts {
  return {
    eventJournal: new PgEventJournalRepository(deps),
    identityClaims: new PgIdentityClaimRepository(deps),
    dedup: new PgDedupRepository(deps),
  };
}
