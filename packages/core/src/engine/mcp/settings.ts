import type { McpToolAvailability, McpServerToolSettings } from '@itphx/synth-shared';

/** Полная доступность: инструмент разрешён и в plan, и в act режимах. */
export function fullMcpAvailability(): McpToolAvailability {
  return { plan: true, act: true };
}

/**
 * Строит дефолтные настройки доступности MCP-сервера по режимам plan/act.
 * Все инструменты сервера по умолчанию доступны в обоих режимах
 * (обратная совместимость — без настроек MCP-тулы не блокируются).
 * Точечные override-ы задаются через .tools[toolName].
 */
export function buildMcpServerSettings(_toolNames: string[] = []): McpServerToolSettings {
  return { default: fullMcpAvailability() };
}

/**
 * Нормализует настройку сервера: гарантирует наличие default и применяет
 * дефолт к отсутствующим полям отдельных инструментов.
 */
export function normalizeMcpServerSettings(settings: McpServerToolSettings | undefined): McpServerToolSettings | undefined {
  if (!settings) return undefined;
  const def = settings.default ?? fullMcpAvailability();
  const tools = settings.tools;
  if (!tools) return { ...settings, default: def };
  const normalizedTools: Record<string, McpToolAvailability> = {};
  for (const [name, avail] of Object.entries(tools)) {
    normalizedTools[name] = { ...def, ...avail };
  }
  return { default: def, tools: normalizedTools };
}

/**
 * Объединяет глобальные (runtime) и локальные (сессионные) настройки
 * доступности MCP-серверов. Сессионные настройки приоритетнее: на уровне
 * сервера берутся сессионные default/tools, но недостающие серверы и поля
 * дополняются из глобальных.
 */
export function mergeMcpToolSettings(
  global: Record<string, McpServerToolSettings> | undefined,
  local: Record<string, McpServerToolSettings> | undefined,
): Record<string, McpServerToolSettings> | undefined {
  if (!global) return local;
  if (!local) return global;
  const merged: Record<string, McpServerToolSettings> = { ...global };
  for (const [serverName, localServer] of Object.entries(local)) {
    const globalServer = merged[serverName];
    if (!globalServer) {
      merged[serverName] = localServer;
      continue;
    }
    merged[serverName] = {
      default: localServer.default ?? globalServer.default,
      tools: { ...globalServer.tools, ...localServer.tools },
    };
  }
  return merged;
}
