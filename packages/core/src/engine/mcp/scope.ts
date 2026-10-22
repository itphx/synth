/**
 * ADR-071 §2.4/§2.5: разрешение эффективного набора MCP-серверов сессии.
 *
 * Модель per-item: системный мастер (`systemEnabled`) → проектный hard-gate
 * (`project.enabled`) → сессионный opt-out (`session.disabled`) → сид
 * (`session.defaultOn`, снапшот) или явное включение (`session.enabled`).
 *
 * Системный мастер — только реестровое `McpRegistryEntry.enabled`; `config.enabled`
 * в резолвинге не участвует (лишь сид записи реестра при первичном создании).
 *
 * Уровень сервера: `instance`-origin → `system`; иначе если разрешён проектом →
 * `project`; иначе `session`. Отключённые серверы не исчезают: возвращается
 * решение с причиной (ADR-071 §2.2).
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
  /**
   * Системный мастер-флаг (hard-gate): `false` — недоступен нигде. Источник —
   * только реестровое `McpRegistryEntry.enabled` (`config.enabled` — сид, не гейт).
   */
  systemEnabled: boolean;
  /**
   * ADR-077 (шаг B2): сервер поднят **исполнителем** (runtime-запись, не реестр).
   *
   * Такой сервер — инфраструктура топологии (system-level), а не curated-запись
   * проекта: проектный allow-list (`project.mcp.enabled`) его не отсекает.
   * Остальные гейты действуют как обычно — мастер-флаг, сессионный opt-out,
   * режимы/политики MCP-инструментов (`mcp.policy`, `mcp.tools`).
   */
  executor?: boolean;
}

/** Вход: сессионные overrides/снапшот. */
export interface McpScopeSession {
  /** Явно включённые серверы (session level). */
  enabled?: string[];
  /** Явные opt-out (включая системные). */
  disabled?: string[];
  /** СНАПШОТ серверов «по умолчанию» (на момент создания сессии). */
  defaultOn?: string[];
}

export interface McpScopeDecision {
  name: string;
  level: McpServerLevel;
  enabled: boolean;
  reason?: McpDisabledReason;
  origin: McpRegistryOrigin;
}

export function resolveMcpScope(
  servers: McpScopeServer[],
  project: ProjectMcpSettings | null | undefined,
  session: McpScopeSession,
): McpScopeDecision[] {
  const sessionEnabled = new Set(session.enabled ?? []);
  const sessionDisabled = new Set(session.disabled ?? []);
  const sessionDefaultOn = new Set(session.defaultOn ?? []);
  // Проект без настроек (`project.mcp` отсутствует) — гейт не задан (legacy,
  // доступно всё). Явные настройки (даже `enabled: []`) — allow-list.
  const projectGate = project ? new Set(project.enabled ?? []) : null;

  return servers.map((server) => {
    const { name } = server;
    const isSystem = server.origin === 'instance' || server.executor === true;
    // ADR-077 (шаг B2): серверы исполнителя — system-level инфраструктура, а не
    // curated-запись проекта; проектный allow-list их не отсекает (см. тип).
    const projectOn = server.executor === true
      ? true
      : projectGate === null
        ? true
        : projectGate.has(name);
    const inProject = server.executor === true || (projectGate !== null && projectGate.has(name));
    // Уровень: system > project > session.
    const level: McpServerLevel = isSystem ? 'system' : inProject ? 'project' : 'session';

    const systemOn = server.systemEnabled;
    const sessionOff = sessionDisabled.has(name);
    const seedOn = sessionDefaultOn.has(name);
    const sessionOn = sessionEnabled.has(name);
    const enabled = systemOn && projectOn && !sessionOff && (seedOn || sessionOn);

    let reason: McpDisabledReason | undefined;
    if (!enabled) {
      if (!systemOn) reason = 'system_disabled';
      else if (!projectOn) reason = 'project_disabled';
      else if (sessionOff) reason = 'session_optout';
      else reason = 'not_default';
    }

    return {
      name,
      level,
      enabled,
      ...(reason ? { reason } : {}),
      origin: server.origin,
    };
  });
}

/**
 * ADR-071 §2.4: эффективный набор MCP-серверов **проекта** — без сессионного
 * слоя (сессионного снапшота нет: у шага пайплайна нет сессии, ADR-101 §1).
 *
 * Модель per-item та же: системный мастер (`systemEnabled`) → проектный
 * hard-gate (`project.enabled`) → «включён» (проект разрешил сервер). Сессионные
 * `enabled`/`disabled`/`defaultOn` **не участвуют**: проектного скоупа шага
 * достаточно, чтобы решить, какие серверы проекту доступны.
 *
 * Логика не дублируется — считается тем же `resolveMcpScope`:
 * - проектный скоуп задан → сессионным «включением» считается проектный
 *   allow-list (`project.enabled`), сида/`opt-out` сессии нет;
 * - проектного скоупа нет (legacy) → гейт не задан, доступны все
 *   системно-включённые серверы.
 */
export function resolveMcpProjectScope(
  servers: McpScopeServer[],
  project: ProjectMcpSettings | null | undefined,
): McpScopeDecision[] {
  // ADR-077 (шаг B2): серверы исполнителя доступны и без записи в проектном
  // allow-list (они не редактируются пользователем, см. `McpScopeServer.executor`).
  const executorNames = servers.filter((server) => server.executor === true).map((server) => server.name);
  if (!project) {
    // Проектного скоупа нет (legacy) — гейт не задан: доступны все
    // системно-включённые серверы (сессионного слоя у шага нет).
    return resolveMcpScope(servers, null, { enabled: servers.map((server) => server.name) });
  }
  return resolveMcpScope(servers, project, { enabled: [...(project.enabled ?? []), ...executorNames] });
}
