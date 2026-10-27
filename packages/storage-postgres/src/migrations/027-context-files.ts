/**
 * Миграция 027_context_files — пользовательские файлы контекста/промптов в SQL
 * (ADR-069/ADR-070, ADR-116): override'ы категорий `user`/`role` и override
 * системных промптов (`system`). Системные промпты образа остаются ФС
 * (`{packageRoot}/prompts`) — в БД они не дублируются.
 *
 * Категория — доменная (`ContextCategory` порта `ContextFileRepository`):
 * - `user`  — `{context}/user/*.md` (файлы «о проекте»: SOUL/COMPANY/ABOUT);
 * - `role`  — `{context}/roles/*.md` (ролевые промпты агентов);
 * - `system` — `{context}/user/system/**` (override промптов режимов,
 *   безопасности, планировщика; `filename` может содержать подкаталог,
 *   напр. `security/deny_path.md`).
 *
 * `content` — текст файла как есть (utf-8), `updated_at` — метка записи; по её
 * максимуму PostgreSQL-порт инвалидирует процесс-локальный кэш
 * (`PgContextFileRepository`: `SELECT max(updated_at)`).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_027_CONTEXT_FILES = `
-- ADR-116: пользовательские файлы контекста/промптов (override'ы) — в SQL.
CREATE TABLE IF NOT EXISTS context_files (
  category   text NOT NULL,          -- user | role | system
  filename   text NOT NULL,          -- имя или относительный путь (system/security/*)
  content    text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (category, filename)
);
COMMENT ON TABLE context_files IS 'Пользовательские файлы контекста/промптов: системные промпты образа остаются ФС (ADR-116)';
`;
