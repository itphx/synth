/**
 * ADR-099: пароли Basic-аутентификации прокси — только файл или env.
 *
 * Значение **никогда** не отдаётся через API и не пишется в аудит/логи:
 * наружу — лишь `ProxyPasswordStatus` (`source`/`set`/`removable`).
 *
 * Пути (ADR-099, профили):
 * - `default` (legacy) — `{dataDir}/secrets/proxy-password`;
 * - остальные — `{dataDir}/secrets/proxy/<name>.password`.
 *
 * Права `0600`, каталоги — `0700`; запись атомарная (tmp → rename), как
 * `FileStore` (ADR-005). Приоритет при чтении — env профиля
 * (`SYNTH_PROXY_PASSWORD` для `default`, `SYNTH_PROXY_<NAME>_PASSWORD` для
 * остальных), затем файл.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  PROXY_PASSWORD_ENV,
  proxyProfilePasswordEnv,
  proxyProfilePasswordPath,
  type ProxyPasswordStatus,
} from '@itphx/synth-shared';

/** Ошибка файла пароля прокси (код для API/логов). */
export class ProxyPasswordFileError extends Error {
  readonly code = 'EGRESS_PROXY_PASSWORD_FILE_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'ProxyPasswordFileError';
  }
}

/** Каталог секретов инстанса (`0700`). */
export function proxySecretsDir(dataDir: string): string {
  return join(dataDir, 'secrets');
}

/** Путь к файлу пароля legacy-default (`{dataDir}/secrets/proxy-password`). */
export function proxyPasswordPath(dataDir: string): string {
  return join(proxySecretsDir(dataDir), 'proxy-password');
}

/** Непустое env-значение (пустая строка — «не задано», как у резолвера). */
function envPassword(env: NodeJS.ProcessEnv, key = PROXY_PASSWORD_ENV): string | undefined {
  const value = env[key];
  return value !== undefined && value !== '' ? value : undefined;
}

/** Источник пароля и возможность удаления через API (без значения). */
export async function getProxyProfilePasswordStatus(
  env: NodeJS.ProcessEnv,
  dataDir: string | undefined,
  name: string,
): Promise<ProxyPasswordStatus> {
  if (envPassword(env, proxyProfilePasswordEnv(name)) !== undefined) {
    return { source: 'env', set: true, removable: false };
  }
  if (!dataDir) return { source: 'none', set: false, removable: false };
  try {
    const raw = await readFile(proxyProfilePasswordPath(dataDir, name), 'utf-8');
    if (raw.trim() !== '') return { source: 'file', set: true, removable: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ProxyPasswordFileError(`proxy: не удалось прочитать пароль: ${reason}`);
    }
  }
  return { source: 'none', set: false, removable: false };
}

/** Источник пароля legacy-default (`SYNTH_PROXY_PASSWORD` / `secrets/proxy-password`). */
export async function getProxyPasswordStatus(
  env: NodeJS.ProcessEnv,
  dataDir: string | undefined,
): Promise<ProxyPasswordStatus> {
  return getProxyProfilePasswordStatus(env, dataDir, 'default');
}

/**
 * Записать пароль профиля в файл (атомарно, `0600`; каталог `0700`).
 * Значение не логируется и не возвращается вызывающему.
 */
export async function writeProxyProfilePasswordFile(
  dataDir: string,
  name: string,
  password: string,
): Promise<void> {
  const value = password.trim();
  if (!value) throw new ProxyPasswordFileError('proxy: пароль не может быть пустым');
  const path = proxyProfilePasswordPath(dataDir, name);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Каталог мог существовать с более широкими правами — сужаем (best-effort).
  await chmod(dir, 0o700).catch(() => {});
  const tmp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, `${value}\n`, { encoding: 'utf-8', mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => {});
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    const reason = err instanceof Error ? err.message : String(err);
    throw new ProxyPasswordFileError(`proxy: не удалось записать пароль: ${reason}`);
  }
}

/** Записать пароль legacy-default (`{dataDir}/secrets/proxy-password`). */
export async function writeProxyPasswordFile(dataDir: string, password: string): Promise<void> {
  return writeProxyProfilePasswordFile(dataDir, 'default', password);
}

/** Удалить файл пароля профиля (идемпотентно). Возвращает `true`, если файл был. */
export async function removeProxyProfilePasswordFile(
  dataDir: string,
  name: string,
): Promise<boolean> {
  const path = proxyProfilePasswordPath(dataDir, name);
  try {
    await rm(path, { force: false });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    const reason = err instanceof Error ? err.message : String(err);
    throw new ProxyPasswordFileError(`proxy: не удалось удалить пароль: ${reason}`);
  }
}

/** Удалить файл пароля legacy-default (идемпотентно). */
export async function removeProxyPasswordFile(dataDir: string): Promise<boolean> {
  return removeProxyProfilePasswordFile(dataDir, 'default');
}
