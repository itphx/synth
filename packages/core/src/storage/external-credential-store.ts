/**
 * PROP-107 (Ф1): файловая реализация порта внешних доступов.
 *
 * Файл — `{dataDir}/secrets/oauth/credentials.json` (ADR-005, атомарная запись
 * tmp→rename, права `0600`, каталог `0700`). Размещение в `secrets/` —
 * принципиально (PROP-107 §10): обычный бэкап без `--with-secrets` исключает
 * только каталог `secrets/`, поэтому токены в обычном JSON попали бы в архив
 * **всегда**.
 *
 * At-rest токены зашифрованы мастер-ключом (`enc:v1:…`, ADR-076) — тот же
 * примитив `encryptSecret`/`decryptSecret`, что у SSH-ключей и вебхуков.
 * Plaintext на диске не появляется никогда; наружу отдаются метаданные с
 * маской (`toExternalCredentialMeta`).
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  CreateExternalCredentialInput,
  ExternalCredential,
  ExternalCredentialFilter,
  ExternalCredentialMeta,
  UpdateExternalCredentialTokensInput,
} from '@itphx/synth-shared';
import { AsyncLock, atomicWrite, generateId, nowISO, safeJsonParse, toExternalCredentialMeta } from '@itphx/synth-shared';
import { CryptoError, decryptSecret, encryptSecret, isEncrypted, resolveMasterKey } from '../security/crypto.js';
import {
  ExternalCredentialStoreError,
  type ExternalCredentialRepository,
} from './ports/external-credential-repository.js';

/** Версия схемы файла доступов (для будущей миграции, ADR-096). */
export const EXTERNAL_CREDENTIALS_SCHEMA_VERSION = 1;

/** Подкаталог внутри `secrets/` — исключается обычным бэкапом (PROP-107 §10). */
export const EXTERNAL_CREDENTIALS_SUBDIR = 'secrets/oauth';

/** Имя файла с записями доступов. */
export const EXTERNAL_CREDENTIALS_FILENAME = 'credentials.json';

/** Префикс id записи доступа. */
export const EXTERNAL_CREDENTIAL_ID_PREFIX = 'extc_';

export interface ExternalCredentialStoreConfig {
  dataDir: string;
  /** Явный мастер-ключ (base64 32 Б / hex 64); пусто — env/файл. */
  secretKey?: string;
  env?: NodeJS.ProcessEnv;
}

interface ExternalCredentialsFile {
  schemaVersion: number;
  credentials: ExternalCredential[];
}

/**
 * Хранилище внешних доступов (PROP-107 Ф1).
 *
 * Публичные методы отдают **только метаданные**; расшифровка токенов —
 * исключительно `reveal()` (подстановка в транспорт, Ф2/Ф3).
 */
export class ExternalCredentialStore implements ExternalCredentialRepository {
  private readonly _lock = new AsyncLock();
  private _masterKeyPromise?: Promise<Buffer>;

  constructor(private readonly _config: ExternalCredentialStoreConfig) {}

  /** Путь к файлу записей доступов. */
  filePath(): string {
    return join(this._config.dataDir, EXTERNAL_CREDENTIALS_SUBDIR, EXTERNAL_CREDENTIALS_FILENAME);
  }

  private async _load(): Promise<ExternalCredentialsFile> {
    try {
      const raw = await readFile(this.filePath(), 'utf-8');
      const parsed = safeJsonParse<ExternalCredentialsFile | null>(raw, null);
      if (!parsed || !Array.isArray(parsed.credentials)) {
        return { schemaVersion: EXTERNAL_CREDENTIALS_SCHEMA_VERSION, credentials: [] };
      }
      return {
        schemaVersion: parsed.schemaVersion ?? EXTERNAL_CREDENTIALS_SCHEMA_VERSION,
        credentials: parsed.credentials.filter(isValidCredential),
      };
    } catch {
      return { schemaVersion: EXTERNAL_CREDENTIALS_SCHEMA_VERSION, credentials: [] };
    }
  }

