/**
 * PROP-143: durable-запись причины остановки хода — **общий писатель**.
 *
 * Модуль `engine/stop-reason.ts` — нормализатор (формат конверта и записи).
 * Здесь — единственная точка, которая **пишет** запись в историю сессии:
 * идемпотентно (не более одной записи на ключ дедупликации), с обфускацией
 * тела (ADR-036) и публикацией `message.added` (инвариант 27 — мутация,
 * видимая другому клиенту, обязана уйти в шину).
 *
 * Ключ дедупликации (`dedupeKey`) — обычно id потока хода (`streamId`):
 * повторный терминальный статус того же хода второй записи не добавляет
 * (PROP-143 §6 «Идемпотентность»).
 *
 * Ошибка записи **не должна** ломать ход: вызывающая сторона ловит её и
 * пишет warning — остановка уже состоялась, а её фиксация — best-effort.
 */
import type { Message } from '@itphx/synth-shared';
import type { SessionManager } from '../sessions/manager.js';
import type { EventBus } from '../events/bus.js';
import { serializeMessage } from '../server/serialize.js';
import { STOP_MESSAGE_TYPE, buildStopRecord } from './stop-reason.js';
import type { StopRecordInput } from './stop-reason.js';

/** Вход общего писателя записи причины остановки. */
export interface AppendStopRecordOptions {
  /** Менеджер сессий — точечная дозапись сообщения в историю (ADR-096/ADR-144). */
  sessionManager: SessionManager;
  /** Шина сессии — публикация `message.added` (инвариант 27). Не задана — без события. */
  eventBus?: EventBus;
  /** Сессия, в историю которой пишется запись. */
  sessionId: string;
  /** Причина остановки и её машинно-читаемые детали. */
  input: StopRecordInput;
  /**
   * Ключ идемпотентности (обычно `streamId` хода). Задана — запись с тем же
   * ключом в истории не создаётся второй раз.
   */
  dedupeKey?: string;
  /**
   * Дополнительные поля метаданных записи (PROP-143): мержатся **после**
   * `buildStopRecord` и **до** `dedupe_key` — итог:
   * `{...metadata записи, ...metadata, ...(dedupe_key)}`.
   *
   * `dedupe_key` ставится после merge — перекрыть его нельзя. Служебные поля
   * записи (маркер `execution_stopped`, `reason`) обфускация тела не теряет —
   * они восстанавливаются из снимка метаданных (см. ниже); но в `metadata`
   * их передавать не нужно: поле перекроет маркер записи.
   */
  metadata?: Record<string, unknown>;
  /** Обфускация тела записи (ADR-036): текст провайдера может нести ключи/URL. */
  obfuscate?: (message: Message) => Promise<Message>;
}

/**
 * Есть ли в истории сессии запись остановки с указанным ключом дедупликации.
 *
 * Ищется служебное сообщение остановки (`metadata.type === 'execution_stopped'`)
 * с совпадающим `metadata.dedupe_key`.
 */
export async function hasStopRecord(
  sessionManager: SessionManager,
  sessionId: string,
  dedupeKey: string,
): Promise<boolean> {
  const session = await sessionManager.getSession(sessionId);
  if (!session) return false;
  return session.messages.some(
    (m) => m.metadata?.type === STOP_MESSAGE_TYPE && m.metadata?.dedupe_key === dedupeKey,
  );
}

/**
 * Записать причину остановки в историю сессии (идемпотентно).
 *
 * Порядок: проверка дедупликации → сборка записи (`buildStopRecord`) →
 * слияние доп. метаданных (`opts.metadata`) → `dedupe_key` → обфускация тела →
 * точечная дозапись в историю → публикация `message.added`.
 *
 * Возвращает `appended: false`, если запись с тем же ключом уже есть (или
 * сессия недоступна для записи) — повторный терминальный статус того же хода
 * второй записи не добавляет.
 */
export async function appendStopRecord(
  opts: AppendStopRecordOptions,
): Promise<{ appended: boolean; message?: Message }> {
  const { sessionManager, eventBus, sessionId, input, dedupeKey, metadata, obfuscate } = opts;

  if (dedupeKey && (await hasStopRecord(sessionManager, sessionId, dedupeKey))) {
    return { appended: false };
  }

  let message = buildStopRecord(input);
  // Дополнительные поля записи — после сборки и до `dedupe_key`
  // (`dedupe_key` служебный и не перекрывается пользовательскими полями).
  if (metadata) {
    message.metadata = { ...message.metadata, ...metadata };
  }
  if (dedupeKey) {
    message.metadata = { ...message.metadata, dedupe_key: dedupeKey };
  }

  if (obfuscate) {
    // Метаданные записи (маркер `execution_stopped`, ключ дедупликации) —
    // служебные: обфускация тела их терять не должна.
    const metadata = message.metadata;
    const obfuscated = await obfuscate(message);
    message = {
      ...obfuscated,
      metadata: { ...metadata, ...(obfuscated.metadata ?? {}) },
    };
  }

  const updated = await sessionManager.addMessage(sessionId, message);
  if (!updated) return { appended: false };

  // Позиция записи — по id (порт назначает `seq`/`ord` при дозаписи).
  const found = updated.messages.findIndex((m) => m.id === message.id);
  const index = found >= 0 ? found : updated.messages.length - 1;
  const persisted = updated.messages[index] ?? message;

  if (eventBus) {
    eventBus.publish(sessionId, 'message.added', {
      message: serializeMessage(persisted, index),
      index,
    });
  }

  return { appended: true, message: persisted };
}
