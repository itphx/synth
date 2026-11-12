/**
 * Fail-closed проверка записи в каталог данных инстанса (PROP-137 Ф1).
 *
 * Каталог `{dataDir}` — единственное место, куда Synth пишет всегда: сессии,
 * проекты, секреты (мастер-ключ, api-key), blob-хранилище (ADR-116), логи
 * аудита. Если процесс запущен от uid, которому каталог не принадлежит,
 * инстанс падает позже и непонятно: `EACCES` на `secrets/master.key`, на
 * `sessions/`, на `blobs/` — а UI при этом отвечает 200 (nginx данные не
 * трогает), то есть «сайт открывается, а данные не сохраняются».
 *
 * Поэтому проверка идёт **до** инициализации хранилища (ADR-096) и падает
 * сразу, с точной командой починки. Проверка именно **записи**, а не
 * `access(W_OK)`: на NFS (и на ряде overlay-FS) бит записи может не совпадать
 * с фактической возможностью создать файл, поэтому создаём временный файл
 * и удаляем его.
 *
 * Содержимое каталога не читается и не логируется — только путь и uid/gid
 * процесса.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Опции проверки каталога данных. */
export interface DataDirCheckOptions {
  /**
   * Название проверяемого каталога в тексте ошибки (по умолчанию
   * `data directory`). Меняется, если проверяется не каталог данных
   * инстанса, а иной каталог с тем же контрактом.
   */
  label?: string;
}

/** Ошибка «каталог данных не доступен на запись». */
export class DataDirNotWritableError extends Error {
  /** Машиночитаемый код причины. */
  readonly code = 'DATA_DIR_NOT_WRITABLE';
  /** Проверяемый каталог. */
  readonly dataDir: string;
  /** uid процесса (или `unknown`, если платформа не сообщает). */
  readonly uid: string;
  /** gid процесса (или `unknown`). */
  readonly gid: string;

  constructor(message: string, details: { dataDir: string; uid: string; gid: string; cause?: unknown }) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'DataDirNotWritableError';
    this.dataDir = details.dataDir;
    this.uid = details.uid;
    this.gid = details.gid;
  }
}

/** Название каталога в тексте ошибки по умолчанию. */
const DEFAULT_LABEL = 'data directory';

/** Имя временного файла-пробы (префикс — чтобы узнать в списке каталога). */
const PROBE_PREFIX = '.synth-write-probe-';

/**
 * Fail-closed проверка каталога данных: каталог существует (при
 * необходимости — создаётся) и в него **можно записать**.
 *
 * @param dataDir путь к каталогу данных инстанца
 * @param opts опции проверки (см. `DataDirCheckOptions`)
 * @throws DataDirNotWritableError — каталог не удалось создать или записать
 */
export async function assertDataDirWritable(
  dataDir: string,
  opts: DataDirCheckOptions = {},
): Promise<void> {
  const label = opts.label ?? DEFAULT_LABEL;
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'unknown';
  const gid = typeof process.getgid === 'function' ? String(process.getgid()) : 'unknown';
  const fail = (cause: unknown): never => {
    throw new DataDirNotWritableError(
      `${label} "${dataDir}" is not writable by uid ${uid} (chown -R ${uid}:${gid} "${dataDir}")`,
      { dataDir, uid, gid, cause },
    );
  };

  try {
    await mkdir(dataDir, { recursive: true });
  } catch (err) {
    fail(err);
  }

  let isDirectory = false;
  try {
    isDirectory = (await stat(dataDir)).isDirectory();
  } catch (err) {
    fail(err);
  }
  if (!isDirectory) {
    fail(new Error(`not a directory: ${dataDir}`));
  }

  // Проба записи: создать файл и удалить его. `access(W_OK)` на NFS/overlay
  // не гарантирует, что файл реально создастся, поэтому пишем по-настоящему.
  const probe = join(dataDir, `${PROBE_PREFIX}${process.pid}-${randomUUID()}`);
  try {
    await writeFile(probe, 'synth', { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    await rm(probe, { force: true }).catch(() => {});
    fail(err);
  }
  await rm(probe, { force: true }).catch(() => {});
}
