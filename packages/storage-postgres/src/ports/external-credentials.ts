/**
 * Порт внешних доступов PostgreSQL-драйвера (PROP-107 Ф1, ADR-097).
 *
 * Отдельная таблица `external_credentials` (миграция `011`): у доступа своя
 * семантика — владелец, статус, срок, отзыв — и колонки с **зашифрованными**
 * токенами (`secret_enc`/`refresh_enc`).
 *
 * **Шифрование — только core-хелперами.** Драйвер не дублирует криптографию:
 * `encryptSecret`/`decryptSecret` и `resolveMasterKey` грузятся ленивым
 * `import('@itphx/synth-core')` (как у SSH-ключей в `content.ts`). В БД лежит
 * готовый токен `enc:v1:…`; plaintext появляется только в памяти на момент
 * подстановки в транспорт (`reveal`).
 *
 * Семантика повторяет файловую реализацию core (`ExternalCredentialStore`):
 * уникальность id, идемпотентный отзыв, необратимость отзыва, статус `error`
 * после отказа refresh, наружу — только метаданные с маской.
 */
import type {
  CreateExternalCredentialInput,
  ExternalCredential,
  ExternalCredentialFilter,
  ExternalCredentialMeta,
  ExternalCredentialOwnerKind,
  ExternalCredentialStatus,
  UpdateExternalCredentialTokensInput,
} from '@itphx/synth-shared';
import { generateId, toExternalCredentialMeta } from '@itphx/synth-shared';
import type { ExternalCredentialRepository, StorageContext } from '@itphx/synth-core';
import type { PostgresExecutor } from '../pool.js';
import { jsonbParam } from '../json-param.js';
import type { PortDeps } from './deps.js';

type Row = Record<string, unknown>;

/** Ленивая загрузка core (крипто-хелперы, доменные ошибки). */
type CoreModule = typeof import('@itphx/synth-core');

let coreAsyncCache: Promise<CoreModule> | null = null;

function loadCore(): Promise<CoreModule> {
  if (!coreAsyncCache) {
    coreAsyncCache = import('@itphx/synth-core').catch((err: unknown) => {
      coreAsyncCache = null;
      throw err;
    });
  }
  return coreAsyncCache;
}

/** ISO-строка из `timestamptz` (pg отдаёт `Date`) либо строки. */
function toISO(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return String(value);
}

/** ISO-строка или `undefined` для nullable-поля. */
function toISOOrUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return toISO(value);
}

/** Массив строк из `jsonb` (невалидные элементы отбрасываются). */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** JSON-строка для `jsonb`-параметра (драйвер сериализует сам). */
function jsonParam(value: unknown): string {
  return jsonbParam(value) ?? 'null';
}

interface ExternalCredentialRow extends Row {
  id: string;
  provider: string;
  connector_id: string | null;
  client_id: string;
  scopes: unknown;
  owner_kind: string;
  owner_id: string;
  project_id: string | null;
  secret_enc: string;
  refresh_enc: string | null;
  status: string;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
  scopes_granted: unknown;
}

function rowToCredential(row: ExternalCredentialRow): ExternalCredential {
  const credential: ExternalCredential = {
    id: row.id,
    provider: row.provider,
    clientId: row.client_id,
    scopes: asStringArray(row.scopes),
    owner: {
      kind: row.owner_kind as ExternalCredentialOwnerKind,
      id: row.owner_id,
    },
    secretEnc: row.secret_enc,
    status: row.status as ExternalCredentialStatus,
    createdBy: row.created_by,
    createdAt: toISO(row.created_at),
  };
  if (row.connector_id !== null) credential.connectorId = row.connector_id;
  if (row.project_id !== null) credential.projectId = row.project_id;
  if (row.refresh_enc !== null) credential.refreshEnc = row.refresh_enc;
  const expiresAt = toISOOrUndefined(row.expires_at);
  if (expiresAt !== undefined) credential.expiresAt = expiresAt;
  const revokedAt = toISOOrUndefined(row.revoked_at);
  if (revokedAt !== undefined) credential.revokedAt = revokedAt;
  const lastUsedAt = toISOOrUndefined(row.last_used_at);
  if (lastUsedAt !== undefined) credential.lastUsedAt = lastUsedAt;
  // `NULL` — поле не задано (паритет с файловой реализацией: `scopesGranted`
  // отсутствует, пока провайдер не сообщил выданные scope'ы).
  if (row.scopes_granted !== null && row.scopes_granted !== undefined) {
    credential.scopesGranted = asStringArray(row.scopes_granted);
  }
  return credential;
}

