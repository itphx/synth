/**
 * Публикация событий плана проекта (ADR-118 §4, PROP-054).
 *
 * `plan.updated` — план изменился: событие идёт в каналы **всех сессий
 * проекта** (не только текущей), payload — `{project_id, version}`.
 * Иначе соседняя сессия того же проекта не узнает о правке доски и продолжит
 * показывать устаревший план (инвариант 27 — мутация, видимая другому
 * клиенту, публикует событие).
 *
 * Публикация — **после** успешного сохранения (мутатор вернул записанный
 * проект): событие о несостоявшейся правке было бы ложью.
 */
import type { EventBus } from '../../events/bus.js';
import type { SessionManager } from '../../sessions/manager.js';

/** Зависимости публикации (не заданы — событие не публикуется). */
export interface PlanEventDeps {
  eventBus?: EventBus;
  sessionManager?: SessionManager;
}

/**
 * Опубликовать `plan.updated` в каналы всех сессий проекта.
 *
 * Ошибки перечисления сессий/публикации **не** пробрасываются: неудача
 * уведомления не должна ломать уже выполненную мутацию.
 */
export async function publishPlanUpdated(
  deps: PlanEventDeps,
  projectId: string,
  version: number,
): Promise<void> {
  const { eventBus, sessionManager } = deps;
  if (!eventBus || !sessionManager || !projectId) return;
  try {
    const sessions = await sessionManager.listSessions({ projectId });
    for (const session of sessions) {
      eventBus.publish(session.id, 'plan.updated', { project_id: projectId, version });
    }
  } catch (err) {
    console.warn('[plan] не удалось опубликовать plan.updated:', err);
  }
}
