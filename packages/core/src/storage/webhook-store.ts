import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  WebhookSubscription,
  WebhookSubscriptionCreated,
  CreateWebhookSubscriptionInput,
  UpdateWebhookSubscriptionPatch,
} from '@itphx/synth-shared';
import { WEBHOOK_SECRET_PREFIX } from '@itphx/synth-shared';
import { generateId, AsyncLock, atomicWrite, safeJsonParse, nowISO } from '@itphx/synth-shared';
import { decryptSecret, encryptSecret, isEncrypted, resolveMasterKey } from '../security/crypto.js';
import type { WebhookRepository } from './ports/webhook-repository.js';

/** ADR-052 (этап II): версия схемы файла подписок webhooks (для будущей миграции ADR-096). */
export const WEBHOOKS_SCHEMA_VERSION = 1;

const SECRET_PREFIX_VISIBLE = 12;

export interface WebhookStoreConfig {
  dataDir: string;
  /** Явный мастер-ключ (base64 32 Б / hex 64); пусто — env/файл. */
  secretKey?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * ADR-052 (этап II): конфликт метки подписки — метка неуникальна
 * (регистронезависимо) в пределах инстанса. Роуты маппят в 409 CONFLICT.
 */
export class WebhookConflictError extends Error {
  constructor(readonly label: string) {
    super(`Метка webhook уже используется: ${label}`);
    this.name = 'WebhookConflictError';
  }
}

/**
 * Внутренняя persisted-запись: публичные поля `WebhookSubscription` + `secret`
 * (signing-секрет, зашифрованный at-rest `enc:v1:…`). Наружу секрет не отдаётся.
 */
export interface WebhookRecord extends WebhookSubscription {
  secret: string;
}

interface WebhooksFile {
  schemaVersion: number;
  subscriptions: WebhookRecord[];
}

/**
 * ADR-052 (этап II): реестр подписок на исходящие события.
 *
 * Хранится одним JSON-файлом `{dataDir}/webhooks/subscriptions.json` (ADR-005,
 * атомарная запись tmp→rename). В отличие от API-ключей (ADR-089/ADR-052), здесь
 * нельзя хранить sha256-хеш: HMAC-подпись доставки требует исходный секрет,
 * поэтому `secret` шифруется at-rest мастер-ключом (AES-256-GCM, ADR-076) и
 * расшифровывается только при отправке (`getSecret`). Plaintext наружу —
 * единственный раз при создании/ротации. Модель PG-ready (ADR-097): плоские
 * записи со стабильным `id` и `schemaVersion`.
 */
export class WebhookStore implements WebhookRepository {
  private _lock = new AsyncLock();
  private _masterKeyPromise?: Promise<Buffer>;

  constructor(private _config: WebhookStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'webhooks', 'subscriptions.json');
  }

