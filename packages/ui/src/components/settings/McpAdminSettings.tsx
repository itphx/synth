import { McpSettings } from './McpSettings'

/**
 * AD-071 §2.5/§2.6: админ-категория MCP — полный реестр (system + user), stdio,
 * enabledByDefault, сетевой доступ и permissions по режимам. Управление
 * встроенными инструментами (`tools.disabled`) вынесено в отдельную категорию
 * «Встроенные инструменты» (`ToolsDisabledSettings`). Пользовательская часть
 * MCP — `McpUserSettings`.
 */
export function McpAdminSettings() {
  return <McpSettings />
}
