/**
 * Публикация событий проектных данных (ADR-118 §4, инвариант 27, PROP-054).
 *
 * `project.updated` с `kind` — журнал (`log`) и инварианты (`invariants`)
 * изменились: событие идёт в каналы **всех сессий проекта** (инвентарь и
 * тексты — ресурс проекта, а не одной сессии), payload — `{project_id, kind}`.
 *
 * Прежде `project_log_write`/`project_invariants_write` события не публиковали
 * вовсе — другие клиенты узнавали о правке только при перезагрузке.
 */
import type { EventBus } from '../../events/bus.js';
import type { SessionManager } from '../../sessions/manager.js';

/** Что изменилось в проекте (для `project.updated`). */
export type ProjectUpdateKind = 'log' | 'invariants';

/** Зависимости публикации (не заданы — событие не публикуется). */
export interface ProjectEventDeps {
  eventBus?: EventBus;
  sessionManager?: SessionManager;
}

/**
 * Опубликовать `project.updated` в каналы всех сессий проекта.
 *
 * Ошибки не пробрасываются: неудача уведомления не должна ломать уже
 * выполненную мутацию.
 */
export async function publishProjectUpdated(
  deps: ProjectEventDeps,
  projectId: string,
  kind: ProjectUpdateKind,
): Promise<void> {
  const { eventBus, sessionManager } = deps;
  if (!eventBus || !sessionManager || !projectId) return;
  try {
    const sessions = await sessionManager.listSessions({ projectId });
    for (const session of sessions) {
      eventBus.publish(session.id, 'project.updated', { project_id: projectId, kind });
    }
  } catch (err) {
    console.warn('[project] не удалось опубликовать project.updated:', err);
  }
}
