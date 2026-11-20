/**
 * Шов публикации `packs.updated` (`events/packs-events.ts`).
 *
 * Проверяется то, чего не видно из фабрики роутов: событие уходит в
 * **инстансный** канал шины (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 * ADR-118) — реестр установок пакетов расширений это ресурс инстанса, а не
 * сессии. Тот же хелпер ставят обе точки сборки (`mount-routes` standalone и
 * managed backend), поэтому канал фиксируем тестом: при подмене на
 * `publish(sessionId, …)` подписчики инстансного канала событие бы не получили,
 * и раздел «Аддоны» держал бы устаревший список до перезагрузки страницы.
 *
 * Второе свойство контракта — payload **минимальный по построению**: вид мутации
 * и (необязательно) имя пакета. Манифест пакета, карта файлов (там тела скиллов
 * и определения агентов) и сводка полномочий в событие не попадают никогда:
 * клиенту достаточно сигнала «перечитай» (инварианты 13/27 `AGENTS.md`).
 */
import { describe, it, expect } from 'vitest';
import type { BusEvent } from '@itphx/synth-shared';
import { EventBus, INSTANCE_EVENT_CHANNEL } from './bus.js';
import { publishPacksUpdated, packsChangedPublisher } from './packs-events.js';

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

describe('publishPacksUpdated / packsChangedPublisher', () => {
  it('публикует в инстансный канал с payload { action, packName }', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishPacksUpdated(bus, { packName: 'synth-media', action: 'install' });

    expect(events).toEqual([
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'packs.updated',
        data: { action: 'install', packName: 'synth-media' },
      },
    ]);
  });

  it('без имени пакета публикует только action (изменение реестра целиком)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishPacksUpdated(bus, { action: 'uninstall' });

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ action: 'uninstall' });
    // Поле не добавляется даже пустой строкой — клиенту важно различать
    // «изменился конкретный пакет» и «перечитай реестр целиком».
    expect('packName' in events[0]!.data).toBe(false);
  });

  it('все виды мутации доезжают до клиента без искажения', () => {
    const bus = new EventBus();
    const events = collect(bus);

    for (const action of ['install', 'approve', 'uninstall'] as const) {
      publishPacksUpdated(bus, { action, packName: 'synth-media' });
    }

    expect(events.map((e) => e.data.action)).toEqual(['install', 'approve', 'uninstall']);
    expect(events.every((e) => e.sessionId === INSTANCE_EVENT_CHANNEL)).toBe(true);
    expect(events.every((e) => e.type === 'packs.updated')).toBe(true);
  });

  it('манифест, файлы и полномочия пакета в payload не попадают (даже если передать их в info)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    // Лишние поля во входе хука — не контракт: помощник собирает payload
    // по-белому списку, а не копирует info целиком.
    publishPacksUpdated(bus, {
      action: 'install',
      packName: 'synth-media',
      manifest: {
        name: 'synth-media',
        version: '1.0.0',
        description: 'Медиа-пак секретный-описание',
      },
      files: { 'agents/publisher/role.md': 'секретная-роль-публикатора' },
      provides: { agents: ['publisher'], mcp: ['media-gateway'] },
    } as never);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.data).sort()).toEqual(['action', 'packName']);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('секретная-роль-публикатора');
    expect(serialized).not.toContain('секретный-описание');
    expect(serialized).not.toContain('media-gateway');
    expect(serialized).not.toContain('"files"');
    expect(serialized).not.toContain('"manifest"');
  });

  it('без шины — no-op (хук необязателен), падений нет', () => {
    expect(() => publishPacksUpdated(undefined, { action: 'install' })).not.toThrow();
    expect(() => publishPacksUpdated(null, { action: 'uninstall' })).not.toThrow();
  });

  it('packsChangedPublisher — готовый хук для опций фабрики роутов', () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hook = packsChangedPublisher(bus);

    hook({ packName: 'synth-media', action: 'install' });
    hook({ packName: 'synth-media', action: 'approve' });
    hook({ packName: 'synth-media', action: 'uninstall' });

    expect(events.map((e) => [e.sessionId, e.type, e.data])).toEqual([
      [INSTANCE_EVENT_CHANNEL, 'packs.updated', { action: 'install', packName: 'synth-media' }],
      [INSTANCE_EVENT_CHANNEL, 'packs.updated', { action: 'approve', packName: 'synth-media' }],
      [INSTANCE_EVENT_CHANNEL, 'packs.updated', { action: 'uninstall', packName: 'synth-media' }],
    ]);
  });

  it('packsChangedPublisher без шины — рабочий no-op хук', () => {
    const hook = packsChangedPublisher(undefined);
    expect(() => hook({ packName: 'synth-media', action: 'install' })).not.toThrow();
  });
});
