/**
 * Сериализация значений в `jsonb`-параметры PostgreSQL.
 *
 * PostgreSQL не принимает U+0000 в `jsonb`: `JSON.stringify` превращает реальный
 * NUL в escape `\u0000`, и сервер отвечает «unsupported Unicode escape sequence».
 * Поэтому значение очищается `stripNullBytesDeep` **до** сериализации — это
 * единственное место, где NUL-байты в JSON-строках ещё различимы как данные
 * (в готовой JSON-строке escape `\u0000` уже неотличим от литеральной
 * последовательности, которую трогать нельзя).
 */

import { stripNullBytesDeep } from '@itphx/synth-shared';

/** JSON-строка для `jsonb`-параметра; `null`/`undefined` → SQL `NULL`. */
export function jsonbParam(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const json = JSON.stringify(stripNullBytesDeep(value));
  return json === undefined ? null : json;
}

/** JSON-строка для `jsonb`-параметра без схлопывания `null` в SQL `NULL`. */
export function jsonbLiteral(value: unknown): string {
  return JSON.stringify(stripNullBytesDeep(value ?? null));
}
