/**
 * ADR-094: разрешение bearer-токена `/metrics`.
 *
 * Источники (инвариант 13 — секреты не в config.yaml):
 * 1) env `SYNTH_METRICS_TOKEN` (trim, пустое — «не задано»);
 * 2) файл `{dataDir}/secrets/metrics-token` (trim).
 *
 * Файл **не создаётся** автоматически, содержимое **не логируется**.
 * Токен из файла читается на каждый запрос `/metrics` — правка из UI
 * (PUT/DELETE `/api/v2/settings/metrics/token`) применяется без рестарта.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Минимальная длина токена `/metrics` (после trim). */
export const MIN_METRICS_TOKEN_LENGTH = 16;

/** Источник действующего токена. */
export type MetricsTokenSource = 'env' | 'file' | 'none';

/** Статус токена без раскрытия значения. */
export interface MetricsTokenStatus {
  configured: boolean;
  source: MetricsTokenSource;
}

/** Путь к файлу токена: `{dataDir}/secrets/metrics-token`. */
export function metricsTokenPath(dataDir: string): string {
  return join(dataDir, 'secrets', 'metrics-token');
}

/** Непустое env-значение (пустая строка/пробелы — «не задано»). */
function envToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.SYNTH_METRICS_TOKEN?.trim();
  return fromEnv || undefined;
}

/**
 * Прочитать токен из файла (trim). `undefined` — файла нет/пустой.
 * Ошибки чтения (кроме отсутствия) не пробрасываются: `/metrics` в этом случае
 * работает как без токена (fail-open по доступности, но не раскрывает секрет).
 */
function fileToken(dataDir: string): string | undefined {
  try {
    const fromFile = readFileSync(metricsTokenPath(dataDir), 'utf-8').trim();
    return fromFile || undefined;
  } catch {
    return undefined;
  }
}

/** Токен `/metrics` или `undefined`, если не задан ни в env, ни в файле. */
export function resolveMetricsToken(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envToken(env) ?? fileToken(dataDir);
}

/** Источник и наличие токена (значение не возвращается). */
export function getMetricsTokenStatus(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): MetricsTokenStatus {
  if (envToken(env) !== undefined) return { configured: true, source: 'env' };
  if (fileToken(dataDir) !== undefined) return { configured: true, source: 'file' };
  return { configured: false, source: 'none' };
}

/**
 * Записать токен в `{dataDir}/secrets/metrics-token` (атомарно, `0600`;
 * каталог `0700`). Значение не логируется и не возвращается вызывающему.
 */
export async function writeMetricsToken(dataDir: string, token: string): Promise<void> {
  const value = token.trim();
  if (value.length < MIN_METRICS_TOKEN_LENGTH) {
    throw new Error(`metrics: токен должен быть не короче ${MIN_METRICS_TOKEN_LENGTH} символов`);
  }
  const path = metricsTokenPath(dataDir);
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
    throw err;
  }
}

/** Удалить файл токена (идемпотентно). Возвращает `true`, если файл был. */
export async function removeMetricsToken(dataDir: string): Promise<boolean> {
  try {
    await rm(metricsTokenPath(dataDir), { force: false });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
