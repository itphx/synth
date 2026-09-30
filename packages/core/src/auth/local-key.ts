import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '@itphx/synth-shared';

/**
 * Локальный API-ключ standalone-сервера.
 *
 * Режим «npm-пакет + запуск бинарника»: без явного `--api-key`/`SYNTH_API_KEY`
 * сервер иначе стартовал бы с пустым ключом и войти в UI было бы невозможно
 * (401). Ключ хранится рядом с остальными секретами `{dataDir}/secrets/api-key`
 * и переиспользуется между запусками.
 */

const SECRETS_DIRNAME = 'secrets';
const API_KEY_FILENAME = 'api-key';

/** Путь к файлу локального API-ключа (`{dataDir}/secrets/api-key`). */
export function localApiKeyFilePath(dataDir: string): string {
  return join(dataDir, SECRETS_DIRNAME, API_KEY_FILENAME);
}

/**
 * Читает сохранённый локальный API-ключ или создаёт новый.
 *
 * - файл существует и непустой (после `trim`) → возвращается он (`created: false`);
 * - иначе генерируется `randomBytes(16).toString('hex')` (32 hex-символа),
 *   каталог `{dataDir}/secrets` создаётся с правами `0700`, файл пишется `0600`
 *   атомарно (tmp→rename), возвращается `created: true`.
 */
export async function resolveOrCreateLocalApiKey(opts: {
  dataDir: string;
}): Promise<{ key: string; created: boolean; path: string }> {
  const path = localApiKeyFilePath(opts.dataDir);

  const existing = (await readFile(path, 'utf-8').catch(() => '')).trim();
  if (existing) {
    return { key: existing, created: false, path };
  }

  const key = randomBytes(16).toString('hex');
  const dir = join(opts.dataDir, SECRETS_DIRNAME);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  await atomicWrite(
    (p, d) => writeFile(p, d, { encoding: 'utf-8', mode: 0o600 }),
    (o, n) => rename(o, n),
    path,
    key,
  );
  await chmod(path, 0o600);
  return { key, created: true, path };
}