  /** Защита от path traversal в id. */
  private _validateId(id: string): void {
    if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
      throw new Error(`Недопустимый id: ${id}`);
    }
  }

  private async _load(): Promise<WebhooksFile> {
    try {
      const raw = await readFile(this._filePath(), 'utf-8');
      const parsed = safeJsonParse<WebhooksFile | null>(raw, null);
      if (!parsed || !Array.isArray(parsed.subscriptions)) {
        return { schemaVersion: WEBHOOKS_SCHEMA_VERSION, subscriptions: [] };
      }
      return {
        schemaVersion: parsed.schemaVersion ?? WEBHOOKS_SCHEMA_VERSION,
        subscriptions: parsed.subscriptions.filter(
          (s): s is WebhookRecord =>
            !!s && typeof s.id === 'string' && typeof s.secret === 'string' && typeof s.url === 'string',
        ),
      };
    } catch {
      return { schemaVersion: WEBHOOKS_SCHEMA_VERSION, subscriptions: [] };
    }
  }

  private async _save(file: WebhooksFile): Promise<void> {
    const path = this._filePath();
    await mkdir(dirname(path), { recursive: true });
    const data = JSON.stringify(
      { schemaVersion: WEBHOOKS_SCHEMA_VERSION, subscriptions: file.subscriptions },
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

  /** Убирает `secret` из внутренней записи — публичное представление. */
  private _toPublic(record: WebhookRecord): WebhookSubscription {
    const { secret, ...pub } = record;
    void secret;
    return pub;
  }

  /** Нормализованный ключ метки: trim + lower-case (регистронезависимая уникальность). */
  private _labelKey(label: string): string {
    return label.trim().toLowerCase();
  }

  /** Бросает `WebhookConflictError`, если `label` уже занята другой подпиской. */
  private _assertLabelUnique(file: WebhooksFile, label: string, excludeId?: string): void {
    const target = this._labelKey(label);
    const conflict = file.subscriptions.some(
      (s) => s.id !== excludeId && this._labelKey(s.label ?? '') === target,
    );
    if (conflict) throw new WebhookConflictError(label);
  }

  private _normalizeLabel(label: string | undefined): string {
    const normalized = label?.trim() ?? '';
    if (!normalized) throw new Error('label обязателен');
    return normalized;
  }

  private _masterKey(): Promise<Buffer> {
    if (!this._masterKeyPromise) {
      this._masterKeyPromise = resolveMasterKey({
        dataDir: this._config.dataDir,
        secretKey: this._config.secretKey,
        env: this._config.env,
      })
        .then((result) => result.key)
        .catch((err: unknown) => {
          this._masterKeyPromise = undefined;
          throw err;
        });
    }
    return this._masterKeyPromise;
  }

  /** Публичные метаданные всех подписок. */
  async list(): Promise<WebhookSubscription[]> {
    const file = await this._load();
    return file.subscriptions.map((s) => this._toPublic(s));
  }

  /** Публичные метаданные подписки либо `null`. */
  async get(id: string): Promise<WebhookSubscription | null> {
    const file = await this._load();
    const record = file.subscriptions.find((s) => s.id === id);
    return record ? this._toPublic(record) : null;
  }

  /**
   * Создаёт подписку: генерирует signing-секрет `whsec_<base64url>`, сохраняет
   * его зашифрованным мастер-ключом и возвращает публичные метаданные + plaintext
   * (единственный раз). Метка `label` обязательна и уникальна глобально по
   * инстансу (регистронезависимо) — иначе `WebhookConflictError`.
   */
  async create(
    input: CreateWebhookSubscriptionInput,
    createdBy: string,
  ): Promise<WebhookSubscriptionCreated> {
    const label = this._normalizeLabel(input.label);
    const key = await this._masterKey();
    await this._lock.acquire();
    try {
      const secret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(24).toString('base64url')}`;
      const record: WebhookRecord = {
        id: `whk_${generateId()}`,
        label,
        ...(input.description !== undefined ? { description: input.description } : {}),
        url: input.url,
        events: [...(input.events ?? [])],
        enabled: input.enabled ?? true,
        secretPrefix: `${secret.slice(0, SECRET_PREFIX_VISIBLE)}…`,
        createdBy,
        createdAt: nowISO(),
        secret: encryptSecret(secret, key),
      };

      const file = await this._load();
      this._assertLabelUnique(file, label);
      file.subscriptions.push(record);
      await this._save(file);

      return { ...this._toPublic(record), secret };
    } finally {
      this._lock.release();
    }
  }

  /**
   * Обновляет поля подписки. `null` для `description` — сброс; `undefined` — не
   * трогать. Смена `label` проверяется на глобальную уникальность (исключая саму
   * запись). Возвращает обновлённые метаданные либо `null`, если подписки нет.
   */
  async update(id: string, patch: UpdateWebhookSubscriptionPatch): Promise<WebhookSubscription | null> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const record = file.subscriptions.find((s) => s.id === id);
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
      if (patch.url !== undefined) record.url = patch.url;
      if (patch.events !== undefined) record.events = [...patch.events];
      if (patch.enabled !== undefined) this._applyEnabled(record, patch.enabled);

      await this._save(file);
      return this._toPublic(record);
    } finally {
      this._lock.release();
    }
  }

  /** Мягкое включение/отключение подписки; `null`, если подписки нет. */
  async setEnabled(id: string, enabled: boolean): Promise<WebhookSubscription | null> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const record = file.subscriptions.find((s) => s.id === id);
      if (!record) return null;
      this._applyEnabled(record, enabled);
      await this._save(file);
      return this._toPublic(record);
    } finally {
      this._lock.release();
    }
  }

  /** Удаление подписки; `true`, если существовала. */
  async remove(id: string): Promise<boolean> {
    this._validateId(id);
    await this._lock.acquire();
    try {
      const file = await this._load();
      const next = file.subscriptions.filter((s) => s.id !== id);
      if (next.length === file.subscriptions.length) return false;
      file.subscriptions = next;
      await this._save(file);
      return true;
    } finally {
      this._lock.release();
    }
  }

  /**
   * Ротация signing-секрета: генерирует новый `whsec_…`, сохраняет зашифрованным
   * и возвращает публичные метаданные + plaintext (единственный раз). `null`,
   * если подписки нет.
   */
  async regenerateSecret(id: string): Promise<WebhookSubscriptionCreated | null> {
    const key = await this._masterKey();
    await this._lock.acquire();
    try {
      const file = await this._load();
      const record = file.subscriptions.find((s) => s.id === id);
      if (!record) return null;
      const secret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(24).toString('base64url')}`;
      record.secret = encryptSecret(secret, key);
      record.secretPrefix = `${secret.slice(0, SECRET_PREFIX_VISIBLE)}…`;
      await this._save(file);
      return { ...this._toPublic(record), secret };
    } finally {
      this._lock.release();
    }
  }

  /**
   * Расшифрованный signing-секрет подписки (только для доставки). Неизвестный
   * id — `null`; повреждённый/чужой ключ шифрования — исключение криптослоя.
   */
  async getSecret(id: string): Promise<string | null> {
    const key = await this._masterKey();
    const file = await this._load();
    const record = file.subscriptions.find((s) => s.id === id);
    if (!record) return null;
    return isEncrypted(record.secret) ? decryptSecret(record.secret, key) : record.secret;
  }

  /** Best-effort отметка последней доставки (`lastDeliveryAt`/`lastStatus`). */
  async touchDelivery(id: string, status: 'ok' | 'failed'): Promise<void> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const record = file.subscriptions.find((s) => s.id === id);
      if (!record) return;
      record.lastDeliveryAt = nowISO();
      record.lastStatus = status;
      await this._save(file);
    } finally {
      this._lock.release();
    }
  }

  private _applyEnabled(record: WebhookRecord, enabled: boolean): void {
    record.enabled = enabled;
    if (enabled) {
      delete record.disabledAt;
    } else {
      record.disabledAt = nowISO();
    }
  }
}
