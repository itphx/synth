import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '@itphx/synth-shared';

/**
 * AD-076 §T2: шифрование секретов at-rest (SSH-ключи) через AES-256-GCM.
 *
 * Формат токена: `enc:v1:<base64 iv(12 Б)>:<base64 authTag(16 Б)>:<base64 ciphertext>`.
 * Значение без префикса `enc:v1:` считается plaintext и возвращается как есть
 * (back-compat со старыми данными, как в прототипе t11).
 */

export const ENCRYPTED_PREFIX = 'enc:v1:';
export const IV_LENGTH = 12;
export const AUTH_TAG_LENGTH = 16;
export const MASTER_KEY_LENGTH = 32;

const SECRETS_DIRNAME = 'secrets';
const MASTER_KEY_FILENAME = 'master.key';

export type CryptoErrorCode = 'encryption_unavailable' | 'decrypt_failed';

/** Типизированная ошибка криптослоя (без утечки plaintext в сообщении). */
export class CryptoError extends Error {
  constructor(
    readonly code: CryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CryptoError';
  }
}

/** Ошибка расшифровки: tamper, неверный ключ или битый формат токена. */
export class SecretDecryptionError extends CryptoError {
  constructor(message = 'Не удалось расшифровать секрет') {
    super('decrypt_failed', message);
    this.name = 'SecretDecryptionError';
  }
}

/** Является ли значение зашифрованным токеном текущего формата. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

/** Шифрует plaintext мастер-ключом; при неверной длине ключа — типизированная ошибка. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  assertMasterKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Расшифровывает токен. Plaintext (без `enc:v1:`) возвращается без изменений.
 * При tamper/неверном ключе бросает `SecretDecryptionError` без утечки plaintext.
 */
export function decryptSecret(token: string, key: Buffer): string {
  if (!isEncrypted(token)) return token;
  assertMasterKey(key);

  const parts = token.slice(ENCRYPTED_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new SecretDecryptionError('Некорректный формат зашифрованного значения');
  }
  const ivB64 = parts[0] ?? '';
  const authTagB64 = parts[1] ?? '';
  const ciphertextB64 = parts[2] ?? '';
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new SecretDecryptionError('Некорректный формат зашифрованного значения');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  } catch (err) {
    if (err instanceof SecretDecryptionError) throw err;
    throw new SecretDecryptionError();
  }
}

export interface ResolveMasterKeyOptions {
  dataDir: string;
  /** Явный мастер-ключ (из конфига/CLI); приоритетнее env. */
  secretKey?: string;
  env?: NodeJS.ProcessEnv;
}

export interface MasterKeyResult {
  key: Buffer;
  source: 'env' | 'file';
}

/**
 * Кэш на процесс: ключ по `dataDir` + исходному материалу ключа. Храним промис,
 * чтобы параллельные вызовы не генерировали конкурирующие мастер-ключи.
 */
const masterKeyCache = new Map<string, Promise<MasterKeyResult>>();

/** Сброс кэша мастер-ключа (тесты/переинициализация). */
export function clearMasterKeyCache(): void {
  masterKeyCache.clear();
}

/**
 * Резолвит мастер-ключ шифрования секретов.
 *
 * Приоритет: непустой `secretKey` → env `SYNTH_SECRET_KEY` → файл
 * `{dataDir}/secrets/master.key` (создаётся при отсутствии: `randomBytes(32)`,
 * каталог `0700`, файл `0600`, атомарная запись tmp→rename).
 * Материал ключа — base64 (ровно 32 байта) либо hex (64 символа); иначе
 * `encryption_unavailable` (молчаливое «обрезание» недопустимо).
 */
export function resolveMasterKey(opts: ResolveMasterKeyOptions): Promise<MasterKeyResult> {
  const material = opts.secretKey?.trim() || opts.env?.SYNTH_SECRET_KEY?.trim() || '';
  const cacheId = `${opts.dataDir}\u0000${material}`;
  const cached = masterKeyCache.get(cacheId);
  if (cached) return cached;

  const pending = resolveMasterKeyUncached(opts, material).catch((err: unknown) => {
    masterKeyCache.delete(cacheId);
    throw err;
  });
  masterKeyCache.set(cacheId, pending);
  return pending;
}

async function resolveMasterKeyUncached(
  opts: ResolveMasterKeyOptions,
  material: string,
): Promise<MasterKeyResult> {
  if (material) {
    return { key: decodeMasterKey(material), source: 'env' };
  }

  const dir = join(opts.dataDir, SECRETS_DIRNAME);
  const filePath = join(dir, MASTER_KEY_FILENAME);
  const existing = await readFile(filePath, 'utf-8').catch(() => null);

  let key: Buffer;
  if (existing && existing.trim()) {
    key = decodeMasterKey(existing);
  } else {
    key = randomBytes(MASTER_KEY_LENGTH);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    await atomicWrite(
      (p, d) => writeFile(p, d, { encoding: 'utf-8', mode: 0o600 }),
      (o, n) => rename(o, n),
      filePath,
      key.toString('base64'),
    );
    await chmod(filePath, 0o600);
  }

  return { key, source: 'file' };
}

function assertMasterKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== MASTER_KEY_LENGTH) {
    throw new CryptoError('encryption_unavailable', 'Мастер-ключ должен быть 32 байта');
  }
}

function decodeMasterKey(raw: string): Buffer {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(normalized, 'base64');
    if (buf.length === MASTER_KEY_LENGTH) return buf;
  }
  throw new CryptoError(
    'encryption_unavailable',
    'Мастер-ключ должен быть 32 байта в base64 или 64 hex-символа',
  );
}
