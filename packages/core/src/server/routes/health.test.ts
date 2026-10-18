/**
 * ADR-094: `/ready` отделён от `/health`.
 * - 200, когда приложение инициализировано (в т.ч. при деградированном хранилище);
 * - 503 только при `getReadiness().ready === false` (старт не завершён/fail-closed).
 */
import { describe, it, expect } from 'vitest';
import { createHealthRoutes } from './health.js';
import type { StorageDegradedInfo } from '../storage-degraded.js';

const degraded: StorageDegradedInfo = {
  active: true,
  backend: 'postgres',
  fallbackDir: '/tmp/synth-fallback',
  reason: 'connect ECONNREFUSED',
  since: '2026-10-18T00:00:00.000Z',
};

describe('createHealthRoutes: /ready (ADR-094)', () => {
  it('по умолчанию — 200 ready, storage ok', async () => {
    const res = await createHealthRoutes().request('/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ready');
    expect(body.storage).toBe('ok');
    expect(body.version).toBeTruthy();
    expect(body.time).toBeTruthy();
    expect(body.startedAt).toBeTruthy();
  });

  it('деградированное хранилище — 200 и storage=degraded (pod не выводится из балансировки)', async () => {
    const app = createHealthRoutes({ getStorageDegraded: () => degraded });
    const res = await app.request('/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ready');
    expect(body.storage).toBe('degraded');
  });

  it('getReadiness().ready=false → 503 not_ready + checks', async () => {
    const app = createHealthRoutes({
      getReadiness: () => ({ ready: false, storage: 'ok', checks: { migrations: 'pending' } }),
    });
    const res = await app.request('/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('not_ready');
    expect(body.checks).toEqual({ migrations: 'pending' });
  });

  it('/health не меняет прежний контракт (status/version/time/startedAt)', async () => {
    const res = await createHealthRoutes({ getStorageDegraded: () => degraded }).request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');
    expect(body.storage).toMatchObject({ degraded: true, backend: 'postgres' });
  });
});
