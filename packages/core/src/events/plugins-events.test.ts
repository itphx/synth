/**
 * Шов публикации `plugins.updated` (`events/plugins-events.ts`).
 *
 * Проверяется то, чего не видно из фабрик роутов: событие уходит в
 * **инстансный** канал шины (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 * ADR-118) — реестр плагинов слоя расширений это ресурс инстанса, а не сессии.
 * Хелпер ставят **две** точки сборки (core standalone + managed backend), причём
 * дважды на файл (`createPluginsRoutes` — жизненный цикл,
 * `createPluginSettingsRoutes` — политика слоя), поэтому канал фиксируем тестом:
 * при подмене на `publish(sessionId, …)` подписчики инстансного канала событие бы
 * не получили, и статусы `active`/`pending approval` «залипали» бы.
 *
 * Второе свойство контракта — payload **минимальный по построению**: вид мутации
 * и (необязательно) имя плагина. **Ни токенов (`synth_svc_…`), ни ключей, ни URL
 * источников установки, ни содержимого манифеста в событие не попадает никогда**
 * (инвариант 13 `AGENTS.md`). Секретная выдача (`POST /plugins/token`) события не
 * публикует вовсе — это реестр service-key, а не реестр плагинов.
 */
import { describe, it, expect } from 'vitest';
import type { BusEvent } from '@itphx/synth-shared';
import { EventBus, INSTANCE_EVENT_CHANNEL } from './bus.js';
import { publishPluginsUpdated, pluginsChangedPublisher } from './plugins-events.js';

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

describe('publishPluginsUpdated / pluginsChangedPublisher', () => {
  it('публикует в инстансный канал с payload { action, pluginName }', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishPluginsUpdated(bus, { pluginName: 'demo-plugin', action: 'install' });

    expect(events).toEqual([
      {
        sessionId: INSTANCE_EVENT_CHANNEL,
        type: 'plugins.updated',
        data: { action: 'install', pluginName: 'demo-plugin' },
      },
    ]);
  });

  it('без имени плагина публикует только action (смена политики слоя целиком)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    publishPluginsUpdated(bus, { action: 'policy' });

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ action: 'policy' });
    // Поле не добавляется даже пустой строкой — клиенту важно различать
    // «изменился конкретный плагин» и «перечитай реестр/политику целиком».
    expect('pluginName' in events[0]!.data).toBe(false);
  });

  it('все виды мутации доезжают до клиента без искажения', () => {
    const bus = new EventBus();
    const events = collect(bus);

    const actions = [
      'install',
      'update',
      'approve',
      'enable',
      'disable',
      'rollback',
      'uninstall',
      'policy',
    ] as const;
    for (const action of actions) {
      publishPluginsUpdated(bus, { action, pluginName: 'demo-plugin' });
    }

    expect(events.map((e) => e.data.action)).toEqual([...actions]);
    expect(events.every((e) => e.sessionId === INSTANCE_EVENT_CHANNEL)).toBe(true);
    expect(events.every((e) => e.type === 'plugins.updated')).toBe(true);
  });

  it('токен, ключи, URL источника и манифест в payload не попадают (даже если передать их в info)', () => {
    const bus = new EventBus();
    const events = collect(bus);

    // Лишние поля во входе хука — не контракт: помощник собирает payload
    // по-белому списку, а не копирует info целиком.
    publishPluginsUpdated(bus, {
      action: 'install',
      pluginName: 'demo-plugin',
      token: 'synth_svc_super-secret-token',
      apiKey: 'sk-live-should-never-leak',
      url: 'https://registry.example.com/bundle.tgz?token=repo-secret',
      source: { kind: 'url', ref: 'https://registry.example.com/bundle.tgz' },
      manifest: { name: 'demo-plugin', env: { SECRET: 'plugin-secret-value' } },
      config: { headers: { Authorization: 'Bearer plugin-secret' } },
    } as never);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.data).sort()).toEqual(['action', 'pluginName']);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('synth_svc_super-secret-token');
    expect(serialized).not.toContain('sk-live-should-never-leak');
    expect(serialized).not.toContain('repo-secret');
    expect(serialized).not.toContain('registry.example.com');
    expect(serialized).not.toContain('plugin-secret-value');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('"manifest"');
  });

  it('без шины — no-op (хук необязателен), падений нет', () => {
    expect(() => publishPluginsUpdated(undefined, { action: 'install' })).not.toThrow();
    expect(() => publishPluginsUpdated(null, { action: 'policy' })).not.toThrow();
  });

  it('pluginsChangedPublisher — готовый хук для опций обеих фабрик роутов', () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hook = pluginsChangedPublisher(bus);

    hook({ pluginName: 'demo-plugin', action: 'enable' });
    hook({ pluginName: 'demo-plugin', action: 'disable' });
    hook({ action: 'policy' });

    expect(events.map((e) => [e.sessionId, e.type, e.data])).toEqual([
      [INSTANCE_EVENT_CHANNEL, 'plugins.updated', { action: 'enable', pluginName: 'demo-plugin' }],
      [INSTANCE_EVENT_CHANNEL, 'plugins.updated', { action: 'disable', pluginName: 'demo-plugin' }],
      [INSTANCE_EVENT_CHANNEL, 'plugins.updated', { action: 'policy' }],
    ]);
  });

  it('pluginsChangedPublisher без шины — рабочий no-op хук', () => {
    const hook = pluginsChangedPublisher(undefined);
    expect(() => hook({ pluginName: 'demo-plugin', action: 'install' })).not.toThrow();
  });
});
