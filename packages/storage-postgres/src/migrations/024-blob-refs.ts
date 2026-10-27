/**
 * Миграция 024_blob_refs — учёт ссылок на объекты blob-хранилища
 * (ADR-115 §«Хранение», ADR-116 §3/«Схема БД»).
 *
 * Байты вложений/артефактов/скиллов/логов **не** переезжают в БД: они лежат
 * на томе (blob-хранилище — файловый порт по конструкции, ADR-116 §2). В БД
 * хранится только учёт ссылок — по нему дедуп (по содержимому) и
 * детерминированный GC (ссылок не осталось → объект можно удалять).
 *
 * FK на таблицу блобов нет — блобов в БД нет; существование объекта проверяет
 * порт `BlobStore`.
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_024_BLOB_REFS = `
-- Учёт ссылок на объекты blob-хранилища (ADR-115/ADR-116).
CREATE TABLE IF NOT EXISTS blob_refs (
  blob_path  text NOT NULL,
  owner_kind text NOT NULL,          -- message | pipeline-run | skill | process
  owner_id   text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (blob_path, owner_kind, owner_id)
);
CREATE INDEX IF NOT EXISTS blob_refs_owner_idx ON blob_refs (owner_kind, owner_id);
COMMENT ON TABLE blob_refs IS 'Ссылки на объекты blob-хранилища: байты лежат на томе, здесь только учёт ссылок (ADR-115/ADR-116)';
`;
