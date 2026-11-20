/**
 * Шов публикации `memory.updated` (`events/memory-events.ts`).
 *
 * Проверяется то, чего не видно из фабрики роутов и scoped-обёртки портов:
 * событие уходит в **инстансный** канал шины (`EventBus.publishInstance`,
 * `INSTANCE_EVENT_CHANNEL`, ADR-118) — память это ресурс инстанса, а не сессии.
 * Тот же хелпер ставят обе точки сборки (`mount-routes` standalone и managed
 * backend), chokepoint плагинов (`engine/plugins/scoped-memory.ts`) и портал
 * (`PATCH /memory/indexes/:id`), поэтому канал фиксируем тестом: при подмене на
 * `publish(sessionId, …)` подписчики инстансного канала событие бы не получили,
 * и раздел «Память» держал бы снимок до перезагрузки страницы.
 *
 * Главное свойство контракта — **содержимого памяти в событии нет**: ни текста
 * факта, ни эмбеддингов, ни поискового запроса, ни корпуса индекса. Payload
 * собирается по-белому списку (`{ scope, action, id? }`), поэтому проверяется
 * отдельным assert'ом: даже если передать содержимое во вход хука, в событие
 * оно не попадёт (docs/MEMORY.md §10, инвариант 13 `AGENTS.md`).
 */
import { describe, it, expect } from 'vitest';
import type { BusEvent } from '@itphx/synth-shared';
import { EventBus, INSTANCE_EVENT_CHANNEL } from './bus.js';
import { publishMemoryUpdated, memoryChangedPublisher } from './memory-events.js';

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

describe('publishMemoryUpdated / memoryChangedPublisher', () => {
  it('публикует в инстансный канал с payload { scope, action, id }', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishMemoryUpdated(bus, { scope: 'facts', action: 'create', id: 'fact-1' });

    expect(events).toEqual([
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'memory.updated',
        data: { scope: 'facts', action: 'create', id: 'fact-1' },
      },
    ]);
  });

  it('без id публикует только область и вид мутации (изменение целиком)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishMemoryUpdated(bus, { scope: 'indexes', action: 'update' });

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ scope: 'indexes', action: 'update' });
    // Поля не добавляются даже пустой строкой — клиенту важно различать
    // «изменилась конкретная запись» и «перечитай срез целиком».
    expect('id' in events[0]!.data).toBe(false);
  });

  it('все области и виды мутации доезжают до клиента без искажения', () => {
    const bus = new EventBus();
    const events = collect(bus);

    for (const scope of ['facts', 'indexes'] as const) {
      for (const action of ['create', 'update', 'delete', 'rebuild', 'consolidate'] as const) {
        publishMemoryUpdated(bus, { scope, action });
      }
    }

    expect(events).toHaveLength(10);
    expect(events.every((e) => e.sessionId === INSTANCE_EVENT_CHANNEL)).toBe(true);
    expect(events.every((e) => e.type === 'memory.updated')).toBe(true);
    expect(events.map((e) => [e.data.scope, e.data.action])).toEqual([
      ['facts', 'create'],
      ['facts', 'update'],
      ['facts', 'delete'],
      ['facts', 'rebuild'],
      ['facts', 'consolidate'],
      ['indexes', 'create'],
      ['indexes', 'update'],
      ['indexes', 'delete'],
      ['indexes', 'rebuild'],
      ['indexes', 'consolidate'],
    ]);
  });

  it('содержимого памяти в payload нет (даже если передать его в info)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    // Лишние поля во входе хука — не контракт: помощник собирает payload
    // по-белому списку, а не копирует info целиком.
    publishMemoryUpdated(bus, {
      scope: 'facts',
      action: 'create',
      id: 'fact-1',
      text: 'деплой в test идёт через Fleet',
      embedding: [0.12, -0.34, 0.56],
      query: 'как деплоить в test',
      chunks: [{ id: 'chunk-1', text: 'кусок корпуса индекса' }],
      namespace: 'plugin:synth-plugin-memory',
    } as never);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.data).sort()).toEqual(['action', 'id', 'scope']);

    // Отдельный assert на содержимое: ни одного поля памяти в событии нет.
    expect('text' in events[0]!.data).toBe(false);
    expect('embedding' in events[0]!.data).toBe(false);
    expect('query' in events[0]!.data).toBe(false);
    expect('chunks' in events[0]!.data).toBe(false);

    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('деплой в test идёт через Fleet');
    expect(serialized).not.toContain('0.12');
    expect(serialized).not.toContain('как деплоить в test');
    expect(serialized).not.toContain('кусок корпуса индекса');
  });

  it('без шины — no-op (хук необязателен), падений нет', () => {
    expect(() => publishMemoryUpdated(undefined, { scope: 'facts', action: 'create' })).not.toThrow();
    expect(() => publishMemoryUpdated(null, { scope: 'indexes', action: 'delete' })).not.toThrow();
  });

  it('memoryChangedPublisher — готовый хук для опций фабрики роутов', () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hook = memoryChangedPublisher(bus);

    hook({ scope: 'indexes', action: 'update', id: 'idx-1' });
    hook({ scope: 'facts', action: 'consolidate' });

    expect(events.map((e) => [e.sessionId, e.type, e.data])).toEqual([
      [INSTANCE_EVENT_CHANNEL, 'memory.updated', { scope: 'indexes', action: 'update', id: 'idx-1' }],
      [INSTANCE_EVENT_CHANNEL, 'memory.updated', { scope: 'facts', action: 'consolidate' }],
    ]);
  });

  it('memoryChangedPublisher без шины — рабочий no-op хук', () => {
    const hook = memoryChangedPublisher(undefined);
    expect(() => hook({ scope: 'facts', action: 'delete', id: 'fact-1' })).not.toThrow();
  });
});
