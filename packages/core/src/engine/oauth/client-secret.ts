/**
 * ADR-105 (Ф2): `client_secret` — только env или файл (инвариант 13).
 *
 * Секрет клиента **не** хранится в `config.yaml`, не пишется в реестр и не
 * логируется. Источники (в порядке приоритета):
 *
 * 1. env `SYNTH_OAUTH_<PROVIDER>_CLIENT_SECRET` (например, `provider=google`
 *    → `SYNTH_OAUTH_GOOGLE_CLIENT_SECRET`);
 * 2. файл `{dataDir}/secrets/oauth/<provider>.client_secret` (права `0600`,
 *    каталог `secrets/` — `0700`; файл кладёт оператор, ядро его только читает).
 *
 * Образец — пароли прокси (`security/proxy-password.ts`) и пароль PostgreSQL.
 * Значение возвращается только вызывающему коду, который подставляет его в
 * запрос к провайдеру; наружу (API/UI/логи) оно не попадает.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Префикс env-переменной с секретом клиента. */
export const OAUTH_CLIENT_SECRET_ENV_PREFIX = 'SYNTH_OAUTH_';

/** Суффикс env-переменной с секретом клиента. */
export const OAUTH_CLIENT_SECRET_ENV_SUFFIX = '_CLIENT_SECRET';

/** Имя файла с секретом клиента (в каталоге `secrets/oauth/`). */
export const OAUTH_CLIENT_SECRET_FILENAME_SUFFIX = '.client_secret';

/** Нормализация ключа провайдера для env-имени: `A-Z0-9_`. */
function providerEnvKey(provider: string): string {
  return provider
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Нормализация ключа провайдера для имени файла: `a-z0-9._-` (без `/`). */
function providerFileKey(provider: string): string {
  const key = provider
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return key || 'provider';
}

/** Имя env-переменной с секретом клиента провайдера. */
export function oauthClientSecretEnv(provider: string): string {
  return `${OAUTH_CLIENT_SECRET_ENV_PREFIX}${providerEnvKey(provider)}${OAUTH_CLIENT_SECRET_ENV_SUFFIX}`;
}

/** Путь к файлу с секретом клиента провайдера. */
export function oauthClientSecretPath(dataDir: string, provider: string): string {
  return join(dataDir, 'secrets', 'oauth', `${providerFileKey(provider)}${OAUTH_CLIENT_SECRET_FILENAME_SUFFIX}`);
}

/** Параметры резолвера секрета клиента. */
export interface ResolveClientSecretOptions {
  provider: string;
  /** Каталог данных инстанса (для файлового источника). */
  dataDir?: string;
  /** Окружение (по умолчанию — `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Секрет клиента: env → файл → `undefined` (секрета нет).
 *
 * Пустое значение env/файла считается «секрета нет» (как у резолвера пароля
 * прокси) — иначе провайдер получил бы пустой `client_secret`.
 */
export async function resolveOAuthClientSecret(
  options: ResolveClientSecretOptions,
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const fromEnv = env[oauthClientSecretEnv(options.provider)];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  if (!options.dataDir) return undefined;
  try {
    const raw = await readFile(oauthClientSecretPath(options.dataDir, options.provider), 'utf-8');
    const value = raw.trim();
    return value === '' ? undefined : value;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
