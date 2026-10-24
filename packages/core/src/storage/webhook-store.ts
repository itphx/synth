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
import {
  MASTER_KEY_LENGTH,
  decryptSecret,
  encryptSecret,
  isEncrypted,
  resolveMasterKey,
} from '../security/crypto.js';
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

/** Коды ошибок хранилища подписок webhooks. */
export type WebhookStoreErrorCode =
  /** Некорректный вход/ключ (например, мастер-ключ не 32 байта). */
  | 'invalid'
  /** Не удалось расшифровать signing-секрет (смена мастер-ключа, повреждение данных). */
  | 'decrypt_failed'
  /** Мастер-ключ недоступен/некорректен — запись секрета невозможна. */
  | 'encryption_unavailable'
  /**
   * Preflight ротации не пройден: подписка не расшифровывается ни старым, ни
   * новым мастер-ключом — операция прервана ДО записи.
   */
  | 'preflight_failed';

/** Типизированная ошибка хранилища подписок (секрет в тексте ошибки не фигурирует). */
export class WebhookStoreError extends Error {
  constructor(
    readonly code: WebhookStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookStoreError';
  }
}

/** Опции ротации мастер-ключа подписок webhooks. */
export interface RotateWebhookKeyOptions {
  /** Предпросмотр: счётчики считаются, записи не сохраняются. */
  dryRun?: boolean;
}

/** Результат ротации мастер-ключа: счётчики подписок и id изменённых. */
export interface RotateWebhookKeyResult {
  /** Всего подписок в хранилище. */
  total: number;
  /** Подписок, где signing-секрет перешифрован старым→новым ключом. */
  rotated: number;
  /** Подписок, где plaintext-секрет зашифрован новым ключом («апгрейд»). */
  upgraded: number;
  /** Подписок, уже зашифрованных новым ключом (ничего не изменено). */
  skipped: number;
  /** id подписок, которые были бы/были изменены (rotated + upgraded). */
  ids: string[];
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

  /**
   * Ротация мастер-ключа (one-shot) — по образцу
   * `ExternalCredentialStore.rotateMasterKey`/`SSHKeyStore.rotateMasterKey`.
   *
   * Signing-секрет подписки шифруется at-rest мастер-ключом (ADR-052 этап II),
   * поэтому после смены мастер-ключа подписки перестают подписывать доставки
   * («Секрет недоступен»), пока секрет не перешифрован.
   *
   * Порядок: сначала **preflight по всем подпискам** (каждый секрет должен
   * расшифровываться новым либо старым ключом; иначе `preflight_failed` со
   * списком id и **ничего не записывается**), затем перешифровка старым→новым
   * (идемпотентно: уже новые — `skipped`), plaintext-секрет «апгрейдится» новым
   * ключом. Запись — атомарно (весь файл перезаписывается tmp→rename, ADR-005).
   * `dryRun` — без записи.
   */
  async rotateMasterKey(
    oldKey: Buffer,
    newKey: Buffer,
    opts: RotateWebhookKeyOptions = {},
  ): Promise<RotateWebhookKeyResult> {
    if (oldKey.length !== MASTER_KEY_LENGTH || newKey.length !== MASTER_KEY_LENGTH) {
      throw new WebhookStoreError('invalid', 'Мастер-ключ должен быть 32 байта');
    }

    await this._lock.acquire();
    try {
      const file = await this._load();
      const failures = new Set<string>();
      const planned: Array<{
        record: WebhookRecord;
        changed: boolean;
        kind: 'rotated' | 'upgraded' | 'skipped';
      }> = [];

      // Preflight: планируем все изменения в памяти, ничего не записывая.
      for (const record of file.subscriptions) {
        const item = planSubscriptionRotation(record, oldKey, newKey, failures);
        if (item) planned.push(item);
      }

      if (failures.size > 0) {
        throw new WebhookStoreError(
          'preflight_failed',
          `Не удалось расшифровать signing-секреты webhooks (ни старым, ни новым ключом): ${[...failures].sort().join(', ')}`,
        );
      }

      let rotated = 0;
      let upgraded = 0;
      let skipped = 0;
      const ids: string[] = [];
      let dirty = false;

      for (const item of planned) {
        if (item.kind === 'rotated') {
          rotated += 1;
          ids.push(item.record.id);
        } else if (item.kind === 'upgraded') {
          upgraded += 1;
          ids.push(item.record.id);
        } else {
          skipped += 1;
        }
        if (!item.changed) continue;
        dirty = true;
        const index = file.subscriptions.findIndex((s) => s.id === item.record.id);
        if (index >= 0) file.subscriptions[index] = item.record;
      }

      // Запись — одна атомарная перезапись файла (ADR-005, tmp→rename).
      if (dirty && !opts.dryRun) {
        await this._save(file);
      }

      return { total: file.subscriptions.length, rotated, upgraded, skipped, ids };
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

type WebhookSecretRotation =
  | { value: string; kind: 'rotated' | 'upgraded' | 'unchanged' }
  | { invalid: true };

/**
 * Перешифровывает signing-секрет подписки: plaintext → шифр новым ключом
 * (upgraded); уже новый шифр → без изменений; старый шифр → расшифровать
 * старым и зашифровать новым (rotated); иначе — invalid (preflight-отказ).
 */
function rotateWebhookSecret(
  secret: string,
  oldKey: Buffer,
  newKey: Buffer,
): WebhookSecretRotation {
  if (!isEncrypted(secret)) {
    return { value: encryptSecret(secret, newKey), kind: 'upgraded' };
  }
  try {
    decryptSecret(secret, newKey);
    return { value: secret, kind: 'unchanged' };
  } catch {
    // Не расшифровывается новым — пробуем старым.
  }
  try {
    const plaintext = decryptSecret(secret, oldKey);
    return { value: encryptSecret(plaintext, newKey), kind: 'rotated' };
  } catch {
    return { invalid: true };
  }
}

/**
 * Планирует ротацию одной подписки; при нерасшифровываемом секрете пишет id в
 * `failures` (preflight-отказ).
 */
function planSubscriptionRotation(
  record: WebhookRecord,
  oldKey: Buffer,
  newKey: Buffer,
  failures: Set<string>,
): { record: WebhookRecord; changed: boolean; kind: 'rotated' | 'upgraded' | 'skipped' } | null {
  const result = rotateWebhookSecret(record.secret, oldKey, newKey);
  if ('invalid' in result) {
    failures.add(record.id);
    return null;
  }
  if (result.kind === 'unchanged') return { record, changed: false, kind: 'skipped' };
  // `secretPrefix` не меняется: plaintext-секрет при ротации тот же.
  const next: WebhookRecord = { ...record, secret: result.value };
  return { record: next, changed: true, kind: result.kind };
}
