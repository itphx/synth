/**
 * PROP-143: durable-запись о фоновом прогоне, потерянном при рестарте.
 *
 * Точка записи — **общий писатель** `engine/stop-record.ts`: запись причины
 * остановки попадает в историю сессии-владельца как служебное `user`-сообщение
 * с маркером `metadata.type = 'execution_stopped'` (PROP-143 §1).
 *
 * Смысл: после рестарта прогон реестра помечен `orphaned`, но **человек и
 * родитель** об этом узнают только из реестра (`GET /api/v2/processes`) —
 * в истории сессии следов нет. Запись «исполнение прервано рестартом»
 * возвращает факт в контекст (PROP-143 §4 п.3).
 *
 * Инварианты:
 * 1. **Идемпотентность**: ключ дедупликации — `background:<id прогона>`;
 *    повторный вызов (например, второй рестарт) второй записи не добавляет.
 * 2. **Ход не запускается**: пишется только служебное сообщение — очередь и
 *    автоход не трогаются (это не уведомление о результате, а факт обрыва).
 * 3. **Ошибка одной записи не мешает остальным**: сбой записи/хранилища
 *    ловится, логируется и цикл идёт дальше; успешные записи считаются.
 */
import type { BackgroundRunRecord } from '@itphx/synth-shared';
import type { EventBus } from '../../events/bus.js';
import type { SessionManager } from '../../sessions/manager.js';
import { appendStopRecord } from '../stop-record.js';
import type { BackgroundLogger } from './types.js';

/**
 * Технический маркер рестарта в `summary` записи реестра.
 *
 * Это значение ставит `BackgroundRunService.recoverOnStart`
 * (`packages/core/src/engine/background/service.ts`) при переводе прогона в
 * `orphaned`. Тело конверта — это **содержательный** итог прогона, а маркер
 * рестарта в нём дублировать не нужно: он и так выражен причиной `restart`,
 * а тело получает локализованный текст (`stop.restarted`).
 */
const RESTART_SUMMARY_MARKER = 'interrupted by restart';

/** Зависимости записи о потерянных прогонах. */
export interface LostRunRecordOptions {
  /** Менеджер сессий — точечная дозапись сообщения в историю (ADR-096/ADR-144). */
  sessionManager: SessionManager;
  /** Шина сессии — публикация `message.added` (инвариант 27). Не задана — без события. */
  eventBus?: EventBus;
  /** Записи реестра, переведённые в `orphaned` (результат `recoverOnStart`). */
  records: readonly BackgroundRunRecord[];
  /**
   * Логгер (тот же контракт, что у сервиса реестра). Не задан — ошибки записи
   * не логируются (модуль не печатает в консоль сам).
   */
  logger?: BackgroundLogger;
}

/**
 * Записать в историю сессий-владельцев факт прерывания фоновых прогонов.
 *
 * Для каждой записи пишется durable-запись причины остановки:
 * `reason: 'restart'`, ключ дедупликации `background:<id прогона>`, в
 * метаданных — id/вид прогона и его детали (дочерняя сессия, процесс,
 * команда, описание).
 *
 * Тело конверта — **содержательный** итог прогона (`summary`); технический
 * маркер рестарта (`interrupted by restart`) в тело не попадает — вместо него
 * локализованный текст причины (`stop.restarted`).
 *
 * @returns число **записанных** записей (уже существующие по ключу
 *          дедупликации не считаются).
 */
export async function appendLostRunRecords(opts: LostRunRecordOptions): Promise<number> {
  let written = 0;
  for (const record of opts.records) {
    try {
      // Содержательный итог прогона; маркер рестарта — технический, в тело
      // конверта не идёт (причина `restart` его уже выражает).
      const summary =
        record.summary && record.summary !== RESTART_SUMMARY_MARKER ? record.summary : undefined;
      const result = await appendStopRecord({
        sessionManager: opts.sessionManager,
        ...(opts.eventBus ? { eventBus: opts.eventBus } : {}),
        sessionId: record.sessionId,
        input: {
          reason: 'restart',
          ...(summary ? { error: summary } : {}),
        },
        dedupeKey: `background:${record.id}`,
        metadata: {
          background_run_id: record.id,
          background_run_kind: record.kind,
          ...(record.childSessionId ? { child_session_id: record.childSessionId } : {}),
          ...(record.processId ? { process_id: record.processId } : {}),
          ...(record.command ? { command: record.command } : {}),
          ...(record.description ? { description: record.description } : {}),
        },
      });
      if (result.appended) written += 1;
    } catch (err) {
      opts.logger?.warn?.(
        `[background] запись о прерванном прогоне ${record.id} не добавлена: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return written;
}
