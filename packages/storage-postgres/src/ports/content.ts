/**
 * Группа портов **контента, секретов и обслуживания** PostgreSQL-драйвера
 * (ADR-097, волна 3b).
 *
 * Владелец файла — один агент волны реализации; правит только `content.ts`.
 * Файл экспортирует единственную фабрику `buildContentPorts(deps)`, возвращающую
 * свою часть `StorageContext`: `serviceKeys`, `sshKeys`, `mcpRegistry`,
 * `skillBundles`, `dictionaries`, `secretPatterns`, `protectedPaths`,
 * `maintenanceAudit`.
 *
 * ── Синхронные геттеры (кэш-фасад) ────────────────────────────────────────
 * `secretPatterns`/`protectedPaths`/`dictionaries` требуют **синхронных** вызовов
 * на горячем пути (сборка промпта, детекция секретов, маршрутизация). Поэтому:
 *   - «системный» слой (дефолтные паттерны, definitions/protected-paths.json,
 *     системные словари) читается **синхронно** из ассетов core либо из
 *     инстанс-конфигурации — он доступен сразу, без обращения к БД;
 *   - пользовательский override — в таблице `settings(key, value jsonb)`
 *     (схема `001-init` общих таблиц для словарей/паттернов/путей НЕ заводит);
 *     он прогревается в память асинхронно при сборке контекста (best-effort
 *     warm) и поддерживается **write-through** при мутациях.
 *
 * Известное ограничение: кэш синхронных геттеров процесс-локальный — правки
 * override другим процессом/инстансом он не увидит до рестарта; короткое окно
 * сразу после старта может отдать системный дефолт до завершения прогрева.
 *
 * ── Core на синхронном пути ───────────────────────────────────────────────
 * Синхронным геттерам нужны данные/хелперы core (`DEFAULT_PATTERNS`,
 * `definitions/protected-paths.json`, системные словари). Прямой доступ к core
 * невозможен: core — `peerDependencies`, а статический рантайм-импорт образовал бы
 * цикл. Поэтому core **инъектирует** значения в конфиг драйвера
 * (`PortDeps.coreSync`, сборка — `packages/core/src/storage/storage-context.ts`);
 * без инъекции (прямой вызов фабрики) они собираются ленивым
 * `import('@itphx/synth-core')` в `core-sync.ts`. Асинхронные методы (шифрование
 * at-rest в `sshKeys`) грузят core тем же ленивым `import()` внутри функций.
 */

import { join, normalize } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import {
  type CreateServiceApiKeyInput,
  type McpRegistryEntry,
  type McpServerConfig,
  type MaintenanceAuditEntry,
  type ServiceApiKey,
  type ServiceApiKeyCreated,
  type SSHKey,
  type SSHKeyMeta,
  type SkillBundle,
  type UpdateServiceApiKeyPatch,
  GlobalRole,
  MCP_REGISTRY_SCHEMA_VERSION,
  SKILL_NAME_MAX,
  SKILL_NAME_REGEX,
  generateId,
  nowISO,
} from '@itphx/synth-shared';
import type {
  DictionaryRepository,
  EnsureServiceKeyInput,
  MaintenanceAuditListOptions,
  MaintenanceAuditRepository,
  McpRegistryRepository,
  ProtectedPathsOverride,
  ProtectedPathsPolicy,
  ProtectedPathsRaw,
  ProtectedPathsRepository,
  RotateMasterKeyOptions,
  RotateMasterKeyResult,
  SecretPattern,
  SecretPatternRepository,
  ServiceKeyCredential,
  ServiceKeyEnsureStatus,
  ServiceKeyRepository,
  ServiceKeyResolution,
  ServiceApiKeyRecord,
  SkillBundleRepository,
  SSHKeyRepository,
  SSHKeyStoreError,
  StorageContext,
  StoredDictionary,
} from '@itphx/synth-core';
import type { PostgresExecutor } from '../pool.js';
import { jsonbParam } from '../json-param.js';
import { PostgresUniqueViolationError } from '../errors.js';
import { readSchemaVersion } from '../migrate.js';
import type { PortDeps } from './deps.js';

// ────────────────────────────────────────────────────────────────────────────
// Типы сущностей и мелкие утилиты
// ────────────────────────────────────────────────────────────────────────────

type SSHKeyCreateRequest = Parameters<SSHKeyRepository['create']>[0];
type SSHKeyUpdateRequest = Parameters<SSHKeyRepository['update']>[1];

type McpRegistryOrigin = McpRegistryEntry['origin'];
type McpRegistryTrust = McpRegistryEntry['trust'];
type McpRegistryAuthor = NonNullable<McpRegistryEntry['author']>;

/** Роль по умолчанию для service-key (least privilege). */
const DEFAULT_SERVICE_KEY_ROLES: GlobalRole[] = [GlobalRole.USER];

/** Часть `StorageContext`, которой владеет группа `content`. */
export type ContentPorts = Pick<
  StorageContext,
  | 'serviceKeys'
  | 'sshKeys'
  | 'mcpRegistry'
  | 'skillBundles'
  | 'dictionaries'
  | 'secretPatterns'
  | 'protectedPaths'
  | 'maintenanceAudit'
>;

// ────────────────────────────────────────────────────────────────────────────
// Ленивая загрузка core (асинхронные методы: крипто-хелперы, доменные ошибки)
// ────────────────────────────────────────────────────────────────────────────

type CoreModule = typeof import('@itphx/synth-core');

let coreAsyncCache: Promise<CoreModule> | null = null;

/** Ленивая загрузка core для асинхронных методов (без статического импорта). */
function loadCore(): Promise<CoreModule> {
  if (!coreAsyncCache) {
    coreAsyncCache = import('@itphx/synth-core').catch((err: unknown) => {
      coreAsyncCache = null;
      throw err;
    });
  }
  return coreAsyncCache;
}

// ────────────────────────────────────────────────────────────────────────────
// SQL-хелперы
// ────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** ISO-строка из значения timestamptz (pg отдаёт `Date`) либо строки. */
function toISO(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return String(value);
}

/** ISO-строка или `undefined` для nullable-поля. */
function toISOOrUndefined(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : toISO(value);
}

/** Массив строк из jsonb/`text[]` (невалидные элементы отбрасываются). */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asRoles(value: unknown): GlobalRole[] {
  return asStringArray(value) as GlobalRole[];
}

/** Параметр jsonb: сериализуем сами (pg сериализует массивы как Postgres-массивы). */
function jsonParam(value: unknown): string {
  return jsonbParam(value) ?? 'null';
}

/** Upsert ключа `settings(key, value jsonb)`. */
async function saveSetting(tx: PostgresExecutor, key: string, value: unknown): Promise<void> {
  await tx.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, jsonParam(value)],
  );
}

async function loadSetting(tx: PostgresExecutor, key: string): Promise<unknown> {
  const rows = await tx.query<Row>('SELECT value FROM settings WHERE key = $1', [key]);
  const row = rows[0];
  return row ? row.value : null;
}

async function deleteSetting(tx: PostgresExecutor, key: string): Promise<boolean> {
  const rows = await tx.query<Row>('DELETE FROM settings WHERE key = $1 RETURNING key', [key]);
  return rows.length > 0;
}

/** Best-effort лог драйвера (не роняет сборку контекста). */
function warnStorage(message: string): void {
  void loadCore()
    .then((core) => core.warning('STORAGE', `postgres: ${message}`))
    .catch(() => undefined);
}

/** Best-effort лог прогрева порта (не роняет сборку контекста). */
function warnWarm(port: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  warnStorage(`прогрев порта '${port}' не удался: ${message}`);
}

/** Синхронные порты-кэши группы `content`, которые нужно прогреть из БД. */
interface WarmableContentPorts {
  secretPatterns: PostgresSecretPatternRepository;
  protectedPaths: PostgresProtectedPathsRepository;
  dictionaries: PostgresDictionaryRepository;
}

/**
 * Best-effort прогрев синхронных кэшей (`secretPatterns`/`protectedPaths`/
 * `dictionaries`) из `settings`.
 *
 * Перед прогревом **один раз** проверяется версия схемы: если таблицы миграций
 * ещё нет (схема не инициализирована — напр. диагностика `doctor` с
 * `postgresSchemaMode:'skip'` до `synth migrate`), прогрев пропускается с
 * **одним** понятным предупреждением, а не пачкой ошибок `relation "settings"
 * does not exist` по каждому порту. Прогрев никогда не роняет сборку контекста.
 */
