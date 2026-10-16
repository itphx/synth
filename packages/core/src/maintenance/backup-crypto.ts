// ADR-091 (остаток): шифрование архива бэкапа внешним ключом оператора.
//
// Формат контейнера `<archive>.tar.gz.enc`:
//   magic (ASCII `SYNTHBK1`, 8 Б) + version (1 Б) + iv (12 Б) + шифротекст… + authTag (16 Б).
// Шифрование — потоковое AES-256-GCM (`createCipheriv`) без удержания архива в
// памяти. Используется ВНЕШНИЙ ключ оператора, а не мастер-ключ инстанса: архив
// может содержать `secrets/` (в т.ч. `master.key`), поэтому ключ шифрования
// обязан храниться отдельно от архива и от инстанса.
//
// Ключ никогда не логируется и не попадает в аудит/вывод: сообщения ошибок не
// включают значение ключа (только путь к файлу ключа, если он задан).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { finished, pipeline } from 'node:stream/promises';

/** Магические байты заголовка контейнера (ASCII `SYNTHBK1`). */
export const BACKUP_ENC_MAGIC = Buffer.from('SYNTHBK1', 'ascii');
/** Версия формата контейнера. */
export const BACKUP_ENC_VERSION = 1;
/** Длина IV (AES-GCM nonce), байт. */
export const BACKUP_ENC_IV_LENGTH = 12;
/** Длина тега аутентификации (AES-GCM), байт. */
export const BACKUP_ENC_TAG_LENGTH = 16;
/** Расширение зашифрованного архива. */
export const BACKUP_ENC_SUFFIX = '.enc';
/** Полное расширение зашифрованного архива бэкапа. */
export const BACKUP_ENC_ARCHIVE_SUFFIX = '.tar.gz.enc';

/** Длина внешнего ключа шифрования, байт. */
const BACKUP_KEY_LENGTH = 32;
/** Длина заголовка контейнера (`magic` + `version` + `iv`). */
const HEADER_LENGTH = BACKUP_ENC_MAGIC.length + 1 + BACKUP_ENC_IV_LENGTH;

/** Типизированная ошибка шифрования/расшифровки архива бэкапа (ADR-091). */
export class BackupEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupEncryptionError';
  }
}

/** Опции резолва внешнего ключа шифрования архива (ADR-091). */
export interface ResolveBackupKeyOptions {
  /** Явный путь к файлу с ключом (флаг CLI `--key-file`). */
  keyFile?: string;
  /** Окружение процесса (по умолчанию — `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Декодирует внешний ключ шифрования: 32 байта в base64 либо 64 hex-символа
 * (автоопределение). Иная длина/формат → `BackupEncryptionError` без эха значения.
 */
export function decodeBackupKey(raw: string): Buffer {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(normalized, 'base64');
    if (buf.length === BACKUP_KEY_LENGTH) return buf;
  }
  throw new BackupEncryptionError(
    'Ключ шифрования бэкапа должен быть 32 байта в base64 или 64 hex-символа',
  );
}

/**
 * Резолвит внешний ключ шифрования архива (ADR-091).
 *
 * Порядок: флаг `--key-file` → env `SYNTH_BACKUP_KEY_FILE` → env `SYNTH_BACKUP_KEY`.
 * Файл читается как текст (ключ — base64/hex). Значение ключа никогда не
 * попадает в сообщение об ошибке.
 *
 * @throws BackupEncryptionError если ключ не задан, файл недоступен или ключ неверного формата.
 */
export async function resolveBackupKey(opts: ResolveBackupKeyOptions = {}): Promise<Buffer> {
  const env = opts.env ?? process.env;
  const keyFile = opts.keyFile?.trim() || env.SYNTH_BACKUP_KEY_FILE?.trim();
  if (keyFile) {
    let raw: string;
    try {
      raw = await readFile(keyFile, 'utf-8');
    } catch {
      throw new BackupEncryptionError(`Не удалось прочитать файл ключа шифрования: ${keyFile}`);
    }
    return decodeBackupKey(raw);
  }

  const inline = env.SYNTH_BACKUP_KEY?.trim();
  if (inline) return decodeBackupKey(inline);

  throw new BackupEncryptionError(
    'Не задан ключ шифрования бэкапа (--key-file, SYNTH_BACKUP_KEY_FILE или SYNTH_BACKUP_KEY)',
  );
}

