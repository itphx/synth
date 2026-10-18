/**
 * ADR-099: PEM-материалы TLS/mTLS **к самому прокси** (профили).
 *
 * Файлы профиля лежат в `{dataDir}/secrets/proxy/<name>/`
 * (`ca.pem`, `client.crt`, `client.key`), права `0600`, каталоги `0700`,
 * запись атомарная (tmp → rename, ADR-005). Содержимое наружу не отдаётся:
 * в конфиг пишутся только пути (`proxy.profiles.<name>.tls.*File`).
 *
 * Имя профиля валидируется (fail-closed) — путь не может выйти за каталог
 * секретов даже при ошибочном вызове.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Имена файлов материалов TLS к прокси внутри каталога профиля. */
export const PROXY_PROFILE_TLS_MATERIALS = {
  ca: 'ca.pem',
  clientCert: 'client.crt',
  clientKey: 'client.key',
} as const;

/** Вид материала TLS профиля. */
export type ProxyProfileTlsMaterial = keyof typeof PROXY_PROFILE_TLS_MATERIALS;

/** Имя профиля: `^[a-z][a-z0-9_-]{0,31}$` (совпадает с shared `PROXY_PROFILE_NAME_RE`). */
const PROFILE_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Ошибка файла TLS-материала прокси (код для API/логов). */
export class ProxyTlsSecretFileError extends Error {
  readonly code = 'EGRESS_PROXY_TLS_SECRET_FILE_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'ProxyTlsSecretFileError';
  }
}

/** Проверка имени профиля перед построением пути. */
function assertProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new ProxyTlsSecretFileError(`proxy: недопустимое имя профиля "${name}"`);
  }
}

/** Каталог материалов профиля (`{dataDir}/secrets/proxy/<name>`). */
export function proxyProfileSecretsDir(dataDir: string, name: string): string {
  assertProfileName(name);
  return join(dataDir, 'secrets', 'proxy', name);
}

/** Путь материала TLS профиля (`ca.pem`/`client.crt`/`client.key`). */
export function proxyProfileTlsFilePath(
  dataDir: string,
  name: string,
  material: ProxyProfileTlsMaterial,
): string {
  return join(proxyProfileSecretsDir(dataDir, name), PROXY_PROFILE_TLS_MATERIALS[material]);
}

/**
 * Записать PEM-материал профиля (атомарно, `0600`, каталоги `0700`).
 * Возвращает путь файла. Содержимое не логируется.
 */
export async function writeProxyProfileTlsFile(
  dataDir: string,
  name: string,
  material: ProxyProfileTlsMaterial,
  pem: string,
): Promise<string> {
  if (pem.trim() === '') throw new ProxyTlsSecretFileError('proxy: PEM не может быть пустым');
  const dir = proxyProfileSecretsDir(dataDir, name);
  const path = proxyProfileTlsFilePath(dataDir, name, material);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    const tmp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, `${pem.trim()}\n`, { encoding: 'utf-8', mode: 0o600 });
      await chmod(tmp, 0o600).catch(() => {});
      await rename(tmp, path);
      await chmod(path, 0o600).catch(() => {});
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return path;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ProxyTlsSecretFileError(`proxy: не удалось записать TLS-материал: ${reason}`);
  }
}

/**
 * Удалить материал профиля (идемпотентно). `expectedPath` ограничивает
 * удаление только файлом из управляемого каталога — внешние пути (config.yaml)
 * не трогаются. Возвращает `true`, если файл был удалён.
 */
export async function removeProxyProfileTlsFile(
  dataDir: string,
  name: string,
  material: ProxyProfileTlsMaterial,
  expectedPath?: string,
): Promise<boolean> {
  const path = proxyProfileTlsFilePath(dataDir, name, material);
  if (expectedPath !== undefined && expectedPath !== path) return false;
  try {
    await rm(path, { force: false });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    const reason = err instanceof Error ? err.message : String(err);
    throw new ProxyTlsSecretFileError(`proxy: не удалось удалить TLS-материал: ${reason}`);
  }
}
