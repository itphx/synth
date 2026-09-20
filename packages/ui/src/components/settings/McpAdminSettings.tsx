import { McpSettings } from './McpSettings'
import { ToolsDisabledSettings } from './ToolsDisabledSettings'

/**
 * AD-071 §2.6: админ-категория MCP — полный реестр (system + user), stdio,
 * enabledByDefault, сетевой доступ, permissions по режимам и instance-wide
 * отключение встроенных инструментов. Пользовательская часть — `McpUserSettings`.
 */
export function McpAdminSettings() {
  return (
    <div className="space-y-6">
      <McpSettings />
      <ToolsDisabledSettings />
    </div>
  )
}
