// ADR-052 (этап I): per-key rate limit service-key в standalone-core.
// Паритет с managed backend: `rateLimitPerMinute` ключа энфорсится глобальным
// middleware (fixed window 60 c, ключ — keyId); 0/не задан — без лимита;
// превышение → 429 RATE_LIMITED; интерактивные креды (api-key/cookie) не
// затрагиваются. Проверяется сквозь `createStandaloneApp` (как в бою).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneApp } from './app.js';

const API_KEY = 'test-key';

describe('ADR-052 (этап I): per-key rate limit service-key в core', () => {
  let dataDir: string;
  let handle: Awaited<ReturnType<typeof createStandaloneApp>>;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-core-service-key-limit-'));
    handle = await createStandaloneApp({ port: 0, dataDir, apiKey: API_KEY });
  });

  afterAll(async () => {
    handle.stopScheduler();
    handle.stopEphemeralSweeper();
    handle.stopEventJournalPruner();
    handle.stopWebhookService();
    handle.stopWebhookDeliveryPruner();
    // maxRetries: фоновая атомарная запись store может пересечься с удалением.
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** Запрос к standalone-app с опциональным Bearer-токеном. */
  const req = async (path: string, init: RequestInit = {}, token?: string): Promise<Response> =>
    handle.app.request(path, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });

  async function createServiceKey(body: Record<string, unknown>): Promise<{ id: string; key: string }> {
    const res = await req(
      '/api/v2/service-keys',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      API_KEY,
    );
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; key: string };
  }

  it('rateLimitPerMinute=N → N запросов проходят, N+1-й получает 429 RATE_LIMITED', async () => {
    const key = await createServiceKey({
      label: 'svc-limited',
      roles: ['ADMIN'],
      scopes: ['keys:read'],
      rateLimitPerMinute: 2,
    });
    // `GET /api/v2/service-keys` в core под `requireAuth` — валидный service-key проходит.
    expect((await req('/api/v2/service-keys', {}, key.key)).status).toBe(200);
    expect((await req('/api/v2/service-keys', {}, key.key)).status).toBe(200);
    const limited = await req('/api/v2/service-keys', {}, key.key);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('rateLimitPerMinute=0 → без лимита', async () => {
    const key = await createServiceKey({
      label: 'svc-unlimited',
      roles: ['ADMIN'],
      scopes: ['keys:read'],
      rateLimitPerMinute: 0,
    });
    for (let i = 0; i < 5; i += 1) {
      expect((await req('/api/v2/service-keys', {}, key.key)).status).toBe(200);
    }
  });

  it('отсутствие rateLimitPerMinute → без лимита', async () => {
    const key = await createServiceKey({ label: 'svc-default', roles: ['ADMIN'], scopes: ['keys:read'] });
    for (let i = 0; i < 5; i += 1) {
      expect((await req('/api/v2/service-keys', {}, key.key)).status).toBe(200);
    }
  });

  it('окна ключей независимы (учёт по keyId)', async () => {
    const a = await createServiceKey({ label: 'svc-a', roles: ['ADMIN'], scopes: ['keys:read'], rateLimitPerMinute: 1 });
    const b = await createServiceKey({ label: 'svc-b', roles: ['ADMIN'], scopes: ['keys:read'], rateLimitPerMinute: 1 });
    expect((await req('/api/v2/service-keys', {}, a.key)).status).toBe(200);
    expect((await req('/api/v2/service-keys', {}, b.key)).status).toBe(200);
    expect((await req('/api/v2/service-keys', {}, a.key)).status).toBe(429);
    expect((await req('/api/v2/service-keys', {}, b.key)).status).toBe(429);
  });

  it('интерактивный кред (api-key) лимитом не затрагивается', async () => {
    for (let i = 0; i < 6; i += 1) {
      expect((await req('/api/v2/service-keys', {}, API_KEY)).status).toBe(200);
    }
  });
});
