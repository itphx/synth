import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { GlobalRole } from '@itphx/synth-shared';
import type { ServiceApiKey, ServiceApiKeyCreated } from '@itphx/synth-shared';
import { generateId, AsyncLock, atomicWrite, safeJsonParse } from '@itphx/synth-shared';
import type { CreateServiceApiKeyInput, UpdateServiceApiKeyPatch } from '@itphx/synth-shared';

/** AD-052 (этап I): версия схемы файла service-key (для будущей миграции AD-032). */
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
 * AD-052: контекст машинной аутентификации по service-key. Секрет здесь не
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
  /** Задел AD-052/AD-090: идентичность отправителя/сервиса. */
  principalId?: string;
}

/**
 * AD-052: конфликт метки service-key — метка неуникальна (регистронезависимо)
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

/**
 * AD-052 (этап I): реестр service-key — независимый от `EventApiKeyStore`
 * (AD-089) ключ инстанса для внешних сервисов.
 *
 * Хранится одним JSON-файлом `{dataDir}/service-keys.json` (AD-005, атомарная
 * запись tmp→rename). Plaintext-секрет не сохраняется — только sha256-хеш;
 * секрет возвращается единственный раз в `create`. Модель PG-ready (AD-032):
 * плоские записи со стабильным `id` и `schemaVersion`.
 */
export class ServiceApiKeyStore {
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
