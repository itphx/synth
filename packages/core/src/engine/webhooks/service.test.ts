import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from '../net/fetch.js';
import type { HostResolver } from '../mcp/network-policy.js';
import { EventBus } from '../../events/bus.js';
import { WebhookStore } from '../../storage/webhook-store.js';
import { WebhookDeliveryStore } from '../../storage/webhook-delivery-store.js';
import { WebhookService, computeBackoffMs } from './service.js';
import { MetricsRegistry } from '../../metrics/registry.js';
import { createWebhookMetrics } from '../../metrics/collectors/webhooks.js';
import { PRIVATE_EGRESS_POLICY } from '../net/egress-guard.js';
import { createEgressLogSink } from '../net/egress-log.js';
import { configureEgressRuntime, resetEgressRuntime } from '../net/egress-runtime.js';
import { MemoryEgressRequestLogRepository } from '../../storage/memory/index.js';
import type { WebhookServiceDeps } from './service.js';
import { verifyWebhookSignature } from './signature.js';

/**
 * Герметичность: DNS не ходит в сеть — резолвер подставляется явно.
 * Публичный адрес — цель разрешена политикой; приватный — отклонена.
 */
const PUBLIC_ADDRESS = '93.184.216.34';
const PRIVATE_ADDRESS = '10.0.0.5';
/** Резолвер по умолчанию: любой хост — публичный адрес (сеть не используется). */
const resolvePublicHost: HostResolver = async () => [PUBLIC_ADDRESS];

