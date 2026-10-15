import type { SSHKey, SSHKeyCreateRequest, SSHKeyMeta, SSHKeyUpdateRequest } from '@itphx/synth-shared';
import type { RotateMasterKeyOptions, RotateMasterKeyResult } from '../ssh-key-store.js';

/**
 * Порт хранилища SSH-ключей агентов (ADR-076 §T2, реализация — `SSHKeyStore`).
 *
 * Инвариант: публичные методы не отдают секреты — расшифровка только через
 * `reveal()` (подстановка в git). Секреты зашифрованы at-rest AES-256-GCM.
 */
export interface SSHKeyRepository {
  list(): Promise<SSHKeyMeta[]>;
  /**
   * Сырые записи, ВКЛЮЧАЯ зашифрованные секреты — только для админских операций
   * хранилища (ротация мастер-ключа), не для HTTP/обычных путей чтения.
   */
  listRaw(): Promise<SSHKey[]>;
  /** Ротация мастер-ключа (one-shot); preflight + dry-run. */
  rotateMasterKey(
    oldKey: Buffer,
    newKey: Buffer,
    opts?: RotateMasterKeyOptions,
  ): Promise<RotateMasterKeyResult>;
  listForAgent(agentId: string): Promise<SSHKeyMeta[]>;
  get(id: string): Promise<SSHKeyMeta | null>;
  create(input: SSHKeyCreateRequest): Promise<SSHKeyMeta>;
  update(id: string, patch: SSHKeyUpdateRequest): Promise<SSHKeyMeta | null>;
  delete(id: string): Promise<boolean>;
  linkAgent(id: string, agentId: string): Promise<SSHKeyMeta | null>;
  unlinkAgent(id: string, agentId: string): Promise<SSHKeyMeta | null>;
  /** Расшифрованные секреты — ТОЛЬКО для подстановки в git. */
  reveal(id: string): Promise<{ privateKey: string; passphrase?: string } | null>;
}