async function warmContentCaches(deps: PortDeps, ports: WarmableContentPorts): Promise<void> {
  let schemaVersion: number | null;
  try {
    schemaVersion = await readSchemaVersion(deps.connection, deps.connection.schema);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnStorage(`не удалось проверить схему хранилища: ${message}`);
    return;
  }

  if (schemaVersion === null) {
    warnStorage('хранилище не инициализировано — выполните `synth migrate`');
    return;
  }

  await Promise.all([
    ports.secretPatterns.warm().catch((err: unknown) => warnWarm('secretPatterns', err)),
    ports.protectedPaths.warm().catch((err: unknown) => warnWarm('protectedPaths', err)),
    ports.dictionaries.warm().catch((err: unknown) => warnWarm('dictionaries', err)),
  ]);
}

// ────────────────────────────────────────────────────────────────────────────
// serviceKeys (ADR-052)
// ────────────────────────────────────────────────────────────────────────────

/** Длина видимой части секрета в `prefix` (`synth_svc_abcd…`) — деталь отображения. */
const SECRET_PREFIX_VISIBLE = 12;

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

interface ServiceKeyRow extends Row {
  id: string;
  label: string;
  description: string | null;
  roles: unknown;
  scopes: unknown;
  allowed_projects: unknown;
  rate_limit_per_minute: number | null;
  secret_hash: string;
  prefix: string;
  created_by: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
}

function serviceKeyToPublic(row: ServiceKeyRow): ServiceApiKey {
  const key: ServiceApiKey = {
    id: row.id,
    label: row.label,
    roles: asRoles(row.roles),
    scopes: asStringArray(row.scopes),
    createdBy: row.created_by,
    createdAt: toISO(row.created_at),
    prefix: row.prefix,
  };
  if (row.description !== null) key.description = row.description;
  if (row.allowed_projects !== null) key.allowedProjects = asStringArray(row.allowed_projects);
  if (row.rate_limit_per_minute !== null) key.rateLimitPerMinute = row.rate_limit_per_minute;
  const expiresAt = toISOOrUndefined(row.expires_at);
  if (expiresAt !== undefined) key.expiresAt = expiresAt;
  const revokedAt = toISOOrUndefined(row.revoked_at);
  if (revokedAt !== undefined) key.revokedAt = revokedAt;
  const lastUsedAt = toISOOrUndefined(row.last_used_at);
  if (lastUsedAt !== undefined) key.lastUsedAt = lastUsedAt;
  return key;
}

/** Внутренняя запись для переноса между backend'ами: публичные поля + sha256-хеш. */
function serviceKeyToRecord(row: ServiceKeyRow): ServiceApiKeyRecord {
  return { ...serviceKeyToPublic(row), hash: row.secret_hash };
}

/** Порт реестра service-key инстанса поверх таблицы `service_keys`. */
class PostgresServiceKeyRepository implements ServiceKeyRepository {
  constructor(private readonly _deps: PortDeps) {}

  private _db(): PostgresExecutor {
    return this._deps.connection;
  }

  async list(): Promise<ServiceApiKey[]> {
    const rows = await this._db().query<ServiceKeyRow>(
      'SELECT * FROM service_keys ORDER BY created_at ASC',
    );
    return rows.map(serviceKeyToPublic);
  }

  async get(id: string): Promise<ServiceApiKey | null> {
    const rows = await this._db().query<ServiceKeyRow>('SELECT * FROM service_keys WHERE id = $1', [id]);
    const row = rows[0];
    return row ? serviceKeyToPublic(row) : null;
  }

  /** Полные записи (включая `secret_hash`) — только для переноса между backend'ами. */
  async exportAll(): Promise<ServiceApiKeyRecord[]> {
    const rows = await this._db().query<ServiceKeyRow>(
      'SELECT * FROM service_keys ORDER BY created_at ASC',
    );
    return rows.map(serviceKeyToRecord);
  }

