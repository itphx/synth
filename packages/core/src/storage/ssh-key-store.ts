import { randomUUID } from 'node:crypto';
import type { SSHKey, SSHKeyMeta, SSHKeyCreateRequest, SSHKeyUpdateRequest } from '@itphx/synth-shared';
import { AsyncLock, nowISO } from '@itphx/synth-shared';
import { JsonStore } from './json-store.js';
import {
  CryptoError,
  decryptSecret,
  encryptSecret,
  resolveMasterKey,
} from '../security/crypto.js';

/** Подкаталог хранилища SSH-ключей внутри `dataDir`. */
const SSH_KEY_SUBDIR = 'secrets/ssh-keys';

export interface SSHKeyStoreConfig {
  dataDir: string;
  /** Явный мастер-ключ (base64 32 Б / hex 64); пусто — env/файл. */
  secretKey?: string;
  env?: NodeJS.ProcessEnv;
}

export type SSHKeyStoreErrorCode =
  | 'not_found'
  | 'name_exists'
  | 'decrypt_failed'
  | 'encryption_unavailable'
  | 'invalid';

/**
 * Типизированная ошибка store, которую роуты маппят в i18n-ключи:
 * `sshkey.not_found`, `sshkey.name_exists`, `sshkey.decrypt_failed`,
 * `sshkey.encryption_unavailable` (AD-076 §T2).
 */
export class SSHKeyStoreError extends Error {
  constructor(
    readonly code: SSHKeyStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SSHKeyStoreError';
  }
}

/**
 * AD-076 §T2: хранилище SSH-ключей агентов.
 *
 * Внутренняя persisted-форма — `SSHKey`, где `privateKey`/`passphrase` лежат
 * зашифрованными (`enc:v1:…`, AES-256-GCM). Файлы — `<dataDir>/secrets/ssh-keys/<id>.json`
 * (AD-005, атомарная запись tmp→rename через `JsonStore`).
 *
 * Публичные методы НИКОГДА не возвращают секреты; расшифровка — только `reveal()`
 * для подстановки в git.
 */
export class SSHKeyStore {
  private readonly _store: JsonStore<SSHKey>;
  private readonly _dataDir: string;
  private readonly _secretKey?: string;
  private readonly _env?: NodeJS.ProcessEnv;
  private readonly _writeLock = new AsyncLock();
  private _masterKeyPromise?: Promise<Buffer>;

  constructor(opts: SSHKeyStoreConfig) {
    this._dataDir = opts.dataDir;
    this._secretKey = opts.secretKey;
    this._env = opts.env;
    this._store = new JsonStore<SSHKey>({ dataDir: opts.dataDir, subdir: SSH_KEY_SUBDIR });
  }

