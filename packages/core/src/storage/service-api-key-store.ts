import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { GlobalRole } from '@itphx/synth-shared';
import type { ServiceApiKey, ServiceApiKeyCreated } from '@itphx/synth-shared';
import { generateId, AsyncLock, atomicWrite, safeJsonParse } from '@itphx/synth-shared';
import type { CreateServiceApiKeyInput, UpdateServiceApiKeyPatch } from '@itphx/synth-shared';
import type { ServiceKeyRepository } from './ports/service-key-repository.js';
import { info, warning } from '../logger.js';

/** ADR-052 (этап I): версия схемы файла service-key (для будущей миграции PROP-032). */
export const SERVICE_API_KEYS_SCHEMA_VERSION = 1;

/**
 * Префикс секрета service-key: видимая часть ключа для идентификации в UI и
 * канонический признак способа аутентификации (service-key vs пользовательский
 * Bearer / binding-key). Единый источник истины для генерации и распознавания.
 */
export const SERVICE_KEY_SECRET_PREFIX = 'synth_svc_';
const SECRET_PREFIX_VISIBLE = 12;

/** `true`, если строка — секрет service-key (`synth_svc_…`). */
export function isServiceKeySecret(raw: string): boolean {
  return raw.startsWith(SERVICE_KEY_SECRET_PREFIX);
}

/** sha256 hex секрета — то, что хранится at-rest вместо plaintext. */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export interface ServiceApiKeyStoreConfig {
  dataDir: string;
}

/**
 * ADR-052: контекст машинной аутентификации по service-key. Секрет здесь не
 * хранится — только стабильные поля ключа, нужные для enforcement (scopes,
 * роли, проектная проекция, лимит).
 */
export interface ServiceKeyCredential {
  keyId: string;
  label: string;
  roles: GlobalRole[];
  scopes: string[];
  /** Проектная проекция (пусто/отсутствует — политика инстанса). */
  allowedProjects?: string[];
  /** Лимит запросов/мин ключа (0/отсутствует — без лимита). */
  rateLimitPerMinute?: number;
  /** Задел ADR-052/PROP-090: идентичность отправителя/сервиса. */
  principalId?: string;
}

/**
 * ADR-052: конфликт метки service-key — метка неуникальна (регистронезависимо)
 * в пределах инстанса. Роуты маппят в 409 CONFLICT.
 */
export class ServiceApiKeyConflictError extends Error {
  constructor(readonly label: string) {
    super(`Метка service-key уже используется: ${label}`);
    this.name = 'ServiceApiKeyConflictError';
  }
}

/**
 * Внутренняя запись: публичные поля `ServiceApiKey` + `hash` (sha256 hex
 * секрета). Наружу (`list`/`get`/`create`) хеш не отдаётся.
 */
export interface ServiceApiKeyRecord extends ServiceApiKey {
  hash: string;
}

interface ServiceKeysFile {
  schemaVersion: number;
  keys: ServiceApiKeyRecord[];
}

/** Дефолтные роли service-key, если `roles` не заданы (least privilege). */
const DEFAULT_SERVICE_KEY_ROLES: GlobalRole[] = [GlobalRole.USER];

/** Автор (createdBy) ключа, провижининг которого выполнен bootstrap-логикой. */
export const BOOTSTRAP_CREATED_BY = 'bootstrap';

/** Вход `ServiceApiKeyStore.ensure` — installer-ключ с внешним секретом (O1). */
export interface EnsureServiceKeyInput {
  label: string;
  /** Plaintext-секрет (`synth_svc_…`; префикс дописывается, если отсутствует). */
  secret: string;
  scopes: string[];
  /** Не заданы/пусты — дефолт хранилища (`USER`); заданы — синхронизируются. */
  roles?: GlobalRole[];
  description?: string;
  createdBy?: string;
}

/** Результат идемпотентного `ensure`: создан / обновлён / без изменений. */
export type ServiceKeyEnsureStatus = 'created' | 'updated' | 'unchanged';

