/**
 * Уведомление родителя о завершении фонового прогона (ADR-111/ADR-113).
 *
 * Точка сборки (composition root) вынесена из `server/app/deps.ts` и
 * `backend/app/deps.ts` — оба контура собирают **один и тот же** нотификатор
 * (паритет core↔backend).
 *
 * Инвариант: **ровно одно** попадание уведомления в историю сессии.
 * Раньше колбэк писал сообщение в историю (`sessionManager.addMessage`) **и**
 * ставил его в очередь (`enqueueUserMessage`) — процессор очереди добавлял то
 * же сообщение в историю второй раз и публиковал второе `message.added`
 * (в чате — две копии уведомления и два автохода).
 *
 * Теперь путь один: `enqueueUserMessage` персистит сообщение в `pendingMessages`,
 * процессор добавляет его в историю и публикует `message.added` — копия ровно
 * одна. Fallback (`addMessage` + `message.added`/`session.updated`) — только
 * когда постановка не удалась (сессия исчезла или исчерпан лимит pending), чтобы
 * уведомление не потерялось.
 */
import type { Message } from '@itphx/synth-shared';
import type { EventBus } from '../../events/bus.js';
import type { SessionManager } from '../../sessions/manager.js';
import {
  enqueueUserMessage,
  type ProcessMessageFn,
  type QueueProcessorManager,
} from '../../queue/processor.js';
import { serializeMessage, serializeSession } from '../../server/serialize.js';

/** Зависимости нотификатора уведомления родителя. */
export interface BackgroundParentNotifierDeps {
  /** Менеджер сессий (запись в историю/очередь). */
  sessionManager: SessionManager;
  /** Шина событий сессии (ADR-009) — публикация `message.added`/`session.updated`. */
  eventBus: EventBus;
  /** Менеджер процессоров очереди — автозапуск обработки поставленного сообщения. */
  processorManager: QueueProcessorManager;
  /** Обработка хода (оркестратор) — автоход после уведомления. */
  processMessage: ProcessMessageFn;
  /**
   * Обфускация user-сообщения перед записью в историю (ADR-036).
   *
   * Не задана — сообщение пишется как есть (уведомление системное: автор
   * `Process`/`Subagent`, а не пользовательский ввод; секреты в исходящих
   * LLM-запросах обфусцирует сам Gateway).
   */
  obfuscate?: (sessionId: string, message: Message) => Promise<Message>;
}

/**
 * Создать колбэк `onNotifyParent` для `BackgroundRunService`.
 *
 * Возвращает функцию `(sessionId, message) => Promise<void>` — сообщение
 * ставится в очередь сессии (автоход) и попадает в историю ровно один раз.
 */
export function createBackgroundParentNotifier(
  deps: BackgroundParentNotifierDeps,
): (sessionId: string, message: Message) => Promise<void> {
  return async (sessionId: string, message: Message): Promise<void> => {
    // Один путь: постановка в очередь. Процессор добавит сообщение в историю
    // и опубликует `message.added` — второй копии не будет.
    const queued = await enqueueUserMessage(
      deps.sessionManager,
      deps.eventBus,
      sessionId,
      message,
      deps.processorManager,
      deps.processMessage,
      deps.obfuscate,
    );
    if (queued) return;

    // Fallback: сессия исчезла или исчерпан лимит pending — пишем уведомление
    // в историю напрямую, чтобы оно не потерялось.
    const updated = await deps.sessionManager.addMessage(sessionId, message);
    if (!updated) return;
    const idx = updated.messages.length - 1;
    deps.eventBus.publish(sessionId, 'message.added', {
      message: serializeMessage(updated.messages[idx]!, idx),
      index: idx,
    });
    deps.eventBus.publish(sessionId, 'session.updated', serializeSession(updated));
  };
}
