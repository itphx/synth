/**
 * Порт бинарного/файлового дерева (blob) — общий для подсистем, которые не
 * ложатся в таблицы: supporting-файлы скиллов, аватары, URL-кэши, экспорт
 * workspace (PROP-032 §«второй вариант хранения»).
 *
 * Контракт намеренно узкий и относительных путей — реализация может быть
 * файловой (`FileBlobStore`), S3 или БД; прямой доступ к ФС из интерфейса
 * отсутствует.
 */
export interface BlobStore {
  /** Чтение содержимого; `null` — файла нет. */
  read(path: string): Promise<Buffer | null>;
  /** Запись содержимого (атомарно), создание подкаталогов. */
  write(path: string, data: Buffer | string, opts?: { mode?: number }): Promise<void>;
  /** Удаление; отсутствие файла ошибкой не считается. */
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Записи под `prefix` (рекурсивно), с размером в байтах. */
  list(prefix?: string): Promise<Array<{ path: string; size: number }>>;
}
