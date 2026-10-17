/**
 * ADR-099: bootstrap-хранилище runtime-настроек доверия TLS (`security-tls.json`).
 *
 * Файл `{dataDir}/security-tls.json` (0600, каталог 0700, атомарная запись
 * tmp→rename) читается **до** подключения к PostgreSQL: настройки TLS нужны,
 * чтобы это подключение вообще стало возможным, поэтому они не могут жить в БД.
 *
 * В JSON — только пути к PEM-файлам (материалы лежат в `{dataDir}/secrets/tls/`,
 * 0600); единственное исключение — `caPem` (публичный сертификат, вставляется
 * текстом из UI). Приватные ключи и PEM-содержимое наружу не отдаются.
 */
import { X509Certificate, createPublicKey, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, chmod, rename, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { atomicWrite } from '../utils/index.js';
import { isPemContent, type TlsRuntimeSettings } from './tls.js';

/** Имя bootstrap-файла в `{dataDir}`. */
export const TLS_RUNTIME_FILENAME = 'security-tls.json';
/** Подкаталог загруженных PEM-материалов (`{dataDir}/secrets/tls`). */
export const TLS_SECRETS_SUBDIR = 'secrets/tls';

/** Имена файлов материалов, которыми управляет API (внешние пути не трогаем). */
export const TLS_MATERIAL_NAMES = {
  ca: 'ca.pem',
  clientCert: 'client.crt',
  clientKey: 'client.key',
} as const;

const CERT_MARKER = /-----BEGIN CERTIFICATE-----/;
const KEY_MARKER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Путь bootstrap-файла. */
export function tlsRuntimePath(dataDir: string): string {
  return join(dataDir, TLS_RUNTIME_FILENAME);
}

/** Каталог PEM-материалов. */
export function tlsSecretsDir(dataDir: string): string {
  return join(dataDir, TLS_SECRETS_SUBDIR);
}

/**
 * Путь материала по безопасному имени (`ca.pem`, `client.crt`, `<id>.key`).
 * Имя — только basename без `..`/разделителей (fail-closed).
 */
export function tlsSecretFilePath(dataDir: string, name: string): string {
  if (!SAFE_NAME_RE.test(name) || name.includes('..')) {
    throw new Error(`[tls] недопустимое имя файла материала: "${name}"`);
  }
  return join(tlsSecretsDir(dataDir), name);
}

/** Имя файла материала маппинга (`<mappingId>.crt` / `<mappingId>.key`). */
export function tlsMappingFileName(id: string, kind: 'cert' | 'key'): string {
  if (!SAFE_NAME_RE.test(id) || id.includes('..')) {
    throw new Error(`[tls] недопустимый id маппинга: "${id}"`);
  }
  return `${id}.${kind === 'cert' ? 'crt' : 'key'}`;
}

/**
 * Читает bootstrap-настройки TLS. Файла нет — `undefined` (поведение прежнее,
 * системное доверие). Невалидный JSON/материалы — fail-closed с понятной
 * ошибкой (никакого тихого фоллбэка на системное доверие).
 */
export function readTlsRuntimeSettings(dataDir: string): TlsRuntimeSettings | undefined {
  const path = tlsRuntimePath(dataDir);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`[config] security-tls.json: не удалось прочитать файл "${path}": ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`[config] security-tls.json: невалидный JSON (${reason})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[config] security-tls.json: ожидается JSON-объект');
  }

  const settings = parsed as TlsRuntimeSettings;
  validateTlsRuntimeSettings(settings);
  return settings;
}

/**
 * Сохраняет bootstrap-настройки (атомарно, 0600; каталог — 0700).
 * Материалы должны уже существовать (см. `writeTlsSecretFile`).
 */
