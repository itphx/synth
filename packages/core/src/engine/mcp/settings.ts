import type { McpToolAvailability, McpServerToolSettings } from '@synth/shared';

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
