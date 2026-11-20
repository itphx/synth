/**
 * Шов публикации `identities.updated` (`events/identities-events.ts`).
 *
 * Проверяется то, чего не видно из фабрики роутов: событие уходит в
 * **инстансный** канал шины (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 * ADR-118) — у идентичностей нет сессии. Тот же хелпер ставят обе точки сборки,
 * поэтому канал фиксируем тестом: при подмене на `publish(sessionId, …)`
 * подписчики инстансного канала событие бы не получили, и панель профиля
 * держала бы устаревший список до перезагрузки страницы.
 *
 * Второе свойство контракта — payload **пустой по построению**: только вид
 * мутации. `provider`/`externalId` — персональные данные человека, а канал
 * доставляется ещё и watch-all администраторам; claim-кода и токенов в событии
 * нет тем более (инвариант 13 `AGENTS.md`).
 */
import { describe, it, expect } from 'vitest';
import type { BusEvent } from '@itphx/synth-shared';
import { EventBus, INSTANCE_EVENT_CHANNEL } from './bus.js';
import { publishIdentitiesUpdated, identitiesChangedPublisher } from './identities-events.js';

interface ReceivedEvent {
  sessionId: string;
  type: string;
  data: Record<string, unknown>;
}

/** Шина + сборщик всех доставленных событий (глобальная подписка). */
function collect(bus: EventBus): ReceivedEvent[] {
  const events: ReceivedEvent[] = [];
  bus.subscribeAll((event: BusEvent) => {
    events.push({ sessionId: event.sessionId, type: event.type, data: event.data });
  });
  return events;
}

describe('publishIdentitiesUpdated / identitiesChangedPublisher', () => {
  it('публикует в инстансный канал с payload { action }', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishIdentitiesUpdated(bus, { action: 'claim' });

    expect(events).toEqual([
      { sessionId: INSTANCE_EVENT_CHANNEL, type: 'identities.updated', data: { action: 'claim' } },
    ]);
  });

  it('оба вида мутации доезжают до клиента без искажения', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishIdentitiesUpdated(bus, { action: 'claim' });
    publishIdentitiesUpdated(bus, { action: 'delete' });

    expect(events.map((e) => e.data.action)).toEqual(['claim', 'delete']);
    expect(events.every((e) => e.sessionId === INSTANCE_EVENT_CHANNEL)).toBe(true);
    expect(events.every((e) => e.type === 'identities.updated')).toBe(true);
  });

  it('идентификаторов, claim-кода и токенов в payload нет (даже если передать их в info)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    // Лишние поля во входе хука — не контракт: помощник собирает payload
    // по-белому списку, а не копирует info целиком.
    publishIdentitiesUpdated(bus, {
      action: 'claim',
      identityId: 'tg:450316139',
      provider: 'tg',
      externalId: '450316139',
      code: 'AB12CD',
      token: 'synth_evt_secret',
      linkedBy: 'u1',
    } as never);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.data)).toEqual(['action']);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('450316139');
    expect(serialized).not.toContain('AB12CD');
    expect(serialized).not.toContain('synth_evt_secret');
    expect(serialized).not.toContain('tg:');
    expect(serialized).not.toContain('u1');
  });

  it('без шины — no-op (хук необязателен), падений нет', () => {
    expect(() => publishIdentitiesUpdated(undefined, { action: 'claim' })).not.toThrow();
    expect(() => publishIdentitiesUpdated(null, { action: 'delete' })).not.toThrow();
  });

  it('identitiesChangedPublisher — готовый хук для опций фабрики роутов', () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hook = identitiesChangedPublisher(bus);

    hook({ action: 'claim' });
    hook({ action: 'delete' });

    expect(events.map((e) => [e.sessionId, e.type, e.data])).toEqual([
      [INSTANCE_EVENT_CHANNEL, 'identities.updated', { action: 'claim' }],
      [INSTANCE_EVENT_CHANNEL, 'identities.updated', { action: 'delete' }],
    ]);
  });

  it('identitiesChangedPublisher без шины — рабочий no-op хук', () => {
    const hook = identitiesChangedPublisher(undefined);
    expect(() => hook({ action: 'claim' })).not.toThrow();
  });
});
