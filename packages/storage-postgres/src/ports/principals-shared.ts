/**
 * Общие утилиты группы портов `principals` PostgreSQL-драйвера
 * (PROP-032, волна 3b).
 *
 * Драйвер объявляет `@itphx/synth-shared` обычной зависимостью, поэтому доменные
 * типы сущностей берутся из неё напрямую (алиасы — для читаемости портов).
 * Значения `jsonb`/`timestamptz` преобразуются здесь, чтобы все порты группы
 * работали единообразно:
 *   - `jsonb` пишется явной JSON-строкой (`pg` иначе превратил бы JS-массив в
 *     Postgres-массив) с приведением `$n::jsonb`;
 *   - `timestamptz` читается как `Date` (`pg` парсит его в `Date`) и отдаётся
 *     домену ISO-строкой — как в файловой реализации (JSON round-trip).
 */

import type { ExternalIdentity, ProfileData, Project } from '@itphx/synth-shared';
import type { PostgresExecutor } from '../pool.js';

/** Доменный проект. */
export type ProjectEntity = Project;

/** Доменный профиль. */
export type ProfileEntity = ProfileData;

/** Внешняя идентичность профиля (ADR-089). */
export type ExternalIdentityEntity = ExternalIdentity;

/** `timestamptz` (`Date` из `pg`) → ISO-строка; `NULL`/`undefined` → `undefined`. */
export function toIso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** `timestamptz NOT NULL` → ISO-строка (отсутствие — пустая строка, не бросаем). */
export function requiredIso(value: unknown): string {
  return toIso(value) ?? '';
}

/** Значение `jsonb`-параметра: JSON-строка либо `null`. */
export function jsonbParam(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

/** Прочитать `jsonb`-значение ключа таблицы `settings`. */
export async function readSetting<T>(exec: PostgresExecutor, key: string): Promise<T | undefined> {
  const rows = await exec.query<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value;
}

/** Записать (upsert) `jsonb`-значение ключа таблицы `settings`. */
export async function writeSetting(
  exec: PostgresExecutor,
  key: string,
  value: unknown,
): Promise<void> {
  await exec.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, jsonbParam(value)],
  );
}

/** Удалить ключ таблицы `settings` (отсутствие — не ошибка). */
export async function deleteSetting(exec: PostgresExecutor, key: string): Promise<void> {
  await exec.query('DELETE FROM settings WHERE key = $1', [key]);
}
