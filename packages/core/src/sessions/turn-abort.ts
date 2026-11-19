/**
 * «Стоп» для сессии — единая реализация (HTTP-роут `POST /sessions/:id/abort`,
 * инстансный тул `synth_session_stop`).
 *
 * ## Зачем отдельный модуль
 *
 * Семантика «Стоп» накопила детали, которые не должны расходиться между
 * поверхностями:
 *
 * 1. персистентный флаг отмены (`status.cancelRequested` + `…At`) пишется
 *    **точечно** под локом порта (`mutateMeta`, ADR-144) — полный снимок затирал
 *    бы параллельную дозапись сообщений; он работает и когда `currentStream`/
 *    cancel-token ещё нет (сессия в очереди/backoff/между итерациями);
 * 2. активный стрим отменяется `orchestrator.cancel(streamId)` — он публикует
 *    `stream.cancelled` и сохраняет частичный ответ, если токен ещё жив;
 * 3. живой процессор очереди останавливается `queueManager.requestStop(id)`;
 *    **очередь сохраняется целиком** («Стоп» останавливает только активный ход,
 *    решение владельца 2026-11-01) — её продолжит `/queue/:sessionId/resume` или
 *    новая постановка сообщения. Процессора нет → флаг снимается, иначе
 *    следующий запуск ложно отменится; при непустой очереди выставляется
 *    `status.queueStopped` (баннер «Обработка остановлена») и публикуется
 *    `queue.stalled`;
 * 4. неприменённые steer-инъекции (ADR-104) снимаются best-effort: границы шага
 *    больше не будет, а пользовательский ввод и уведомления фоновых прогонов
 *    **возвращаются в очередь** (`requeueMessages`), а не теряются.
 *
 * Фоновые прогоны (detached-саб-агенты, фоновые процессы) «Стоп» **не**
 * останавливает (решение 2026-10-31, модель opencode): их гасят явно
 * (`POST /processes/:id/stop`, «Стоп» их собственной сессии).
 *
 * Модуль сознательно не знает ни про HTTP, ни про тулы: он получает порты
 * (`SessionManager`/очередь/оркестратор/шина) и возвращает факт остановки — а
 * вызывающий решает, как это выглядит (404 ответа роута, `ToolResult` тула).
 */
import { nowISO } from '@itphx/synth-shared';
import type { Session } from '@itphx/synth-shared';
import type { SessionManager } from './manager.js';
import type { EventBus } from '../events/bus.js';
import type { QueueProcessorManager } from '../queue/processor.js';
import { requeueMessages } from '../queue/processor.js';
import { dropSteerInjections } from '../engine/steering/apply.js';

/** Зависимости остановки хода (ровно те порты, что нужны семантике «Стоп»). */
export interface AbortSessionTurnDeps {
  /** Менеджер сессий: чтение сессии и точечная правка `status` под локом порта. */
  sessionManager: SessionManager;
  /** Оркестратор: отмена активного стрима (`cancel(streamId)`). */
  orchestrator?: { cancel(streamId: string): void };
  /** Процессоры очереди: остановка активного процессора сессии. */
  queueManager: Pick<QueueProcessorManager, 'requestStop'>;
  /** Шина событий сессии (`queue.stalled`, `steer.dropped`, `queue.state`). */
  eventBus: EventBus;
  /**
   * Обработчик сбоя снятия steer-очереди (best-effort). Не задан — `console.warn`
   * (прежнее поведение роута).
   */
  onSteerDropError?: (error: unknown) => void;
}

/** Итог остановки хода. */
export interface AbortSessionTurnResult {
  /** Сессия, по которой пришёл «Стоп». */
  sessionId: string;
  /**
   * Что-то действительно шло: активный стрим, блокировка хода или живой
   * процессор очереди. `false` — «останавливать было нечего» (не ошибка).
   */
  wasRunning: boolean;
  /** Живой процессор очереди получил запрос остановки. */
  processorStopped: boolean;
  /** Очередь осознанно остановлена (`status.queueStopped`). */
  queueStopped: boolean;
  /** Сколько сообщений осталось в очереди сессии. */
  pending: number;
}

