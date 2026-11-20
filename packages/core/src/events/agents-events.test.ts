/**
 * Шов публикации `agents.updated` (`events/agents-events.ts`).
 *
 * Проверяется то, чего не видно из фабрик роутов и тулов: событие уходит в
 * **инстансный** канал шины (`EventBus.publishInstance`, ADR-118) — агент это
 * ресурс инстанса, а не сессии. Тот же хелпер ставят обе точки сборки
 * (`mount-routes` standalone и managed backend), поэтому канал фиксируем тестом:
 * при подмене на `publish(sessionId, …)` UI-подписчики инстансного канала
 * событие бы не получили.
 */
import { describe, it, expect } from 'vitest';
import type { BusEvent, EventType } from '@itphx/synth-shared';
import { EventBus, INSTANCE_EVENT_CHANNEL } from './bus.js';
import { agentsChangedPublisher, publishAgentsUpdated } from './agents-events.js';

interface ReceivedEvent {
  sessionId: string;
  type: string;
  data: Record<string, unknown>;
}

/**
 * Шина + сборщик всех доставленных событий (глобальная подписка).
 *
 * `subscribeAll` отдаёт **один** объект `BusEvent` (`sessionId`/`type`/`data`/
 * `timestamp`), а не три аргумента — сборщик разбирает его по полям.
 */
function collect(bus: EventBus): ReceivedEvent[] {
  const events: ReceivedEvent[] = [];
  bus.subscribeAll((event: BusEvent) => {
    events.push({ sessionId: event.sessionId, type: event.type, data: event.data });
  });
  return events;
}

describe('publishAgentsUpdated / agentsChangedPublisher', () => {
  it('публикует в инстансный канал с payload { id, action }', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishAgentsUpdated(bus, { id: 'fixer', action: 'save' });

    expect(events).toEqual([
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'agents.updated',
        data: { action: 'save', id: 'fixer' },
      },
    ]);
  });

  it('пустой id в payload не попадает (изменение реестра целиком)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishAgentsUpdated(bus, { id: '', action: 'reset' });

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ action: 'reset' });
    expect('id' in events[0]!.data).toBe(false);
  });

  it('без шины — no-op (хук необязателен), падений нет', () => {
    expect(() => publishAgentsUpdated(undefined, { id: 'fixer', action: 'save' })).not.toThrow();
    expect(() => publishAgentsUpdated(null, { id: 'fixer', action: 'delete' })).not.toThrow();
  });

  it('agentsChangedPublisher — готовый хук для опций фабрики роутов', () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hook = agentsChangedPublisher(bus);

    hook({ id: 'admin', action: 'enable' });
    hook({ id: 'admin', action: 'delete' });

    expect(events.map((e) => [e.sessionId, e.type as EventType, e.data])).toEqual([
      [INSTANCE_EVENT_CHANNEL, 'agents.updated', { action: 'enable', id: 'admin' }],
      [INSTANCE_EVENT_CHANNEL, 'agents.updated', { action: 'delete', id: 'admin' }],
    ]);
  });
});