/**
 * ADR-052 (этап I): реестр service-key — независимый от `EventApiKeyStore`
 * (ADR-089) ключ инстанса для внешних сервисов.
 *
 * Хранится одним JSON-файлом `{dataDir}/service-keys.json` (ADR-005, атомарная
 * запись tmp→rename). Plaintext-секрет не сохраняется — только sha256-хеш;
 * секрет возвращается единственный раз в `create`. Модель PG-ready (PROP-032):
 * плоские записи со стабильным `id` и `schemaVersion`.
 */
export class ServiceApiKeyStore implements ServiceKeyRepository {
  private _lock = new AsyncLock();

  constructor(private _config: ServiceApiKeyStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'service-keys.json');
  }

  /** Защита от path traversal в id (как в `EventApiKeyStore._validateId`). */
  private _validateId(id: string): void {
    if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
      throw new Error(`Недопустимый id: ${id}`);
    }
  }

  private async _load(): Promise<ServiceKeysFile> {
    try {
      const raw = await readFile(this._filePath(), 'utf-8');
      const parsed = safeJsonParse<ServiceKeysFile | null>(raw, null);
      if (!parsed || !Array.isArray(parsed.keys)) {
        return { schemaVersion: SERVICE_API_KEYS_SCHEMA_VERSION, keys: [] };
      }
      return {
        schemaVersion: parsed.schemaVersion ?? SERVICE_API_KEYS_SCHEMA_VERSION,
        keys: parsed.keys.filter(
          (k): k is ServiceApiKeyRecord =>
            !!k && typeof k.id === 'string' && typeof k.hash === 'string',
        ),
      };
    } catch {
      return { schemaVersion: SERVICE_API_KEYS_SCHEMA_VERSION, keys: [] };
    }
  }

  private async _save(file: ServiceKeysFile): Promise<void> {
    const path = this._filePath();
    await mkdir(dirname(path), { recursive: true });
    const data = JSON.stringify(
      { schemaVersion: SERVICE_API_KEYS_SCHEMA_VERSION, keys: file.keys },
      null,
      2,
    );
    await atomicWrite(
      (p, d) => writeFile(p, d, 'utf-8'),
      (o, n) => rename(o, n),
      path,
      data,
    );
  }

  /** Убирает `hash` из внутренней записи — публичное представление. */
  private _toPublic(record: ServiceApiKeyRecord): ServiceApiKey {
    const { hash, ...pub } = record;
    void hash;
    return pub;
  }

  /** Нормализованный ключ метки: trim + lower-case (регистронезависимая уникальность). */
  private _labelKey(label: string): string {
    return label.trim().toLowerCase();
  }

  /** Бросает `ServiceApiKeyConflictError`, если `label` уже занята другим ключом. */
  private _assertLabelUnique(file: ServiceKeysFile, label: string, excludeKeyId?: string): void {
    const target = this._labelKey(label);
    const conflict = file.keys.some(
      (k) => k.id !== excludeKeyId && this._labelKey(k.label ?? '') === target,
    );
    if (conflict) throw new ServiceApiKeyConflictError(label);
  }

  /** Нормализует и проверяет метку: непустая строка после trim. */
  private _normalizeLabel(label: string | undefined): string {
    const normalized = label?.trim() ?? '';
    if (!normalized) throw new Error('label обязателен');
    return normalized;
  }

  /** Публичные метаданные всех ключей (без hash/секрета). */
  async list(): Promise<ServiceApiKey[]> {
    const file = await this._load();
    return file.keys.map((k) => this._toPublic(k));
  }

  /** Публичные метаданные ключа либо `null`, если ключа нет. */
  async get(id: string): Promise<ServiceApiKey | null> {
    const file = await this._load();
    const record = file.keys.find((k) => k.id === id);
    return record ? this._toPublic(record) : null;
  }

  /**
   * Полные записи (включая `hash`) — только для переноса между backend'ами
   * (`synth storage migrate`, PROP-032); публичный API использует `list()`.
   */
  async exportAll(): Promise<ServiceApiKeyRecord[]> {
    const file = await this._load();
    return file.keys.map((record) => ({
      ...record,
      roles: [...record.roles],
      scopes: [...record.scopes],
      ...(record.allowedProjects ? { allowedProjects: [...record.allowedProjects] } : {}),
    }));
  }

  /**
   * Импорт готовой записи как есть: `id`/`prefix`/`hash`/метаданные сохраняются,
   * новый секрет не генерируется. Идемпотентно: при совпадении `id`, метки или
   * хеша возвращается существующая запись (без перезаписи).
   */
  async importExisting(record: ServiceApiKeyRecord): Promise<ServiceApiKey> {
    this._validateId(record.id);
    const label = this._normalizeLabel(record.label);
    if (!record.hash) throw new Error('hash обязателен');
    await this._lock.acquire();
    try {
      const file = await this._load();
      const sameId = file.keys.find((k) => k.id === record.id);
      if (sameId) return this._toPublic(sameId);
      const sameLabel = file.keys.find(
        (k) => this._labelKey(k.label ?? '') === this._labelKey(label),
      );
      if (sameLabel) return this._toPublic(sameLabel);
      const sameHash = file.keys.find((k) => k.hash === record.hash);
      if (sameHash) return this._toPublic(sameHash);

      const stored: ServiceApiKeyRecord = {
        ...record,
        label,
        roles: [...record.roles],
        scopes: [...record.scopes],
        ...(record.allowedProjects ? { allowedProjects: [...record.allowedProjects] } : {}),
      };
      file.keys.push(stored);
      await this._save(file);
      return this._toPublic(stored);
    } finally {
      this._lock.release();
    }
  }

  /**
   * Создаёт ключ: генерирует секрет `synth_svc_<base64url>`, сохраняет только
   * его sha256-хеш и возвращает публичные метаданные + plaintext-секрет
   * (единственный раз). Метка `label` обязательна и уникальна глобально по
   * инстансу (регистронезависимо) — иначе `ServiceApiKeyConflictError`.
   */
  async create(input: CreateServiceApiKeyInput, createdBy: string): Promise<ServiceApiKeyCreated> {
    const label = this._normalizeLabel(input.label);
    await this._lock.acquire();
    try {
      const secret = `${SERVICE_KEY_SECRET_PREFIX}${randomBytes(24).toString('base64url')}`;
      const record: ServiceApiKeyRecord = {
        id: `svk_${generateId()}`,
        label,
        ...(input.description !== undefined ? { description: input.description } : {}),
        roles: input.roles && input.roles.length > 0 ? [...input.roles] : [...DEFAULT_SERVICE_KEY_ROLES],
        scopes: [...input.scopes],
        ...(input.allowedProjects !== undefined ? { allowedProjects: [...input.allowedProjects] } : {}),
        ...(input.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: input.rateLimitPerMinute } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        createdBy,
        createdAt: new Date().toISOString(),
        prefix: `${secret.slice(0, SECRET_PREFIX_VISIBLE)}…`,
        hash: hashSecret(secret),
      };

      const file = await this._load();
      this._assertLabelUnique(file, label);
      file.keys.push(record);
      await this._save(file);

      return { ...this._toPublic(record), key: secret };
    } finally {
      this._lock.release();
    }
  }

  /**
   * ADR-052/O1 (installer): идемпотентный провижининг ключа с **внешним**
   * секретом (из env/Secret). Ключа с такой меткой нет — создаёт его с заданным
   * секретом (at-rest хранится только sha256-хеш; `prefix` считается); есть —
   * синхронизирует `scopes` и (если переданы) `roles`, секрет не меняет.
   *
   * Секрет используется как есть; если он не начинается с `synth_svc_`,
   * префикс дописывается (иначе аутентификация по ключу не распознает секрет).
   * `revokedAt`/`expiresAt` не трогаются. Возвращает статус `created` / `updated`
   * / `unchanged` и публичные метаданные (без секрета/хеша).
   */
  async ensure(input: EnsureServiceKeyInput): Promise<{
    status: ServiceKeyEnsureStatus;
    key: ServiceApiKey;
  }> {
    const label = this._normalizeLabel(input.label);
    const rawSecret = input.secret?.trim() ?? '';
    if (!rawSecret) throw new Error('secret обязателен');
    const secret = isServiceKeySecret(rawSecret)
      ? rawSecret
      : `${SERVICE_KEY_SECRET_PREFIX}${rawSecret}`;
    const roles =
      input.roles && input.roles.length > 0 ? [...input.roles] : [...DEFAULT_SERVICE_KEY_ROLES];

    await this._lock.acquire();
    try {
      const file = await this._load();
      const existing = file.keys.find(
        (k) => this._labelKey(k.label ?? '') === this._labelKey(label),
      );

      if (!existing) {
        const record: ServiceApiKeyRecord = {
          id: `svk_${generateId()}`,
          label,
          ...(input.description !== undefined ? { description: input.description } : {}),
          roles,
          scopes: [...input.scopes],
          createdBy: input.createdBy ?? BOOTSTRAP_CREATED_BY,
          createdAt: new Date().toISOString(),
          prefix: `${secret.slice(0, SECRET_PREFIX_VISIBLE)}…`,
          hash: hashSecret(secret),
        };
        file.keys.push(record);
        await this._save(file);
        return { status: 'created', key: this._toPublic(record) };
      }

      const sameScopes =
        existing.scopes.length === input.scopes.length &&
        existing.scopes.every((s, i) => s === input.scopes[i]);
      const sameRoles =
        !input.roles ||
        input.roles.length === 0 ||
        (existing.roles.length === roles.length && existing.roles.every((r, i) => r === roles[i]));

      if (sameScopes && sameRoles) {
        return { status: 'unchanged', key: this._toPublic(existing) };
      }

      if (!sameScopes) existing.scopes = [...input.scopes];
      if (!sameRoles) existing.roles = roles;
      await this._save(file);
      return { status: 'updated', key: this._toPublic(existing) };
    } finally {
      this._lock.release();
    }
  }

  /**
   * Обновляет поля ключа. `null` для `description`/`allowedProjects`/
   * `rateLimitPerMinute`/`expiresAt` — сброс; `undefined` — не трогать. Смена
   * `label` проверяется на глобальную уникальность (исключая саму запись).
   * Возвращает обновлённые метаданные либо `null`, если ключа нет.
   */
  async update(id: string, patch: UpdateServiceApiKeyPatch): Promise<ServiceApiKey | null> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const record = file.keys.find((k) => k.id === id);
      if (!record) return null;

      if (patch.label !== undefined) {
        const label = this._normalizeLabel(patch.label);
        this._assertLabelUnique(file, label, id);
        record.label = label;
      }
      if (patch.description !== undefined) {
        if (patch.description === null) delete record.description;
        else record.description = patch.description;
      }
      if (patch.roles !== undefined) {
        record.roles = patch.roles.length > 0 ? [...patch.roles] : [...DEFAULT_SERVICE_KEY_ROLES];
      }
      if (patch.scopes !== undefined) {
        record.scopes = [...patch.scopes];
      }
      if (patch.allowedProjects !== undefined) {
        if (patch.allowedProjects === null) delete record.allowedProjects;
        else record.allowedProjects = [...patch.allowedProjects];
      }
      if (patch.rateLimitPerMinute !== undefined) {
        if (patch.rateLimitPerMinute === null) delete record.rateLimitPerMinute;
        else record.rateLimitPerMinute = patch.rateLimitPerMinute;
      }
      if (patch.expiresAt !== undefined) {
        if (patch.expiresAt === null) delete record.expiresAt;
        else record.expiresAt = patch.expiresAt;
      }

      await this._save(file);
      return this._toPublic(record);
    } finally {
      this._lock.release();
    }
  }

  /** Удаление ключа; `true`, если ключ существовал. */
  async remove(id: string): Promise<boolean> {
    this._validateId(id);
    await this._lock.acquire();
    try {
      const file = await this._load();
      const next = file.keys.filter((k) => k.id !== id);
      if (next.length === file.keys.length) return false;
      file.keys = next;
      await this._save(file);
      return true;
    } finally {
      this._lock.release();
    }
  }

  /**
   * Мягкий отзыв ключа: проставляет `revokedAt` = now, после чего
   * `resolveBySecret` больше не резолвит ключ. Идемпотентно: повторный вызов для
   * уже отозванного ключа — `true` без смены даты. Возвращает `false`, если
   * ключа нет.
   */
  async revoke(id: string): Promise<boolean> {
    this._validateId(id);
    await this._lock.acquire();
    try {
      const file = await this._load();
      const record = file.keys.find((k) => k.id === id);
      if (!record) return false;
      if (!record.revokedAt) {
        record.revokedAt = new Date().toISOString();
        await this._save(file);
      }
      return true;
    } finally {
      this._lock.release();
    }
  }

  /**
   * Резолвит секрет: sha256 + поиск записи. Неверный/неизвестный секрет,
   * отозванный (`revokedAt`) или истёкший (`expiresAt` в прошлом) — `null`.
   * Возвращает публичные метаданные ключа и контекст машинной аутентификации
   * (`ServiceKeyCredential`).
   */
  async resolveBySecret(
    rawSecret: string,
  ): Promise<{ key: ServiceApiKey; credential: ServiceKeyCredential } | null> {
    if (!rawSecret) return null;
    const hash = hashSecret(rawSecret);
    const file = await this._load();
    const record = file.keys.find((k) => k.hash === hash);
    if (!record) return null;

    // Отозванный/истёкший ключ недействителен.
    if (record.revokedAt) return null;
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return null;

    const key = this._toPublic(record);
    return {
      key,
      credential: {
        keyId: key.id,
        label: key.label,
        roles: [...key.roles],
        scopes: [...key.scopes],
        ...(key.allowedProjects ? { allowedProjects: [...key.allowedProjects] } : {}),
        ...(key.rateLimitPerMinute !== undefined
          ? { rateLimitPerMinute: key.rateLimitPerMinute }
          : {}),
      },
    };
  }

  /** Best-effort отметка использования ключа (`lastUsedAt`). */
  async touch(id: string): Promise<void> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const record = file.keys.find((k) => k.id === id);
      if (!record) return;
      record.lastUsedAt = new Date().toISOString();
      await this._save(file);
    } finally {
      this._lock.release();
    }
  }
}

