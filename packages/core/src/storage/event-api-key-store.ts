import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { EventBindingApiKey, EventBindingApiKeyCreated } from '@itphx/synth-shared';
import { generateId, AsyncLock, atomicWrite, safeJsonParse } from '@itphx/synth-shared';
import type { EventKeyCredential } from '../engine/events/credential.js';

/** AD-089/AD-052: версия схемы файла API-ключей привязок (для миграции AD-032). */
export const EVENT_API_KEYS_SCHEMA_VERSION = 1;

export interface EventApiKeyStoreConfig {
  dataDir: string;
}

/** Вход создания ключа: `description` обязателен, `name` — опционален. */
export interface CreateEventApiKeyInput {
  bindingId: string;
  name?: string;
  description: string;
  createdBy: string;
}

/**
 * Внутренняя запись: публичные поля `EventBindingApiKey` + `hash` (sha256 hex
 * секрета). Наружу (`listByBinding`/`resolveBySecret`/`create`) хеш не отдаётся.
 */
export interface EventApiKeyRecord extends EventBindingApiKey {
  hash: string;
}

interface ApiKeysFile {
  schemaVersion: number;
  keys: EventApiKeyRecord[];
}

/** Префикс секрета: видимая часть ключа для идентификации в UI. */
const SECRET_PREFIX = 'synth_evt_';
const SECRET_PREFIX_VISIBLE = 12;

/** sha256 hex секрета — то, что хранится at-rest вместо plaintext. */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * AD-089/AD-052: реестр API-ключей привязок для аутентификации приёма событий.
 *
 * Хранится одним JSON-файлом `{dataDir}/events/api-keys.json` (AD-005,
 * атомарная запись tmp→rename). Plaintext-секрет не сохраняется — только
 * `sha256`-хеш; секрет возвращается единственный раз в `create`. Модель PG-ready
 * (AD-032): плоские записи со стабильным `id` и `schemaVersion`.
 */
export class EventApiKeyStore {
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
        keys: parsed.keys.filter(
          (k): k is EventApiKeyRecord =>
            !!k && typeof k.id === 'string' && typeof k.hash === 'string' && typeof k.bindingId === 'string',
        ),
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

  /** Убирает `hash` из внутренней записи — публичное представление. */
  private _toPublic(record: EventApiKeyRecord): EventBindingApiKey {
    // `hash` намеренно не попадает наружу; деструктуризация отбрасывает его.
    const { hash, ...pub } = record;
    void hash;
    return pub;
  }

  async listByBinding(bindingId: string): Promise<EventBindingApiKey[]> {
    const file = await this._load();
    return file.keys.filter((k) => k.bindingId === bindingId).map((k) => this._toPublic(k));
  }

  /**
   * Создаёт ключ: генерирует секрет `synth_evt_<base64url>`, сохраняет только
   * его sha256-хеш и возвращает публичные метаданные + plaintext-секрет
   * (единственный раз).
   */
  async create(input: CreateEventApiKeyInput): Promise<EventBindingApiKeyCreated> {
    this._validateId(input.bindingId);
    await this._lock.acquire();
    try {
      const secret = `${SECRET_PREFIX}${randomBytes(24).toString('base64url')}`;
      const record: EventApiKeyRecord = {
        id: `eak_${generateId()}`,
        bindingId: input.bindingId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        description: input.description,
        createdBy: input.createdBy,
        createdAt: new Date().toISOString(),
        prefix: `${secret.slice(0, SECRET_PREFIX_VISIBLE)}…`,
        hash: hashSecret(secret),
      };

      const file = await this._load();
      file.keys.push(record);
      await this._save(file);

      return { ...this._toPublic(record), key: secret };
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
   * Мягкий отзыв ключа (AD-052 — задел): проставляет `revokedAt` = now, после
   * чего `resolveBySecret` больше не резолвит ключ. Возвращает `false`, если
   * ключа в этой привязке нет. HTTP-эндпоинта revoke пока нет — метод уровня
   * реестра для будущей публичной API-платформы.
   */
  async revoke(bindingId: string, keyId: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const record = file.keys.find((k) => k.id === keyId && k.bindingId === bindingId);
      if (!record) return false;
      record.revokedAt = new Date().toISOString();
      await this._save(file);
      return true;
    } finally {
      this._lock.release();
    }
  }

  /**
   * Резолвит секрет: sha256 + поиск записи. Неверный/неизвестный секрет,
   * отозванный (`revokedAt`) или истёкший (`expiresAt` в прошлом) — `null`.
   * Возвращает публичные метаданные ключа и контекст машинной аутентификации
   * (`EventKeyCredential`, задел AD-052).
   */
  async resolveBySecret(
    rawSecret: string,
  ): Promise<{ key: EventBindingApiKey; credential: EventKeyCredential } | null> {
    if (!rawSecret) return null;
    const hash = hashSecret(rawSecret);
    const file = await this._load();
    const record = file.keys.find((k) => k.hash === hash);
    if (!record) return null;

    // AD-089/AD-052: отозванный/истёкший ключ недействителен.
    if (record.revokedAt) return null;
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return null;

    const key = this._toPublic(record);
    return {
      key,
      credential: { keyId: key.id, bindingId: key.bindingId },
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
