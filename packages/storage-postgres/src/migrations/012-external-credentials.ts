/**
 * PROP-107 (Ф1): миграция таблицы внешних доступов (`external_credentials`).
 *
 * Отдельная таблица (не `documents`/`settings`): у доступа есть собственная
 * семантика — владелец, статус, срок, отзыв — и колонки с **зашифрованными**
 * токенами (`secret_enc`/`refresh_enc`), которые не должны попадать в общие
 * JSON-документы.
 *
 * Шифрование — **только** core-хелперами (`encryptSecret`/`decryptSecret`,
 * формат `enc:v1:…`): драйвер не дублирует криптографию. Поэтому значения
 * хранятся как `text` (готовый токен `enc:v1:…`), а не в открытом виде.
 *
 * Миграция идемпотентна (`IF NOT EXISTS`).
 */
export const MIGRATION_011_EXTERNAL_CREDENTIALS = `
CREATE TABLE IF NOT EXISTS external_credentials (
  id             text PRIMARY KEY,
  provider       text NOT NULL,
  connector_id   text,
  client_id      text NOT NULL,
  scopes         jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_kind     text NOT NULL,
  owner_id       text NOT NULL,
  project_id     text,
  secret_enc     text NOT NULL,
  refresh_enc    text,
  status         text NOT NULL,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL,
  last_used_at   timestamptz,
  scopes_granted jsonb
);

CREATE INDEX IF NOT EXISTS external_credentials_owner_idx
  ON external_credentials (owner_kind, owner_id);
CREATE INDEX IF NOT EXISTS external_credentials_connector_idx
  ON external_credentials (connector_id);
`;
