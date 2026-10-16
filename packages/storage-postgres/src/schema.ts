/**
 * Работа с идентификатором схемы PostgreSQL (namespace таблиц драйвера).
 *
 * Имена схем подставляются в DDL/`search_path`, поэтому принимаются только
 * безопасные идентификаторы (буква/`_`, далее буквы/цифры/`_`) — параметризовать
 * идентификаторы нельзя, а `quoteIdent` оборачивает имя в кавычки.
 */

import { PostgresStorageConfigError } from './errors.js';

const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Схема по умолчанию (`public`), если в конфиге не задано иное. */
export const DEFAULT_SCHEMA = 'public';

/** Проверяет, что имя схемы — безопасный идентификатор (иначе конфиг-ошибка). */
export function assertValidSchema(schema: string): string {
  if (!SCHEMA_RE.test(schema)) {
    throw new PostgresStorageConfigError(
      `Некорректное имя схемы \`${schema}\`: допустимы буквы/цифры/подчёркивание, первым символом — не цифра.`,
    );
  }
  return schema;
}

/** Экранирование идентификатора (двойные кавычки) для подстановки в SQL. */
export function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
