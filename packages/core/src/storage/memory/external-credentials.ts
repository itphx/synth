/**
 * PROP-107 (Ф1): in-memory реализация порта внешних доступов.
 *
 * Герметичная реализация без модулей ФС — для тестов и режима
 * `storage.backend: 'memory'`. Семантика повторяет файловую
 * (`ExternalCredentialStore`): те же поля записи, тот же маппер метаданных, тот
 * же порядок и те же правила статусов.
 *
 * Отличие от файловой реализации — только в источнике ключа: здесь он
 * **эфемерный** (случайный, на время жизни экземпляра), а не мастер-ключ
 * инстанса. Запись при этом хранится в той же форме (`secretEnc` = `enc:v1:…`),
 * поэтому поведение порта (маскирование, `reveal`, статусы) совпадает с
 * файловым backend'ом — контрактный suite один на оба.
 */
import { randomBytes } from 'node:crypto';
import type {
  CreateExternalCredentialInput,
  ExternalCredential,
  ExternalCredentialFilter,
  ExternalCredentialMeta,
  UpdateExternalCredentialTokensInput,
} from '@itphx/synth-shared';
import { generateId, nowISO, toExternalCredentialMeta } from '@itphx/synth-shared';
import { CryptoError, decryptSecret, encryptSecret, isEncrypted } from '../../security/crypto.js';
import {
  ExternalCredentialStoreError,
  type ExternalCredentialRepository,
} from '../ports/external-credential-repository.js';
import { EXTERNAL_CREDENTIAL_ID_PREFIX, matchesFilter, sortCredentials } from '../external-credential-store.js';

/** Порт внешних доступов поверх `Map` (семантика `ExternalCredentialStore`). */
export class MemoryExternalCredentialRepository implements ExternalCredentialRepository {
  /** Эфемерный ключ шифрования: секрет в памяти процесса, at-rest нет. */
  private readonly _key = randomBytes(32);
  private readonly _credentials = new Map<string, ExternalCredential>();

  async list(filter?: ExternalCredentialFilter): Promise<ExternalCredentialMeta[]> {
    return sortCredentials([...this._credentials.values()])
      .filter((credential) => matchesFilter(credential, filter))
      .map((credential) => toExternalCredentialMeta(credential));
  }

  async get(id: string): Promise<ExternalCredentialMeta | null> {
    const credential = this._credentials.get(id);
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
    const id = input.id?.trim() || `${EXTERNAL_CREDENTIAL_ID_PREFIX}${generateId()}`;
    if (this._credentials.has(id)) {
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
      secretEnc: encryptSecret(input.accessToken, this._key),
      ...(input.refreshToken !== undefined && input.refreshToken !== ''
        ? { refreshEnc: encryptSecret(input.refreshToken, this._key) }
        : {}),
      status: 'active',
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      createdBy: input.createdBy,
      createdAt: nowISO(),
      ...(input.scopesGranted !== undefined
        ? { scopesGranted: [...input.scopesGranted] }
        : {}),
    };
    this._credentials.set(id, credential);
    return toExternalCredentialMeta(credential);
  }

  async updateTokens(
    id: string,
    patch: UpdateExternalCredentialTokensInput,
  ): Promise<ExternalCredentialMeta | null> {
    const credential = this._credentials.get(id);
    if (!credential) return null;
    if (patch.accessToken !== undefined) {
      if (patch.accessToken.trim() === '') {
        throw new ExternalCredentialStoreError('invalid', 'access-токен не может быть пустым');
      }
      credential.secretEnc = encryptSecret(patch.accessToken, this._key);
    }
    if (patch.refreshToken !== undefined && patch.refreshToken !== '') {
      credential.refreshEnc = encryptSecret(patch.refreshToken, this._key);
    }
    if (patch.expiresAt !== undefined) credential.expiresAt = patch.expiresAt;
    if (patch.scopesGranted !== undefined) credential.scopesGranted = [...patch.scopesGranted];
    if (credential.status !== 'revoked') {
      credential.status =
        patch.status ?? (patch.accessToken !== undefined ? 'active' : credential.status);
    }
    return toExternalCredentialMeta(credential);
  }

  async markError(id: string): Promise<ExternalCredentialMeta | null> {
    const credential = this._credentials.get(id);
    if (!credential) return null;
    if (credential.status !== 'revoked') credential.status = 'error';
    return toExternalCredentialMeta(credential);
  }

  async revoke(id: string): Promise<ExternalCredentialMeta | null> {
    const credential = this._credentials.get(id);
    if (!credential) return null;
    credential.status = 'revoked';
    credential.revokedAt = credential.revokedAt ?? nowISO();
    return toExternalCredentialMeta(credential);
  }

  async touch(id: string): Promise<void> {
    const credential = this._credentials.get(id);
    if (!credential) return;
    credential.lastUsedAt = nowISO();
  }

  async reveal(id: string): Promise<{ accessToken: string; refreshToken?: string } | null> {
    const credential = this._credentials.get(id);
    if (!credential) return null;
    try {
      const accessToken = isEncrypted(credential.secretEnc)
        ? decryptSecret(credential.secretEnc, this._key)
        : credential.secretEnc;
      const refreshToken =
        credential.refreshEnc === undefined
          ? undefined
          : isEncrypted(credential.refreshEnc)
            ? decryptSecret(credential.refreshEnc, this._key)
            : credential.refreshEnc;
      return refreshToken === undefined ? { accessToken } : { accessToken, refreshToken };
    } catch (err) {
      if (err instanceof CryptoError) {
        throw new ExternalCredentialStoreError(
          err.code === 'encryption_unavailable' ? 'encryption_unavailable' : 'decrypt_failed',
          err.message,
        );
      }
      throw new ExternalCredentialStoreError('decrypt_failed', 'Не удалось расшифровать секрет');
    }
  }

  async listRaw(): Promise<ExternalCredential[]> {
    return sortCredentials([...this._credentials.values()]).map((credential) => ({ ...credential }));
  }
}
