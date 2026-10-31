/**
 * ADR-118 §5: серверный снимок **живого шага** (in-memory).
 *
 * Зачем. Содержимое шага, который ещё стримится, складывается у клиента из
 * дельт (`part.delta`/`part.updated`). Если открыть сессию посреди хода
 * (переключение вкладки, перезагрузка страницы, второй клиент), лента может
 * показать только то, что сервер успел **персистить** (запись с троттлингом),
 * а остальное дорисуется со следующим чанком — «мелькает и пропадает».
 *
 * Решение. Ядро держит актуальный снимок стримящегося шага (текст, reasoning,
 * части) и отдаёт его в DTO сессии (`GET /api/v2/sessions/:id` →
 * `current_stream.live`). Клиент восстанавливает шаг по снимку целиком, без
 * ожидания следующей дельты. Хранилище не трогается: снимок — производное
 * состояние процесса (после рестарта источник — история).
 *
 * Инварианты:
 * - снимок привязан к `streamId`: после завершения хода/нового стрима старый
 *   снимок не отдаётся (`current_stream` сменился или снят);
 * - `step.finished` снимает снимок (`clearLiveStreamSnapshotByMessage`) —
 *   финальный шаг читается из истории;
 * - память ограничена (TTL + число сессий), записи не накапливаются.
 */
import type { Part } from '@itphx/synth-shared';

export interface LiveStreamSnapshot {
  /** Живой стрим, к которому относится шаг (`session.currentStream.streamId`). */
  streamId: string;
  /** Id хода (`turn_...`), если известен. */
  turnId?: string;
  /** Id сообщения шага (assistant). */
  messageId: string;
  /** Индекс шага в ходе. */
  stepIndex?: number;
  /** Накопленный текст шага. */
  content: string;
  /** Накопленные рассуждения шага. */
  reasoning?: string;
  /** Части шага (детерминированные id, как у `part.delta`/`part.updated`). */
  parts: Part[];
  /** Момент последнего обновления (ISO). */
  updatedAt: string;
}

/** Снимок живёт не дольше этого времени без обновлений. */
const TTL_MS = 30 * 60_000;
/** Предел числа сессий со снимком (защита от утечки при многих сессиях). */
const MAX_SESSIONS = 500;

const bySession = new Map<string, LiveStreamSnapshot>();
const sessionByMessage = new Map<string, string>();

/** Записать/заменить снимок живого шага сессии. */
export function setLiveStreamSnapshot(sessionId: string, snapshot: LiveStreamSnapshot): void {
  if (!sessionId) return;
  if (bySession.size >= MAX_SESSIONS && !bySession.has(sessionId)) {
    evictExpired();
    if (bySession.size >= MAX_SESSIONS) {
      // Всё ещё переполнено — снимаем самую старую запись.
      const oldest = bySession.keys().next().value as string | undefined;
      if (oldest) bySession.delete(oldest);
    }
  }
  const previous = bySession.get(sessionId);
  if (previous && previous.messageId !== snapshot.messageId) {
    sessionByMessage.delete(previous.messageId);
  }
  bySession.set(sessionId, snapshot);
  sessionByMessage.set(snapshot.messageId, sessionId);
}

/**
 * Снимок живой сессии. `streamId` (если задан) должен совпасть — иначе
 * снимок относится к завершившемуся/прошлому стриму и не отдаётся.
 */
export function getLiveStreamSnapshot(
  sessionId: string,
  streamId?: string | null,
): LiveStreamSnapshot | null {
  const snapshot = bySession.get(sessionId);
  if (!snapshot) return null;
  if (streamId !== undefined && streamId !== null && snapshot.streamId !== streamId) return null;
  if (Date.now() - Date.parse(snapshot.updatedAt) > TTL_MS) {
    clearLiveStreamSnapshot(sessionId);
    return null;
  }
  return snapshot;
}

/** Снять снимок сессии (опционально — только для указанного сообщения шага). */
export function clearLiveStreamSnapshot(sessionId: string, messageId?: string): void {
  const snapshot = bySession.get(sessionId);
  if (!snapshot) return;
  if (messageId && snapshot.messageId !== messageId) return;
  bySession.delete(sessionId);
  sessionByMessage.delete(snapshot.messageId);
}

/** Снять снимок по id сообщения шага (зовётся на `step.finished`). */
export function clearLiveStreamSnapshotByMessage(messageId: string): void {
  if (!messageId) return;
  const sessionId = sessionByMessage.get(messageId);
  if (!sessionId) return;
  sessionByMessage.delete(messageId);
  const snapshot = bySession.get(sessionId);
  if (snapshot && snapshot.messageId === messageId) bySession.delete(sessionId);
}

/** Полный сброс (тесты). */
export function resetLiveStreamSnapshots(): void {
  bySession.clear();
  sessionByMessage.clear();
}

/** Число записей (диагностика/тесты). */
export function liveStreamSnapshotCount(): number {
  return bySession.size;
}

function evictExpired(): void {
  const now = Date.now();
  for (const [sessionId, snapshot] of bySession) {
    if (now - Date.parse(snapshot.updatedAt) > TTL_MS) {
      bySession.delete(sessionId);
      sessionByMessage.delete(snapshot.messageId);
    }
  }
}
