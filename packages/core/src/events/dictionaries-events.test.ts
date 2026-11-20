/**
 * Шов публикации `dictionaries.updated` (`events/dictionaries-events.ts`).
 *
 * Проверяется то, чего не видно из фабрики роутов: событие уходит в
 * **инстансный** канал шины (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 * ADR-118) — словари классификации это каталог инстанса, а не ресурс сессии.
 * Тот же хелпер ставят обе точки сборки (`mount-routes` standalone и managed
 * backend), поэтому канал фиксируем тестом: при подмене на `publish(sessionId, …)`
 * секция «Словари» держала бы устаревший список до перезагрузки страницы.
 *
 * Второе свойство контракта — payload **минимальный по построению**: вид мутации,
 * категория и язык. Содержимое словаря (YAML-текст, `keywords`/`tools`) в
 * событие не попадает никогда.
 */
import { describe, it, expect } from 'vitest';
import type { BusEvent } from '@itphx/synth-shared';
import { EventBus, INSTANCE_EVENT_CHANNEL } from './bus.js';
import { publishDictionariesUpdated, dictionariesChangedPublisher } from './dictionaries-events.js';

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

describe('publishDictionariesUpdated / dictionariesChangedPublisher', () => {
  it('публикует в инстансный канал с payload { action, category, lang }', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishDictionariesUpdated(bus, { action: 'save', category: 'coding', lang: 'ru' });

    expect(events).toEqual([
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'dictionaries.updated',
        data: { action: 'save', category: 'coding', lang: 'ru' },
      },
    ]);
  });

  it('без category/lang публикует только action (каталог изменился целиком)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishDictionariesUpdated(bus, { action: 'reset' });

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ action: 'reset' });
    expect('category' in events[0]!.data).toBe(false);
    expect('lang' in events[0]!.data).toBe(false);
  });

  it('оба вида мутации доезжают до клиента без искажения', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishDictionariesUpdated(bus, { action: 'save', category: 'coding', lang: 'en' });
    publishDictionariesUpdated(bus, { action: 'reset', category: 'coding', lang: 'en' });

    expect(events.map((e) => e.data.action)).toEqual(['save', 'reset']);
    expect(events.every((e) => e.sessionId === INSTANCE_EVENT_CHANNEL)).toBe(true);
    expect(events.every((e) => e.type === 'dictionaries.updated')).toBe(true);
  });

  it('содержимое словаря в payload не попадает (даже если передать его в info)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    // Лишние поля во входе хука — не контракт: помощник собирает payload
    // по-белому списку, а не копирует info целиком.
    publishDictionariesUpdated(bus, {
      action: 'save',
      category: 'coding',
      lang: 'ru',
      content: 'keywords:\n  - секретное-слово\n',
      keywords: ['секретное-слово'],
      tools: ['write_file'],
    } as never);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.data).sort()).toEqual(['action', 'category', 'lang']);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('секретное-слово');
    expect(serialized).not.toContain('keywords');
    expect(serialized).not.toContain('write_file');
  });

  it('без шины — no-op (хук необязателен), падений нет', () => {
    expect(() => publishDictionariesUpdated(undefined, { action: 'save' })).not.toThrow();
    expect(() => publishDictionariesUpdated(null, { action: 'reset' })).not.toThrow();
  });

  it('dictionariesChangedPublisher — готовый хук для опций фабрики роутов', () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hook = dictionariesChangedPublisher(bus);

    hook({ action: 'save', category: 'coding', lang: 'ru' });
    hook({ action: 'reset', category: 'coding', lang: 'ru' });
    hook({ action: 'save' });

    expect(events.map((e) => [e.sessionId, e.type, e.data])).toEqual([
      [INSTANCE_EVENT_CHANNEL, 'dictionaries.updated', { action: 'save', category: 'coding', lang: 'ru' }],
      [INSTANCE_EVENT_CHANNEL, 'dictionaries.updated', { action: 'reset', category: 'coding', lang: 'ru' }],
      [INSTANCE_EVENT_CHANNEL, 'dictionaries.updated', { action: 'save' }],
    ]);
  });

  it('dictionariesChangedPublisher без шины — рабочий no-op хук', () => {
    const hook = dictionariesChangedPublisher(undefined);
    expect(() => hook({ action: 'save', category: 'coding', lang: 'ru' })).not.toThrow();
  });
});
