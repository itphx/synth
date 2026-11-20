/**
 * Шов публикации `users.updated` (`events/users-events.ts`).
 *
 * Проверяется то, чего не видно из фабрики роутов: событие уходит в
 * **инстансный** канал шины (`EventBus.publishInstance`, ADR-118) — каталог
 * пользователей это ресурс инстанса, а не сессии. Тот же хелпер ставит точка
 * сборки (`app/mount-routes.ts`), поэтому канал фиксируем тестом: при подмене на
 * `publish(sessionId, …)` UI-подписчики инстансного канала событие бы не
 * получили, и админ-панель «Пользователи» держала бы снимок до перезагрузки.
 *
 * Второй предмет проверки — **состав payload'а**: только `userId` и вид мутации
 * (`action`). Почта, телефон, заметки, роли и идентичности в событие не попадают
 * никогда (инвариант 13 корневого `AGENTS.md`) — это свойство типа payload'а, но
 * проверяем фактическую запись в шину, а не декларацию типа.
 */
import { describe, it, expect } from 'vitest';
import type { BusEvent, EventType } from '@itphx/synth-shared';
import { EventBus, INSTANCE_EVENT_CHANNEL } from '@itphx/synth-core';
import { publishUsersUpdated, usersChangedPublisher } from './users-events.js';

interface ReceivedEvent {
  sessionId: string;
  type: string;
  data: Record<string, unknown>;
}

/**
 * Шина + сборщик всех доставленных событий (глобальная подписка).
 *
 * `subscribeAll` отдаёт **один** объект `BusEvent` (`sessionId`/`type`/`data`/
 * `timestamp`) — сборщик разбирает его по полям.
 */
function collect(bus: EventBus): ReceivedEvent[] {
  const events: ReceivedEvent[] = [];
  bus.subscribeAll((event: BusEvent) => {
    events.push({ sessionId: event.sessionId, type: event.type, data: event.data });
  });
  return events;
}

describe('publishUsersUpdated / usersChangedPublisher', () => {
  it('публикует в инстансный канал с payload { action, userId }', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishUsersUpdated(bus, { action: 'create', userId: 'u-2' });

    expect(events).toEqual([
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'users.updated',
        data: { action: 'create', userId: 'u-2' },
      },
    ]);
  });

  it('без userId в payload попадает только вид мутации', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishUsersUpdated(bus, { action: 'update' });

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ action: 'update' });
    expect('userId' in events[0]!.data).toBe(false);
  });

  it('payload — ровно два поля: никаких почты, ролей, заметок и токенов', () => {
    const bus = new EventBus();
    const events = collect(bus);

    // Хук типизирован `{userId?, action}`; лишние поля имитируют ошибку
    // вызывающего (например, передачу всего профиля целиком).
    publishUsersUpdated(bus, {
      action: 'update',
      userId: 'u-2',
      email: 'leak@example.com',
      notes: 'секретная заметка',
      roles: ['ADMIN'],
      token: 'synth_svc_deadbeef',
    } as never);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.data).sort()).toEqual(['action', 'userId']);
    const serialized = JSON.stringify(events[0]!.data);
    expect(serialized).not.toContain('leak@example.com');
    expect(serialized).not.toContain('секретная заметка');
    expect(serialized).not.toContain('ADMIN');
    expect(serialized).not.toContain('synth_svc_');
  });

  it('без шины — no-op (хук необязателен), падений нет', () => {
    expect(() => publishUsersUpdated(undefined, { action: 'create', userId: 'u-2' })).not.toThrow();
    expect(() => publishUsersUpdated(null, { action: 'delete', userId: 'u-2' })).not.toThrow();
  });

  it('usersChangedPublisher — готовый хук для опций фабрики роутов', () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hook = usersChangedPublisher(bus);

    hook({ action: 'create', userId: 'u-2' });
    hook({ action: 'update', userId: 'u-2' });
    hook({ action: 'delete', userId: 'u-2' });

    expect(events.map((e) => [e.sessionId, e.type as EventType, e.data])).toEqual([
      [INSTANCE_EVENT_CHANNEL, 'users.updated', { action: 'create', userId: 'u-2' }],
      [INSTANCE_EVENT_CHANNEL, 'users.updated', { action: 'update', userId: 'u-2' }],
      [INSTANCE_EVENT_CHANNEL, 'users.updated', { action: 'delete', userId: 'u-2' }],
    ]);
  });

  it('usersChangedPublisher без шины — хук молчит и не падает', () => {
    const hook = usersChangedPublisher(undefined);

    expect(() => hook({ action: 'delete', userId: 'u-2' })).not.toThrow();
  });
});