/** Является ли путь зашифрованным архивом бэкапа (`*.tar.gz.enc`). */
export function isEncryptedArchivePath(path: string): boolean {
  return path.endsWith(BACKUP_ENC_ARCHIVE_SUFFIX);
}

/** Путь зашифрованного архива для исходного tar.gz (`<archive>.tar.gz` → `<archive>.tar.gz.enc`). */
export function encryptedArchivePath(archivePath: string): string {
  return `${archivePath}${BACKUP_ENC_SUFFIX}`;
}

/** Путь sidecar-метаданных зашифрованного архива (`<archive>.tar.gz.enc.meta.json`). */
export function encryptedMetaPath(encryptedPath: string): string {
  return `${encryptedPath}.meta.json`;
}

/**
 * Sidecar-метаданные зашифрованного архива (ADR-091): плейнтекст рядом с `.enc`,
 * без путей файлов и хешей — только сводка для `listBackups` (расшифровать
 * архив без ключа нельзя, поэтому манифест изнутри недоступен).
 */
export interface BackupEncryptedMeta {
  tool: 'synth-backup';
  formatVersion: number;
  schemaVersion: number;
  instanceVersion: string;
  createdAt: string;
  withSecrets: boolean;
  withWorkspace: boolean;
  /** PROP-032: физический backend хранения на момент снятия (см. `BackupManifest`). */
  storageBackend?: string;
  /** Число записей манифеста (без путей/хешей). */
  entries: number;
  encrypted: true;
}

/** Собирает sidecar-метаданные из манифеста бэкапа. */
export function buildEncryptedMeta(manifest: {
  formatVersion: number;
  schemaVersion: number;
  instanceVersion: string;
  createdAt: string;
  withSecrets: boolean;
  withWorkspace: boolean;
  storageBackend?: string;
  entries: unknown[];
}): BackupEncryptedMeta {
  return {
    tool: 'synth-backup',
    formatVersion: manifest.formatVersion,
    schemaVersion: manifest.schemaVersion,
    instanceVersion: manifest.instanceVersion,
    createdAt: manifest.createdAt,
    withSecrets: manifest.withSecrets === true,
    withWorkspace: manifest.withWorkspace === true,
    ...(manifest.storageBackend ? { storageBackend: manifest.storageBackend } : {}),
    entries: Array.isArray(manifest.entries) ? manifest.entries.length : 0,
    encrypted: true,
  };
}

/**
 * Читает sidecar-метаданные `.enc`. Нет файла / битый JSON / не наш tool → `null`
 * (не бросает: список архивов не должен рушиться из-за повреждённого sidecar).
 */
export async function readEncryptedMeta(encryptedPath: string): Promise<BackupEncryptedMeta | null> {
  let raw: string;
  try {
    raw = await readFile(encryptedMetaPath(encryptedPath), 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BackupEncryptedMeta>;
    if (!parsed || parsed.tool !== 'synth-backup' || parsed.encrypted !== true) return null;
    if (typeof parsed.createdAt !== 'string' || parsed.createdAt.length === 0) return null;
    return {
      tool: 'synth-backup',
      formatVersion: typeof parsed.formatVersion === 'number' ? parsed.formatVersion : 1,
      schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 0,
      instanceVersion: typeof parsed.instanceVersion === 'string' ? parsed.instanceVersion : '',
      createdAt: parsed.createdAt,
      withSecrets: parsed.withSecrets === true,
      withWorkspace: parsed.withWorkspace === true,
      ...(typeof parsed.storageBackend === 'string' && parsed.storageBackend
        ? { storageBackend: parsed.storageBackend }
        : {}),
      entries: typeof parsed.entries === 'number' ? parsed.entries : 0,
      encrypted: true,
    };
  } catch {
    return null;
  }
}

/** Проверяет длину ключа (32 байта). */
function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== BACKUP_KEY_LENGTH) {
    throw new BackupEncryptionError('Ключ шифрования бэкапа должен быть 32 байта');
  }
}

