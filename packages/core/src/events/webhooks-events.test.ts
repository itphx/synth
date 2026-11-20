/**
 * Шов публикации `webhooks.updated` (`events/webhooks-events.ts`).
 *
 * Проверяется то, чего не видно из фабрики роутов: событие уходит в
 * **инстансный** канал шины (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 * ADR-118) — реестр подписок на исходящие события это ресурс инстанса, а не
 * сессии. Тот же хелпер ставят обе точки сборки (`mount-routes` standalone и
 * managed backend), поэтому канал фиксируем тестом: при подмене на
 * `publish(sessionId, …)` подписчики инстансного канала событие бы не получили, и
 * раздел «Webhooks» держал бы устаревший список до перезагрузки страницы.
 *
 * Второе свойство контракта — payload **минимальный по построению**: вид мутации
 * и (необязательно) id подписки. Signing-секрет (`whsec_…`), целевой URL (в нём
 * у получателя бывает токен) и прочий конфиг подписки в событие не попадают
 * никогда (инвариант 13 `AGENTS.md`).
 */
import { describe, it, expect } from 'vitest';
import type { BusEvent } from '@itphx/synth-shared';
import { EventBus, INSTANCE_EVENT_CHANNEL } from './bus.js';
import { publishWebhooksUpdated, webhooksChangedPublisher } from './webhooks-events.js';

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

describe('publishWebhooksUpdated / webhooksChangedPublisher', () => {
  it('публикует в инстансный канал с payload { action, subscriptionId }', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishWebhooksUpdated(bus, { action: 'create', subscriptionId: 'whk_1' });

    expect(events).toEqual([
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'webhooks.updated',
        data: { action: 'create', subscriptionId: 'whk_1' },
      },
    ]);
  });

  it('без subscriptionId публикует только action (реестр изменился целиком)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishWebhooksUpdated(bus, { action: 'delete' });

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ action: 'delete' });
    // Поле не добавляется даже пустой строкой — клиенту важно различать
    // «изменилась конкретная подписка» и «перечитай список целиком».
    expect('subscriptionId' in events[0]!.data).toBe(false);
  });

  it('все виды мутации доезжают до клиента без искажения', () => {
    const bus = new EventBus();
    const events = collect(bus);

    for (const action of ['create', 'update', 'delete', 'regenerate', 'revoke', 'test'] as const) {
      publishWebhooksUpdated(bus, { action, subscriptionId: 'whk_1' });
    }

    expect(events.map((e) => e.data.action)).toEqual([
      'create',
      'update',
      'delete',
      'regenerate',
      'revoke',
      'test',
    ]);
    expect(events.every((e) => e.sessionId === INSTANCE_EVENT_CHANNEL)).toBe(true);
    expect(events.every((e) => e.type === 'webhooks.updated')).toBe(true);
  });

  it('signing-секрет и целевой URL в payload не попадают (даже если передать их в info)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    // Лишние поля во входе хука — не контракт: помощник собирает payload
    // по-белому списку, а не копирует info целиком.
    publishWebhooksUpdated(bus, {
      action: 'create',
      subscriptionId: 'whk_1',
      secret: 'whsec_super-secret-signing-key',
      secretPrefix: 'whsec_sup…',
      url: 'https://hooks.example.com/ingest?token=receiver-secret-token',
      events: ['session.created'],
    } as never);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.data).sort()).toEqual(['action', 'subscriptionId']);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('whsec_super-secret-signing-key');
    expect(serialized).not.toContain('whsec_sup');
    expect(serialized).not.toContain('receiver-secret-token');
    expect(serialized).not.toContain('hooks.example.com');
  });

  it('без шины — no-op (хук необязателен), падений нет', () => {
    expect(() => publishWebhooksUpdated(undefined, { action: 'create' })).not.toThrow();
    expect(() => publishWebhooksUpdated(null, { action: 'delete' })).not.toThrow();
  });

  it('webhooksChangedPublisher — готовый хук для опций фабрики роутов', () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hook = webhooksChangedPublisher(bus);

    hook({ action: 'create', subscriptionId: 'whk_1' });
    hook({ action: 'test', subscriptionId: 'whk_1' });
    hook({ action: 'delete' });

    expect(events.map((e) => [e.sessionId, e.type, e.data])).toEqual([
      [INSTANCE_EVENT_CHANNEL, 'webhooks.updated', { action: 'create', subscriptionId: 'whk_1' }],
      [INSTANCE_EVENT_CHANNEL, 'webhooks.updated', { action: 'test', subscriptionId: 'whk_1' }],
      [INSTANCE_EVENT_CHANNEL, 'webhooks.updated', { action: 'delete' }],
    ]);
  });

  it('webhooksChangedPublisher без шины — рабочий no-op хук', () => {
    const hook = webhooksChangedPublisher(undefined);
    expect(() => hook({ action: 'create', subscriptionId: 'whk_1' })).not.toThrow();
  });
});
