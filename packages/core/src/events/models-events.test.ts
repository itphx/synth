/**
 * Шов публикации `models.updated` (`events/models-events.ts`).
 *
 * Проверяется то, чего не видно из фабрик роутов: событие уходит в
 * **инстансный** канал шины (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 * ADR-118) — каталог провайдеров/моделей это ресурс инстанса, а не сессии. Тот
 * же хелпер ставят обе точки сборки (`mount-routes` standalone и managed
 * backend) и две фабрики роутов (`createProviderRoutes`, `createModelRoutes`),
 * поэтому канал фиксируем тестом: при подмене на `publish(sessionId, …)`
 * подписчики инстансного канала событие бы не получили, и селект модели в чате
 * показывал бы устаревший каталог до перезагрузки страницы.
 *
 * Второе свойство контракта — payload **минимальный по построению**: провайдер,
 * id модели и вид мутации. Конфиг провайдера (`apiKey`, `baseUrl` — в URL
 * иногда лежит токен) в событие не попадает никогда (инвариант 13 `AGENTS.md`).
 */
import { describe, it, expect } from 'vitest';
import type { BusEvent } from '@itphx/synth-shared';
import { EventBus, INSTANCE_EVENT_CHANNEL } from './bus.js';
import { publishModelsUpdated, modelsChangedPublisher } from './models-events.js';

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

describe('publishModelsUpdated / modelsChangedPublisher', () => {
  it('публикует в инстансный канал с payload { action, provider, modelId }', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishModelsUpdated(bus, { provider: 'itphx', modelId: 'gpt-4o', action: 'save' });

    expect(events).toEqual([
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'models.updated',
        data: { action: 'save', provider: 'itphx', modelId: 'gpt-4o' },
      },
    ]);
  });

  it('без провайдера/модели публикует только action (изменение каталога целиком)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishModelsUpdated(bus, { action: 'fetch' });

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ action: 'fetch' });
    // Поля не добавляются даже пустой строкой — клиенту важно различать
    // «изменился конкретный провайдер/модель» и «пересканирован каталог».
    expect('provider' in events[0]!.data).toBe(false);
    expect('modelId' in events[0]!.data).toBe(false);
  });

  it('все виды мутации доезжают до клиента без искажения', () => {
    const bus = new EventBus();
    const events = collect(bus);

    for (const action of ['save', 'delete', 'default', 'fetch', 'provider'] as const) {
      publishModelsUpdated(bus, { action, provider: 'p' });
    }

    expect(events.map((e) => e.data.action)).toEqual([
      'save', 'delete', 'default', 'fetch', 'provider',
    ]);
    expect(events.every((e) => e.sessionId === INSTANCE_EVENT_CHANNEL)).toBe(true);
    expect(events.every((e) => e.type === 'models.updated')).toBe(true);
  });

  it('секреты провайдера в payload не попадают (даже если передать их в info)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    // Лишние поля во входе хука — не контракт: помощник собирает payload
    // по-белому списку, а не копирует info целиком.
    publishModelsUpdated(bus, {
      provider: 'itphx',
      action: 'provider',
      apiKey: 'sk-super-secret',
      baseUrl: 'https://user:token@proxy.local/v1',
      headers: { Authorization: 'Bearer sk-super-secret' },
    } as never);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.data).sort()).toEqual(['action', 'provider']);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('sk-super-secret');
    expect(serialized).not.toContain('user:token');
    expect(serialized).not.toContain('Authorization');
  });

  it('без шины — no-op (хук необязателен), падений нет', () => {
    expect(() => publishModelsUpdated(undefined, { action: 'save', provider: 'p' })).not.toThrow();
    expect(() => publishModelsUpdated(null, { action: 'fetch' })).not.toThrow();
  });

  it('modelsChangedPublisher — готовый хук для опций фабрик роутов', () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hook = modelsChangedPublisher(bus);

    hook({ provider: 'p', action: 'provider' });
    hook({ provider: 'p', modelId: 'm', action: 'save' });
    hook({ action: 'fetch' });

    expect(events.map((e) => [e.sessionId, e.type, e.data])).toEqual([
      [INSTANCE_EVENT_CHANNEL, 'models.updated', { action: 'provider', provider: 'p' }],
      [INSTANCE_EVENT_CHANNEL, 'models.updated', { action: 'save', provider: 'p', modelId: 'm' }],
      [INSTANCE_EVENT_CHANNEL, 'models.updated', { action: 'fetch' }],
    ]);
  });

  it('modelsChangedPublisher без шины — рабочий no-op хук', () => {
    const hook = modelsChangedPublisher(undefined);
    expect(() => hook({ provider: 'p', action: 'delete' })).not.toThrow();
  });
});