  private async _save(file: ExternalCredentialsFile): Promise<void> {
    const path = this.filePath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700).catch(() => {});
    const data = JSON.stringify(
      { schemaVersion: EXTERNAL_CREDENTIALS_SCHEMA_VERSION, credentials: file.credentials },
      null,
      2,
    );
    await atomicWrite(
      (p, d) => writeFile(p, d, { encoding: 'utf-8', mode: 0o600 }),
      (o, n) => rename(o, n),
      path,
      data,
    );
    // Гарантия прав: `mode` при создании учитывает umask, поэтому права
    // выставляем явно (в т.ч. для уже существующего файла).
    await chmod(path, 0o600).catch(() => {});
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
          throw mapCryptoError(err);
        });
    }
    return this._masterKeyPromise;
  }

  async list(filter?: ExternalCredentialFilter): Promise<ExternalCredentialMeta[]> {
    const file = await this._load();
    return sortCredentials(file.credentials)
      .filter((credential) => matchesFilter(credential, filter))
      .map((credential) => toExternalCredentialMeta(credential));
  }

  async get(id: string): Promise<ExternalCredentialMeta | null> {
    const file = await this._load();
    const credential = file.credentials.find((c) => c.id === id);
    return credential ? toExternalCredentialMeta(credential) : null;
  }

  async create(input: CreateExternalCredentialInput): Promise<ExternalCredentialMeta> {
    if (!input.accessToken || input.accessToken.trim() === '') {
      throw new ExternalCredentialStoreError('invalid', 'access-токен обязателен');
    }
    if (!input.provider || input.provider.trim() === '') {
      throw new ExternalCredentialStoreError('invalid', 'provider обязателен');
    }
    if (!input.clientId || input.clientId.trim() === '') {
      throw new ExternalCredentialStoreError('invalid', 'clientId обязателен');
    }
    const key = await this._masterKey();
    const id = input.id?.trim() || `${EXTERNAL_CREDENTIAL_ID_PREFIX}${generateId()}`;

    await this._lock.acquire();
    try {
      const file = await this._load();
      if (file.credentials.some((c) => c.id === id)) {
        throw new ExternalCredentialStoreError('duplicate_id', `Доступ с id ${id} уже существует`);
      }
      const credential: ExternalCredential = {
        id,
        provider: input.provider.trim(),
        ...(input.connectorId !== undefined ? { connectorId: input.connectorId } : {}),
        clientId: input.clientId.trim(),
        scopes: [...(input.scopes ?? [])],
        owner: { ...input.owner },
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        secretEnc: encryptSecret(input.accessToken, key),
        ...(input.refreshToken !== undefined && input.refreshToken !== ''
          ? { refreshEnc: encryptSecret(input.refreshToken, key) }
          : {}),
        status: 'active',
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        createdBy: input.createdBy,
        createdAt: nowISO(),
        ...(input.scopesGranted !== undefined
          ? { scopesGranted: [...input.scopesGranted] }
          : {}),
      };
      file.credentials.push(credential);
      await this._save(file);
      return toExternalCredentialMeta(credential);
    } finally {
      this._lock.release();
    }
  }

  async updateTokens(
    id: string,
    patch: UpdateExternalCredentialTokensInput,
  ): Promise<ExternalCredentialMeta | null> {
    const key = await this._masterKey();

    await this._lock.acquire();
    try {
      const file = await this._load();
      const credential = file.credentials.find((c) => c.id === id);
      if (!credential) return null;

      if (patch.accessToken !== undefined) {
        if (patch.accessToken.trim() === '') {
          throw new ExternalCredentialStoreError('invalid', 'access-токен не может быть пустым');
        }
        credential.secretEnc = encryptSecret(patch.accessToken, key);
      }
      if (patch.refreshToken !== undefined && patch.refreshToken !== '') {
        credential.refreshEnc = encryptSecret(patch.refreshToken, key);
      }
      if (patch.expiresAt !== undefined) credential.expiresAt = patch.expiresAt;
      if (patch.scopesGranted !== undefined) credential.scopesGranted = [...patch.scopesGranted];
      // Отозванный доступ не «оживает»: обновление токенов его не resurrect'ит.
      if (credential.status !== 'revoked') {
        credential.status =
          patch.status ?? (patch.accessToken !== undefined ? 'active' : credential.status);
      }

      await this._save(file);
      return toExternalCredentialMeta(credential);
    } finally {
      this._lock.release();
    }
  }

  async markError(id: string): Promise<ExternalCredentialMeta | null> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const credential = file.credentials.find((c) => c.id === id);
      if (!credential) return null;
      if (credential.status !== 'revoked') credential.status = 'error';
      await this._save(file);
      return toExternalCredentialMeta(credential);
    } finally {
      this._lock.release();
    }
  }

  async revoke(id: string): Promise<ExternalCredentialMeta | null> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const credential = file.credentials.find((c) => c.id === id);
      if (!credential) return null;
      // Идемпотентно: время отзыва фиксируется один раз.
      credential.status = 'revoked';
      credential.revokedAt = credential.revokedAt ?? nowISO();
      await this._save(file);
      return toExternalCredentialMeta(credential);
    } finally {
      this._lock.release();
    }
  }

  async touch(id: string): Promise<void> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const credential = file.credentials.find((c) => c.id === id);
      if (!credential) return;
      credential.lastUsedAt = nowISO();
      await this._save(file);
    } finally {
      this._lock.release();
    }
  }

  async reveal(id: string): Promise<{ accessToken: string; refreshToken?: string } | null> {
    const key = await this._masterKey();
    const file = await this._load();
    const credential = file.credentials.find((c) => c.id === id);
    if (!credential) return null;
    try {
      const accessToken = isEncrypted(credential.secretEnc)
        ? decryptSecret(credential.secretEnc, key)
        : credential.secretEnc;
      const refreshToken =
        credential.refreshEnc === undefined
          ? undefined
          : isEncrypted(credential.refreshEnc)
            ? decryptSecret(credential.refreshEnc, key)
            : credential.refreshEnc;
      return refreshToken === undefined ? { accessToken } : { accessToken, refreshToken };
    } catch (err) {
      throw mapCryptoError(err);
    }
  }

  async listRaw(): Promise<ExternalCredential[]> {
    const file = await this._load();
    return sortCredentials(file.credentials).map((credential) => ({ ...credential }));
  }
}

