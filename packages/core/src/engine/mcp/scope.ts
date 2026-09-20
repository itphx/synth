/**
 * AD-071 §2.4/§2.5: разрешение эффективного набора MCP-серверов сессии.
 *
 * Формула: `(instance.defaultOn ∪ project.defaultOn ∪ session.enabled) − session.disabled`.
 * Уровень сервера определяется жёстким приоритетом `system > project > session`
 * (имя уникально в реестре, поэтому конфликт — это выбор «владельца» решения).
 * Отключённые серверы не исчезают: возвращается решение с причиной (AD-071 §2.2).
 *
 * Функция чистая (без I/O и McpManager) — её используют и оркестратор, и API.
 */

import type {
  McpDisabledReason,
  McpRegistryOrigin,
  McpServerLevel,
  ProjectMcpSettings,
} from '@itphx/synth-shared';

/** Вход: сервер реестра/конфига с признаками уровня. */
export interface McpScopeServer {
  name: string;
  origin: McpRegistryOrigin;
  /** Instance `enabledByDefault` (системный default-on). */
  enabledByDefault: boolean;
  /** `config.enabled !== false`. */
  configEnabled: boolean;
}

/** Вход: сессионные overrides. */
export interface McpScopeSession {
  /** Явно включённые серверы (session level). */
  enabled?: string[];
  /** Явные opt-out (включая системные). */
  disabled?: string[];
}

export interface McpScopeDecision {
  name: string;
  level: McpServerLevel;
  enabled: boolean;
  reason?: McpDisabledReason;
  origin: McpRegistryOrigin;
  enabledByDefault: boolean;
}

export function resolveMcpScope(
  servers: McpScopeServer[],
  project: ProjectMcpSettings | null | undefined,
  session: McpScopeSession,
): McpScopeDecision[] {
  const sessionEnabled = new Set(session.enabled ?? []);
  const sessionDisabled = new Set(session.disabled ?? []);
  const projectEnabled = new Set(project?.enabled ?? []);
  const projectDefaultOn = new Set(project?.defaultOn ?? []);

  return servers.map((server) => {
    const { name } = server;
    // Приоритет уровней: system > project > session.
    const isSystem = server.origin === 'instance';
    const inProject = !isSystem && (projectEnabled.has(name) || projectDefaultOn.has(name));
    const level: McpServerLevel = isSystem ? 'system' : inProject ? 'project' : 'session';

    const defaultOn = (isSystem && server.enabledByDefault) || projectDefaultOn.has(name);
    const baseOn = defaultOn || sessionEnabled.has(name);
    const enabled = baseOn && server.configEnabled && !sessionDisabled.has(name);

    let reason: McpDisabledReason | undefined;
    if (!enabled) {
      if (!server.configEnabled) reason = 'config';
      else if (sessionDisabled.has(name)) reason = 'session_optout';
      else if (level === 'project') reason = 'project_disabled';
      else reason = 'not_default';
    }

    return {
      name,
      level,
      enabled,
      ...(reason ? { reason } : {}),
      origin: server.origin,
      enabledByDefault: server.enabledByDefault,
    };
  });
}
