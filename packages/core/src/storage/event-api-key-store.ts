import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { EventBindingApiKey, EventBindingApiKeyCreated } from '@itphx/synth-shared';
import { generateId, AsyncLock, atomicWrite, safeJsonParse } from '@itphx/synth-shared';
import type { EventKeyCredential } from '../engine/events/credential.js';
import type { EventApiKeyRepository } from './ports/event-api-key-repository.js';

/** ADR-089/ADR-052: версия схемы файла API-ключей привязок (для миграции PROP-032). */
export const EVENT_API_KEYS_SCHEMA_VERSION = 1;

export interface EventApiKeyStoreConfig {
  dataDir: string;
}

/** Вход создания ключа: обязательная уникальная `label`, опциональные поля. */
export interface CreateEventApiKeyInput {
  bindingId: string;
  /** Обязательная уникальная (глобально по инстансу) метка ключа. */
  label: string;
  description?: string;
  /** ISO-8601 срок действия. */
  expiresAt?: string;
  /** Лимит запросов/мин (0 — без лимита); не задан — глобальный дефолт. */
  rateLimitPerMinute?: number;
  createdBy: string;
}

/** Патч обновления ключа: `undefined` — не трогать, `null` — сбросить. */
export interface UpdateEventApiKeyPatch {
  label?: string;
  description?: string | null;
  expiresAt?: string | null;
  rateLimitPerMinute?: number | null;
}

/**
 * ADR-089/ADR-052: конфликт метки API-ключа привязки — метка неуникальна
 * (регистронезависимо) в пределах инстанса. Роуты маппят в 409 CONFLICT.
 */
export class EventApiKeyConflictError extends Error {
  constructor(readonly label: string) {
    super(`Метка API-ключа уже используется: ${label}`);
    this.name = 'EventApiKeyConflictError';
  }
}

/**
 * Внутренняя запись: публичные поля `EventBindingApiKey` + `hash` (sha256 hex
 * секрета). Наружу (`listByBinding`/`resolveBySecret`/`create`) хеш не отдаётся.
 */
export interface EventApiKeyRecord extends EventBindingApiKey {
  hash: string;
  /** Legacy-поле (до введения `label`); нормализуется при загрузке. */
  name?: string;
}

interface ApiKeysFile {
  schemaVersion: number;
  keys: EventApiKeyRecord[];
}

/**
 * Префикс секрета API-ключа привязки: видимая часть ключа для идентификации в
 * UI и канонический признак способа аутентификации (binding-key vs обычный
 * пользовательский Bearer). Единый источник истины для генерации и распознавания.
 */
export const EVENT_API_KEY_SECRET_PREFIX = 'synth_evt_';
const SECRET_PREFIX_VISIBLE = 12;

/** `true`, если строка — секрет API-ключа привязки (`synth_evt_…`). */
export function isEventApiKeySecret(raw: string): boolean {
  return raw.startsWith(EVENT_API_KEY_SECRET_PREFIX);
}

/** sha256 hex секрета — то, что хранится at-rest вместо plaintext. */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * ADR-089/ADR-052: реестр API-ключей привязок для аутентификации приёма событий.
 *
 * Хранится одним JSON-файлом `{dataDir}/events/api-keys.json` (ADR-005,
 * атомарная запись tmp→rename). Plaintext-секрет не сохраняется — только
 * `sha256`-хеш; секрет возвращается единственный раз в `create`. Модель PG-ready
 * (PROP-032): плоские записи со стабильным `id` и `schemaVersion`.
 */
export class EventApiKeyStore implements EventApiKeyRepository {
  private _lock = new AsyncLock();