/** Запись считается валидной, если это запись доступа с обязательными полями. */
function isValidCredential(value: unknown): value is ExternalCredential {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ExternalCredential>;
  return (
    typeof record.id === 'string' &&
    record.id !== '' &&
    typeof record.provider === 'string' &&
    typeof record.clientId === 'string' &&
    typeof record.secretEnc === 'string' &&
    typeof record.status === 'string'
  );
}

/** Детерминированный порядок — по времени создания, тай-брейк по id. */
export function sortCredentials(credentials: ExternalCredential[]): ExternalCredential[] {
  return [...credentials].sort((a, b) => {
    if (a.createdAt === b.createdAt) return a.id.localeCompare(b.id);
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** Отбор по фильтру (владелец/коннектор/провайдер/проект/статус). */
export function matchesFilter(
  credential: ExternalCredential,
  filter?: ExternalCredentialFilter,
): boolean {
  if (!filter) return true;
  if (filter.owner) {
    if (credential.owner.kind !== filter.owner.kind || credential.owner.id !== filter.owner.id) {
      return false;
    }
  }
  if (filter.connectorId !== undefined && credential.connectorId !== filter.connectorId) {
    return false;
  }
  if (filter.provider !== undefined && credential.provider !== filter.provider) {
    return false;
  }
  if (filter.projectId !== undefined && credential.projectId !== filter.projectId) {
    return false;
  }
  if (filter.status !== undefined && credential.status !== filter.status) return false;
  return true;
}

/** Ошибка криптослоя → типизированная ошибка хранилища (без утечки секрета). */
function mapCryptoError(err: unknown): ExternalCredentialStoreError {
  if (err instanceof ExternalCredentialStoreError) return err;
  if (err instanceof CryptoError) {
    return new ExternalCredentialStoreError(
      err.code === 'encryption_unavailable' ? 'encryption_unavailable' : 'decrypt_failed',
      err.message,
    );
  }
  return new ExternalCredentialStoreError('decrypt_failed', 'Не удалось расшифровать секрет');
}