/** Заголовок контейнера: magic + version + iv. */
function _buildHeader(iv: Buffer): Buffer {
  return Buffer.concat([BACKUP_ENC_MAGIC, Buffer.from([BACKUP_ENC_VERSION]), iv]);
}

/** Разбирает заголовок контейнера; неверный magic/версия → ошибка. */
function _parseHeader(header: Buffer): { iv: Buffer } {
  if (header.length < HEADER_LENGTH) {
    throw new BackupEncryptionError('Неверный ключ или архив повреждён (короткий заголовок)');
  }
  if (!header.subarray(0, BACKUP_ENC_MAGIC.length).equals(BACKUP_ENC_MAGIC)) {
    throw new BackupEncryptionError(
      'Файл не является зашифрованным архивом Synth (неверный заголовок)',
    );
  }
  const version = header[BACKUP_ENC_MAGIC.length];
  if (version !== BACKUP_ENC_VERSION) {
    throw new BackupEncryptionError(
      `Неподдерживаемая версия формата зашифрованного архива: ${String(version)}`,
    );
  }
  return { iv: header.subarray(HEADER_LENGTH - BACKUP_ENC_IV_LENGTH, HEADER_LENGTH) };
}

/** Читает диапазон байт `[start, end]` (включительно) из файла. */
function _readRange(path: string, start: number, end: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, { start, end });
    stream.on('error', reject);
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Потоково шифрует файл `sourcePath` в `outPath` (AES-256-GCM, внешний ключ).
 * Заголовок (`magic`/версия/`iv`) — в начале, `authTag` — в конце. Права — `0600`.
 */
export async function encryptArchiveToFile(
  sourcePath: string,
  outPath: string,
  key: Buffer,
): Promise<void> {
  assertKey(key);
  const iv = randomBytes(BACKUP_ENC_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  await mkdir(dirname(outPath), { recursive: true });
  const out = createWriteStream(outPath, { mode: 0o600 });
  try {
    out.write(_buildHeader(iv));
    await pipeline(createReadStream(sourcePath), cipher, out, { end: false });
    out.end(cipher.getAuthTag());
    await finished(out);
    await chmod(outPath, 0o600);
  } catch (err) {
    out.destroy();
    throw err;
  }
}

/**
 * Потоково расшифровывает контейнер `sourcePath` в `outPath` (AES-256-GCM).
 * Проверяет `magic`/версию и верифицирует `authTag`: несовпадение (неверный ключ
 * или повреждённый шифротекст) → `BackupEncryptionError`. Права результата — `0600`.
 */
export async function decryptArchiveToFile(
  sourcePath: string,
  outPath: string,
  key: Buffer,
): Promise<void> {
  assertKey(key);
  const info = await stat(sourcePath);
  if (info.size < HEADER_LENGTH + BACKUP_ENC_TAG_LENGTH) {
    throw new BackupEncryptionError('Неверный ключ или архив повреждён (файл слишком короткий)');
  }

  const header = await _readRange(sourcePath, 0, HEADER_LENGTH - 1);
  const { iv } = _parseHeader(header);
  const authTag = await _readRange(
    sourcePath,
    info.size - BACKUP_ENC_TAG_LENGTH,
    info.size - 1,
  );

  const bodyStart = HEADER_LENGTH;
  const bodyEnd = info.size - BACKUP_ENC_TAG_LENGTH - 1; // включительно

  await mkdir(dirname(outPath), { recursive: true });
  const out = createWriteStream(outPath, { mode: 0o600 });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  try {
    if (bodyEnd >= bodyStart) {
      await pipeline(createReadStream(sourcePath, { start: bodyStart, end: bodyEnd }), decipher, out);
    } else {
      out.end();
      await finished(out);
      // Пустое тело: проверяем тег на нулевом шифротексте.
      decipher.final();
    }
    await chmod(outPath, 0o600);
  } catch {
    out.destroy();
    throw new BackupEncryptionError('Неверный ключ или архив повреждён');
  }
}
