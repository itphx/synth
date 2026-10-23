/**
 * ADR-102 §3: шов записи семейства `activity` через hook-шину (ADR-030).
 *
 * Подписка на жизненный цикл агента/инструментов превращает существующие эмиты
 * в инкременты роллапов — без дублирования источника истины:
 * - `session_start` → `sessions_created`;
 * - `session_end` (только архивация) → `sessions_archived`;
 * - `post_tool_use` → `tool_calls`;
 * - `agent_spawned` → `turns` (запуск саб-агента), `agent_failed` → `errors`.
 *
 * Оси — `user`/`project` (ADR-102 §2: `agent` в осях `activity` не участвует).
 * Значения осей приходят в контексте хука там, где они уже под рукой; иначе
 * резолвятся по id сессии (архивация/агентские события). Обработчики —
 * `async` (fire-and-forget), ошибки изолирует `HookBus`, запись — best-effort.
 */

import type { HookBus } from '../engine/hooks/hook-bus.js';
import type { HookContextMap } from '@itphx/synth-shared';
import type { AnalyticsRecorder } from './recorder.js';

/** Оси атрибуции события активности. */
export interface AnalyticsActivityAxes {
  userId?: string;
  projectId?: string;
}

/** Зависимости подписки на hook-шину. */
export interface AttachAnalyticsHooksDeps {
  recorder: AnalyticsRecorder;
  /**
   * Резолвинг осей по id сессии (когда контекст хука их не несёт — напр.
   * агентские события: id дочерней сессии). Ошибка/`null` → пустые оси.
   */
  resolveSessionAxes?: (sessionId: string) => Promise<AnalyticsActivityAxes | null>;
}

/**
 * Подписать сборщик `activity` на hook-шину. Возвращает функцию отписки —
 * вызывается на graceful shutdown/в тестах.
 *
 * Подписки — `builtin` (обработчики ядра, ADR-090): снять их через
 * обычный `off`/функцию отписки нельзя, поэтому отписка идёт через
 * `offBuiltin` — явный путь владельца регистрации.
 */
export function attachAnalyticsActivityHooks(
  hooks: HookBus,
  deps: AttachAnalyticsHooksDeps,
): () => void {
  const { recorder } = deps;
  const resolveAxes = async (
    sessionId: string | undefined,
    fallback?: AnalyticsActivityAxes,
  ): Promise<AnalyticsActivityAxes> => {
    if (fallback && (fallback.userId || fallback.projectId)) return fallback;
    if (!sessionId || !deps.resolveSessionAxes) return fallback ?? {};
    try {
      return (await deps.resolveSessionAxes(sessionId)) ?? fallback ?? {};
    } catch {
      return fallback ?? {};
    }
  };

  const options = { mode: 'async' as const, builtin: true };

  const onSessionStart = async (ctx: HookContextMap['session_start']) => {
    if (!recorder.enabled) return;
    const axes = await resolveAxes(ctx.sessionId, {
      userId: ctx.userId,
      projectId: ctx.projectId,
    });
    await recorder.recordActivity('sessions_created', axes);
  };

  const onSessionEnd = async (ctx: HookContextMap['session_end']) => {
    // `session_end` эмитится и при удалении, и при архивации (ADR-030/ADR-089);
    // мера `sessions_archived` — только архив.
    if (!recorder.enabled || ctx.archived !== true) return;
    const axes = await resolveAxes(ctx.sessionId, {
      userId: ctx.userId,
      projectId: ctx.projectId,
    });
    await recorder.recordActivity('sessions_archived', axes);
  };

  const onPostToolUse = async (ctx: HookContextMap['post_tool_use']) => {
    if (!recorder.enabled) return;
    const axes = await resolveAxes(ctx.sessionId, {
      userId: ctx.userId,
      projectId: ctx.projectId,
    });
    await recorder.recordActivity('tool_calls', axes);
  };

  const onAgentSpawned = async (ctx: HookContextMap['agent_spawned']) => {
    if (!recorder.enabled) return;
    const axes = await resolveAxes(ctx.agentId);
    await recorder.recordActivity('turns', axes);
  };

  const onAgentFailed = async (ctx: HookContextMap['agent_failed']) => {
    if (!recorder.enabled) return;
    const axes = await resolveAxes(ctx.agentId);
    await recorder.recordActivity('errors', axes);
  };

  hooks.on('session_start', onSessionStart, options);
  hooks.on('session_end', onSessionEnd, options);
  hooks.on('post_tool_use', onPostToolUse, options);
  hooks.on('agent_spawned', onAgentSpawned, options);
  hooks.on('agent_failed', onAgentFailed, options);

  return () => {
    hooks.offBuiltin('session_start', onSessionStart);
    hooks.offBuiltin('session_end', onSessionEnd);
    hooks.offBuiltin('post_tool_use', onPostToolUse);
    hooks.offBuiltin('agent_spawned', onAgentSpawned);
    hooks.offBuiltin('agent_failed', onAgentFailed);
  };
}
