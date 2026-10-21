import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWrite } from '@itphx/synth-shared';

/**
 * Общий слой чтения/записи JSON-коллекций для файловых портов слоя хранения
 * (ADR-005 — JSON + атомарная запись tmp→rename; ADR-096 — слой хранения).
 *
 * Формат файла: `{ "schemaVersion": 1, "<key>": [ ... ] }` — версия схемы
 * оставлена на будущее (миграции хранилища, ADR-092).
 *
 * Семантика чтения:
 * - файла нет — **пустой репозиторий** (не ошибка);
 * - файл есть, но JSON не разбирается или форма неверна — **понятная ошибка**
 *   (тихий пустой список здесь опасен: данные выглядели бы потерянными).
 */

/** Текущая версия схемы JSON-коллекции. */
export const JSON_COLLECTION_SCHEMA_VERSION = 1;

/** Разобранное содержимое JSON-коллекции (имя массива — по ключу `key`). */
type CollectionFile = Record<string, unknown>;

/**
 * Прочитать коллекцию из JSON-файла.
 *
 * @param path — путь к файлу;
 * @param key — имя массива внутри файла (`definitions`/`instances`/`packs`);
 * @param label — человекочитаемое имя хранилища для текста ошибки.
 */
export async function readCollectionFile<T>(path: string, key: string, label: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    // Файла нет — репозиторий пуст (это не ошибка).
    if (isNotFound(err)) return [];
    throw new Error(`Не удалось прочитать ${label} (${path}): ${errorText(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Повреждён файл ${label} (${path}): не удалось разобрать JSON — ${errorText(err)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Повреждён файл ${label} (${path}): ожидался JSON-объект с полем "${key}"`);
  }
  const items = parsed[key];
  if (!Array.isArray(items)) {
    throw new Error(`Повреждён файл ${label} (${path}): поле "${key}" — ожидался массив`);
  }
  return items as T[];
}

/**
 * Атомарно записать коллекцию в JSON-файл (tmp → rename, ADR-005).
 * Каталог создаётся при первой записи.
 */
export async function writeCollectionFile<T>(path: string, key: string, items: T[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file: CollectionFile = { schemaVersion: JSON_COLLECTION_SCHEMA_VERSION, [key]: items };
  const data = JSON.stringify(file, null, 2);
  await atomicWrite(
    (p, d) => writeFile(p, d, 'utf-8'),
    (o, n) => rename(o, n),
    path,
    data,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