/** Реализация порта `ExternalCredentialRepository` поверх SQL. */
class PostgresExternalCredentialRepository implements ExternalCredentialRepository {
  private _masterKeyPromise?: Promise<{ core: CoreModule; key: Buffer }>;

  constructor(private readonly _deps: PortDeps) {}

  private _db(): PostgresExecutor {
    return this._deps.connection;
  }

  /** Мастер-ключ core (ленивый импорт — криптография в драйвере не дублируется). */
  private async _masterKey(): Promise<{ core: CoreModule; key: Buffer }> {
    const core = await loadCore();
    if (!this._masterKeyPromise) {
      this._masterKeyPromise = core
        .resolveMasterKey({
          dataDir: this._deps.dataDir,
          secretKey: this._deps.secretKey,
          env: this._deps.env,
        })
        .then((result) => ({ core, key: result.key }))
        .catch((err: unknown) => {
          this._masterKeyPromise = undefined;
          throw mapCryptoError(err, core);
        });
    }
    return this._masterKeyPromise;
  }

  async list(filter?: ExternalCredentialFilter): Promise<ExternalCredentialMeta[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.owner) {
      params.push(filter.owner.kind, filter.owner.id);
      conditions.push(`owner_kind = $${params.length - 1} AND owner_id = $${params.length}`);
    }
    if (filter?.connectorId !== undefined) {
      params.push(filter.connectorId);
      conditions.push(`connector_id = $${params.length}`);
    }
    if (filter?.provider !== undefined) {
      params.push(filter.provider);
      conditions.push(`provider = $${params.length}`);
    }
    if (filter?.projectId !== undefined) {
      params.push(filter.projectId);
      conditions.push(`project_id = $${params.length}`);
    }
    if (filter?.status !== undefined) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this._db().query<ExternalCredentialRow>(
      `SELECT * FROM external_credentials ${where} ORDER BY created_at ASC, id ASC`,
      params,
    );
    return rows.map((row) => toExternalCredentialMeta(rowToCredential(row)));
  }

  async get(id: string): Promise<ExternalCredentialMeta | null> {
    const rows = await this._db().query<ExternalCredentialRow>(
      'SELECT * FROM external_credentials WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row ? toExternalCredentialMeta(rowToCredential(row)) : null;
  }

  async create(input: CreateExternalCredentialInput): Promise<ExternalCredentialMeta> {
    const core = await loadCore();
    if (!input.accessToken || input.accessToken.trim() === '') {
      throw new core.ExternalCredentialStoreError('invalid', 'access-токен обязателен');
    }
    if (!input.provider || input.provider.trim() === '') {
      throw new core.ExternalCredentialStoreError('invalid', 'provider обязателен');
    }
    if (!input.clientId || input.clientId.trim() === '') {
      throw new core.ExternalCredentialStoreError('invalid', 'clientId обязателен');
    }
    const { key } = await this._masterKey();
    const id = input.id?.trim() || `${core.EXTERNAL_CREDENTIAL_ID_PREFIX}${generateId()}`;

    const secretEnc = core.encryptSecret(input.accessToken, key);
    const refreshEnc =
      input.refreshToken !== undefined && input.refreshToken !== ''
        ? core.encryptSecret(input.refreshToken, key)
        : null;

    const rows = await this._db().query<ExternalCredentialRow>(
      `INSERT INTO external_credentials
         (id, provider, connector_id, client_id, scopes, owner_kind, owner_id, project_id,
          secret_enc, refresh_enc, status, expires_at, revoked_at, created_by, created_at,
          last_used_at, scopes_granted)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,'active',$11,NULL,$12,now(),NULL,$13::jsonb)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [
        id,
        input.provider.trim(),
        input.connectorId ?? null,
        input.clientId.trim(),
        jsonParam([...(input.scopes ?? [])]),
        input.owner.kind,
        input.owner.id,
        input.projectId ?? null,
        secretEnc,
        refreshEnc,
        input.expiresAt ?? null,
        input.createdBy,
        input.scopesGranted !== undefined ? jsonParam([...input.scopesGranted]) : null,
      ],
    );
    const row = rows[0];
    if (!row) {
      // `ON CONFLICT DO NOTHING` — id уже занят.
      throw new core.ExternalCredentialStoreError(
        'duplicate_id',
        `Доступ с id ${id} уже существует`,
      );
    }
    return toExternalCredentialMeta(rowToCredential(row));
  }

  async updateTokens(
    id: string,
    patch: UpdateExternalCredentialTokensInput,
  ): Promise<ExternalCredentialMeta | null> {
    const { core, key } = await this._masterKey();

    const sets: string[] = [];
    const params: unknown[] = [id];

    if (patch.accessToken !== undefined) {
      if (patch.accessToken.trim() === '') {
        throw new core.ExternalCredentialStoreError('invalid', 'access-токен не может быть пустым');
      }
      params.push(core.encryptSecret(patch.accessToken, key));
      sets.push(`secret_enc = $${params.length}`);
    }
    if (patch.refreshToken !== undefined && patch.refreshToken !== '') {
      params.push(core.encryptSecret(patch.refreshToken, key));
      sets.push(`refresh_enc = $${params.length}`);
    }
    if (patch.expiresAt !== undefined) {
      params.push(patch.expiresAt);
      sets.push(`expires_at = $${params.length}`);
    }
    if (patch.scopesGranted !== undefined) {
      params.push(jsonParam([...patch.scopesGranted]));
      sets.push(`scopes_granted = $${params.length}::jsonb`);
    }
    // Статус: отозванный доступ не «оживает»; иначе — по патчу или `active`
    // при смене токена.
    const status = patch.status ?? (patch.accessToken !== undefined ? 'active' : undefined);
    if (status !== undefined) {
      params.push(status);
      sets.push(`status = CASE WHEN status = 'revoked' THEN status ELSE $${params.length}::text END`);
    }
    if (sets.length === 0) return this.get(id);

    const rows = await this._db().query<ExternalCredentialRow>(
      `UPDATE external_credentials SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    const row = rows[0];
    return row ? toExternalCredentialMeta(rowToCredential(row)) : null;
  }

  async markError(id: string): Promise<ExternalCredentialMeta | null> {
    const rows = await this._db().query<ExternalCredentialRow>(
      `UPDATE external_credentials
          SET status = CASE WHEN status = 'revoked' THEN status ELSE 'error' END
        WHERE id = $1
        RETURNING *`,
      [id],
    );
    const row = rows[0];
    return row ? toExternalCredentialMeta(rowToCredential(row)) : null;
  }

  async revoke(id: string): Promise<ExternalCredentialMeta | null> {
    // Идемпотентно: `revoked_at` фиксируется один раз (COALESCE).
    const rows = await this._db().query<ExternalCredentialRow>(
      `UPDATE external_credentials
          SET status = 'revoked', revoked_at = COALESCE(revoked_at, now())
        WHERE id = $1
        RETURNING *`,
      [id],
    );
    const row = rows[0];
    return row ? toExternalCredentialMeta(rowToCredential(row)) : null;
  }

  async touch(id: string): Promise<void> {
    await this._db().query(
      'UPDATE external_credentials SET last_used_at = now() WHERE id = $1',
      [id],
    );
  }

  async reveal(id: string): Promise<{ accessToken: string; refreshToken?: string } | null> {
    const { core, key } = await this._masterKey();
    const rows = await this._db().query<ExternalCredentialRow>(
      'SELECT secret_enc, refresh_enc FROM external_credentials WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    try {
      const accessToken = core.isEncrypted(row.secret_enc)
        ? core.decryptSecret(row.secret_enc, key)
        : row.secret_enc;
      if (row.refresh_enc === null) return { accessToken };
      const refreshToken = core.isEncrypted(row.refresh_enc)
        ? core.decryptSecret(row.refresh_enc, key)
        : row.refresh_enc;
      return { accessToken, refreshToken };
    } catch (err) {
      throw mapCryptoError(err, core);
    }
  }

  async listRaw(): Promise<ExternalCredential[]> {
    const rows = await this._db().query<ExternalCredentialRow>(
      'SELECT * FROM external_credentials ORDER BY created_at ASC, id ASC',
    );
    return rows.map(rowToCredential);
  }
}

/** Ошибка криптослоя → типизированная ошибка хранилища (без утечки секрета). */
function mapCryptoError(err: unknown, core: CoreModule): unknown {
  if (err instanceof core.ExternalCredentialStoreError) return err;
  if (err instanceof core.CryptoError) {
    return new core.ExternalCredentialStoreError(
      err.code === 'encryption_unavailable' ? 'encryption_unavailable' : 'decrypt_failed',
      err.message,
    );
  }
  return new core.ExternalCredentialStoreError('decrypt_failed', 'Не удалось расшифровать секрет');
}

/** Часть `StorageContext`, которой владеет модуль внешних доступов. */
export type ExternalCredentialPorts = Pick<StorageContext, 'externalCredentials'>;

/** Собрать порт внешних доступов. */
export function buildExternalCredentialPorts(deps: PortDeps): ExternalCredentialPorts {
  return {
    externalCredentials: new PostgresExternalCredentialRepository(deps),
  };
}
