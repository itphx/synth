/**
 * Публикация события `worktree.updated` (ADR-114 §6, `docs/WORKTREES.md` §6).
 *
 * Событие идёт в **существующую** шину сессий (ADR-024) — новых транспортных
 * каналов не заводим. Канал у события — **каждой сессии проекта**: инвентарь
 * worktree'ов — ресурс проекта, а не одной сессии, поэтому подписчики других
 * сессий того же проекта тоже должны увидеть изменение.
 *
 * Дополнительно публикуется `fs.changed { scope: 'all' }`: создание/удаление
 * worktree меняет структуру каталогов на диске, поэтому дерево Files и
 * открытые редакторы должны перечитать рабочее дерево (ADR-089/ADR-024).
 *
 * Направление зависимостей — как у соседних модулей: хелпер знает только
 * **шину** и **источник сессий** (структурный интерфейс), а не `SessionManager`
 * целиком. Так его можно вызвать из deps, из HTTP-роутов и из тестов.
 */
import type { Session } from '@itphx/synth-shared';
import type { EventBus } from '../../events/bus.js';

/**
 * Предел числа сессий, которым публикуется событие.
 *
 * Событие — сигнал «перечитай инвентарь», а не поток данных: 200 каналов
 * достаточно для любого реального проекта, а перебор не даёт заблокировать
 * публикацию на проекте с тысячами сессий.
 */
export const WORKTREE_EVENT_MAX_SESSIONS = 200;

/**
 * Источник сессий проекта — структурно совместим с `SessionManager`
 * (`listSessions({ projectId })`).
 */
export interface WorktreeEventSessionSource {
  listSessions(filter?: { projectId?: string; userId?: string }): Promise<Session[]>;
}

/** Зависимости публикации события worktree. */
export interface WorktreeEventDeps {
  /** Шина событий сессий (ADR-009). */
  eventBus: EventBus;
  /** Источник сессий проекта (обычно `SessionManager`). */
  sessionStore: WorktreeEventSessionSource;
}

/**
 * Опубликовать `worktree.updated` в каналы сессий проекта + `fs.changed`.
 *
 * Проект без сессий — молча ничего (нечего инвалидировать: подписчиков нет).
 * Ошибка чтения сессий не должна ломать операцию worktree: событие — побочный
 * сигнал, поэтому ошибка глушится (операция уже выполнена успешно).
 */
export async function publishWorktreeUpdated(
  deps: WorktreeEventDeps,
  projectId: string,
): Promise<void> {
  let sessions: Session[];
  try {
    sessions = await deps.sessionStore.listSessions({ projectId });
  } catch {
    return;
  }
  for (const session of sessions.slice(0, WORKTREE_EVENT_MAX_SESSIONS)) {
    deps.eventBus.publish(session.id, 'worktree.updated', { project_id: projectId });
    // Инвалидация дерева Files: структура каталогов изменилась.
    deps.eventBus.publish(session.id, 'fs.changed', { scope: 'all' });
  }
}
