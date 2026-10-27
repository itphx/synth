/**
 * Корень blob-хранилища инстанса (ADR-115/ADR-116).
 *
 * Байты вложений/артефактов/скиллов/логов живут на томе, отдельно от JSON-файлов
 * домена: `FileBlobStore` создаётся с корнем `{dataDir}/blobs`, поэтому все
 * пути порта относительные (`attachments/…`, `artifacts/…`, `skills/…`,
 * `processes/…`). Раньше корнем был сам `dataDir` — путь `processes/<id>.log`
 * совпадал с каталогом реестра фоновых прогонов.
 *
 * `prepareBlobRoot` — синхронная идемпотентная подготовка каталога при старте:
 * создаёт `{dataDir}/blobs` и переносит **логи** фоновых процессов из старой
 * раскладки (`{dataDir}/processes/*`). Реестр прогонов
 * (`{dataDir}/processes/registry.json`) — не blob: он остаётся на месте, иначе
 * после переезда реестр «потерялся» бы (файл уехал в корень blob'ов, а порт
 * читает его по старому пути).
 *
 * Функция best-effort: ошибка переезда — предупреждение в лог, старт не падает
 * (логи — производные данные, потеря переживается retention-очисткой).
 */

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Каталог blob-хранилища внутри `dataDir` (относительное имя). */
export const BLOB_ROOT_DIR = 'blobs';

/** Прежний каталог логов фоновых процессов (`{dataDir}/processes`). */
const LEGACY_PROCESS_DIR = 'processes';

/**
 * Имя файла реестра фоновых прогонов внутри `{dataDir}/processes` — не blob,
 * при переезде логов остаётся на месте.
 */
const BACKGROUND_REGISTRY_FILE = 'registry.json';

/** Путь корня blob-хранилища для каталога данных инстанса. */
export function blobRootPath(dataDir: string): string {
  return join(dataDir, BLOB_ROOT_DIR);
}

/**
 * Подготовить корень blob-хранилища: `{dataDir}/blobs` существует, а логи
 * фоновых процессов из старой раскладки перенесены внутрь него.
 *
 * Идемпотентна: повторный вызов на уже перенесённых данных ничего не меняет.
 * Отсутствие каталогов — не ошибка.
 */
export function prepareBlobRoot(
  dataDir: string,
  log: (message: string) => void = (message) => console.warn(message),
): void {
  const blobsRoot = blobRootPath(dataDir);
  try {
    mkdirSync(blobsRoot, { recursive: true });
  } catch (err) {
    log(`[blob-root] не удалось создать каталог ${blobsRoot}: ${describeError(err)}`);
    return;
  }

  const legacyDir = join(dataDir, LEGACY_PROCESS_DIR);
  const targetDir = join(blobsRoot, LEGACY_PROCESS_DIR);
  if (!existsSync(legacyDir) || existsSync(targetDir)) return;

  try {
    mkdirSync(targetDir, { recursive: true });
    for (const entry of readdirSync(legacyDir)) {
      // Реестр фоновых прогонов — данные домена, не blob.
      if (entry === BACKGROUND_REGISTRY_FILE) continue;
      moveEntry(join(legacyDir, entry), join(targetDir, entry));
    }
  } catch (err) {
    log(`[blob-root] перенос ${legacyDir} → ${targetDir} не удался: ${describeError(err)}`);
  }
}

/**
 * Перенос записи каталога (файл или каталог) с фоллбеком на копирование при
 * `EXDEV` — `rename` не работает между разными файловыми системами, а том
 * данных и каталог blob'ов теоретически могут быть смонтированы раздельно.
 */
function moveEntry(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
