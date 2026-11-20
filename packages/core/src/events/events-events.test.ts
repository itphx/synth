/**
 * Шов публикации `events.updated` (`events/events-events.ts`).
 *
 * Проверяется то, чего не видно из фабрики роутов: событие уходит в
 * **инстансный** канал шины (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 * ADR-118) — реестр приёма внешних событий это ресурс инстанса, а не сессии.
 * Тот же хелпер ставят обе точки сборки (`mount-routes` standalone и managed
 * backend), поэтому канал фиксируем тестом: при подмене на `publish(sessionId, …)`
 * подписчики инстансного канала событие бы не получили, и раздел «События»
 * держал бы устаревший реестр до перезагрузки страницы.
 *
 * Второе свойство контракта — payload **минимальный по построению**: вид мутации
 * и (необязательно) id привязки/правила. Секрет API-ключа (`synth_evt_…`), его
 * хеш, id самого ключа и тело привязки/правила в событие не попадают никогда
 * (инвариант 13 `AGENTS.md`).
 */
import { describe, it, expect } from 'vitest';
import type { BusEvent } from '@itphx/synth-shared';
import { EventBus, INSTANCE_EVENT_CHANNEL } from './bus.js';
import { publishEventsUpdated, eventsChangedPublisher } from './events-events.js';

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

describe('publishEventsUpdated / eventsChangedPublisher', () => {
  it('публикует в инстансный канал с payload { action, bindingId }', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishEventsUpdated(bus, { action: 'binding.create', bindingId: 'bdg_1' });

    expect(events).toEqual([
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'events.updated',
        data: { action: 'binding.create', bindingId: 'bdg_1' },
      },
    ]);
  });

  it('мутация ключа несёт id привязки, но не id ключа (список перечитывается по привязке)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishEventsUpdated(bus, { action: 'key.revoke', bindingId: 'bdg_1' });

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ action: 'key.revoke', bindingId: 'bdg_1' });
  });

  it('без id публикует только action (поле не добавляется даже пустым)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishEventsUpdated(bus, { action: 'route.delete' });

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ action: 'route.delete' });
    expect('bindingId' in events[0]!.data).toBe(false);
    expect('routeId' in events[0]!.data).toBe(false);
  });

  it('все виды мутации доезжают до клиента без искажения', () => {
    const bus = new EventBus();
    const events = collect(bus);

    const actions = [
      'binding.create',
      'binding.update',
      'binding.delete',
      'key.create',
      'key.update',
      'key.revoke',
      'key.delete',
      'route.create',
      'route.update',
      'route.delete',
    ] as const;
    for (const action of actions) publishEventsUpdated(bus, { action });

    expect(events.map((e) => e.data.action)).toEqual([...actions]);
    expect(events.every((e) => e.sessionId === INSTANCE_EVENT_CHANNEL)).toBe(true);
    expect(events.every((e) => e.type === 'events.updated')).toBe(true);
  });

  it('секрет ключа, хеш и id ключа в payload не попадают (даже если передать их в info)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    // Лишние поля во входе хука — не контракт: помощник собирает payload
    // по-белому списку, а не копирует info целиком.
    publishEventsUpdated(bus, {
      action: 'key.create',
      bindingId: 'bdg_1',
      keyId: 'eak_1',
      key: 'synth_evt_super-secret-api-key',
      hash: 'sha256:deadbeef',
      secretPrefix: 'synth_evt_ab…',
      label: 'ci-key',
    } as never);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.data).sort()).toEqual(['action', 'bindingId']);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('synth_evt_super-secret-api-key');
    expect(serialized).not.toContain('sha256:deadbeef');
    expect(serialized).not.toContain('synth_evt_ab');
    expect(serialized).not.toContain('eak_1');
    expect(serialized).not.toContain('ci-key');
  });

  it('без шины — no-op (хук необязателен), падений нет', () => {
    expect(() => publishEventsUpdated(undefined, { action: 'binding.create' })).not.toThrow();
    expect(() => publishEventsUpdated(null, { action: 'route.delete' })).not.toThrow();
  });

  it('eventsChangedPublisher — готовый хук для опций фабрики роутов', () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hook = eventsChangedPublisher(bus);

    hook({ action: 'binding.create', bindingId: 'bdg_1' });
    hook({ action: 'key.create', bindingId: 'bdg_1' });
    hook({ action: 'route.update', routeId: 'rte_1' });
    hook({ action: 'binding.delete', bindingId: 'bdg_1' });

    expect(events.map((e) => [e.sessionId, e.type, e.data])).toEqual([
      [INSTANCE_EVENT_CHANNEL, 'events.updated', { action: 'binding.create', bindingId: 'bdg_1' }],
      [INSTANCE_EVENT_CHANNEL, 'events.updated', { action: 'key.create', bindingId: 'bdg_1' }],
      [INSTANCE_EVENT_CHANNEL, 'events.updated', { action: 'route.update', routeId: 'rte_1' }],
      [INSTANCE_EVENT_CHANNEL, 'events.updated', { action: 'binding.delete', bindingId: 'bdg_1' }],
    ]);
  });

  it('eventsChangedPublisher без шины — рабочий no-op хук', () => {
    const hook = eventsChangedPublisher(undefined);
    expect(() => hook({ action: 'binding.create', bindingId: 'bdg_1' })).not.toThrow();
  });
});
