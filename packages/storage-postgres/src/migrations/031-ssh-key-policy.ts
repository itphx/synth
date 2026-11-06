/**
 * Миграция 031_ssh_key_policy — политика SSH-ключа (PROP-124).
 *
 * В контракт `SSHKey` добавлены поля `usages` (`git`/`ssh`), `allowHosts`
 * (правила хостов) и `allowPorts` (порты). PG-порт их не писал и не читал —
 * после reload ключ терял политику (тихая потеря данных).
 *
 * Дефолты для существующих строк — как при чтении файлового стора (fail-closed):
 * `usages = {git}`, `allow_hosts = {}`, `allow_ports = {}`.
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_031_SSH_KEY_POLICY = `
-- PROP-124: способы использования ключа (git|ssh) — дефолт {git}.
ALTER TABLE ssh_keys ADD COLUMN IF NOT EXISTS usages text[] NOT NULL DEFAULT ARRAY['git'];
COMMENT ON COLUMN ssh_keys.usages IS 'PROP-124: способы использования ключа (git|ssh)';

-- PROP-124: правила хостов (режим tools): hostname | *.suffix | IP | CIDR.
ALTER TABLE ssh_keys ADD COLUMN IF NOT EXISTS allow_hosts text[] NOT NULL DEFAULT ARRAY[]::text[];
COMMENT ON COLUMN ssh_keys.allow_hosts IS 'PROP-124: правила хостов политики ключа (режим tools)';

-- PROP-124: порты (режим tools): 1..65535; пусто — 22 (ssh).
ALTER TABLE ssh_keys ADD COLUMN IF NOT EXISTS allow_ports integer[] NOT NULL DEFAULT ARRAY[]::integer[];
COMMENT ON COLUMN ssh_keys.allow_ports IS 'PROP-124: порты политики ключа (режим tools)';
`;