/**
 * Прервать текущий ход сессии. Сессии нет — `null` (вызывающий решает, что
 * ответить: 404 у роута, `session.not_found` у тула).
 *
 * @param session уже прочитанная сессия (роут читает её до проверки доступа) —
 *                чтобы не делать второй `getSession`; не задана — читаем сами.
 */
export async function abortSessionTurn(
  deps: AbortSessionTurnDeps,
  sessionId: string,
  session?: Session | null,
): Promise<AbortSessionTurnResult | null> {
  const current = session ?? (await deps.sessionManager.getSession(sessionId));
  if (!current) return null;

  // 1. Персистентный флаг отмены: точечная правка под локом порта, `updatedAt`
  //    не двигаем — паритет с прежним `saveSession`.
  await deps.sessionManager.mutateMeta(sessionId, (meta) => {
    meta.status.cancelRequested = true;
    meta.status.cancelRequestedAt = nowISO();
  }, { touchUpdatedAt: false });

  // 2. Graceful-отмена активного стрима (публикует `stream.cancelled`).
  if (current.currentStream) {
    deps.orchestrator?.cancel(current.currentStream.streamId);
  }

  // 3. Живой процессор останавливаем; очередь при этом сохраняется целиком.
  const processorStopped = deps.queueManager.requestStop(sessionId);
  let queueStopped = false;
  let pending = current.pendingMessages?.length ?? 0;
  if (!processorStopped) {
    // Снятие флага/остановка — метаданные: та же точечная правка под локом
    // порта (`updatedAt` не двигаем — паритет с прежним `saveSession`).
    const reset = await deps.sessionManager.mutateMeta(sessionId, (meta) => {
      meta.status.cancelRequested = undefined;
      meta.status.cancelRequestedAt = undefined;
      // Осознанный «Стоп» при непустой очереди: после рестарта такую сессию не
      // автозапускаем, UI показывает баннер «Обработка остановлена».
      if (meta.pendingMessages.length > 0) {
        meta.status.queueStopped = true;
        meta.status.queueStoppedAt = nowISO();
        queueStopped = true;
      }
      return meta.pendingMessages.length;
    }, { touchUpdatedAt: false });
    pending = reset.found ? reset.value : 0;
    if (pending > 0 && queueStopped) {
      deps.eventBus.publish(sessionId, 'queue.stalled', { pending_count: pending });
    }
  }

  // 4. Снятие неприменённых инъекций: best-effort — сбой хранилища/шины не
  //    должен превращать «сессия уже отменена» в ошибку ответа.
  try {
    await dropSteerInjections({
      sessionManager: deps.sessionManager,
      sessionId,
      reason: 'aborted',
      streamId: current.currentStream?.streamId,
      publishDropped: (event) => deps.eventBus.publish(sessionId, 'steer.dropped', event),
      // ADR-104 × ADR-111/ADR-113: ни ввод пользователя, ни уведомления
      // фоновых прогонов не теряем — весь остаток возвращается в очередь.
      // Автостарта нет: ход остановил пользователь, сообщение ждёт его решения
      // (видно в панели очереди).
      requeue: async (messages) => {
        return requeueMessages({
          sessionManager: deps.sessionManager,
          eventBus: deps.eventBus,
          sessionId,
          messages,
        });
      },
    });
  } catch (err) {
    if (deps.onSteerDropError) {
      deps.onSteerDropError(err);
    } else {
      console.warn(
        `[sessions] снятие очереди инъекций сессии ${sessionId} не удалось: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    sessionId,
    wasRunning: Boolean(current.currentStream)
      || Boolean(current.status?.blocked)
      || processorStopped,
    processorStopped,
    queueStopped,
    pending,
  };
}
