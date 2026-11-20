/**
 * Шов публикации `skills.updated` (`events/skills-events.ts`).
 *
 * Проверяется то, чего не видно из фабрик роутов: событие уходит в
 * **инстансный** канал шины (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 * ADR-118) — реестр скиллов это ресурс инстанса, а не сессии. Тот же хелпер
 * ставят обе точки сборки (`mount-routes` standalone и managed backend) и три
 * фабрики роутов (`createSkillRoutes`, `createSkillBundleRoutes`,
 * `createSkillScopeRoutes`-семейство), поэтому канал фиксируем тестом: при
 * подмене на `publish(sessionId, …)` подписчики инстансного канала событие бы не
 * получили, и панели скиллов/долларовый пикер в композере показывали бы
 * устаревший состав до перезагрузки страницы.
 *
 * Второе свойство контракта — payload **минимальный по построению**: только имя,
 * вид мутации и (для уровневой операции) её область. Содержимое скилла (тело
 * `SKILL.md`, `metadata`, supporting-файлы) в событие не попадает никогда —
 * в скиллах встречаются рецепты с секретами (инвариант 13 `AGENTS.md`).
 */
import { describe, it, expect } from 'vitest';
import type { BusEvent } from '@itphx/synth-shared';
import { EventBus, INSTANCE_EVENT_CHANNEL } from './bus.js';
import { publishSkillsUpdated, skillsChangedPublisher } from './skills-events.js';

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

describe('publishSkillsUpdated / skillsChangedPublisher', () => {
  it('публикует в инстансный канал с payload { action, name }', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishSkillsUpdated(bus, { name: 'api-review', action: 'create' });

    expect(events).toEqual([
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'skills.updated',
        data: { action: 'create', name: 'api-review' },
      },
    ]);
  });

  it('без имени публикует только action (изменение реестра целиком — reload)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishSkillsUpdated(bus, { action: 'reload' });

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ action: 'reload' });
    // Поле `name` не добавляется даже пустой строкой — клиент различает
    // «изменился конкретный скилл» и «пересканирован реестр» по наличию ключа.
    expect('name' in events[0]!.data).toBe(false);
  });

  it('уровневая операция несёт scope/projectId/sessionId в том же инстансном событии', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishSkillsUpdated(bus, { name: 'db-migration', action: 'scope', scope: 'session', sessionId: 's1' });
    publishSkillsUpdated(bus, { action: 'scope', scope: 'project', projectId: 'p1' });
    publishSkillsUpdated(bus, { action: 'scope', scope: 'instance' });

    expect(events).toEqual([
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'skills.updated',
        data: { action: 'scope', name: 'db-migration', scope: 'session', sessionId: 's1' },
      },
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'skills.updated',
        data: { action: 'scope', scope: 'project', projectId: 'p1' },
      },
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'skills.updated',
        data: { action: 'scope', scope: 'instance' },
      },
    ]);
    // Область не «протекает» между вызовами: у инстансного события нет ни
    // projectId, ни sessionId, у проектного — sessionId.
    expect('projectId' in events[2]!.data).toBe(false);
    expect('sessionId' in events[1]!.data).toBe(false);
  });

  it('содержимое скилла в payload не попадает (даже если передать его в info)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    // Лишние поля во входе хука — не контракт: помощник собирает payload
    // по-белому списку, а не копирует info целиком.
    publishSkillsUpdated(bus, {
      name: 'leaky',
      action: 'update',
      body: '# секретный рецепт',
      metadata: { token: 'sk-secret' },
      files: { 'references/a.md': 'секретный файл' },
    } as never);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.data).sort()).toEqual(['action', 'name']);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('секретный рецепт');
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('секретный файл');
  });

  it('без шины — no-op (хук необязателен), падений нет', () => {
    expect(() => publishSkillsUpdated(undefined, { name: 'x', action: 'create' })).not.toThrow();
    expect(() => publishSkillsUpdated(null, { action: 'reload' })).not.toThrow();
  });

  it('skillsChangedPublisher — готовый хук для опций фабрики роутов', () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hook = skillsChangedPublisher(bus);

    hook({ name: 'a', action: 'create' });
    hook({ name: 'a', action: 'files' });
    hook({ action: 'scope', scope: 'instance' });

    expect(events.map((e) => [e.sessionId, e.type, e.data])).toEqual([
      [INSTANCE_EVENT_CHANNEL, 'skills.updated', { action: 'create', name: 'a' }],
      [INSTANCE_EVENT_CHANNEL, 'skills.updated', { action: 'files', name: 'a' }],
      [INSTANCE_EVENT_CHANNEL, 'skills.updated', { action: 'scope', scope: 'instance' }],
    ]);
  });

  it('skillsChangedPublisher без шины — рабочий no-op хук', () => {
    const hook = skillsChangedPublisher(undefined);
    expect(() => hook({ name: 'a', action: 'delete' })).not.toThrow();
  });
});
