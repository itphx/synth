/**
 * Шов публикации `credentials.updated` (`events/credentials-events.ts`).
 *
 * Проверяется то, чего не видно из фабрики роутов: событие уходит в
 * **инстансный** канал шины (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 * ADR-118) — слой внешних доступов (ADR-105) это ресурс инстанса, а не сессии.
 * Тот же хелпер ставят обе точки сборки (`mount-routes` standalone и managed
 * backend) и единственная фабрика `createOAuthRoutes`, поэтому канал фиксируем
 * тестом: при подмене на `publish(sessionId, …)` подписчики инстансного канала
 * событие бы не получили, и раздел «Внешние доступы» показывал бы устаревший
 * список до перезагрузки страницы.
 *
 * Главное свойство контракта — **токенов в событии нет**: `access_token`,
 * `refresh_token`, маска секрета и прочие детали записи в payload не попадают
 * никогда (инвариант 13 `AGENTS.md`). Проверяется отдельным assert'ом: даже
 * если передать их во вход хука, в событие они не попадут — помощник собирает
 * payload по-белому списку (`{ action, credentialId?, provider? }`).
 */
import { describe, it, expect } from 'vitest';
import type { BusEvent } from '@itphx/synth-shared';
import { EventBus, INSTANCE_EVENT_CHANNEL } from './bus.js';
import { publishCredentialsUpdated, credentialsChangedPublisher } from './credentials-events.js';

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

describe('publishCredentialsUpdated / credentialsChangedPublisher', () => {
  it('публикует в инстансный канал с payload { action, credentialId, provider }', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishCredentialsUpdated(bus, {
      action: 'save',
      credentialId: 'extc_1',
      provider: 'demo',
    });

    expect(events).toEqual([
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'credentials.updated',
        data: { action: 'save', credentialId: 'extc_1', provider: 'demo' },
      },
    ]);
  });

  it('без id/провайдера публикует только action (слой доступов изменился целиком)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishCredentialsUpdated(bus, { action: 'delete' });

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ action: 'delete' });
    // Поля не добавляются даже пустой строкой — клиенту важно различать
    // «изменилась конкретная запись» и «перечитай список целиком».
    expect('credentialId' in events[0]!.data).toBe(false);
    expect('provider' in events[0]!.data).toBe(false);
  });

  it('все виды мутации доезжают до клиента без искажения', () => {
    const bus = new EventBus();
    const events = collect(bus);

    for (const action of ['save', 'delete', 'refresh', 'bind'] as const) {
      publishCredentialsUpdated(bus, { action });
    }

    expect(events.map((e) => e.data.action)).toEqual(['save', 'delete', 'refresh', 'bind']);
    expect(events.every((e) => e.sessionId === INSTANCE_EVENT_CHANNEL)).toBe(true);
    expect(events.every((e) => e.type === 'credentials.updated')).toBe(true);
  });

  it('токенов в payload нет (даже если передать их в info)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    // Лишние поля во входе хука — не контракт: помощник собирает payload
    // по-белому списку, а не копирует info целиком.
    publishCredentialsUpdated(bus, {
      action: 'refresh',
      credentialId: 'extc_1',
      provider: 'demo',
      access_token: 'acc-super-secret',
      refresh_token: 'ref-super-secret',
      token: 'generic-super-secret',
      secretMask: 'mask:0123456789abcdef',
    } as never);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.data).sort()).toEqual(['action', 'credentialId', 'provider']);

    // Отдельный assert на секреты: ни одного из полей-токенов в событии нет.
    expect('access_token' in events[0]!.data).toBe(false);
    expect('refresh_token' in events[0]!.data).toBe(false);
    expect('token' in events[0]!.data).toBe(false);
    expect('secretMask' in events[0]!.data).toBe(false);

    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('acc-super-secret');
    expect(serialized).not.toContain('ref-super-secret');
    expect(serialized).not.toContain('generic-super-secret');
    expect(serialized).not.toContain('mask:0123456789abcdef');
    // И сами имена полей-токенов не просочились как ключи.
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');
  });

  it('без шины — no-op (хук необязателен), падений нет', () => {
    expect(() => publishCredentialsUpdated(undefined, { action: 'save' })).not.toThrow();
    expect(() => publishCredentialsUpdated(null, { action: 'delete' })).not.toThrow();
  });

  it('credentialsChangedPublisher — готовый хук для опций фабрики роутов', () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hook = credentialsChangedPublisher(bus);

    hook({ action: 'save', credentialId: 'extc_1', provider: 'demo' });
    hook({ action: 'refresh', credentialId: 'extc_1', provider: 'demo' });
    hook({ action: 'delete', credentialId: 'extc_1', provider: 'demo' });
    hook({ action: 'bind', credentialId: 'extc_1', provider: 'demo' });

    expect(events.map((e) => [e.sessionId, e.type, e.data])).toEqual([
      [
        INSTANCE_EVENT_CHANNEL,
        'credentials.updated',
        { action: 'save', credentialId: 'extc_1', provider: 'demo' },
      ],
      [
        INSTANCE_EVENT_CHANNEL,
        'credentials.updated',
        { action: 'refresh', credentialId: 'extc_1', provider: 'demo' },
      ],
      [
        INSTANCE_EVENT_CHANNEL,
        'credentials.updated',
        { action: 'delete', credentialId: 'extc_1', provider: 'demo' },
      ],
      [
        INSTANCE_EVENT_CHANNEL,
        'credentials.updated',
        { action: 'bind', credentialId: 'extc_1', provider: 'demo' },
      ],
    ]);
  });

  it('credentialsChangedPublisher без шины — рабочий no-op хук', () => {
    const hook = credentialsChangedPublisher(undefined);
    expect(() => hook({ action: 'save' })).not.toThrow();
  });
});
