/**
 * Классификация user-сообщений истории сессии.
 *
 * В историю попадают не только реплики пользователя: steer-инъекции (ADR-104),
 * уведомления фоновых прогонов (ADR-111/ADR-113), сообщения шедулера (ADR-051),
 * срабатывания таймеров (PROP-141) и синтетические/локальные (`ephemeral`)
 * сообщения тоже имеют `role: 'user'`.
 * Для потребителей, которым нужен именно **диалог** (авто-тайтл, подсчёт
 * реплик в финализации хода), служебные сообщения не должны считаться второй
 * репликой пользователя — иначе, например, steer-инъекция, персистящаяся на
 * границе шага, блокировала авто-заголовок.
 */
import { MessageRole, STEER_METADATA_KEY } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';

/** Поля сообщения, нужные для классификации (структурно совместимо с `Message`). */
export type ClassifiableUserMessage = Pick<Message, 'author' | 'ephemeral' | 'metadata'>;

/**
 * Служебное user-сообщение: не является репликой пользователя в диалоге.
 *
 * Признаки (любой): `ephemeral` (локальный ответ `/`-команды), `synthetic`
 * (системные state-сообщения), steer-инъекция (`metadata.steer`), уведомление
 * фонового прогона (`metadata.type === 'background_run_result'`), сообщение
 * шедулера (`metadata.scheduler` / `schedule_id` / `author === 'Scheduler'`),
 * вложение тула (`metadata.source === 'tool-attachment'` — медиа-реплика
 * текущего хода, см. `_injectToolAttachments`), срабатывание таймера
 * (`metadata.type === 'timer_fired'` — PROP-141, Часть B), уведомление о
 * переносе сессии (`metadata.type === 'session_moved'` — PROP-141, Часть D).
 */
export function isServiceUserMessage(message: ClassifiableUserMessage): boolean {
  if (message.ephemeral) return true;
  const meta = message.metadata;
  if (meta?.synthetic) return true;
  if (meta?.[STEER_METADATA_KEY] === true) return true;
  if (meta?.type === 'background_run_result') return true;
  if (meta?.scheduler === true) return true;
  if (meta?.schedule_id !== undefined) return true;
  if (meta?.source === 'tool-attachment') return true;
  // PROP-141: срабатывание таймера/будильника — служебное сообщение системы,
  // а не реплика человека (авто-тайтл, границы хода, статистика автора).
  if (meta?.type === 'timer_fired') return true;
  // PROP-141 (Часть D): уведомление о переносе сессии между проектами —
  // служебное сообщение системы, а не реплика человека.
  if (meta?.type === 'session_moved') return true;
  if (message.author === 'Scheduler') return true;
  return false;
}

/**
 * Служебное user-сообщение, **не открывающее свой ход**: приходит в историю
 * внутри чужого хода (вложение тула, ADR-115) или вовсе без хода
 * (уведомление о переносе сессии, PROP-141 — ход не запускается).
 *
 * Такое сообщение не сдвигает границу хода (`engine/context/disabled-turns.ts`)
 * и не становится границей автора в статистике (`sessions/stats.ts`).
 */
export function isNonTurnServiceUserMessage(message: ClassifiableUserMessage): boolean {
  if (!isServiceUserMessage(message)) return false;
  const meta = message.metadata;
  return meta?.source === 'tool-attachment' || meta?.type === 'session_moved';
}

/** Реплика пользователя диалога: `role: 'user'` и не служебное сообщение. */
export function isUserDialogueMessage(
  message: ClassifiableUserMessage & Pick<Message, 'role'>,
): boolean {
  return message.role === MessageRole.USER && !isServiceUserMessage(message);
}