describe('WebhookService (ADR-052, этап II)', () => {
  let tmpDir: string;
  let store: WebhookStore;
  let deliveryStore: WebhookDeliveryStore;
  let bus: EventBus;
  let service: WebhookService;

  const baseConfig = {
    enabled: true,
    maxAttempts: 3,
    timeoutMs: 5_000,
    policy: PRIVATE_EGRESS_POLICY,
  };

  const makeService = (
    fetchImpl: FetchLike,
    overrides: Partial<typeof baseConfig> = {},
    deps: Partial<WebhookServiceDeps> = {},
  ) => {
    service = new WebhookService({
      store,
      deliveryStore,
      eventBus: bus,
      config: { ...baseConfig, ...overrides },
      fetchImpl,
      // backoff без реальных пауз
      sleep: async () => {},
      // DNS не ходит в сеть — резолвер детерминирован (по умолчанию — публичный адрес).
      resolveHost: resolvePublicHost,
      ...deps,
    });
    service.start();
    return service;
  };

  /**
   * Fire-and-forget диспетчеризация `WebhookService._dispatch` (подписчик шины
   * запускает её как `void this._dispatch(event)`) — перехватываем и дожидаемся
   * фактического завершения. Детерминированная альтернатива «магической» паузе
   * `setTimeout(20)`: ждём реальную обработку события, а не спим фиксированное
   * время (которого под нагрузкой может не хватить — `_dispatch` читает стор).
   */
  function trackDispatches(): () => Promise<void> {
    type DispatchEvent = { type: string; sessionId: string; data: Record<string, unknown>; timestamp: string };
    const internals = service as unknown as { _dispatch: (event: DispatchEvent) => Promise<void> };
    const original = internals._dispatch.bind(service);
    const pending: Promise<void>[] = [];
    vi.spyOn(internals, '_dispatch').mockImplementation((event) => {
      const p = original(event);
      pending.push(p);
      return p;
    });
    return async () => {
      // Во время ожидания могут запуститься новые диспетчеризации — ждём все.
      while (pending.length > 0) {
        await Promise.all(pending.splice(0, pending.length));
      }
    };
  }

  const okResponse = () => new Response(null, { status: 200 });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-webhook-service-'));
    store = new WebhookStore({ dataDir: tmpDir });
    deliveryStore = new WebhookDeliveryStore({ dataDir: tmpDir });
    bus = new EventBus();
  });

  afterEach(async () => {
    service?.stop();
    resetEgressRuntime();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('доставляет подходящее событие: 2xx → ok, заголовки и подпись валидны', async () => {
    await store.create({ label: 's', url: 'https://example.com/hook', events: ['session.created'] }, 'u-1');
    let captured: { headers: Record<string, string>; body: string } | undefined;
    makeService(async (_input, init) => {
      captured = {
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ''),
      };
      return okResponse();
    });

    bus.publish('s1', 'session.created', { id: 's1' });

    await vi.waitFor(async () => {
      expect(await deliveryStore.list()).toHaveLength(1);
    });
    const delivery = (await deliveryStore.list())[0]!;
    expect(delivery.status).toBe('ok');
    expect(delivery.attempts).toBe(1);
    expect(delivery.responseStatus).toBe(200);

    expect(captured!.headers['X-Synth-Event']).toBe('session.created');
    expect(captured!.headers['X-Synth-Delivery']).toBe(delivery.id);
    const secret = await store.getSecret((await store.list())[0]!.id);
    expect(verifyWebhookSignature(secret!, captured!.body, captured!.headers['X-Synth-Signature']!)).toBe(true);
  });

  it('фильтр подписки: несовпадающий тип не доставляется', async () => {
    await store.create({ label: 's', url: 'https://example.com/hook', events: ['plan.approved'] }, 'u-1');
    const fetchImpl = vi.fn<FetchLike>(async () => okResponse());
    makeService(fetchImpl);
    const drain = trackDispatches();

    bus.publish('s1', 'session.created', {});
    await drain();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await deliveryStore.list()).toHaveLength(0);
  });

  it('retry/backoff: падение, падение, успех → attempts=3, ok', async () => {
    await store.create({ label: 's', url: 'https://example.com/hook', events: ['session.created'] }, 'u-1');
    let calls = 0;
    makeService(async () => {
      calls++;
      if (calls < 3) throw new Error('network down');
      return okResponse();
    });

    bus.publish('s1', 'session.created', {});
    await vi.waitFor(async () => {
      expect(await deliveryStore.list()).toHaveLength(1);
    });
    const delivery = (await deliveryStore.list())[0]!;
    expect(delivery.status).toBe('ok');
    expect(delivery.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it('исчерпание попыток: 5xx → failed с responseStatus/error', async () => {
    await store.create({ label: 's', url: 'https://example.com/hook', events: ['session.created'] }, 'u-1');
    makeService(async () => new Response(null, { status: 500 }), { maxAttempts: 2 });

    bus.publish('s1', 'session.created', {});
    await vi.waitFor(async () => {
      expect(await deliveryStore.list()).toHaveLength(1);
    });
    const delivery = (await deliveryStore.list())[0]!;
    expect(delivery.status).toBe('failed');
    expect(delivery.attempts).toBe(2);
    expect(delivery.responseStatus).toBe(500);
    expect(delivery.error).toBe('HTTP 500');

    const sub = (await store.list())[0]!;
    expect(sub.lastStatus).toBe('failed');
  });

  it('дедуп: повторный триггер того же события не отправляется дважды', async () => {
    await store.create({ label: 's', url: 'https://example.com/hook', events: ['session.created'] }, 'u-1');
    const fetchImpl = vi.fn<FetchLike>(async () => okResponse());
    makeService(fetchImpl);
    const drain = trackDispatches();

    bus.publish('s1', 'session.created', { id: 'x' });
    bus.publish('s1', 'session.created', { id: 'x' });
    await drain();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await deliveryStore.list()).toHaveLength(1);
  });

  it('отключённая подписка не доставляется', async () => {
    const sub = await store.create({ label: 's', url: 'https://example.com/hook', events: ['session.created'] }, 'u-1');
    await store.setEnabled(sub.id, false);
    const fetchImpl = vi.fn<FetchLike>(async () => okResponse());
    makeService(fetchImpl);
    const drain = trackDispatches();

    bus.publish('s1', 'session.created', {});
    await drain();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('deliverTest: тестовая доставка в обход фильтра', async () => {
    const sub = await store.create({ label: 's', url: 'https://example.com/hook', events: ['plan.approved'] }, 'u-1');
    makeService(async () => okResponse());

    const delivery = await service.deliverTest(sub.id);
    expect(delivery?.status).toBe('ok');
    expect(delivery?.eventType).toBe('webhook.test');
    expect(await service.deliverTest('whk_missing')).toBeNull();
  });

  it('мастер-выключен (enabled=false) — подписка не доставляет', async () => {
    await store.create({ label: 's', url: 'https://example.com/hook', events: ['session.created'] }, 'u-1');
    const fetchImpl = vi.fn<FetchLike>(async () => okResponse());
    makeService(fetchImpl, { enabled: false });

    // Мастер-выключен: подписчик шины возвращает управление синхронно, не запуская
    // `_dispatch` — ждать нечего, проверяем сразу (без «магической» паузы).
    bus.publish('s1', 'session.created', {});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('редирект на приватный адрес → отказ (хоп не выполняется, PROP-100 дефект 2)', async () => {
    await store.create({ label: 's', url: 'https://hooks.example/hook', events: ['session.created'] }, 'u-1');
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      if (String(input) === 'https://hooks.example/hook') {
        return new Response(null, { status: 302, headers: { location: 'https://internal.example/secret' } });
      }
      return okResponse();
    });
    makeService(fetchImpl, {}, {
      resolveHost: async (host) => (host === 'internal.example' ? [PRIVATE_ADDRESS] : [PUBLIC_ADDRESS]),
    });

    bus.publish('s1', 'session.created', {});
    await vi.waitFor(async () => {
      expect(await deliveryStore.list()).toHaveLength(1);
    });
    const delivery = (await deliveryStore.list())[0]!;
    expect(delivery.status).toBe('failed');
    // Отказ — по адресу из резолвера (DNS не ходит в сеть), а не «по имени».
    expect(delivery.error).toContain(PRIVATE_ADDRESS);
    // Приватный хоп не запрашивается: был только исходный запрос.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).not.toContain('https://internal.example/secret');
  });

  it('редирект на публичный адрес → доставка', async () => {
    await store.create({ label: 's', url: 'https://hooks.example/hook', events: ['session.created'] }, 'u-1');
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      if (String(input) === 'https://hooks.example/hook') {
        return new Response(null, { status: 301, headers: { location: 'https://target.example/final' } });
      }
      if (String(input) === 'https://target.example/final') return okResponse();
      throw new Error(`unexpected: ${String(input)}`);
    });
    makeService(fetchImpl, {}, {
      resolveHost: async () => ['93.184.216.34'],
    });

    bus.publish('s1', 'session.created', {});
    await vi.waitFor(async () => {
      expect(await deliveryStore.list()).toHaveLength(1);
    });
    const delivery = (await deliveryStore.list())[0]!;
    expect(delivery.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('превышение лимита редиректов → failed (без бесконечного цикла)', async () => {
    await store.create({ label: 's', url: 'https://hooks.example/hook', events: ['session.created'] }, 'u-1');
    const fetchImpl = vi.fn<FetchLike>(async () =>
      new Response(null, { status: 302, headers: { location: 'https://hooks.example/loop' } }));
    makeService(fetchImpl, { maxAttempts: 1 }, {
      resolveHost: async () => ['93.184.216.34'],
    });

    bus.publish('s1', 'session.created', {});
    await vi.waitFor(async () => {
      expect(await deliveryStore.list()).toHaveLength(1);
    });
    const delivery = (await deliveryStore.list())[0]!;
    expect(delivery.status).toBe('failed');
    expect(delivery.error).toMatch(/редирект/i);
    // 5 разрешённых хопов + начальный запрос = 6, дальше отказ.
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('пишет доставки в журнал egress (blocked и allowed, scope webhooks)', async () => {
    const repo = new MemoryEgressRequestLogRepository();
    configureEgressRuntime({ log: createEgressLogSink(repo, { enabled: true }) });

    // Заблокированная цель: отказ до HTTP-запроса.
    await store.create({ label: 'blocked', url: 'https://127.0.0.1/hook', events: ['session.created'] }, 'u-1');
    const neverFetch = vi.fn<FetchLike>(async () => okResponse());
    makeService(neverFetch);
    bus.publish('s1', 'session.created', { n: 1 });
    await vi.waitFor(async () => {
      expect(await deliveryStore.list()).toHaveLength(1);
    });
    expect(neverFetch).not.toHaveBeenCalled();
    const blocked = (await repo.list())[0]!;
    expect(blocked).toMatchObject({ scope: 'webhooks', status: 'blocked', host: '127.0.0.1' });
    expect(blocked.reason).toBeTruthy();
    // Отказ — по адресу, а не «по имени хоста».
    expect(blocked.reason).toContain('127.0.0.1');

    // Разрешённая цель: запись allowed с httpStatus.
    await store.create({ label: 'allowed', url: 'https://93.184.216.34/hook', events: ['session.moved'] }, 'u-1');
    service.stop();
    makeService(vi.fn<FetchLike>(async () => okResponse()));
    bus.publish('s1', 'session.moved', { n: 2 });
    await vi.waitFor(async () => {
      expect(await deliveryStore.list()).toHaveLength(2);
    });
    const allowed = (await repo.list())[0]!;
    expect(allowed).toMatchObject({
      scope: 'webhooks',
      status: 'allowed',
      host: '93.184.216.34',
      httpStatus: 200,
    });
    expect(allowed.url).toBe('https://93.184.216.34/hook');
  });

  it('computeBackoffMs: экспоненциальный рост и джиттер в границах', () => {
    const noJitter = () => 0.5;
    expect(computeBackoffMs(1, noJitter)).toBe(1_000);
    expect(computeBackoffMs(2, noJitter)).toBe(2_000);
    expect(computeBackoffMs(3, noJitter)).toBe(4_000);
    expect(computeBackoffMs(10, noJitter)).toBe(30_000);
    // джиттер ±20%
    expect(computeBackoffMs(1, () => 0)).toBe(800);
    expect(computeBackoffMs(1, () => 1)).toBe(1_200);
  });
});

describe('WebhookService × ADR-094 (метрики доставок)', () => {
  let tmpDir: string;
  let store: WebhookStore;
  let deliveryStore: WebhookDeliveryStore;
  let bus: EventBus;

  const okResponse = () => new Response(null, { status: 200 });

  const baseConfig = {
    enabled: true,
    maxAttempts: 2,
    timeoutMs: 5_000,
    policy: PRIVATE_EGRESS_POLICY,
  };

  const makeService = (
    fetchImpl: FetchLike,
    onDelivery: WebhookServiceDeps['onDelivery'],
    overrides: Partial<typeof baseConfig> = {},
    deps: Partial<WebhookServiceDeps> = {},
  ) => new WebhookService({
    store,
    deliveryStore,
    eventBus: bus,
    config: { ...baseConfig, ...overrides },
    fetchImpl,
    sleep: async () => {},
    onDelivery,
    // DNS не ходит в сеть — резолвер детерминирован (по умолчанию — публичный адрес).
    resolveHost: resolvePublicHost,
    ...deps,
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-webhook-metrics-'));
    store = new WebhookStore({ dataDir: tmpDir });
    deliveryStore = new WebhookDeliveryStore({ dataDir: tmpDir });
    bus = new EventBus();
  });

  afterEach(async () => {
    resetEgressRuntime();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('deliverTest: ok / error / blocked — ровно один вызов на доставку', async () => {
    const onDelivery = vi.fn();

    const okSub = await store.create({ label: 'ok', url: 'https://example.com/hook', events: ['webhook.test'] }, 'u-1');
    const okService = makeService(async () => okResponse(), onDelivery);
    const okDelivery = await okService.deliverTest(okSub.id);
    expect(okDelivery?.status).toBe('ok');
    expect(onDelivery).toHaveBeenLastCalledWith({ outcome: 'ok', attempts: 1, durationMs: expect.any(Number) });
    expect(onDelivery).toHaveBeenCalledTimes(1);

    const errSub = await store.create({ label: 'err', url: 'https://example.com/hook', events: ['webhook.test'] }, 'u-1');
    const errService = makeService(async () => new Response(null, { status: 500 }), onDelivery);
    const errDelivery = await errService.deliverTest(errSub.id);
    expect(errDelivery?.status).toBe('failed');
    expect(onDelivery).toHaveBeenLastCalledWith({ outcome: 'error', attempts: 2, durationMs: expect.any(Number) });
    expect(onDelivery).toHaveBeenCalledTimes(2);

    const blockedSub = await store.create({ label: 'blocked', url: 'https://127.0.0.1/hook', events: ['webhook.test'] }, 'u-1');
    const blockedService = makeService(async () => okResponse(), onDelivery);
    const blockedDelivery = await blockedService.deliverTest(blockedSub.id);
    expect(blockedDelivery?.status).toBe('failed');
    expect(onDelivery).toHaveBeenLastCalledWith({ outcome: 'blocked', attempts: 0, durationMs: expect.any(Number) });
    expect(onDelivery).toHaveBeenCalledTimes(3);
  });

  it('повторы при attempts>1 попадают в synth_webhook_retries_total', async () => {
    const registry = new MetricsRegistry();
    const sub = await store.create({ label: 'retry', url: 'https://example.com/hook', events: ['webhook.test'] }, 'u-1');
    let calls = 0;
    const service = makeService(
      async () => {
        calls += 1;
        return calls < 3 ? new Response(null, { status: 500 }) : okResponse();
      },
      createWebhookMetrics(registry),
      { maxAttempts: 3 },
    );

    const delivery = await service.deliverTest(sub.id);
    expect(delivery).toMatchObject({ status: 'ok', attempts: 3 });

    const text = registry.render().text;
    expect(text).toContain('synth_webhook_deliveries_total{outcome="ok"} 1');
    expect(text).toContain('synth_webhook_retries_total 2');
    expect(text).toContain('synth_webhook_delivery_duration_seconds_count 1');
  });
});
