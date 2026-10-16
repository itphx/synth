/**
 * ADR-070 §2.9.1: единая ось доступности тулов (`ToolAccess`).
 *
 * Список tool-дефинишенов постоянен (не фильтруется по режиму/роли/окружению), а
 * доступность конкретного тула вычисляется здесь и передаётся permission-слою
 * как эффект `unavailable(mode | role | dependency | workspace)`:
 *  - `mode` — тул откроется, если пользователь переключит режим (plan/act/yolo);
 *  - `role` — тул недоступен текущему агенту, но доступен другому (делегировать);
 *  - `dependency` — в окружении нет нужного бинарника (git/rg/sh);
 *  - `workspace` — у проекта сессии не задан рабочий каталог (file/shell/git).
 *
 * `allow`/`ask`/`deny` — прежние эффекты ADR-029; `deny` — жёсткий запрет без
 * подсказок о переключении/делегировании.
 */

import { ToolCapability } from '@itphx/synth-shared';
import type { McpServerToolSettings, PlanMode, SessionMode } from '@itphx/synth-shared';
import { getMcpToolAvailability, isPlanBlockedTool, isPlanRestricted } from './evaluator.js';
import { isRuntimeDepAvailable, TOOL_RUNTIME_DEP, type RuntimeDeps } from '../tools/runtime-deps.js';
import { isStorageDegraded } from './storage-state.js';

export type ToolUnavailableReason = 'mode' | 'role' | 'dependency' | 'workspace' | 'storage';

/**
 * Capabilities, привязанные к рабочему каталогу проекта: без него относительные
 * пути не имеют определённой базы, поэтому file/shell/git-тулы блокируются.
 */
const WORKSPACE_CAPABILITIES: ReadonlySet<string> = new Set([
  ToolCapability.FILE_READ,
  ToolCapability.FILE_WRITE,
  ToolCapability.SHELL,
  ToolCapability.SEARCH,
  ToolCapability.GIT_READ,
  ToolCapability.GIT_WRITE,
]);

/**
 * PROP-032 (W5): тулы, остающиеся доступными при деградированном хранилище
 * (строгий read-only). Деградация — аварийный режим диагностики: доступны только
 * загрузка скиллов (`skill` — runbook восстановления) и веб-поиск/чтение
 * (`web_fetch`/`web_search`) — они не трогают доменное хранилище.
 *
 * Всё остальное (file/shell/git-тулы, `task`, запись плана/todo, работа с
 * проектом/сессиями) недоступно: доменные мутации в файловом фоллбеке привели бы
 * к split-brain (данные, созданные в фоллбеке, исчезнут при возврате к БД).
 */
const DEGRADED_SAFE_TOOLS: ReadonlySet<string> = new Set([
  'skill',
  'web_fetch',
  'web_search',
]);

/** Доступен ли тул при деградированном хранилище (строгий read-only). */
export function isToolAvailableInDegradedMode(toolName: string): boolean {
  return DEGRADED_SAFE_TOOLS.has(toolName);
}

/** Зависит ли тул от рабочего каталога проекта (file/shell/git/search). */
export function isWorkspaceDependentTool(capabilities?: readonly string[]): boolean {
  if (!capabilities || capabilities.length === 0) return false;
  return capabilities.some((cap) => WORKSPACE_CAPABILITIES.has(cap));
}

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
  /** Доступность внешних программ окружения (git/rg/sh). Не задана — fail-open. */
  runtimeDeps?: RuntimeDeps;
  /**
   * Задан ли рабочий каталог проекта (ADR-075). `false` — file/shell/git-тулы
   * недоступны (`workspace`); `true`/`undefined` — fail-open (обратная совместимость).
   */
  workspaceReady?: boolean;
  /**
   * PROP-032 (W5): хранилище в деградированном read-only режиме. Не задано —
   * берётся рантайм-состояние (`isStorageDegraded`). `true` — доступны только
   * безопасные тулы (`isToolAvailableInDegradedMode`), прочие `unavailable(storage)`.
   */
  storageDegraded?: boolean;
}

/**
 * Вычисляет доступность тула.
 *
 * Порядок проверок:
 *  0. storage — хранилище недоступно (деградация): доступны только безопасные
 *     тулы (скиллы/веб); остальное `unavailable(storage)`.
 *  1. role — если `agentCapabilities` заданы и ни одна capability тула не
 *     пересекается с ними. Тул без capabilities считается доступным (нельзя
 *     определить принадлежность).
 *  2. mode — plan-рестрикция write/edit/git-write (ADR-025) либо MCP-тул,
 *     выключенный в текущем режиме настройками сессии.
 *  3. dependency — в окружении нет внешней программы тула (`TOOL_RUNTIME_DEP`).
 *  4. workspace — не задан рабочий каталог проекта, а тул зависит от него.
 *  5. иначе — доступен.
 */
export function computeToolAvailability(
  toolName: string,
  capabilities: readonly string[] | undefined,
  opts: ToolAvailabilityOptions,
): ToolAvailability {
  // 0. Хранилище: деградированный режим — строгий read-only. Доступны только
  // безопасные тулы (скиллы/веб), остальные видимы модели как `unavailable(storage)`.
  const degraded = opts.storageDegraded ?? isStorageDegraded();
  if (degraded && !isToolAvailableInDegradedMode(toolName)) {
    return { available: false, reason: 'storage' };
  }

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

  // 3. Зависимость окружения: нет внешней программы тула (git/rg/sh).
  const dep = TOOL_RUNTIME_DEP[toolName];
  if (dep && !isRuntimeDepAvailable(opts.runtimeDeps, dep)) {
    return { available: false, reason: 'dependency' };
  }

  // 4. Рабочий каталог проекта: без `project.workspace` относительные пути
  // файловых/shell/git-тулов не имеют определённой базы — недоступны.
  if (opts.workspaceReady === false && isWorkspaceDependentTool(capabilities)) {
    return { available: false, reason: 'workspace' };
  }

  // 5. Доступен.
  return { available: true };
}