/** Запись installer-ключа для bootstrap (структурно совместима с config-схемой). */
export interface BootstrapServiceKeyEntry {
  label: string;
  secret: string;
  scopes: string[];
  roles?: GlobalRole[];
  description?: string;
}

/**
 * ADR-052/O1: best-effort провижининг списка installer service-key'ев при старте
 * (core standalone и backend). Каждый ключ обрабатывается независимо:
 * `ensure` идемпотентно создаёт/синхронизирует ключ; ошибка одного entry
 * логируется (без секрета) и **не** роняет старт инстанса — installer просто не
 * получит доступ, оператор увидит warning (`ensure`-ошибки не критичны для
 * работы остальных API).
 */
export async function applyBootstrapServiceKeys(
  store: ServiceKeyRepository,
  entries: readonly BootstrapServiceKeyEntry[],
): Promise<void> {
  for (const entry of entries) {
    try {
      const result = await store.ensure({
        label: entry.label,
        secret: entry.secret,
        scopes: entry.scopes,
        ...(entry.roles ? { roles: entry.roles } : {}),
        ...(entry.description !== undefined ? { description: entry.description } : {}),
      });
      info('bootstrap', `service-key "${result.key.label}": ${result.status}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warning('bootstrap', `service-key "${entry.label}" не применён: ${message}`);
    }
  }
}
