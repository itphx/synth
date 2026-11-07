/**
 * ADR-039/ADR-070: durable state-сообщение `todos_updated` в истории дочерней
 * сессии саб-агента.
 *
 * У основной сессии состояние (`mode/plan/todos/agent`) синхронизирует
 * `syncStateMessages` на каждом ходе. Цикл саб-агента (`run-cycle.ts`) этот
 * механизм не вызывает, поэтому ребёнок видел seeded `session.todos` только
 * через системный промпт — а список задач должен быть **chronological
 * state-сообщением** (ADR-070 §2.8), как у основной сессии. Функция идемпотентна:
 * сравнивает последнее `todos_updated` с актуальным рендером списка и добавляет
 * новое сообщение только при отличии.
 *
 * Вызывается: при создании ребёнка (после сида `task.todos`), при продолжении
 * по `task_id` (`task/tool.ts`) и при HTTP-resume (`task-resume.ts`).
 */
import type { SessionManager } from '../../../sessions/manager.js';
import { nextOrd } from '../../../storage/message-write.js';
import {
  buildTodosUpdatedContent,
  createStateMessage,
  findLastStateMessage,
} from '../../context/state-messages.js';

/** `todos_updated` state-сообщение? (derived state, удаление/замена безопасны). */
function isTodosStateMessage(message: { metadata?: Record<string, unknown> }): boolean {
  return message.metadata?.state === true && message.metadata?.type === 'todos_updated';
}

/**
 * Привести durable state-сообщение `todos_updated` в соответствие с
 * `session.todos` ребёнка.
 *
 * - списка нет / он пуст — сообщение не нужно; устаревшие `todos_updated`
 *   удаляются (иначе модель увидела бы отменённый список);
 * - контент совпадает с последним сообщением — ничего не делаем (идемпотентно);
 * - иначе дописываем `createStateMessage('todos_updated', content)`.
 *
 * Всё — под per-session локом; ошибки не глотаются (вызывающий решает,
 * фатальны ли они — state-сообщение derived и не должно ломать прогон).
 */
export async function ensureTodoStateMessage(
  sessionManager: SessionManager,
  sessionId: string,
): Promise<void> {
  await sessionManager.withLock(sessionId, async (session) => {
    const content = buildTodosUpdatedContent(session.todos ?? []);
    const last = findLastStateMessage(session.messages, 'todos_updated');

    if (!content) {
      if (!last) return;
      session.messages = session.messages.filter((message) => !isTodosStateMessage(message));
      await sessionManager.saveSession(session);
      return;
    }

    if (last && last.content === content) return;

    const message = createStateMessage('todos_updated', content);
    message.seq = session.messages.length + 1;
    message.ord = nextOrd(session.messages);
    session.messages.push(message);
    await sessionManager.saveSession(session);
  });
}