  constructor(private _config: EventApiKeyStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'events', 'api-keys.json');
  }

  /** Защита от path traversal в id (как в `EventBindingStore._validateId`). */
  private _validateId(id: string): void {
    if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
      throw new Error(`Недопустимый id: ${id}`);
    }
  }

  private async _load(): Promise<ApiKeysFile> {
    try {
      const raw = await readFile(this._filePath(), 'utf-8');
      const parsed = safeJsonParse<ApiKeysFile | null>(raw, null);
      if (!parsed || !Array.isArray(parsed.keys)) {
        return { schemaVersion: EVENT_API_KEYS_SCHEMA_VERSION, keys: [] };
      }
      return {
        schemaVersion: parsed.schemaVersion ?? EVENT_API_KEYS_SCHEMA_VERSION,
        keys: parsed.keys
          .filter(
            (k): k is EventApiKeyRecord =>
              !!k && typeof k.id === 'string' && typeof k.hash === 'string' && typeof k.bindingId === 'string',
          )
          // Legacy-backfill: до введения обязательного `label` ключи хранили
          // `name` (опционально) / только `prefix`. Нормализуем к `label`.
          .map((k) => {
            const record = k as EventApiKeyRecord;
            if (!record.label) {
              record.label = record.name ?? record.prefix ?? record.id;
            }
            delete record.name;
            return record;
          }),
      };
    } catch {
      return { schemaVersion: EVENT_API_KEYS_SCHEMA_VERSION, keys: [] };
    }
  }

  private async _save(file: ApiKeysFile): Promise<void> {
    const path = this._filePath();
    await mkdir(dirname(path), { recursive: true });
    const data = JSON.stringify(
      { schemaVersion: EVENT_API_KEYS_SCHEMA_VERSION, keys: file.keys },
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

  /** Убирает `hash` (и legacy `name`) из внутренней записи — публичное представление. */
  private _toPublic(record: EventApiKeyRecord): EventBindingApiKey {
    // `hash`/`name` намеренно не попадают наружу; деструктуризация отбрасывает их.
    const { hash, name, ...pub } = record;
    void hash;
    void name;
    return pub;
  }

  /** Нормализованный ключ метки: trim + lower-case (регистронезависимая уникальность). */
  private _labelKey(label: string): string {
    return label.trim().toLowerCase();
  }

  /** Бросает `EventApiKeyConflictError`, если `label` уже занята другим ключом. */
  private _assertLabelUnique(file: ApiKeysFile, label: string, excludeKeyId?: string): void {
    const target = this._labelKey(label);
    const conflict = file.keys.some(
      (k) => k.id !== excludeKeyId && this._labelKey(k.label ?? '') === target,
    );
    if (conflict) throw new EventApiKeyConflictError(label);
  }

  /** Нормализует и проверяет метку: непустая строка после trim. */
  private _normalizeLabel(label: string | undefined): string {
    const normalized = label?.trim() ?? '';
    if (!normalized) throw new Error('label обязателен');
    return normalized;
  }

  async listByBinding(bindingId: string): Promise<EventBindingApiKey[]> {
    const file = await this._load();
    return file.keys.filter((k) => k.bindingId === bindingId).map((k) => this._toPublic(k));
  }

  /** Публичные метаданные ключа привязки либо `null`, если ключа нет. */
  async get(bindingId: string, keyId: string): Promise<EventBindingApiKey | null> {
    const file = await this._load();
    const record = file.keys.find((k) => k.id === keyId && k.bindingId === bindingId);
    return record ? this._toPublic(record) : null;
  }

  /**
   * Создаёт ключ: генерирует секрет `synth_evt_<base64url>`, сохраняет только
   * его sha256-хеш и возвращает публичные метаданные + plaintext-секрет
   * (единственный раз). Метка `label` обязательна и уникальна глобально по
   * инстансу (регистронезависимо) — иначе `EventApiKeyConflictError`.
   */
  async create(input: CreateEventApiKeyInput): Promise<EventBindingApiKeyCreated> {
    this._validateId(input.bindingId);
    const label = this._normalizeLabel(input.label);
    await this._lock.acquire();
    try {
      const secret = `${EVENT_API_KEY_SECRET_PREFIX}${randomBytes(24).toString('base64url')}`;
      const record: EventApiKeyRecord = {
        id: `eak_${generateId()}`,
        bindingId: input.bindingId,
        label,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        ...(input.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: input.rateLimitPerMinute } : {}),
        createdBy: input.createdBy,
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
   * Обновляет поля ключа. `null` для `description`/`expiresAt`/
   * `rateLimitPerMinute` — сброс поля; `undefined` — не трогать. Смена `label`
   * проверяется на глобальную уникальность (исключая саму запись). Возвращает
   * обновлённые метаданные либо `null`, если ключа нет.
   */
  async update(
    bindingId: string,
    keyId: string,
    patch: UpdateEventApiKeyPatch,
  ): Promise<EventBindingApiKey | null> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const record = file.keys.find((k) => k.id === keyId && k.bindingId === bindingId);
      if (!record) return null;

      if (patch.label !== undefined) {
        const label = this._normalizeLabel(patch.label);
        this._assertLabelUnique(file, label, keyId);
        record.label = label;
      }
      if (patch.description !== undefined) {
        if (patch.description === null) delete record.description;
        else record.description = patch.description;
      }
      if (patch.expiresAt !== undefined) {
        if (patch.expiresAt === null) delete record.expiresAt;
        else record.expiresAt = patch.expiresAt;
      }
      if (patch.rateLimitPerMinute !== undefined) {
        if (patch.rateLimitPerMinute === null) delete record.rateLimitPerMinute;
        else record.rateLimitPerMinute = patch.rateLimitPerMinute;
      }

      await this._save(file);
      return this._toPublic(record);
    } finally {
      this._lock.release();
    }
  }

  async remove(bindingId: string, keyId: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const next = file.keys.filter((k) => !(k.id === keyId && k.bindingId === bindingId));
      if (next.length === file.keys.length) return false;
      file.keys = next;
      await this._save(file);
      return true;
    } finally {
      this._lock.release();
    }
  }

  /** Каскадное удаление ключей привязки; возвращает число удалённых. */
  async removeByBinding(bindingId: string): Promise<number> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const next = file.keys.filter((k) => k.bindingId !== bindingId);
      const removed = file.keys.length - next.length;
      if (removed === 0) return 0;
      file.keys = next;
      await this._save(file);
      return removed;
    } finally {
      this._lock.release();
    }
  }

  /**
   * Мягкий отзыв ключа (ADR-052 — задел): проставляет `revokedAt` = now, после
   * чего `resolveBySecret` больше не резолвит ключ. Идемпотентно: повторный
   * вызов для уже отозванного ключа — `true` без смены даты. Возвращает `false`,
   * если ключа в этой привязке нет.
   */
  async revoke(bindingId: string, keyId: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const record = file.keys.find((k) => k.id === keyId && k.bindingId === bindingId);
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
   * (`EventKeyCredential`, задел ADR-052).
   */
  async resolveBySecret(
    rawSecret: string,
  ): Promise<{ key: EventBindingApiKey; credential: EventKeyCredential } | null> {
    if (!rawSecret) return null;
    const hash = hashSecret(rawSecret);
    const file = await this._load();
    const record = file.keys.find((k) => k.hash === hash);
    if (!record) return null;

    // ADR-089/ADR-052: отозванный/истёкший ключ недействителен.
    if (record.revokedAt) return null;
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return null;

    const key = this._toPublic(record);
    return {
      key,
      credential: {
        keyId: key.id,
        bindingId: key.bindingId,
        // ADR-089: владелец ключа (создатель) — атрибуция создаваемых сессий.
        ...(key.createdBy ? { ownerId: key.createdBy } : {}),
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
