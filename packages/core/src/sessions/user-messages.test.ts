/**
 * PROP-141 (Часть B): классификация user-сообщений истории сессии
 * (`sessions/user-messages.ts`).
 *
 * Срабатывание таймера/будильника попадает в историю как `role: 'user'`
 * (`metadata.type === 'timer_fired'`, автор `Timer`), но это **служебное**
 * сообщение системы, а не реплика человека: авто-тайтл, границы хода и
 * статистика автора не должны считать его второй репликой пользователя.
 *
 * Проверяется:
 *   • `timer_fired` → `isServiceUserMessage` = true, `isUserDialogueMessage` = false;
 *   • контроль: обычное user-сообщение → false/true соответственно;
 *   • реальный продюсер сообщения (`eventToMessage`) даёт служебное сообщение.
 */
import { describe, it, expect } from 'vitest';
import { MessageRole } from '@itphx/synth-shared';
import type { Message, SynthEvent } from '@itphx/synth-shared';
import { isServiceUserMessage, isUserDialogueMessage } from './user-messages.js';
import { eventToMessage } from '../engine/events/request-session.js';

/** Минимальное сообщение истории (только поля, нужные классификации). */
function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [],
    content: 'текст',
    createdAt: '2026-11-17T10:00:00.000Z',
    disabled: false,
    pinned: false,
    hidden: false,
    ...overrides,
  };
}

/** Событие срабатывания таймера (как его публикует движок таймеров). */
function timerEvent(overrides: Partial<SynthEvent> = {}): SynthEvent {
  return {
    id: 'evt_timer_1',
    source: 'timer',
    type: 'timer_fired',
    payload: {
      sessionId: 'ses_1',
      timerId: 'tmr_1',
      kind: 'timer',
      repeat: 'once',
      comment: 'позвонить в сервис',
      scheduledFor: '2026-11-17T10:00:00.000Z',
      firedAt: '2026-11-17T10:00:00.500Z',
    },
    identity: {},
    dedupKey: 'timer:tmr_1:2026-11-17T10:00:00.000Z',
    ts: '2026-11-17T10:00:00.500Z',
    ...overrides,
  };
}

describe('Классификация user-сообщений: срабатывание таймера (PROP-141)', () => {
  it('timer_fired — служебное сообщение, а не реплика человека', () => {
    const message = makeMessage({
      role: MessageRole.USER,
      author: 'Timer',
      metadata: {
        type: 'timer_fired',
        timer_id: 'tmr_1',
        comment: 'позвонить в сервис',
      },
    });

    expect(isServiceUserMessage(message)).toBe(true);
    expect(isUserDialogueMessage(message)).toBe(false);
  });

  it('контроль: обычное user-сообщение — реплика диалога', () => {
    const message = makeMessage({
      role: MessageRole.USER,
      content: 'посчитай до трёх',
    });

    expect(isServiceUserMessage(message)).toBe(false);
    expect(isUserDialogueMessage(message)).toBe(true);
  });

  it('сообщение, собранное продюсером (eventToMessage), — служебное', () => {
    const message = eventToMessage(timerEvent());

    expect(message.role).toBe(MessageRole.USER);
    expect(message.metadata?.type).toBe('timer_fired');
    expect(isServiceUserMessage(message)).toBe(true);
    expect(isUserDialogueMessage(message)).toBe(false);
  });

  it('роль важна: timer_fired в assistant-сообщении — не реплика диалога', () => {
    const message = makeMessage({
      role: MessageRole.ASSISTANT,
      metadata: { type: 'timer_fired' },
    });

    expect(isServiceUserMessage(message)).toBe(true);
    expect(isUserDialogueMessage(message)).toBe(false);
  });
});
