import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * ADR-069 §3.5 (R5) / ADR-046 §8.3: дешёвые подписи файлов для ленивой
 * инвалидации кэшей (скиллы, проектные инструкции).
 *
 * Подпись — `id:floor(mtimeMs):size`; отсутствующий файл/каталог помечается
 * маркером `id:!`. Значения сортируются, поэтому подпись стабильна при
 * неизменном содержимом и меняется при mtime/размере/наборе кандидатов.
 * `stat` инъектируется для тестируемости.
 */

/** Маркер отсутствующего кандидата (файл/каталог не найден либо `path: null`). */
export const MISSING_SIGNATURE_MARKER = '!';

export interface FileSignatureEntry {
  /** Стабильный идентификатор кандидата (например, имя подкаталога или каталог). */
  id: string;
  /** Абсолютный путь к файлу; `null` — кандидат отсутствует (стабильный маркер). */
  path: string | null;
}

/** Инъектируемый `stat` (возвращает mtime и размер). */
export type StatLike = (path: string) => Promise<{ mtimeMs: number; size: number }>;

/**
 * Подпись набора файлов: по каждому элементу `id:floor(mtimeMs):size` либо
 * `id:!` (нет пути/`stat` не удался). Результат отсортирован и склеен `|`.
 */
export async function filesSignature(
  entries: readonly FileSignatureEntry[],
  statFn: StatLike = stat,
): Promise<string> {
  const parts = await Promise.all(
    entries.map(async ({ id, path }) => {
      if (!path) return `${id}:${MISSING_SIGNATURE_MARKER}`;
      try {
        const info = await statFn(path);
        return `${id}:${Math.floor(info.mtimeMs)}:${info.size}`;
      } catch {
        return `${id}:${MISSING_SIGNATURE_MARKER}`;
      }
    }),
  );
  parts.sort();
  return parts.join('|');
}

/**
 * Подпись каталогов: на каждый каталог берётся **первый существующий** файл из
 * `fileNames` (порядок приоритета) — `dir:fileName:floor(mtimeMs):size`; если
 * ни один не найден — `dir:!`. Результат отсортирован и склеен `|`.
 */
export async function dirsSignature(
  dirs: readonly string[],
  fileNames: readonly string[],
  statFn: StatLike = stat,
): Promise<string> {
  const parts = await Promise.all(
    dirs.map(async (dir) => {
      for (const name of fileNames) {
        try {
          const info = await statFn(join(dir, name));
          return `${dir}:${name}:${Math.floor(info.mtimeMs)}:${info.size}`;
        } catch {
          // нет такого имени — пробуем следующее
        }
      }
      return `${dir}:${MISSING_SIGNATURE_MARKER}`;
    }),
  );
  parts.sort();
  return parts.join('|');
}
