/**
 * Миграция 033_session_source_id — маркер источника сессии при переносе между
 * инстансами (`Session.sourceSessionId`).
 *
 * Поле используется как **ключ дедупликации повторного импорта**: повторная
 * загрузка той же сессии в тот же проект обновляет существующую запись, а не
 * создаёт дубль. PG-порт его не писал и не читал — после reload маркер терялся
 * (повторный импорт создавал вторую копию).
 *
 * Колонка nullable: у локально созданных сессий и у записей до появления поля
 * маркера нет. Индекс — по паре «проект + маркер», partial: ищется только
 * непустое значение (дедуп в рамках проекта).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_033_SESSION_SOURCE_ID = `
-- Маркер источника при переносе между инстансами (ключ дедупликации импорта).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source_session_id text;
COMMENT ON COLUMN sessions.source_session_id IS 'Маркер источника сессии при переносе между инстансами; ключ дедупликации повторного импорта';
CREATE INDEX IF NOT EXISTS sessions_project_source_idx ON sessions (project_id, source_session_id) WHERE source_session_id IS NOT NULL;
`;
