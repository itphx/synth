import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from '../net/fetch.js';
import { EventBus } from '../../events/bus.js';
import { WebhookStore } from '../../storage/webhook-store.js';
import { WebhookDeliveryStore } from '../../storage/webhook-delivery-store.js';
import { WebhookService, computeBackoffMs } from './service.js';
import { verifyWebhookSignature } from './signature.js';

describe('WebhookService (AD-052, этап II)', () => {
  let tmpDir: string;
  let store: WebhookStore;
  let deliveryStore: WebhookDeliveryStore;
  let bus: EventBus;
  let service: WebhookService;

  const baseConfig = {
    enabled: true,
    maxAttempts: 3,
    timeoutMs: 5_000,
    allowPrivateTargets: true,
  };

  const makeService = (fetchImpl: FetchLike, overrides: Partial<typeof baseConfig> = {}) => {
    service = new WebhookService({
      store,
      deliveryStore,
      eventBus: bus,
      config: { ...baseConfig, ...overrides },
      fetchImpl,
      // backoff без реальных пауз
      sleep: async () => {},
    });
    service.start();
    return service;
  };

  const okResponse = () => new Response(null, { status: 200 });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-webhook-service-'));
    store = new WebhookStore({ dataDir: tmpDir });
    deliveryStore = new WebhookDeliveryStore({ dataDir: tmpDir });
    bus = new EventBus();
  });

  afterEach(async () => {
    service?.stop();
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

    bus.publish('s1', 'session.created', {});
    await new Promise((r) => setTimeout(r, 20));

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

    bus.publish('s1', 'session.created', { id: 'x' });
    bus.publish('s1', 'session.created', { id: 'x' });

    await vi.waitFor(async () => {
      expect(await deliveryStore.list()).toHaveLength(1);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await deliveryStore.list()).toHaveLength(1);
  });

  it('отключённая подписка не доставляется', async () => {
    const sub = await store.create({ label: 's', url: 'https://example.com/hook', events: ['session.created'] }, 'u-1');
    await store.setEnabled(sub.id, false);
    const fetchImpl = vi.fn<FetchLike>(async () => okResponse());
    makeService(fetchImpl);

    bus.publish('s1', 'session.created', {});
    await new Promise((r) => setTimeout(r, 20));
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

    bus.publish('s1', 'session.created', {});
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchImpl).not.toHaveBeenCalled();
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
