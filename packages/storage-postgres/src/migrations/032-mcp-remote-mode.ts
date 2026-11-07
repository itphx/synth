/**
 * Миграция 032_mcp_remote_mode — режим доставки MCP-сервера в локальные
 * сессии гибрида (PROP-125).
 *
 * В контракт `McpRegistryEntry` добавлено поле `remoteMode`
 * (`auto`|`relay`|`tools`). PG-порт его не писал и не читал — после reload
 * режим терялся (тихая потеря данных).
 *
 * Дефолт для существующих строк — `auto` (как при чтении файлового стора):
 * `relay` для http/sse, `tools` для stdio.
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_032_MCP_REMOTE_MODE = `
-- PROP-125: режим доставки сервера в локальные сессии гибрида (auto|relay|tools).
ALTER TABLE mcp_registry ADD COLUMN IF NOT EXISTS remote_mode text NOT NULL DEFAULT 'auto';
COMMENT ON COLUMN mcp_registry.remote_mode IS 'PROP-125: режим доставки MCP-сервера в локальные сессии гибрида (auto|relay|tools)';
`;