  /** Публичные метаданные всех ключей (без секретов). */
  async list(): Promise<SSHKeyMeta[]> {
    const records = await this._store.list();
    return records.map(toMeta).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Публичные метаданные ключей, привязанных к агенту. */
  async listForAgent(agentId: string): Promise<SSHKeyMeta[]> {
    const all = await this.list();
    return all.filter((key) => key.agentIds.includes(agentId));
  }

  /** Публичные метаданные ключа по id (null, если нет). */
  async get(id: string): Promise<SSHKeyMeta | null> {
    const record = await this._store.load(id);
    return record ? toMeta(record) : null;
  }

  /** Создаёт ключ: шифрует секреты, проверяет уникальность имени (case-insensitive). */
  async create(input: SSHKeyCreateRequest): Promise<SSHKeyMeta> {
    assertNonEmptyPrivateKey(input.privateKey);
    const key = await this._masterKey();

    await this._writeLock.acquire();
    try {
      const existing = await this._store.list();
      if (existing.some((k) => k.name.toLowerCase() === input.name.toLowerCase())) {
        throw new SSHKeyStoreError('name_exists', `SSH-ключ "${input.name}" уже существует`);
      }

      const now = nowISO();
      const record: SSHKey = {
        id: randomUUID(),
        name: input.name,
        type: input.type ?? 'user',
        privateKey: encryptSecret(input.privateKey, key),
        passphrase: input.passphrase === undefined ? undefined : encryptSecret(input.passphrase, key),
        agentIds: input.agentIds ? [...input.agentIds] : [],
        createdAt: now,
        updatedAt: now,
      };
      await this._store.save(record.id, record);
      return toMeta(record);
    } finally {
      this._writeLock.release();
    }
  }

  /** Частично обновляет ключ; при переданных секретах — перешифровывает. */
  async update(id: string, patch: SSHKeyUpdateRequest): Promise<SSHKeyMeta | null> {
    const key = await this._masterKey();

    await this._writeLock.acquire();
    try {
      const record = await this._store.load(id);
      if (!record) return null;

      const nextName = patch.name;
      if (nextName !== undefined && nextName.toLowerCase() !== record.name.toLowerCase()) {
        const others = await this._store.list();
        if (others.some((k) => k.id !== id && k.name.toLowerCase() === nextName.toLowerCase())) {
          throw new SSHKeyStoreError('name_exists', `SSH-ключ "${nextName}" уже существует`);
        }
      }

      if (patch.privateKey !== undefined) {
        assertNonEmptyPrivateKey(patch.privateKey);
        record.privateKey = encryptSecret(patch.privateKey, key);
      }
      if (patch.passphrase !== undefined) {
        record.passphrase = encryptSecret(patch.passphrase, key);
      }
      if (nextName !== undefined) record.name = nextName;
      if (patch.type !== undefined) record.type = patch.type;
      if (patch.agentIds !== undefined) record.agentIds = [...patch.agentIds];
      record.updatedAt = nowISO();

      await this._store.save(id, record);
      return toMeta(record);
    } finally {
      this._writeLock.release();
    }
  }

  /** Удаляет ключ; `false`, если такого не было. */
  async delete(id: string): Promise<boolean> {
    await this._writeLock.acquire();
    try {
      const record = await this._store.load(id);
      if (!record) return false;
      await this._store.delete(id);
      return true;
    } finally {
      this._writeLock.release();
    }
  }

  /** Привязывает агента к ключу (идемпотентно). */
  async linkAgent(id: string, agentId: string): Promise<SSHKeyMeta | null> {
    return this._mutateAgentIds(id, (ids) => (ids.includes(agentId) ? ids : [...ids, agentId]));
  }

  /** Отвязывает агента от ключа (идемпотентно). */
  async unlinkAgent(id: string, agentId: string): Promise<SSHKeyMeta | null> {
    return this._mutateAgentIds(id, (ids) => ids.filter((a) => a !== agentId));
  }

  /**
   * Расшифрованные секреты — ТОЛЬКО для подстановки в git.
   * При ошибке расшифровки бросает `SSHKeyStoreError` c кодом `decrypt_failed`.
   */
  async reveal(id: string): Promise<{ privateKey: string; passphrase?: string } | null> {
    const key = await this._masterKey();
    const record = await this._store.load(id);
    if (!record) return null;
    try {
      const privateKey = decryptSecret(record.privateKey, key);
      const passphrase =
        record.passphrase === undefined ? undefined : decryptSecret(record.passphrase, key);
      return passphrase === undefined ? { privateKey } : { privateKey, passphrase };
    } catch (err) {
      throw mapCryptoError(err);
    }
  }

  private async _mutateAgentIds(
    id: string,
    mutate: (ids: string[]) => string[],
  ): Promise<SSHKeyMeta | null> {
    await this._writeLock.acquire();
    try {
      const record = await this._store.load(id);
      if (!record) return null;
      record.agentIds = mutate([...record.agentIds]);
      record.updatedAt = nowISO();
      await this._store.save(id, record);
      return toMeta(record);
    } finally {
      this._writeLock.release();
    }
  }

  private _masterKey(): Promise<Buffer> {
    if (!this._masterKeyPromise) {
      this._masterKeyPromise = resolveMasterKey({
        dataDir: this._dataDir,
        secretKey: this._secretKey,
        env: this._env,
      })
        .then((result) => result.key)
        .catch((err: unknown) => {
          this._masterKeyPromise = undefined;
          throw mapCryptoError(err);
        });
    }
    return this._masterKeyPromise;
  }
}

function toMeta(record: SSHKey): SSHKeyMeta {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    agentIds: [...record.agentIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function assertNonEmptyPrivateKey(privateKey: string): void {
  if (!privateKey || privateKey.trim() === '') {
    throw new SSHKeyStoreError('invalid', 'Приватный ключ не может быть пустым');
  }
}

function mapCryptoError(err: unknown): SSHKeyStoreError {
  if (err instanceof SSHKeyStoreError) return err;
  if (err instanceof CryptoError) {
    return new SSHKeyStoreError(
      err.code === 'encryption_unavailable' ? 'encryption_unavailable' : 'decrypt_failed',
      err.message,
    );
  }
  return new SSHKeyStoreError('decrypt_failed', 'Не удалось расшифровать секрет');
}
