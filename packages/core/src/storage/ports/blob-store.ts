import type { Readable } from 'node:stream';

/**
 * Порт бинарного/файлового дерева (blob) — общий для подсистем, которые не
 * ложатся в таблицы: supporting-файлы скиллов, аватары, URL-кэши, экспорт
 * workspace (ADR-096 §«второй вариант хранения»).
 *
 * Контракт намеренно узкий и относительных путей — реализация может быть
 * файловой (`FileBlobStore`), S3 или БД; прямой доступ к ФС из интерфейса
 * отсутствует.
 */

/** Метаданные объекта blob-хранилища (ADR-115). */
export interface BlobStat {
  /** Размер объекта, байт. */
  size: number;
  /** Время последнего изменения, мс (эпоха, как у `fs.Stats.mtimeMs`). */
  mtimeMs: number;
}

/**
 * Диапазон чтения (ADR-115): полуинтервал **включительно** с обоих концов —
 * как у `fs.createReadStream` (`start`/`end`).
 */
export interface BlobReadRange {
  /** Начальное смещение, байт (по умолчанию — с начала объекта). */
  start?: number;
  /** Конечное смещение, байт, **включительно** (по умолчанию — до конца). */
  end?: number;
}

export interface BlobStore {
  /** Чтение содержимого; `null` — файла нет. */
  read(path: string): Promise<Buffer | null>;
  /** Запись содержимого (атомарно), создание подкаталогов. */
  write(path: string, data: Buffer | string, opts?: { mode?: number }): Promise<void>;
  /**
   * Дописывание в конец файла; создаёт подкаталоги (файла нет — создаётся).
   *
   * Назначение — журналы (логи фоновых процессов, PROP-097): данные
   * дописываются по мере поступления. Контракт атомарности **не** требуется
   * (это append-only журнал, а не запись конфигурации) — зато не требуется и
   * переписывание файла целиком при каждом чтении.
   */
  append(path: string, data: Buffer | string): Promise<void>;
  /** Удаление; отсутствие файла ошибкой не считается. */
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Записи под `prefix` (рекурсивно), с размером в байтах. */
  list(prefix?: string): Promise<Array<{ path: string; size: number }>>;
  /**
   * ADR-115: метаданные объекта (размер/mtime) — для ответа раздачи и
   * заголовка `Range`. `null` — объекта нет.
   */
  stat(path: string): Promise<BlobStat | null>;
  /**
   * ADR-115: потоковое чтение объекта (раздача без чтения в память).
   * Диапазон — **включительно** с обоих концов, как у `fs`. `null` — объекта
   * нет (поток не создаётся — вызывающий отдаёт 404 без чтения).
   */
  readStream(path: string, opts?: BlobReadRange): Promise<Readable | null>;
}
