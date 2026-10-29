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
 * Теперь путь зависит от состояния хода (ADR-111/ADR-113): при активном ходе
 * уведомление идёт в очередь инъекций и персистится оркестратором на границе
 * шага; при завершённом — в `pendingMessages`, и процессор добавляет его в
 * историю и публикует `message.added`. В каждом пути копия ровно одна.
 * Fallback (`addMessage` + `message.added`/`session.updated`) — только когда не
 * удалась ни инъекция, ни постановка (сессия исчезла/исчерпан лимит pending),
 * чтобы уведомление не потерялось.
 */
import type { Message } from '@itphx/synth-shared';
import { MAX_STEER_INJECTIONS_PER_TURN, STEER_METADATA_KEY } from '@itphx/synth-shared';
import type { EventBus } from '../../events/bus.js';
import type { SessionManager } from '../../sessions/manager.js';
import {
  enqueueSteerMessage,
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
   * ADR-111/ADR-113: идёт ли сейчас ход сессии. Активный ход → уведомление
   * вклинивается в него на границе шага (`steerInbox`); иначе — обычная очередь.
   * Не задан — поведение прежнее (только очередь).
   */
  isTurnActive?: (sessionId: string) => Promise<boolean>;
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
 * Доставка (ADR-111/ADR-113, как inbox с delivery `steer`|`queue` в opencode):
 *   • ход идёт — уведомление в очередь инъекций (`enqueueSteerMessage`) и
 *     вклинивается в текущий ход на ближайшей границе шага (оркестратор
 *     персистит его — ровно одна копия в истории);
 *   • хода нет (или исчерпан лимит инъекций) — обычная очередь + автоход
 *     (`enqueueUserMessage`: процессор персистит сообщение — тоже одна копия).
 * Fallback (`addMessage`) — только если не удалась ни инъекция, ни постановка
 * в очередь (сессия исчезла / исчерпан лимит pending), чтобы уведомление не
 * потерялось.
 *
 * Причина ровно одной копии в каждом пути: историю пишет **или** оркестратор
 * (steer), **или** процессор очереди (queue), но не оба.
 */
export function createBackgroundParentNotifier(
  deps: BackgroundParentNotifierDeps,
): (sessionId: string, message: Message) => Promise<void> {
  return async (sessionId: string, message: Message): Promise<void> => {
    // 1. Активный ход — вклиниваемся в него (ADR-104), а не ждём конца.
    const active = deps.isTurnActive ? await deps.isTurnActive(sessionId) : false;
    if (active) {
      const steered = await enqueueSteerMessage(
        deps.sessionManager,
        deps.eventBus,
        sessionId,
        message,
        MAX_STEER_INJECTIONS_PER_TURN,
        deps.obfuscate,
      );
      if (steered.accepted) return;
      // Лимит инъекций на ход — не теряем результат: уходим в обычную очередь.
      // Маркер `steer` (его успел поставить `enqueueSteerMessage`) снимаем:
      // сообщение пойдёт как обычное сообщение очереди.
      if (message.metadata) delete message.metadata[STEER_METADATA_KEY];
    }

    // 2. Хода нет (или лимит инъекций) — обычная очередь + автоход.
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

    // 3. Fallback: сессия исчезла или исчерпан лимит pending — пишем уведомление
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
