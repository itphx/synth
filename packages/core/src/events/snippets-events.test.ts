/**
 * Шов публикации `snippets.updated` (`events/snippets-events.ts`).
 *
 * Проверяется то, чего не видно из фабрики роутов: событие уходит в
 * **инстансный** канал шины (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 * ADR-118). Сниппет живёт на уровне `instance`/`user`/`project` и сессии-владельца
 * у него нет, поэтому канал именно инстансный; тот же хелпер ставят обе точки
 * сборки (`mount-routes` standalone и managed backend). При подмене на
 * `publish(sessionId, …)` панель «Сниппеты» и `#`-пикер композера держали бы
 * устаревший список до перезагрузки страницы.
 *
 * Второе свойство контракта — payload **минимальный по построению**: вид мутации
 * и (необязательно) имя сниппета. **Текста сниппета (`body`), описания и алиасов
 * в событие не попадает никогда**: сниппет — пользовательский (а на проектном
 * уровне ещё и недоверенный) ввод, а сигналу достаточно «перечитай»
 * (инвариант 13 `AGENTS.md`).
 */
import { describe, it, expect } from 'vitest';
import type { BusEvent } from '@itphx/synth-shared';
import { EventBus, INSTANCE_EVENT_CHANNEL } from './bus.js';
import { publishSnippetsUpdated, snippetsChangedPublisher } from './snippets-events.js';

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

describe('publishSnippetsUpdated / snippetsChangedPublisher', () => {
  it('публикует в инстансный канал с payload { action, snippetId }', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishSnippetsUpdated(bus, { snippetId: 'greet', action: 'create' });

    expect(events).toEqual([
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'snippets.updated',
        data: { action: 'create', snippetId: 'greet' },
      },
    ]);
  });

  it('без имени публикует только action (реестр изменился целиком)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishSnippetsUpdated(bus, { action: 'delete' });

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ action: 'delete' });
    // Поле не добавляется даже пустой строкой — клиенту важно различать
    // «изменился конкретный сниппет» и «перечитай реестр целиком».
    expect('snippetId' in events[0]!.data).toBe(false);
  });

  it('все виды мутации доезжают до клиента без искажения', () => {
    const bus = new EventBus();
    const events = collect(bus);

    for (const action of ['create', 'update', 'delete'] as const) {
      publishSnippetsUpdated(bus, { action, snippetId: 'greet' });
    }

    expect(events.map((e) => e.data.action)).toEqual(['create', 'update', 'delete']);
    expect(events.every((e) => e.sessionId === INSTANCE_EVENT_CHANNEL)).toBe(true);
    expect(events.every((e) => e.type === 'snippets.updated')).toBe(true);
  });

  it('текст сниппета, описание и алиасы в payload не попадают (даже если передать их в info)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    // Лишние поля во входе хука — не контракт: помощник собирает payload
    // по-белому списку, а не копирует info целиком.
    publishSnippetsUpdated(bus, {
      action: 'create',
      snippetId: 'greet',
      body: 'секретный-текст-сниппета: rm -rf /',
      description: 'секретное-описание',
      aliases: ['секретный-алиас'],
      scope: 'project',
      projectId: 'p1',
    } as never);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.data).sort()).toEqual(['action', 'snippetId']);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('секретный-текст-сниппета');
    expect(serialized).not.toContain('rm -rf');
    expect(serialized).not.toContain('секретное-описание');
    expect(serialized).not.toContain('секретный-алиас');
    expect(serialized).not.toContain('"body"');
    expect(serialized).not.toContain('"aliases"');
  });

  it('без шины — no-op (хук необязателен), падений нет', () => {
    expect(() => publishSnippetsUpdated(undefined, { action: 'create' })).not.toThrow();
    expect(() => publishSnippetsUpdated(null, { action: 'delete' })).not.toThrow();
  });

  it('snippetsChangedPublisher — готовый хук для опций фабрики роутов', () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hook = snippetsChangedPublisher(bus);

    hook({ snippetId: 'greet', action: 'create' });
    hook({ snippetId: 'greet', action: 'update' });
    hook({ snippetId: 'greet', action: 'delete' });

    expect(events.map((e) => [e.sessionId, e.type, e.data])).toEqual([
      [INSTANCE_EVENT_CHANNEL, 'snippets.updated', { action: 'create', snippetId: 'greet' }],
      [INSTANCE_EVENT_CHANNEL, 'snippets.updated', { action: 'update', snippetId: 'greet' }],
      [INSTANCE_EVENT_CHANNEL, 'snippets.updated', { action: 'delete', snippetId: 'greet' }],
    ]);
  });

  it('snippetsChangedPublisher без шины — рабочий no-op хук', () => {
    const hook = snippetsChangedPublisher(undefined);
    expect(() => hook({ snippetId: 'greet', action: 'create' })).not.toThrow();
  });
});
