/**
 * ADR-030: контракты hook-шины событий агента и интеграций. Система хуков не
 * реализована в рантайме (Plugin SDK — отдельный этап), здесь только типы:
 * имена хуков, режим выполнения, результат и карта контекстов.
 */
import type { SynthEvent, EventInitiator } from './events.js';

/** ADR-030: имена хуков жизненного цикла агента и интеграций (ADR-089). */
export type HookName =
  | 'pre_tool_use' | 'post_tool_use'
  | 'session_start' | 'session_end'
  | 'plan_approved' | 'plan_rejected'
  | 'agent_spawned' | 'agent_completed' | 'agent_failed'
  | 'permission_denied'
  | 'external_event' | 'message_received' | 'callback'
  | 'session_requested' | 'schedule_fired';

/**
 * Режим выполнения хука: `sync` — блокирующий (можно `block`/`patch`),
 * `async` — fire-and-forget (тяжёлые операции: CI, нотификации).
 */
export type HookMode = 'sync' | 'async';

/** ADR-030: результат хука. `block`/`reason` — только для `sync`. */
export interface HookResult {
  block?: boolean;
  reason?: string;
  patch?: Record<string, unknown>;
}

/**
 * PROP-102: оси атрибуции для сборщиков аналитики (`user`/`project`) — заполняются
 * на месте эмита, где значения уже под рукой (без чтения сессии в подписчике).
 * Необязательны: без них подписчик резолвит сессию по id (если она ещё есть).
 */
export interface HookAnalyticsAxes {
  /** Владелец/пользователь сессии (`Session.userId`), ось `user`. */
  userId?: string;
  /** Проект сессии (`Session.projectId`), ось `project`. */
  projectId?: string;
}

/** ADR-030: карта контекста по имени хука (минимально необходимые поля). */
export interface HookContextMap {
  pre_tool_use: { tool: string; input: unknown; agent?: string };
  post_tool_use: {
    tool: string;
    input: unknown;
    output?: unknown;
    duration: number;
    /** PROP-102: сессия вызова и оси атрибуции активности (ADR-030). */
    sessionId?: string;
    userId?: string;
    projectId?: string;
  };
  session_start: { sessionId: string; projectId?: string; agent?: string; userId?: string };
  session_end: {
    sessionId: string;
    summary?: string;
    userId?: string;
    projectId?: string;
    /** PROP-102: сессия архивирована (а не удалена) — мера `sessions_archived`. */
    archived?: boolean;
  };
  plan_approved: { sessionId: string; planContent?: string };
  plan_rejected: { sessionId: string; reason?: string };
  agent_spawned: { agentId: string; agentType?: string; parentId?: string };
  agent_completed: { agentId: string; result?: unknown };
  agent_failed: { agentId: string; error?: string; retries?: number };
  permission_denied: { tool: string; input?: unknown; reason?: string };
  external_event: { event: SynthEvent };
  message_received: { source: string; chatKey?: string; threadKey?: string; from?: string; text?: string };
  callback: { source: string; callbackId: string; data?: unknown; from?: string };
  session_requested: {
    reason?: string;
    agentTemplate?: string;
    project?: string;
    initiator: EventInitiator;
  };
  schedule_fired: { scheduleId: string; cron?: string; payload?: unknown };
}