  /**
   * Импорт готовой записи как есть (ADR-097): `id`/`prefix`/`secret_hash`
   * сохраняются. `ON CONFLICT DO NOTHING` — идемпотентно; при конфликте
   * возвращается существующая строка (по `id`, метке или хешу).
   */
  async importExisting(record: ServiceApiKeyRecord): Promise<ServiceApiKey> {
    const label = record.label?.trim() ?? '';
    if (!record.id) throw new Error('id обязателен');
    if (!label) throw new Error('label обязателен');
    if (!record.hash) throw new Error('hash обязателен');

    const inserted = await this._db().query<ServiceKeyRow>(
      `INSERT INTO service_keys
         (id, label, description, roles, scopes, allowed_projects, rate_limit_per_minute,
          secret_hash, prefix, created_by, created_at, last_used_at, expires_at, revoked_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        record.id,
        label,
        record.description ?? null,
        jsonParam(record.roles),
        jsonParam(record.scopes),
        record.allowedProjects !== undefined ? jsonParam(record.allowedProjects) : null,
        record.rateLimitPerMinute ?? null,
        record.hash,
        record.prefix,
        record.createdBy,
        record.createdAt,
        record.lastUsedAt ?? null,
        record.expiresAt ?? null,
        record.revokedAt ?? null,
      ],
    );
    if (inserted[0]) return serviceKeyToPublic(inserted[0]);

    const existing = await this._db().query<ServiceKeyRow>(
      `SELECT * FROM service_keys
        WHERE id = $1 OR lower(label) = lower($2) OR secret_hash = $3
        ORDER BY CASE WHEN id = $1 THEN 0 WHEN lower(label) = lower($2) THEN 1 ELSE 2 END
        LIMIT 1`,
      [record.id, label, record.hash],
    );
    if (!existing[0]) throw new Error(`service-key ${record.id} не импортирован (конфликт без записи)`);
    return serviceKeyToPublic(existing[0]);
  }

  private async _assertLabelUnique(label: string, excludeId?: string): Promise<void> {
    const rows = await this._db().query<Row>(
      'SELECT id FROM service_keys WHERE lower(label) = lower($1) AND ($2::text IS NULL OR id <> $2) LIMIT 1',
      [label, excludeId ?? null],
    );
    if (rows.length > 0) {
      const { ServiceApiKeyConflictError } = await loadCore();
      throw new ServiceApiKeyConflictError(label);
    }
  }

  async create(input: CreateServiceApiKeyInput, createdBy: string): Promise<ServiceApiKeyCreated> {
    const { SERVICE_KEY_SECRET_PREFIX } = await loadCore();
    const label = input.label?.trim() ?? '';
    if (!label) throw new Error('label обязателен');
    await this._assertLabelUnique(label);

    const secret = `${SERVICE_KEY_SECRET_PREFIX}${randomBytes(24).toString('base64url')}`;
    const record: ServiceApiKey = {
      id: `svk_${generateId()}`,
      label,
      roles: input.roles && input.roles.length > 0 ? [...input.roles] : [...DEFAULT_SERVICE_KEY_ROLES],
      scopes: [...input.scopes],
      createdBy,
      createdAt: nowISO(),
      prefix: `${secret.slice(0, SECRET_PREFIX_VISIBLE)}…`,
    };
    if (input.description !== undefined) record.description = input.description;
    if (input.allowedProjects !== undefined) record.allowedProjects = [...input.allowedProjects];
    if (input.rateLimitPerMinute !== undefined) record.rateLimitPerMinute = input.rateLimitPerMinute;
    if (input.expiresAt !== undefined) record.expiresAt = input.expiresAt;

    try {
      await this._db().query(
        `INSERT INTO service_keys
           (id, label, description, roles, scopes, allowed_projects, rate_limit_per_minute,
            secret_hash, prefix, created_by, created_at, expires_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12)`,
        [
          record.id,
          record.label,
          record.description ?? null,
          jsonParam(record.roles),
          jsonParam(record.scopes),
          record.allowedProjects !== undefined ? jsonParam(record.allowedProjects) : null,
          record.rateLimitPerMinute ?? null,
          hashSecret(secret),
          record.prefix,
          record.createdBy,
          record.createdAt,
          record.expiresAt ?? null,
        ],
      );
    } catch (err) {
      if (err instanceof PostgresUniqueViolationError) {
        const { ServiceApiKeyConflictError } = await loadCore();
        throw new ServiceApiKeyConflictError(label);
      }
      throw err;
    }

    return { ...record, key: secret };
  }

  async ensure(input: EnsureServiceKeyInput): Promise<{ status: ServiceKeyEnsureStatus; key: ServiceApiKey }> {
    const { BOOTSTRAP_CREATED_BY, SERVICE_KEY_SECRET_PREFIX } = await loadCore();
    const label = input.label?.trim() ?? '';
    if (!label) throw new Error('label обязателен');
    const rawSecret = input.secret?.trim() ?? '';
    if (!rawSecret) throw new Error('secret обязателен');
    const secret = rawSecret.startsWith(SERVICE_KEY_SECRET_PREFIX)
      ? rawSecret
      : `${SERVICE_KEY_SECRET_PREFIX}${rawSecret}`;
    const roles =
      input.roles && input.roles.length > 0 ? [...input.roles] : [...DEFAULT_SERVICE_KEY_ROLES];

    const existingRows = await this._db().query<ServiceKeyRow>(
      'SELECT * FROM service_keys WHERE lower(label) = lower($1) LIMIT 1',
      [label],
    );
    const existing = existingRows[0];

    if (!existing) {
      const record: ServiceApiKey = {
        id: `svk_${generateId()}`,
        label,
        roles,
        scopes: [...input.scopes],
        createdBy: input.createdBy ?? BOOTSTRAP_CREATED_BY,
        createdAt: nowISO(),
        prefix: `${secret.slice(0, SECRET_PREFIX_VISIBLE)}…`,
      };
      if (input.description !== undefined) record.description = input.description;
      try {
        await this._db().query(
          `INSERT INTO service_keys
             (id, label, description, roles, scopes, secret_hash, prefix, created_by, created_at)
           VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)`,
          [
            record.id,
            record.label,
            record.description ?? null,
            jsonParam(record.roles),
            jsonParam(record.scopes),
            hashSecret(secret),
            record.prefix,
            record.createdBy,
            record.createdAt,
          ],
        );
      } catch (err) {
        if (err instanceof PostgresUniqueViolationError) {
          const { ServiceApiKeyConflictError } = await loadCore();
          throw new ServiceApiKeyConflictError(label);
        }
        throw err;
      }
      return { status: 'created', key: record };
    }

    const current = serviceKeyToPublic(existing);
    const sameScopes =
      current.scopes.length === input.scopes.length &&
      current.scopes.every((s, i) => s === input.scopes[i]);
    const sameRoles = !input.roles || input.roles.length === 0
      ? true
      : current.roles.length === roles.length && current.roles.every((r, i) => r === roles[i]);

    if (sameScopes && sameRoles) return { status: 'unchanged', key: current };

    const nextScopes = sameScopes ? current.scopes : [...input.scopes];
    const nextRoles = sameRoles ? current.roles : roles;
    await this._db().query('UPDATE service_keys SET scopes = $2::jsonb, roles = $3::jsonb WHERE id = $1', [
      current.id,
      jsonParam(nextScopes),
      jsonParam(nextRoles),
    ]);
    return { status: 'updated', key: { ...current, scopes: nextScopes, roles: nextRoles } };
  }

  async update(id: string, patch: UpdateServiceApiKeyPatch): Promise<ServiceApiKey | null> {
    const rows = await this._db().query<ServiceKeyRow>('SELECT * FROM service_keys WHERE id = $1', [id]);
    const existing = rows[0];
    if (!existing) return null;
    const current = serviceKeyToPublic(existing);

    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (column: string, value: unknown, cast = ''): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };

    if (patch.label !== undefined) {
      const label = patch.label.trim();
      if (!label) throw new Error('label обязателен');
      await this._assertLabelUnique(label, id);
      push('label', label);
    }
    if (patch.description !== undefined) push('description', patch.description === null ? null : patch.description);
    if (patch.roles !== undefined) {
      push('roles', jsonParam(patch.roles.length > 0 ? [...patch.roles] : [...DEFAULT_SERVICE_KEY_ROLES]), '::jsonb');
    }
    if (patch.scopes !== undefined) push('scopes', jsonParam([...patch.scopes]), '::jsonb');
    if (patch.allowedProjects !== undefined) {
      push('allowed_projects', patch.allowedProjects === null ? null : jsonParam(patch.allowedProjects), '::jsonb');
    }
    if (patch.rateLimitPerMinute !== undefined) push('rate_limit_per_minute', patch.rateLimitPerMinute);
    if (patch.expiresAt !== undefined) push('expires_at', patch.expiresAt);

    if (sets.length === 0) return current;
    try {
      await this._db().query(`UPDATE service_keys SET ${sets.join(', ')} WHERE id = $1`, params);
    } catch (err) {
      if (err instanceof PostgresUniqueViolationError) {
        const { ServiceApiKeyConflictError } = await loadCore();
        throw new ServiceApiKeyConflictError(patch.label ?? '');
      }
      throw err;
    }
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this._db().query<Row>('DELETE FROM service_keys WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  }

  async revoke(id: string): Promise<boolean> {
    const rows = await this._db().query<Row>(
      'UPDATE service_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING id',
      [id],
    );
    return rows.length > 0;
  }

  async resolveBySecret(rawSecret: string): Promise<ServiceKeyResolution | null> {
    if (!rawSecret) return null;
    const rows = await this._db().query<ServiceKeyRow>(
      `SELECT * FROM service_keys
        WHERE secret_hash = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1`,
      [hashSecret(rawSecret)],
    );
    const row = rows[0];
    if (!row) return null;
    const key = serviceKeyToPublic(row);
    const credential: ServiceKeyCredential = {
      keyId: key.id,
      label: key.label,
      roles: [...key.roles],
      scopes: [...key.scopes],
    };
    if (key.allowedProjects) credential.allowedProjects = [...key.allowedProjects];
    if (key.rateLimitPerMinute !== undefined) credential.rateLimitPerMinute = key.rateLimitPerMinute;
    return { key, credential };
  }

  async touch(id: string): Promise<void> {
    await this._db().query('UPDATE service_keys SET last_used_at = now() WHERE id = $1', [id]);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// sshKeys (ADR-076)
// ────────────────────────────────────────────────────────────────────────────

interface SSHKeyRow extends Row {
  id: string;
  name: string;
  type: string | null;
  private_enc: Buffer | string;
  passphrase_enc: Buffer | string | null;
  created_at: Date | string;
  updated_at: Date | string | null;
  agent_ids?: unknown;
}

function bufferToToken(value: Buffer | string): string {
  return Buffer.isBuffer(value) ? value.toString('utf-8') : value;
}

function sshKeyToMeta(row: SSHKeyRow, agentIds: string[]): SSHKeyMeta {
  const meta: SSHKeyMeta = {
    id: row.id,
    name: row.name,
    type: row.type ?? 'user',
    agentIds: [...agentIds],
    createdAt: toISO(row.created_at),
  };
  const updatedAt = toISOOrUndefined(row.updated_at);
  if (updatedAt !== undefined) meta.updatedAt = updatedAt;
  return meta;
}

function mapCryptoError(err: unknown, core: CoreModule): SSHKeyStoreError {
  if (err instanceof core.SSHKeyStoreError) return err;
  if (err instanceof core.CryptoError) {
    return new core.SSHKeyStoreError(
      err.code === 'encryption_unavailable' ? 'encryption_unavailable' : 'decrypt_failed',
      err.message,
    );
  }
  return new core.SSHKeyStoreError('decrypt_failed', 'Не удалось расшифровать секрет');
}

/** Порт хранилища SSH-ключей поверх `ssh_keys`/`ssh_key_agents` (секреты AES-256-GCM). */
class PostgresSSHKeyRepository implements SSHKeyRepository {
  private _masterKeyPromise?: Promise<Buffer>;

  constructor(private readonly _deps: PortDeps) {}

  private _db(): PostgresExecutor {
    return this._deps.connection;
  }

  private async _masterKey(): Promise<{ core: CoreModule; key: Buffer }> {
    const core = await loadCore();
    if (!this._masterKeyPromise) {
      this._masterKeyPromise = core
        .resolveMasterKey({ dataDir: this._deps.dataDir, secretKey: this._deps.secretKey, env: this._deps.env })
        .then((result) => result.key)
        .catch((err: unknown) => {
          this._masterKeyPromise = undefined;
          throw mapCryptoError(err, core);
        });
    }
    return { core, key: await this._masterKeyPromise };
  }

  private async _agentIds(keyId: string): Promise<string[]> {
    const rows = await this._db().query<Row>(
      'SELECT agent_id FROM ssh_key_agents WHERE key_id = $1 ORDER BY agent_id',
      [keyId],
    );
    return rows.map((row) => String(row.agent_id));
  }

  private async _getRow(id: string): Promise<SSHKeyRow | null> {
    const rows = await this._db().query<SSHKeyRow>('SELECT * FROM ssh_keys WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async list(): Promise<SSHKeyMeta[]> {
    const rows = await this._db().query<SSHKeyRow>(
      `SELECT k.*, COALESCE(array_agg(a.agent_id ORDER BY a.agent_id)
                             FILTER (WHERE a.agent_id IS NOT NULL), '{}') AS agent_ids
         FROM ssh_keys k
         LEFT JOIN ssh_key_agents a ON a.key_id = k.id
        GROUP BY k.id
        ORDER BY k.name ASC`,
    );
    return rows.map((row) => sshKeyToMeta(row, asStringArray(row.agent_ids)));
  }

  async listRaw(): Promise<SSHKey[]> {
    const rows = await this._db().query<SSHKeyRow>(
      `SELECT k.*, COALESCE(array_agg(a.agent_id ORDER BY a.agent_id)
                             FILTER (WHERE a.agent_id IS NOT NULL), '{}') AS agent_ids
         FROM ssh_keys k
         LEFT JOIN ssh_key_agents a ON a.key_id = k.id
        GROUP BY k.id
        ORDER BY k.name ASC`,
    );
    return rows.map((row) => {
      const record: SSHKey = {
        id: row.id,
        name: row.name,
        type: row.type ?? 'user',
        privateKey: bufferToToken(row.private_enc),
        agentIds: asStringArray(row.agent_ids),
        createdAt: toISO(row.created_at),
      };
      const updatedAt = toISOOrUndefined(row.updated_at);
      if (updatedAt !== undefined) record.updatedAt = updatedAt;
      if (row.passphrase_enc !== null) record.passphrase = bufferToToken(row.passphrase_enc);
      return record;
    });
  }

  async listForAgent(agentId: string): Promise<SSHKeyMeta[]> {
    const rows = await this._db().query<SSHKeyRow>(
      `SELECT k.*, COALESCE(array_agg(a.agent_id ORDER BY a.agent_id)
                             FILTER (WHERE a.agent_id IS NOT NULL), '{}') AS agent_ids
         FROM ssh_keys k
         JOIN ssh_key_agents a ON a.key_id = k.id
        WHERE EXISTS (SELECT 1 FROM ssh_key_agents x WHERE x.key_id = k.id AND x.agent_id = $1)
        GROUP BY k.id
        ORDER BY k.name ASC`,
      [agentId],
    );
    return rows.map((row) => sshKeyToMeta(row, asStringArray(row.agent_ids)));
  }

  async get(id: string): Promise<SSHKeyMeta | null> {
    const row = await this._getRow(id);
    if (!row) return null;
    return sshKeyToMeta(row, await this._agentIds(id));
  }

  private async _assertNameUnique(name: string, excludeId?: string): Promise<void> {
    const rows = await this._db().query<Row>(
      'SELECT id FROM ssh_keys WHERE lower(name) = lower($1) AND ($2::text IS NULL OR id <> $2) LIMIT 1',
      [name, excludeId ?? null],
    );
    if (rows.length > 0) {
      const { SSHKeyStoreError } = await loadCore();
      throw new SSHKeyStoreError('name_exists', `SSH-ключ "${name}" уже существует`);
    }
  }

  async create(input: SSHKeyCreateRequest): Promise<SSHKeyMeta> {
    if (!input.privateKey || input.privateKey.trim() === '') {
      const { SSHKeyStoreError } = await loadCore();
      throw new SSHKeyStoreError('invalid', 'Приватный ключ не может быть пустым');
    }
    await this._assertNameUnique(input.name);
    const { core, key } = await this._masterKey();
    const now = nowISO();
    const id = generateId();
    const agentIds = input.agentIds ? [...input.agentIds] : [];
    const privateEnc = core.encryptSecret(input.privateKey, key);
    const passphraseEnc =
      input.passphrase === undefined ? null : core.encryptSecret(input.passphrase, key);

    await this._deps.connection.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO ssh_keys (id, name, type, private_enc, passphrase_enc, created_at, updated_at)
         VALUES ($1,$2,$3,$4::bytea,$5::bytea,$6,$7)`,
        [id, input.name, input.type ?? 'user', privateEnc, passphraseEnc, now, now],
      );
      for (const agentId of agentIds) {
        await tx.query(
          'INSERT INTO ssh_key_agents (key_id, agent_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, agentId],
        );
      }
    });

    return sshKeyToMeta(
      { id, name: input.name, type: input.type ?? 'user', private_enc: privateEnc, passphrase_enc: passphraseEnc, created_at: now, updated_at: now },
      agentIds,
    );
  }

  async update(id: string, patch: SSHKeyUpdateRequest): Promise<SSHKeyMeta | null> {
    const existing = await this._getRow(id);
    if (!existing) return null;
    const { core, key } = await this._masterKey();

    if (patch.name !== undefined && patch.name.toLowerCase() !== existing.name.toLowerCase()) {
      await this._assertNameUnique(patch.name, id);
    }
    if (patch.privateKey !== undefined && (!patch.privateKey || patch.privateKey.trim() === '')) {
      throw new core.SSHKeyStoreError('invalid', 'Приватный ключ не может быть пустым');
    }

    const nextName = patch.name ?? existing.name;
    const nextType = patch.type ?? existing.type ?? 'user';
    const nextPrivate = patch.privateKey !== undefined ? core.encryptSecret(patch.privateKey, key) : bufferToToken(existing.private_enc);
    const nextPassphrase =
      patch.passphrase !== undefined
        ? core.encryptSecret(patch.passphrase, key)
        : existing.passphrase_enc === null
          ? null
          : bufferToToken(existing.passphrase_enc);
    const updatedAt = nowISO();

    const agentIds =
      patch.agentIds !== undefined ? [...patch.agentIds] : await this._agentIds(id);

    await this._deps.connection.withTransaction(async (tx) => {
      await tx.query(
        `UPDATE ssh_keys
            SET name = $2, type = $3, private_enc = $4::bytea, passphrase_enc = $5::bytea, updated_at = $6
          WHERE id = $1`,
        [id, nextName, nextType, nextPrivate, nextPassphrase, updatedAt],
      );
      if (patch.agentIds !== undefined) {
        await tx.query('DELETE FROM ssh_key_agents WHERE key_id = $1', [id]);
        for (const agentId of agentIds) {
          await tx.query(
            'INSERT INTO ssh_key_agents (key_id, agent_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [id, agentId],
          );
        }
      }
    });

    return sshKeyToMeta(
      {
        id,
        name: nextName,
        type: nextType,
        private_enc: nextPrivate,
        passphrase_enc: nextPassphrase,
        created_at: existing.created_at,
        updated_at: updatedAt,
      },
      agentIds,
    );
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this._db().query<Row>('DELETE FROM ssh_keys WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  }

  async linkAgent(id: string, agentId: string): Promise<SSHKeyMeta | null> {
    if (!(await this._getRow(id))) return null;
    await this._db().query(
      'INSERT INTO ssh_key_agents (key_id, agent_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [id, agentId],
    );
    await this._db().query('UPDATE ssh_keys SET updated_at = $2 WHERE id = $1', [id, nowISO()]);
    return this.get(id);
  }

  async unlinkAgent(id: string, agentId: string): Promise<SSHKeyMeta | null> {
    if (!(await this._getRow(id))) return null;
    await this._db().query('DELETE FROM ssh_key_agents WHERE key_id = $1 AND agent_id = $2', [id, agentId]);
    await this._db().query('UPDATE ssh_keys SET updated_at = $2 WHERE id = $1', [id, nowISO()]);
    return this.get(id);
  }

  async reveal(id: string): Promise<{ privateKey: string; passphrase?: string } | null> {
    const row = await this._getRow(id);
    if (!row) return null;
    const { core, key } = await this._masterKey();
    try {
      const privateKey = core.decryptSecret(bufferToToken(row.private_enc), key);
      if (row.passphrase_enc === null) return { privateKey };
      return { privateKey, passphrase: core.decryptSecret(bufferToToken(row.passphrase_enc), key) };
    } catch (err) {
      throw mapCryptoError(err, core);
    }
  }

  async rotateMasterKey(
    oldKey: Buffer,
    newKey: Buffer,
    opts: RotateMasterKeyOptions = {},
  ): Promise<RotateMasterKeyResult> {
    const core = await loadCore();
    if (oldKey.length !== core.crypto.MASTER_KEY_LENGTH || newKey.length !== core.crypto.MASTER_KEY_LENGTH) {
      throw new core.SSHKeyStoreError('invalid', 'Мастер-ключ должен быть 32 байта');
    }

    const rows = await this._db().query<SSHKeyRow>('SELECT * FROM ssh_keys ORDER BY name ASC');
    const failures = new Set<string>();
    const planned: Array<{ row: SSHKeyRow; privateKey: string; passphrase: string | null; kind: 'rotated' | 'upgraded' | 'skipped' }> = [];

    for (const row of rows) {
      const privateKey = bufferToToken(row.private_enc);
      const passphrase = row.passphrase_enc === null ? null : bufferToToken(row.passphrase_enc);
      const plan = planRotation(core, privateKey, passphrase, oldKey, newKey);
      if (!plan) {
        failures.add(row.id);
        continue;
      }
      planned.push({ row, privateKey: plan.privateKey, passphrase: plan.passphrase, kind: plan.kind });
    }

    if (failures.size > 0) {
      throw new core.SSHKeyStoreError(
        'preflight_failed',
        `Не удалось расшифровать SSH-ключи (ни старым, ни новым ключом): ${[...failures].sort().join(', ')}`,
      );
    }

    let rotated = 0;
    let upgraded = 0;
    let skipped = 0;
    const ids: string[] = [];
    for (const item of planned) {
      if (item.kind === 'rotated') {
        rotated += 1;
        ids.push(item.row.id);
      } else if (item.kind === 'upgraded') {
        upgraded += 1;
        ids.push(item.row.id);
      } else {
        skipped += 1;
      }
      if (item.kind !== 'skipped' && !opts.dryRun) {
        await this._db().query(
          'UPDATE ssh_keys SET private_enc = $2::bytea, passphrase_enc = $3::bytea WHERE id = $1',
          [item.row.id, item.privateKey, item.passphrase],
        );
      }
    }
    return { total: rows.length, rotated, upgraded, skipped, ids };
  }
}

interface RotationPlan {
  privateKey: string;
  passphrase: string | null;
  kind: 'rotated' | 'upgraded' | 'skipped';
}

/** Планирует ротацию полей одной записи (plaintext → upgraded, старый шифр → rotated). */
function planRotation(
  core: CoreModule,
  privateKey: string,
  passphrase: string | null,
  oldKey: Buffer,
  newKey: Buffer,
): RotationPlan | null {
  let kind: 'rotated' | 'upgraded' | 'skipped' = 'skipped';

  const rotateToken = (token: string): string | null => {
    if (!core.isEncrypted(token)) {
      kind = 'upgraded';
      return core.encryptSecret(token, newKey);
    }
    try {
      core.decryptSecret(token, newKey);
      return token;
    } catch {
      // не расшифровывается новым — пробуем старым
    }
    try {
      const plaintext = core.decryptSecret(token, oldKey);
      kind = 'rotated';
      return core.encryptSecret(plaintext, newKey);
    } catch {
      return null;
    }
  };

  const nextPrivate = rotateToken(privateKey);
  if (nextPrivate === null) return null;
  let nextPassphrase: string | null = passphrase;
  if (passphrase !== null) {
    nextPassphrase = rotateToken(passphrase);
    if (nextPassphrase === null) return null;
  }
  return { privateKey: nextPrivate, passphrase: nextPassphrase, kind };
}

// ────────────────────────────────────────────────────────────────────────────
// mcpRegistry (ADR-071)
// ────────────────────────────────────────────────────────────────────────────

interface McpRegistryRow extends Row {
  id: string;
  schema_version: number;
  name: string;
  config: unknown;
  origin: string;
  author: unknown;
  trust: unknown;
  enabled: boolean;
  enabled_by_default: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

function mcpRowToEntry(row: McpRegistryRow): McpRegistryEntry {
  return {
    schemaVersion: row.schema_version ?? MCP_REGISTRY_SCHEMA_VERSION,
    id: row.id,
    name: row.name,
    config: row.config as McpServerConfig,
    origin: row.origin as McpRegistryOrigin,
    author: (row.author as McpRegistryAuthor | null) ?? null,
    trust: (row.trust as McpRegistryTrust) ?? 'community',
    enabled: row.enabled !== false,
    enabledByDefault: row.enabled_by_default === true,
    createdAt: toISO(row.created_at),
    updatedAt: toISO(row.updated_at),
  };
}

/** Порт реестра MCP-серверов поверх таблицы `mcp_registry`. */
class PostgresMcpRegistryRepository implements McpRegistryRepository {
  constructor(private readonly _deps: PortDeps) {}

  private _db(): PostgresExecutor {
    return this._deps.connection;
  }

  async list(): Promise<McpRegistryEntry[]> {
    const rows = await this._db().query<McpRegistryRow>('SELECT * FROM mcp_registry ORDER BY name ASC');
    return rows.map(mcpRowToEntry);
  }

  async get(id: string): Promise<McpRegistryEntry | null> {
    const rows = await this._db().query<McpRegistryRow>('SELECT * FROM mcp_registry WHERE id = $1', [id]);
    const row = rows[0];
    return row ? mcpRowToEntry(row) : null;
  }

  async getByName(name: string): Promise<McpRegistryEntry | null> {
    const rows = await this._db().query<McpRegistryRow>('SELECT * FROM mcp_registry WHERE name = $1', [name]);
    const row = rows[0];
    return row ? mcpRowToEntry(row) : null;
  }

  async add(input: {
    name: string;
    config: McpServerConfig;
    origin: McpRegistryOrigin;
    author?: McpRegistryAuthor | null;
    trust?: McpRegistryTrust;
    enabled?: boolean;
    enabledByDefault?: boolean;
    id?: string;
  }): Promise<McpRegistryEntry> {
    const duplicate = await this._db().query<Row>(
      'SELECT id FROM mcp_registry WHERE name = $1 LIMIT 1',
      [input.name],
    );
    if (duplicate.length > 0) {
      throw new Error(`MCP-сервер "${input.name}" уже существует в реестре`);
    }
    const now = nowISO();
    const entry: McpRegistryEntry = {
      schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
      id: input.id ?? generateId(),
      name: input.name,
      config: input.config,
      origin: input.origin,
      author: input.author ?? null,
      trust: input.trust ?? (input.origin === 'instance' ? 'builtin' : 'community'),
      enabled: input.enabled ?? true,
      enabledByDefault: input.enabledByDefault ?? input.config.enabledByDefault ?? false,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this._insert(entry);
    } catch (err) {
      if (err instanceof PostgresUniqueViolationError) {
        throw new Error(`MCP-сервер "${input.name}" уже существует в реестре`);
      }
      throw err;
    }
    return entry;
  }

  private async _insert(entry: McpRegistryEntry): Promise<void> {
    await this._db().query(
      `INSERT INTO mcp_registry
         (id, schema_version, name, config, origin, author, trust, enabled, enabled_by_default, created_at, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)`,
      [
        entry.id,
        entry.schemaVersion,
        entry.name,
        jsonParam(entry.config),
        entry.origin,
        entry.author === null ? null : jsonParam(entry.author),
        jsonParam(entry.trust),
        entry.enabled,
        entry.enabledByDefault,
        entry.createdAt,
        entry.updatedAt,
      ],
    );
  }

  async update(id: string, patch: {
    name?: string;
    config?: McpServerConfig;
    enabled?: boolean;
    enabledByDefault?: boolean;
    trust?: McpRegistryTrust;
    origin?: McpRegistryOrigin;
  }): Promise<McpRegistryEntry | null> {
    const rows = await this._db().query<McpRegistryRow>('SELECT * FROM mcp_registry WHERE id = $1', [id]);
    const current = rows[0];
    if (!current) return null;

    const entry = mcpRowToEntry(current);
    if (patch.name && patch.name !== entry.name) {
      const dup = await this._db().query<Row>(
        'SELECT id FROM mcp_registry WHERE name = $1 AND id <> $2 LIMIT 1',
        [patch.name, id],
      );
      if (dup.length > 0) throw new Error(`MCP-сервер "${patch.name}" уже существует в реестре`);
    }

    const updated: McpRegistryEntry = {
      ...entry,
      name: patch.name ?? entry.name,
      config: patch.config ?? entry.config,
      origin: patch.origin ?? entry.origin,
      trust: patch.trust ?? entry.trust,
      enabled: patch.enabled ?? entry.enabled,
      enabledByDefault: patch.enabledByDefault ?? entry.enabledByDefault,
      schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
      updatedAt: nowISO(),
    };
    try {
      await this._db().query(
        `UPDATE mcp_registry
            SET name = $2, config = $3::jsonb, origin = $4, trust = $5::jsonb,
                enabled = $6, enabled_by_default = $7, schema_version = $8, updated_at = $9
          WHERE id = $1`,
        [
          id,
          updated.name,
          jsonParam(updated.config),
          updated.origin,
          jsonParam(updated.trust),
          updated.enabled,
          updated.enabledByDefault,
          updated.schemaVersion,
          updated.updatedAt,
        ],
      );
    } catch (err) {
      if (err instanceof PostgresUniqueViolationError) {
        throw new Error(`MCP-сервер "${updated.name}" уже существует в реестре`);
      }
      throw err;
    }
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this._db().query<Row>('DELETE FROM mcp_registry WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  }

  async seedFromConfig(servers: Record<string, McpServerConfig>): Promise<number> {
    const existing = new Set(
      (await this._db().query<Row>('SELECT name FROM mcp_registry')).map((row) => String(row.name)),
    );
    let added = 0;
    for (const [name, config] of Object.entries(servers)) {
      if (existing.has(name)) continue;
      await this._insert({
        schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
        id: generateId(),
        name,
        config,
        origin: 'instance',
        author: null,
        trust: 'builtin',
        enabled: config.enabled !== false,
        enabledByDefault: config.enabledByDefault ?? false,
        createdAt: nowISO(),
        updatedAt: nowISO(),
      });
      added += 1;
    }
    return added;
  }

  async toServerConfigMap(): Promise<Record<string, McpServerConfig>> {
    const map: Record<string, McpServerConfig> = {};
    for (const entry of await this.list()) map[entry.name] = entry.config;
    return map;
  }

  async toOriginMap(): Promise<Record<string, McpRegistryOrigin>> {
    const map: Record<string, McpRegistryOrigin> = {};
    for (const entry of await this.list()) map[entry.name] = entry.origin;
    return map;
  }

  async toTrustMap(): Promise<Record<string, McpRegistryTrust>> {
    const map: Record<string, McpRegistryTrust> = {};
    for (const entry of await this.list()) map[entry.name] = entry.trust;
    return map;
  }

  async toAuthorMap(): Promise<Record<string, McpRegistryAuthor>> {
    const map: Record<string, McpRegistryAuthor> = {};
    for (const entry of await this.list()) if (entry.author) map[entry.name] = entry.author;
    return map;
  }

  async toDefaultServers(): Promise<string[]> {
    return (await this.list())
      .filter((entry) => entry.origin === 'instance' && entry.enabledByDefault)
      .map((entry) => entry.name);
  }

  async toManagerMaps(): Promise<{
    servers: Record<string, McpServerConfig>;
    origins: Record<string, McpRegistryOrigin>;
    trusts: Record<string, McpRegistryTrust>;
    authors: Record<string, McpRegistryAuthor>;
    systemEnabled: Record<string, boolean>;
    defaults: string[];
  }> {
    const servers: Record<string, McpServerConfig> = {};
    const origins: Record<string, McpRegistryOrigin> = {};
    const trusts: Record<string, McpRegistryTrust> = {};
    const authors: Record<string, McpRegistryAuthor> = {};
    const systemEnabled: Record<string, boolean> = {};
    const defaults: string[] = [];
    for (const entry of await this.list()) {
      servers[entry.name] = entry.config;
      origins[entry.name] = entry.origin;
      trusts[entry.name] = entry.trust;
      systemEnabled[entry.name] = entry.enabled !== false;
      if (entry.author) authors[entry.name] = entry.author;
      if (entry.origin === 'instance' && entry.enabledByDefault) defaults.push(entry.name);
    }
    return { servers, origins, trusts, authors, systemEnabled, defaults };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// skillBundles (ADR-046)
// ────────────────────────────────────────────────────────────────────────────

interface SkillBundleRow extends Row {
  name: string;
  description: string;
  skills: unknown;
  instruction: string | null;
}

function assertBundleName(name: string): void {
  if (!name || name.length > SKILL_NAME_MAX || !SKILL_NAME_REGEX.test(name)) {
    throw new Error(`Недопустимое имя bundle: ${name}`);
  }
}

function bundleRowToBundle(row: SkillBundleRow): SkillBundle {
  const bundle: SkillBundle = {
    name: row.name,
    description: row.description,
    skills: asStringArray(row.skills),
  };
  if (row.instruction !== null) bundle.instruction = row.instruction;
  return bundle;
}

/** Порт instance-хранилища bundles поверх таблицы `skill_bundles`. */
class PostgresSkillBundleRepository implements SkillBundleRepository {
  constructor(private readonly _deps: PortDeps) {}

  private _db(): PostgresExecutor {
    return this._deps.connection;
  }

  async exists(name: string): Promise<boolean> {
    const rows = await this._db().query<Row>('SELECT 1 AS ok FROM skill_bundles WHERE name = $1 LIMIT 1', [name]);
    return rows.length > 0;
  }

  async get(name: string): Promise<SkillBundle | undefined> {
    const rows = await this._db().query<SkillBundleRow>('SELECT * FROM skill_bundles WHERE name = $1', [name]);
    const row = rows[0];
    return row ? bundleRowToBundle(row) : undefined;
  }

  async list(): Promise<SkillBundle[]> {
    const rows = await this._db().query<SkillBundleRow>('SELECT * FROM skill_bundles ORDER BY name ASC');
    return rows.map(bundleRowToBundle);
  }

  async set(bundle: SkillBundle): Promise<void> {
    assertBundleName(bundle.name);
    await this._db().query(
      `INSERT INTO skill_bundles (name, description, skills, instruction)
       VALUES ($1,$2,$3::jsonb,$4)
       ON CONFLICT (name) DO UPDATE
         SET description = EXCLUDED.description,
             skills = EXCLUDED.skills,
             instruction = EXCLUDED.instruction`,
      [bundle.name, bundle.description, jsonParam(bundle.skills), bundle.instruction ?? null],
    );
  }

  async remove(name: string): Promise<boolean> {
    assertBundleName(name);
    const rows = await this._db().query<Row>('DELETE FROM skill_bundles WHERE name = $1 RETURNING name', [name]);
    return rows.length > 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// maintenanceAudit (ADR-092)
// ────────────────────────────────────────────────────────────────────────────

interface MaintenanceAuditRow extends Row {
  id: string;
  ts: Date | string;
  op: string;
  status: string;
  actor: string | null;
  version: string | null;
  details: unknown;
  error: string | null;
}

function maintenanceRowToEntry(row: MaintenanceAuditRow): MaintenanceAuditEntry {
  const entry: MaintenanceAuditEntry = {
    id: row.id,
    ts: toISO(row.ts),
    op: row.op as MaintenanceAuditEntry['op'],
    status: row.status as MaintenanceAuditEntry['status'],
  };
  if (row.actor !== null) entry.actor = row.actor;
  if (row.version !== null) entry.version = row.version;
  if (row.details !== null && row.details !== undefined) entry.details = row.details as Record<string, unknown>;
  if (row.error !== null) entry.error = row.error;
  return entry;
}

/** Порт append-only аудит-журнала обслуживания поверх таблицы `maintenance_audit`. */
class PostgresMaintenanceAuditRepository implements MaintenanceAuditRepository {
  constructor(private readonly _deps: PortDeps) {}

  private _db(): PostgresExecutor {
    return this._deps.connection;
  }

  async append(entry: MaintenanceAuditEntry): Promise<void> {
    await this._db().query(
      `INSERT INTO maintenance_audit (id, ts, op, status, actor, version, details, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [
        entry.id,
        entry.ts,
        entry.op,
        entry.status,
        entry.actor ?? null,
        entry.version ?? null,
        entry.details !== undefined ? jsonParam(entry.details) : null,
        entry.error ?? null,
      ],
    );
  }

  async list(opts: MaintenanceAuditListOptions = {}): Promise<MaintenanceAuditEntry[]> {
    const params: unknown[] = [];
    let where = '';
    if (opts.op !== undefined) {
      params.push(opts.op);
      where = `WHERE op = $${params.length}`;
    }
    let limit = '';
    const { limit: requested } = opts;
    if (requested !== undefined && Number.isFinite(requested) && requested > 0) {
      params.push(Math.floor(requested));
      limit = `LIMIT $${params.length}::int`;
    }
    const rows = await this._db().query<MaintenanceAuditRow>(
      `SELECT * FROM maintenance_audit ${where} ORDER BY seq DESC ${limit}`,
      params,
    );
    return rows.map(maintenanceRowToEntry);
  }

  async clear(): Promise<number> {
    const rows = await this._db().query<Row>(
      'WITH deleted AS (DELETE FROM maintenance_audit RETURNING 1) SELECT count(*)::int AS n FROM deleted',
    );
    const value = rows[0]?.n;
    return typeof value === 'number' ? value : 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// secretPatterns (ADR-036) — синхронный кэш-фасад
// ────────────────────────────────────────────────────────────────────────────

const SECRET_PATTERNS_KEY = 'storage.override.secret_patterns';

/** Валиден ли паттерн (непустой `type`, компилируемый `regex`) — паритет с core. */
function isValidPattern(value: unknown): value is SecretPattern {
  if (typeof value !== 'object' || value === null) return false;
  const { type, regex } = value as Record<string, unknown>;
  if (typeof type !== 'string' || type.trim() === '') return false;
  if (typeof regex !== 'string') return false;
  try {
    new RegExp(regex);
    return true;
  } catch {
    return false;
  }
}

/**
 * Дефолтные паттерны в сериализуемом виде (копия инъектированного набора core,
 * `DEFAULT_PATTERNS`). Всегда свежая копия — вызывающий не мутирует инъекцию.
 */
function defaultSecretPatterns(deps: PortDeps): SecretPattern[] {
  return deps.coreSync.secretPatterns.map((pattern) => ({ ...pattern }));
}

/** Порт паттернов детекции секретов (системный дефолт + DB-override, sync-геттеры). */
class PostgresSecretPatternRepository implements SecretPatternRepository {
  private _override: SecretPattern[] | null = null;
  private _warmed = false;

  constructor(private readonly _deps: PortDeps) {}

  /** Best-effort прогрев override из `settings` (стартует при сборке контекста). */
  async warm(): Promise<void> {
    if (this._warmed) return;
    const value = await loadSetting(this._deps.connection, SECRET_PATTERNS_KEY);
    // Гонка warm ↔ мутация: пока ждали БД, мутация уже прогрела/записала кэш
    // (`_warmed = true`) — не перетираем его устаревшим чтением.
    if (this._warmed) return;
    if (Array.isArray(value) && value.every(isValidPattern)) {
      this._override = value.map((pattern) => ({ type: pattern.type, regex: pattern.regex }));
    }
    this._warmed = true;
  }

  hasOverride(): boolean {
    return this._override !== null;
  }

  getDefaultPatterns(): SecretPattern[] {
    return defaultSecretPatterns(this._deps);
  }

  getPatterns(): SecretPattern[] {
    if (this._override === null) return this.getDefaultPatterns();
    return this._override.map((pattern) => ({ ...pattern }));
  }

  getEffectivePatterns(): SecretPattern[] {
    return this.getPatterns();
  }

  async savePatterns(patterns: SecretPattern[]): Promise<boolean> {
    if (!Array.isArray(patterns) || !patterns.every(isValidPattern)) return false;
    const normalized = patterns.map((pattern) => ({ type: pattern.type, regex: pattern.regex }));
    await saveSetting(this._deps.connection, SECRET_PATTERNS_KEY, normalized);
    this._override = normalized;
    this._warmed = true;
    return true;
  }

  async reset(): Promise<boolean> {
    if (this._override === null) return false;
    await deleteSetting(this._deps.connection, SECRET_PATTERNS_KEY);
    this._override = null;
    this._warmed = true;
    return true;
  }

  getRawPatterns(): { isOverridden: boolean; patterns: SecretPattern[]; defaultPatterns: SecretPattern[] } {
    return {
      isOverridden: this.hasOverride(),
      patterns: this.getPatterns(),
      defaultPatterns: this.getDefaultPatterns(),
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// protectedPaths — синхронный кэш-фасад
// ────────────────────────────────────────────────────────────────────────────

const PROTECTED_PATHS_KEY = 'storage.override.protected_paths';
const POLICY_LIST_KEYS = ['deniedPaths', 'deniedPrefixes', 'approvalPaths', 'deniedCommandPrefixes'] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function clonePolicy(policy: ProtectedPathsPolicy): ProtectedPathsPolicy {
  const clone: ProtectedPathsPolicy = {
    deniedPaths: [...policy.deniedPaths],
    deniedPrefixes: [...policy.deniedPrefixes],
    approvalPaths: [...policy.approvalPaths],
    deniedCommandPrefixes: [...policy.deniedCommandPrefixes],
  };
  if (policy.dataDir !== undefined) clone.dataDir = policy.dataDir;
  return clone;
}

function applyCascade(base: string[], add: string[], remove: string[]): string[] {
  const removed = new Set(remove);
  const kept = base.filter((item) => !removed.has(item));
  const added = new Set(kept);
  for (const item of add) if (!added.has(item)) kept.push(item);
  return kept;
}

function applyOverride(base: ProtectedPathsPolicy, override: ProtectedPathsOverride): ProtectedPathsPolicy {
  const result: ProtectedPathsPolicy = {
    deniedPaths: [],
    deniedPrefixes: [],
    approvalPaths: [],
    deniedCommandPrefixes: [],
  };
  for (const key of POLICY_LIST_KEYS) {
    result[key] = applyCascade(base[key] ?? [], override.add[key] ?? [], override.remove[key] ?? []);
  }
  return result;
}

function emptyOverride(): ProtectedPathsOverride {
  return { version: 1, add: {}, remove: {} };
}

function normalizeOverride(raw: Partial<ProtectedPathsOverride>): ProtectedPathsOverride {
  const add = raw.add ?? {};
  const remove = raw.remove ?? {};
  const override = emptyOverride();
  override.version = typeof raw.version === 'number' ? raw.version : 1;
  for (const key of POLICY_LIST_KEYS) {
    override.add[key] = isStringArray(add[key]) ? [...add[key]] : [];
    override.remove[key] = isStringArray(remove[key]) ? [...remove[key]] : [];
  }
  return override;
}

/** Порт защищённых путей (системный base + DB-override, sync-геттеры). */
class PostgresProtectedPathsRepository implements ProtectedPathsRepository {
  private _base?: ProtectedPathsPolicy;
  private _override: ProtectedPathsOverride | null = null;
  private _warmed = false;

  constructor(private readonly _deps: PortDeps) {}

  /** Best-effort прогрев override из `settings`. */
  async warm(): Promise<void> {
    if (this._warmed) return;
    const value = await loadSetting(this._deps.connection, PROTECTED_PATHS_KEY);
    // См. `secretPatterns.warm`: не перетираем кэш после конкурентной мутации.
    if (this._warmed) return;
    if (typeof value === 'object' && value !== null) {
      this._override = normalizeOverride(value as Partial<ProtectedPathsOverride>);
    }
    this._warmed = true;
  }

  /** Системный base (definitions/protected-paths.json); sync, всегда свежая копия. */
  private _basePolicy(): ProtectedPathsPolicy {
    if (!this._base) {
      this._base = this._deps.coreSync.protectedPathsBase;
    }
    return this._base;
  }

  private _effective(): ProtectedPathsPolicy {
    const base = this._basePolicy();
    const merged = this._override ? applyOverride(base, this._override) : base;
    const dynamic = [join(this._deps.dataDir, 'secrets'), join(this._deps.dataDir, 'security')];
    const seen = new Set(merged.deniedPrefixes.map((prefix) => normalize(prefix)));
    const deniedPrefixes = [...merged.deniedPrefixes];
    for (const entry of dynamic) {
      if (!seen.has(normalize(entry))) {
        seen.add(normalize(entry));
        deniedPrefixes.push(entry);
      }
    }
    return { ...merged, deniedPrefixes, dataDir: this._deps.dataDir };
  }

  hasOverride(): boolean {
    return this._override !== null;
  }

  getBase(): ProtectedPathsPolicy {
    return clonePolicy(this._basePolicy());
  }

  getPolicy(): ProtectedPathsPolicy {
    return this._effective();
  }

  getEffective(): ProtectedPathsPolicy {
    return this._effective();
  }

  getRaw(): ProtectedPathsRaw {
    const policy = { ...this.getPolicy() };
    delete policy.dataDir;
    const base = this.getBase();
    return { isOverridden: this.hasOverride(), policy, base, defaultBase: base };
  }

  getOverride(): ProtectedPathsOverride | null {
    return this._override ? normalizeOverride(this._override) : null;
  }

  async savePolicy(effective: ProtectedPathsPolicy): Promise<boolean> {
    if (!POLICY_LIST_KEYS.every((key) => isStringArray(effective[key] ?? []))) return false;
    const base = this._basePolicy();
    const override = emptyOverride();
    for (const key of POLICY_LIST_KEYS) {
      const baseArr = base[key] ?? [];
      const effArr = effective[key] ?? [];
      const effSet = new Set(effArr);
      const baseSet = new Set(baseArr);
      override.add[key] = effArr.filter((item) => !baseSet.has(item));
      override.remove[key] = baseArr.filter((item) => !effSet.has(item));
    }
    await saveSetting(this._deps.connection, PROTECTED_PATHS_KEY, override);
    this._override = override;
    this._warmed = true;
    return true;
  }

  async saveRawOverride(raw: Partial<ProtectedPathsOverride>): Promise<boolean> {
    const override = normalizeOverride(raw);
    await saveSetting(this._deps.connection, PROTECTED_PATHS_KEY, override);
    this._override = override;
    this._warmed = true;
    return true;
  }

  async reset(): Promise<boolean> {
    if (this._override === null) return false;
    await deleteSetting(this._deps.connection, PROTECTED_PATHS_KEY);
    this._override = null;
    this._warmed = true;
    return true;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// dictionaries (ADR-034/ADR-035) — синхронный кэш-фасад
// ────────────────────────────────────────────────────────────────────────────

const DICTIONARIES_KEY = 'storage.override.dictionaries';

interface DictionaryOverrideData {
  keywords: string[];
  tools?: string[];
}

interface DictionariesOverride {
  entries: Record<string, DictionaryOverrideData>;
  codingTools: string[] | null;
}

function emptyDictionariesOverride(): DictionariesOverride {
  return { entries: {}, codingTools: null };
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Строгий парсер YAML-содержимого словаря (`keywords:`/`tools:`), как в core/memory. */
function parseDictionaryContent(raw: string): { keywords: string[]; tools?: string[] } {
  const keywords: string[] = [];
  const tools: string[] = [];
  let current: 'keywords' | 'tools' | null = null;
  let keywordsSeen = false;
  let toolsSeen = false;

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed === 'keywords:' || trimmed === 'tools:') {
      current = trimmed === 'keywords:' ? 'keywords' : 'tools';
      if (current === 'keywords') keywordsSeen = true;
      else toolsSeen = true;
      continue;
    }
    if (trimmed.startsWith('-')) {
      if (!current) throw new Error(`Строка ${i + 1}: элемент списка вне keywords/tools`);
      let value = trimmed.startsWith('- ') ? trimmed.slice(2) : trimmed.slice(1);
      value = value.trim().replace(/^["']|["']$/g, '');
      if (!value) throw new Error(`Строка ${i + 1}: пустое значение списка`);
      if (current === 'keywords') keywords.push(value.toLowerCase());
      else tools.push(value);
      continue;
    }
    throw new Error(`Строка ${i + 1}: некорректный YAML — ${trimmed}`);
  }
  if (!keywordsSeen) throw new Error('YAML: отсутствует ключ keywords');
  return toolsSeen
    ? { keywords: dedupe(keywords), tools: dedupe(tools) }
    : { keywords: dedupe(keywords) };
}

/**
 * Порт словарей классификации: системные словари читаются из ассетов core
 * (синхронно), пользовательский override — из `settings` (sync-кэш + write-through).
 */
class PostgresDictionaryRepository implements DictionaryRepository {
  private _system?: DictionaryRepository;
  private _override: DictionariesOverride = emptyDictionariesOverride();
  private _warmed = false;

  constructor(private readonly _deps: PortDeps) {}

  /** Системный источник словарей, инъектированный core (`DictionaryStore`). */
  private _systemStore(): DictionaryRepository {
    if (!this._system) {
      this._system = this._deps.coreSync.systemDictionaries;
    }
    return this._system;
  }

  /** Best-effort прогрев override из `settings`. */
  async warm(): Promise<void> {
    if (this._warmed) return;
    const value = await loadSetting(this._deps.connection, DICTIONARIES_KEY);
    // См. `secretPatterns.warm`: не перетираем кэш после конкурентной мутации.
    if (this._warmed) return;
    if (typeof value === 'object' && value !== null) {
      const parsed = value as Partial<DictionariesOverride>;
      const entries: Record<string, DictionaryOverrideData> = {};
      if (parsed.entries && typeof parsed.entries === 'object') {
        for (const [key, data] of Object.entries(parsed.entries)) {
          if (!data || !isStringArray(data.keywords)) continue;
          entries[key] = {
            keywords: [...data.keywords],
            ...(isStringArray(data.tools) ? { tools: [...data.tools] } : {}),
          };
        }
      }
      this._override = {
        entries,
        codingTools: isStringArray(parsed.codingTools) ? [...parsed.codingTools] : null,
      };
    }
    this._warmed = true;
  }

  private _entry(category: string, language: string): DictionaryOverrideData | undefined {
    return this._override.entries[`${category}.${language}`];
  }

  getKeywords(category: string, language: string): string[] {
    const override = this._entry(category, language);
    if (override) return [...override.keywords];
    return this._systemStore().getKeywords(category, language);
  }

  getCategorizedKeywords(category: string, language: string): Record<string, string[]> {
    // Override хранит плоские keywords/tools; категоризированные данные — только
    // системные (известное ограничение: override не участвует в категоризации).
    return this._systemStore().getCategorizedKeywords(category, language);
  }

  getCodingTools(): string[] {
    if (this._override.codingTools !== null) return [...this._override.codingTools];
    return this._systemStore().getCodingTools();
  }

  isKnownCategory(category: string): boolean {
    return this._systemStore().isKnownCategory(category);
  }

  isValidLanguage(language: string): boolean {
    return this._systemStore().isValidLanguage(language);
  }

  getDictionary(category: string, language: string): StoredDictionary | null {
    if (!this.isKnownCategory(category) || !this.isValidLanguage(language)) return null;
    const override = this._entry(category, language);
    if (!override) return this._systemStore().getDictionary(category, language);
    const dictionary: StoredDictionary = {
      category,
      language,
      source: 'user',
      keywords: [...override.keywords],
    };
    if (category === 'coding') dictionary.tools = this.getCodingTools();
    else if (override.tools) dictionary.tools = [...override.tools];
    return dictionary;
  }

  listDictionaries(): StoredDictionary[] {
    return this._systemStore()
      .listDictionaries()
      .map((dictionary) => this.getDictionary(dictionary.category, dictionary.language) ?? dictionary);
  }

  async saveUserDictionary(
    category: string,
    language: string,
    data: { keywords: string[]; tools?: string[] },
  ): Promise<StoredDictionary | null> {
    if (!this.isKnownCategory(category) || !this.isValidLanguage(language)) return null;
    this._override.entries[`${category}.${language}`] = {
      keywords: [...data.keywords],
      ...(data.tools !== undefined ? { tools: [...data.tools] } : {}),
    };
    if (category === 'coding' && data.tools !== undefined) {
      this._override.codingTools = [...data.tools];
    }
    await this._persist();
    return this.getDictionary(category, language);
  }

  async deleteUserDictionary(category: string, language: string): Promise<StoredDictionary | null> {
    if (!this.isKnownCategory(category) || !this.isValidLanguage(language)) return null;
    delete this._override.entries[`${category}.${language}`];
    if (category === 'coding') this._override.codingTools = null;
    await this._persist();
    return this.getDictionary(category, language);
  }

  getContent(category: string, language: string): string {
    const override = this._entry(category, language);
    if (!override) return this._systemStore().getContent(category, language);
    const lines: string[] = ['keywords:'];
    for (const keyword of override.keywords) lines.push(`  - ${keyword}`);
    if (override.tools !== undefined) {
      lines.push('tools:');
      for (const tool of override.tools) lines.push(`  - ${tool}`);
    }
    return `${lines.join('\n')}\n`;
  }

  async saveUserContent(
    category: string,
    language: string,
    content: string,
  ): Promise<StoredDictionary | null> {
    if (!this.isKnownCategory(category) || !this.isValidLanguage(language)) return null;
    const { DICTIONARY_MAX_KEYWORDS, DICTIONARY_MAX_TOOLS } = await loadCore();
    const parsed = parseDictionaryContent(content);
    if (parsed.keywords.length > DICTIONARY_MAX_KEYWORDS) {
      throw new Error(`keywords: не более ${DICTIONARY_MAX_KEYWORDS} слов`);
    }
    if (parsed.tools && parsed.tools.length > DICTIONARY_MAX_TOOLS) {
      throw new Error(`tools: не более ${DICTIONARY_MAX_TOOLS} элементов`);
    }
    return this.saveUserDictionary(category, language, parsed);
  }

  private async _persist(): Promise<void> {
    await saveSetting(this._deps.connection, DICTIONARIES_KEY, this._override);
    this._warmed = true;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Сборка группы портов
// ────────────────────────────────────────────────────────────────────────────

/** Собрать порты группы `content`. */
export function buildContentPorts(deps: PortDeps): ContentPorts {
  const secretPatterns = new PostgresSecretPatternRepository(deps);
  const protectedPaths = new PostgresProtectedPathsRepository(deps);
  const dictionaries = new PostgresDictionaryRepository(deps);

  // Best-effort прогрев синхронных кэшей из БД (не блокирует сборку контекста:
  // фабрика синхронная, а awaited-конструктора у драйвера нет). Мутации
  // write-through, поэтому кэш консистентен сразу после записи; pre-existing
  // override появляется в кэше по завершении прогрева (короткое окно старта).
  // Если схема ещё не инициализирована — прогрев пропускается с одним сообщением.
  //
  // Прогрев остаётся fire-and-forget, но если владелец контекста умеет
  // отслеживать фоновые задачи (`trackBackground`), регистрируем его — тогда
  // `close()` дождётся завершения прогрева до закрытия пула. Иначе late
  // warm-запросы уходят в закрытый пул и дают ложные «пул недоступен».
  const warm = warmContentCaches(deps, { secretPatterns, protectedPaths, dictionaries });
  if (deps.trackBackground) deps.trackBackground(warm);
  else void warm;

  return {
    serviceKeys: new PostgresServiceKeyRepository(deps),
    sshKeys: new PostgresSSHKeyRepository(deps),
    mcpRegistry: new PostgresMcpRegistryRepository(deps),
    skillBundles: new PostgresSkillBundleRepository(deps),
    dictionaries,
    secretPatterns,
    protectedPaths,
    maintenanceAudit: new PostgresMaintenanceAuditRepository(deps),
  };
}
