/**
 * AD-070 §2.9.1: единая ось доступности тулов (`ToolAccess`).
 *
 * Список tool-дефинишенов постоянен (не фильтруется по режиму/роли), а
 * доступность конкретного тула вычисляется здесь и передаётся permission-слою
 * как эффект `unavailable(mode | role)`:
 *  - `mode` — тул откроется, если пользователь переключит режим (plan/act/yolo);
 *  - `role` — тул недоступен текущему агенту, но доступен другому (делегировать).
 *
 * `allow`/`ask`/`deny` — прежние эффекты AD-029; `deny` — жёсткий запрет без
 * подсказок о переключении/делегировании.
 */

import { ToolCapability } from '@itphx/synth-shared';
import type { McpServerToolSettings, PlanMode, SessionMode } from '@itphx/synth-shared';
import { getMcpToolAvailability, isPlanBlockedTool, isPlanRestricted } from './evaluator.js';

export type ToolUnavailableReason = 'mode' | 'role';

export interface ToolAvailability {
  available: boolean;
  reason?: ToolUnavailableReason;
}

export interface ToolAvailabilityOptions {
  sessionMode?: SessionMode;
  planMode?: PlanMode;
  planApproved?: boolean;
  mcpToolSettings?: Record<string, McpServerToolSettings>;
  agentCapabilities?: readonly string[];
}

/**
 * Вычисляет доступность тула.
 *
 * Порядок проверок:
 *  1. role — если `agentCapabilities` заданы и ни одна capability тула не
 *     пересекается с ними. Тул без capabilities считается доступным (нельзя
 *     определить принадлежность).
 *  2. mode — plan-рестрикция write/edit/git-write (AD-025) либо MCP-тул,
 *     выключенный в текущем режиме настройками сессии.
 *  3. иначе — доступен.
 */
export function computeToolAvailability(
  toolName: string,
  capabilities: readonly string[] | undefined,
  opts: ToolAvailabilityOptions,
): ToolAvailability {
  // 1. Ролевая недоступность: у агента нет ни одной capability тула.
  if (opts.agentCapabilities && capabilities && capabilities.length > 0) {
    const agentCaps = new Set(opts.agentCapabilities);
    if (!capabilities.some((cap) => agentCaps.has(cap))) {
      return { available: false, reason: 'role' };
    }
  }

  // 2a. Режимная недоступность: plan-рестрикция write/edit/git-write.
  if (
    isPlanRestricted(opts.sessionMode, opts.planMode, opts.planApproved)
    && isPlanBlockedTool(toolName, capabilities)
  ) {
    return { available: false, reason: 'mode' };
  }

  // 2b. Режимная недоступность: MCP-тул, выключенный в текущем режиме.
  if (capabilities?.includes(ToolCapability.MCP) && opts.mcpToolSettings) {
    const availability = getMcpToolAvailability(opts.mcpToolSettings, toolName);
    if (availability) {
      const modeKey = opts.sessionMode === 'plan' ? 'plan' : 'act';
      if (!availability[modeKey]) {
        return { available: false, reason: 'mode' };
      }
    }
  }

  // 3. Доступен.
  return { available: true };
}
