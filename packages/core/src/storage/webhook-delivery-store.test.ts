import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebhookDeliveryStore } from './webhook-delivery-store.js';
import type { WebhookDelivery } from '@itphx/synth-shared';

function delivery(overrides: Partial<WebhookDelivery>): WebhookDelivery {
  return {
    id: 'whd_1',
    subscriptionId: 'whk_1',
    eventType: 'session.created',
    status: 'ok',
    attempts: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('WebhookDeliveryStore (AD-052, этап II)', () => {
  let store: WebhookDeliveryStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-webhook-deliveries-'));
    store = new WebhookDeliveryStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('record + list по подписке и limit', async () => {
    await store.record(delivery({ id: 'a', subscriptionId: 'whk_1' }));
    await store.record(delivery({ id: 'b', subscriptionId: 'whk_2' }));
    await store.record(delivery({ id: 'c', subscriptionId: 'whk_1' }));

    const all = await store.list();
    expect(all.map((d) => d.id)).toEqual(['a', 'b', 'c']);

    const only1 = await store.listBySubscription('whk_1');
    expect(only1.map((d) => d.id)).toEqual(['a', 'c']);
    expect((await store.listBySubscription('whk_1', 1)).map((d) => d.id)).toEqual(['c']);

    const lastOne = await store.list(1);
    expect(lastOne.map((d) => d.id)).toEqual(['c']);
  });

  it('prune удаляет старые записи; retentionDays <= 0 — без ограничения', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();
    await store.record(delivery({ id: 'old', createdAt: old }));
    await store.record(delivery({ id: 'new' }));

    expect(await store.prune(0)).toBe(0);
    const removed = await store.prune(30);
    expect(removed).toBe(1);
    expect((await store.list()).map((d) => d.id)).toEqual(['new']);
  });
});
