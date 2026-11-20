/**
 * Шов публикации `execution.updated` (`events/execution-events.ts`).
 *
 * Проверяется то, чего не видно из фабрик роутов: событие уходит в
 * **инстансный** канал шины (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 * ADR-118) — каталог профилей исполнения это ресурс инстанса, а не сессии. Тот
 * же хелпер ставят обе точки сборки (`mount-routes` standalone и managed
 * backend) и две фабрики роутов (`createSettingsRoutes` — каталог,
 * `createExecutionRoutes` — пулы), поэтому канал фиксируем тестом: при подмене
 * на `publish(sessionId, …)` подписчики инстансного канала событие бы не
 * получили, и селекторы профиля (агент/проект/сессия) держали бы устаревший
 * каталог до перезагрузки страницы.
 *
 * Второе свойство контракта — payload **минимальный по построению**: вид
 * мутации и (необязательно) id профиля/имя пула. Адреса исполнителей, токен
 * provisioner'а и прочий конфиг профиля в событие не попадают никогда
 * (инвариант 13 `AGENTS.md`).
 */
import { describe, it, expect } from 'vitest';
import type { BusEvent } from '@itphx/synth-shared';
import { EventBus, INSTANCE_EVENT_CHANNEL } from './bus.js';
import { publishExecutionUpdated, executionChangedPublisher } from './execution-events.js';

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

describe('publishExecutionUpdated / executionChangedPublisher', () => {
  it('публикует в инстансный канал с payload { action, profileId }', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishExecutionUpdated(bus, { action: 'profile.save', profileId: 'gpu' });

    expect(events).toEqual([
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'execution.updated',
        data: { action: 'profile.save', profileId: 'gpu' },
      },
    ]);
  });

  it('публикует имя пула для мутаций пулов', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishExecutionUpdated(bus, {
      action: 'pool.delete',
      poolName: 'project:p1:exec:gpu',
    });

    expect(events).toEqual([
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'execution.updated',
        data: { action: 'pool.delete', poolName: 'project:p1:exec:gpu' },
      },
    ]);
  });

  it('без profileId/poolName публикует только action (каталог изменился целиком)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishExecutionUpdated(bus, { action: 'profile.reset' });

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ action: 'profile.reset' });
    // Поля не добавляются даже пустой строкой — клиенту важно различать
    // «изменился конкретный профиль/пул» и «перечитай каталог целиком».
    expect('profileId' in events[0]!.data).toBe(false);
    expect('poolName' in events[0]!.data).toBe(false);
  });

  it('все виды мутации доезжают до клиента без искажения', () => {
    const bus = new EventBus();
    const events = collect(bus);

    for (const action of [
      'profile.save',
      'profile.delete',
      'profile.reset',
      'pool.save',
      'pool.delete',
    ] as const) {
      publishExecutionUpdated(bus, { action });
    }

    expect(events.map((e) => e.data.action)).toEqual([
      'profile.save',
      'profile.delete',
      'profile.reset',
      'pool.save',
      'pool.delete',
    ]);
    expect(events.every((e) => e.sessionId === INSTANCE_EVENT_CHANNEL)).toBe(true);
    expect(events.every((e) => e.type === 'execution.updated')).toBe(true);
  });

  it('адреса исполнителей и токены в payload не попадают (даже если передать их в info)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    // Лишние поля во входе хука — не контракт: помощник собирает payload
    // по-белому списку, а не копирует info целиком.
    publishExecutionUpdated(bus, {
      action: 'profile.save',
      profileId: 'gpu',
      url: ['http://user:token@executor.local:8080'],
      token: 'provisioner-secret',
      env: { API_KEY: 'sk-super-secret' },
      args: ['--api-key', 'sk-super-secret'],
    } as never);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.data).sort()).toEqual(['action', 'profileId']);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('provisioner-secret');
    expect(serialized).not.toContain('sk-super-secret');
    expect(serialized).not.toContain('user:token');
    expect(serialized).not.toContain('executor.local');
  });

  it('без шины — no-op (хук необязателен), падений нет', () => {
    expect(() => publishExecutionUpdated(undefined, { action: 'profile.save' })).not.toThrow();
    expect(() => publishExecutionUpdated(null, { action: 'profile.reset' })).not.toThrow();
  });

  it('executionChangedPublisher — готовый хук для опций фабрик роутов', () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hook = executionChangedPublisher(bus);

    hook({ action: 'profile.save' });
    hook({ action: 'profile.save', profileId: 'gpu' });
    hook({ action: 'pool.delete', poolName: 'session:s1:browser:browser' });

    expect(events.map((e) => [e.sessionId, e.type, e.data])).toEqual([
      [INSTANCE_EVENT_CHANNEL, 'execution.updated', { action: 'profile.save' }],
      [INSTANCE_EVENT_CHANNEL, 'execution.updated', { action: 'profile.save', profileId: 'gpu' }],
      [
        INSTANCE_EVENT_CHANNEL,
        'execution.updated',
        { action: 'pool.delete', poolName: 'session:s1:browser:browser' },
      ],
    ]);
  });

  it('executionChangedPublisher без шины — рабочий no-op хук', () => {
    const hook = executionChangedPublisher(undefined);
    expect(() => hook({ action: 'profile.reset' })).not.toThrow();
  });
});