export async function writeTlsRuntimeSettings(
  dataDir: string,
  settings: TlsRuntimeSettings,
): Promise<void> {
  validateTlsRuntimeSettings(settings);
  const path = tlsRuntimePath(dataDir);
  const payload = `${JSON.stringify(settings, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => {});
  await atomicWrite(
    (p, d) => writeFile(p, d, { encoding: 'utf-8', mode: 0o600 }),
    (o, n) => rename(o, n),
    path,
    payload,
  );
  await chmod(path, 0o600).catch(() => {});
}

/**
 * Записывает материал (CA/сертификат/ключ) в `{dataDir}/secrets/tls/<name>`
 * атомарно, режим 0600; каталог — 0700. Возвращает путь.
 */
export async function writeTlsSecretFile(
  dataDir: string,
  name: string,
  content: string,
): Promise<string> {
  const path = tlsSecretFilePath(dataDir, name);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  await atomicWrite(
    (p, d) => writeFile(p, d, { encoding: 'utf-8', mode: 0o600 }),
    (o, n) => rename(o, n),
    path,
    content,
  );
  await chmod(path, 0o600).catch(() => {});
  return path;
}

/** Читает материал из `secrets/tls` (для валидации/статуса). */
export function readTlsSecretFile(dataDir: string, name: string): string | undefined {
  const path = tlsSecretFilePath(dataDir, name);
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Валидирует runtime-настройки: уникальные id, корректные host-паттерны,
 * парность cert/key, читаемость и PEM-формат, соответствие сертификата ключу
 * (сравнение публичных ключей). Ошибки не содержат PEM-содержимого.
 */
export function validateTlsRuntimeSettings(settings: TlsRuntimeSettings): void {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('[config] security.tls: runtime-настройки должны быть объектом');
  }
  if (settings.caFile !== undefined && settings.caPem !== undefined) {
    throw new Error(
      "[config] security.tls: 'caFile' и 'caPem' взаимоисключащи (runtime-настройки)",
    );
  }
  if (settings.caPem !== undefined) {
    validatePemText(settings.caPem, 'runtime.caPem', CERT_MARKER, 'CERTIFICATE');
  }
  if (settings.caFile !== undefined) {
    validateCertificateFile(settings.caFile, 'runtime.caFile');
  }

  if (settings.defaultClient !== undefined) {
    validateClientPair(settings.defaultClient, 'runtime.defaultClient');
  }

  const mappings = settings.mappings ?? [];
  if (!Array.isArray(mappings)) {
    throw new Error('[config] security.tls: runtime.mappings должен быть массивом');
  }
  const ids = new Set<string>();
  for (const [index, mapping] of mappings.entries()) {
    const where = `runtime.mappings[${index}]`;
    if (!mapping || typeof mapping !== 'object') {
      throw new Error(`[config] security.tls: ${where} должен быть объектом`);
    }
    const id = typeof mapping.id === 'string' ? mapping.id.trim() : '';
    if (!id || !SAFE_NAME_RE.test(id) || id.includes('..')) {
      throw new Error(`[config] security.tls: ${where}.id пуст или содержит недопустимые символы`);
    }
    if (id === 'default') {
      throw new Error(`[config] security.tls: ${where}.id="default" зарезервирован`);
    }
    if (ids.has(id)) {
      throw new Error(`[config] security.tls: дубликат id маппинга "${id}"`);
    }
    ids.add(id);

    if (!Array.isArray(mapping.hosts) || mapping.hosts.length === 0) {
      throw new Error(`[config] security.tls: ${where}.hosts должен быть непустым массивом`);
    }
    for (const pattern of mapping.hosts) {
      if (!isValidHostPattern(pattern)) {
        throw new Error(`[config] security.tls: ${where}.hosts: недопустимый паттерн "${String(pattern)}"`);
      }
    }
    validateClientPair(mapping, where);
  }
}

/** `true` — корректный host-паттерн (`host`, `*.suffix`, `*`). */
export function isValidHostPattern(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return false;
  const value = pattern.trim().toLowerCase();
  if (value === '') return false;
  if (value === '*') return true;
  if (value.startsWith('*.')) {
    const suffix = value.slice(2);
    return suffix !== '' && !suffix.includes('*') && isValidHostname(suffix);
  }
  return !value.includes('*') && isValidHostname(value);
}

/** Грубая проверка hostname/IP (без схемы/порта/слэшей). */
function isValidHostname(value: string): boolean {
  if (value === '' || value.length > 253) return false;
  if (value.includes('/') || value.includes(':') || value.includes('@')) return false;
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value);
}

function validateClientPair(
  pair: { certFile?: string; keyFile?: string },
  where: string,
): void {
  const hasCert = typeof pair.certFile === 'string' && pair.certFile !== '';
  const hasKey = typeof pair.keyFile === 'string' && pair.keyFile !== '';
  if (hasCert !== hasKey) {
    throw new Error(
      `[config] security.tls: ${where}: mTLS требует и certFile, и keyFile (задайте оба либо ни одного)`,
    );
  }
  if (!hasCert || !hasKey) return;
  const cert = readFileOrThrow(pair.certFile!, `${where}.certFile`);
  const key = readFileOrThrow(pair.keyFile!, `${where}.keyFile`);
  validatePemText(cert, `${where}.certFile`, CERT_MARKER, 'CERTIFICATE');
  validatePemText(key, `${where}.keyFile`, KEY_MARKER, 'PRIVATE KEY');
  assertCertMatchesKey(cert, key, where);
}

function validateCertificateFile(path: string, where: string): void {
  const content = readFileOrThrow(path, where);
  validatePemText(content, where, CERT_MARKER, 'CERTIFICATE');
}

function readFileOrThrow(path: string, where: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`[config] security.tls: ${where}: не удалось прочитать файл "${path}": ${reason}`);
  }
}

function validatePemText(content: string, where: string, marker: RegExp, kind: string): void {
  if (!isPemContent(content) || !marker.test(content)) {
    throw new Error(`[config] security.tls: ${where} не содержит PEM (ожидается "-----BEGIN ${kind}-----")`);
  }
}

/** Сравнивает публичный ключ сертификата и приватного ключа (SPKI DER). */
export function assertCertMatchesKey(certPem: string, keyPem: string, where = 'client'): void {
  let certPublic: Buffer;
  let keyPublic: Buffer;
  try {
    certPublic = new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  } catch {
    throw new Error(`[config] security.tls: ${where}: не удалось разобрать сертификат (PEM/X509)`);
  }
  try {
    keyPublic = createPublicKey(createPrivateKey(keyPem))
      .export({ type: 'spki', format: 'der' }) as Buffer;
  } catch {
    throw new Error(
      `[config] security.tls: ${where}: не удалось разобрать приватный ключ ` +
        '(PEM/PKCS#8 либо зашифрованный ключ без пароля)',
    );
  }
  if (!certPublic.equals(keyPublic)) {
    throw new Error(`[config] security.tls: ${where}: сертификат и приватный ключ не соответствуют друг другу`);
  }
}

/**
 * Subject сертификата (для read-only статуса API) — без PEM-содержимого.
 * Невалидный PEM → `undefined` (статус не должен падать из-за отображения).
 */
export function certificateSubjectFromPem(pem: string | undefined): string | undefined {
  if (!pem) return undefined;
  try {
    return normalizeSubject(new X509Certificate(pem).subject);
  } catch {
    return undefined;
  }
}

/** Subject первого сертификата в файле (статус). */
export function certificateSubjectFromFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return certificateSubjectFromPem(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

/** Subject'ы всех сертификатов PEM-бандла (CA может содержать несколько). */
export function certificateSubjectsFromPem(pem: string | undefined): string[] {
  if (!pem) return [];
  const subjects: string[] = [];
  for (const block of extractPemBlocks(pem, 'CERTIFICATE')) {
    const subject = certificateSubjectFromPem(block);
    if (subject) subjects.push(subject);
  }
  return subjects;
}

/** Количество сертификатов в PEM-бандле. */
export function countCertificates(pem: string | undefined): number {
  if (!pem) return 0;
  return extractPemBlocks(pem, 'CERTIFICATE').length;
}

function extractPemBlocks(pem: string, kind: string): string[] {
  const re = new RegExp(`-----BEGIN ${kind}-----[\\s\\S]*?-----END ${kind}-----`, 'g');
  return pem.match(re) ?? [];
}

function normalizeSubject(subject: string): string {
  return subject
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(', ');
}

/** Имя файла материала маппинга без пути (для статуса). */
export function materialBasename(path: string): string {
  return basename(path);
}
