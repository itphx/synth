// ADR-052 (этап II): webhooks на backend — сквозной срез через createBackendApp.
// Проверяем: managed-RBAC (USER → 403, ADMIN → 200), создание подписки с
// однократной выдачей signing-секрета (`whsec_…`), 409 при дубле label,
// SSRF-политику целевого URL (http/приватный адрес → 400), revoke/regenerate/
// список/журнал/удаление, 404 на неизвестную подписку и мастер-выключатель
// `webhooks.enabled: false` → 503 на мутации/тест.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

const ADMIN_KEY = 'admin-key-123';
const USER_KEY = 'user-key-456';

// Публичный IP-литерал: проходит SSRF-политику без DNS-резолва (8.8.8.8 не в
// приватных диапазонах), поэтому пригоден как валидный целевой URL в тестах.
const PUBLIC_URL = 'https://8.8.8.8/hook';

/** Общие помощники HTTP-запросов к backend-app. */
function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('ADR-052 (этап II): webhooks на backend (webhooks.enabled: true)', () => {
  let rootDir: string;
  let backend: BackendAppHandle;

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'synth-backend-webhooks-'));
    const configPath = join(rootDir, 'config.yaml');
    await writeFile(configPath, 'webhooks:\n  enabled: true\n', 'utf-8');
    backend = await createBackendApp({
      dataDir: join(rootDir, 'data'),
      authDebug: true,
      configPath,
    });
  });

  afterAll(async () => {
    backend.stopScheduler();
    backend.stopEphemeralSweeper();
    backend.stopEventJournalPruner();
    backend.stopWebhookService();
    backend.stopWebhookDeliveryPruner();
    // maxRetries: фоновая атомарная запись store может пересечься с удалением.
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** Запрос к backend-app с опциональным Bearer-токеном. */
  const req = async (path: string, init: RequestInit = {}, token?: string): Promise<Response> =>
    backend.app.request(path, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });

  interface CreatedWebhook {
    id: string;
    label: string;
    url: string;
    events: string[];
    enabled: boolean;
    secretPrefix: string;
    secret: string;
  }

  async function createWebhook(body: Record<string, unknown>): Promise<CreatedWebhook> {
    const res = await req('/api/v2/webhooks', jsonInit('POST', body), ADMIN_KEY);
    expect(res.status).toBe(201);
    return (await res.json()) as CreatedWebhook;
  }

  it('RBAC: USER → 403 на CRUD, ADMIN → 200', async () => {
    expect((await req('/api/v2/webhooks', {}, USER_KEY)).status).toBe(403);
    expect((await req('/api/v2/webhooks', {}, ADMIN_KEY)).status).toBe(200);

    const denied = await req(
      '/api/v2/webhooks',
      jsonInit('POST', { label: 'rbac-denied', url: PUBLIC_URL }),
      USER_KEY,
    );
    expect(denied.status).toBe(403);
  });

  it('создание: signing-секрет `whsec_…` отдаётся единожды; в списке — только префикс', async () => {
    const created = await createWebhook({ label: 'hooks-create', url: PUBLIC_URL });
    expect(created.id.startsWith('whk_')).toBe(true);
    expect(created.secret.startsWith('whsec_')).toBe(true);
    expect(created.secretPrefix.length).toBeGreaterThan(0);
    expect(created.secretPrefix).not.toBe(created.secret);
    expect(created.enabled).toBe(true);
    expect(created.url).toBe(PUBLIC_URL);

    const listRes = await req('/api/v2/webhooks', {}, ADMIN_KEY);
    expect(listRes.status).toBe(200);
    const { subscriptions } = (await listRes.json()) as {
      subscriptions: Array<{ id: string; secret?: string; secretPrefix: string }>;
    };
    const found = subscriptions.find((s) => s.id === created.id);
    expect(found).toBeDefined();
    expect(found?.secret).toBeUndefined();
    expect(found?.secretPrefix).toBe(created.secretPrefix);
  });

  it('409 CONFLICT при дублировании label (регистронезависимо)', async () => {
    await createWebhook({ label: 'hooks-dup', url: PUBLIC_URL });
    const dup = await req(
      '/api/v2/webhooks',
      jsonInit('POST', { label: 'HOOKS-DUP', url: PUBLIC_URL }),
      ADMIN_KEY,
    );
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it('SSRF: http и приватный https URL → 400 VALIDATION_ERROR', async () => {
    const http = await req(
      '/api/v2/webhooks',
      jsonInit('POST', { label: 'ssrf-http', url: 'http://127.0.0.1/hook' }),
      ADMIN_KEY,
    );
    expect(http.status).toBe(400);
    expect(((await http.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    const privateAddr = await req(
      '/api/v2/webhooks',
      jsonInit('POST', { label: 'ssrf-private', url: 'https://10.0.0.5/hook' }),
      ADMIN_KEY,
    );
    expect(privateAddr.status).toBe(400);
    expect(((await privateAddr.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('невалидное тело (нет label/url) → 400 VALIDATION_ERROR', async () => {
    const res = await req('/api/v2/webhooks', jsonInit('POST', { url: PUBLIC_URL }), ADMIN_KEY);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('regenerate/revoke/удаление/журнал доставок', async () => {
    const created = await createWebhook({ label: 'hooks-life', url: PUBLIC_URL });

    const regen = await req(`/api/v2/webhooks/${created.id}/regenerate`, { method: 'POST' }, ADMIN_KEY);
    expect(regen.status).toBe(200);
    const rotated = (await regen.json()) as CreatedWebhook;
    expect(rotated.secret.startsWith('whsec_')).toBe(true);
    expect(rotated.secret).not.toBe(created.secret);

    const revoke = await req(`/api/v2/webhooks/${created.id}/revoke`, { method: 'POST' }, ADMIN_KEY);
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as { enabled: boolean }).enabled).toBe(false);

    const deliveries = await req(`/api/v2/webhooks/${created.id}/deliveries`, {}, ADMIN_KEY);
    expect(deliveries.status).toBe(200);
    expect(await deliveries.json()).toEqual({ deliveries: [] });

    const del = await req(`/api/v2/webhooks/${created.id}`, { method: 'DELETE' }, ADMIN_KEY);
    expect(del.status).toBe(204);

    expect((await req(`/api/v2/webhooks/${created.id}`, {}, ADMIN_KEY)).status).toBe(404);
  });

  it('неизвестная подписка → 404 (GET, test)', async () => {
    expect((await req('/api/v2/webhooks/whk_unknown', {}, ADMIN_KEY)).status).toBe(404);
    expect((await req('/api/v2/webhooks/whk_unknown/test', { method: 'POST' }, ADMIN_KEY)).status).toBe(404);
  });

  it('PATCH обновляет метаданные (description/enabled)', async () => {
    const created = await createWebhook({ label: 'hooks-patch', url: PUBLIC_URL });
    const patch = await req(
      `/api/v2/webhooks/${created.id}`,
      jsonInit('PATCH', { description: 'обновлено', enabled: false }),
      ADMIN_KEY,
    );
    expect(patch.status).toBe(200);
    const updated = (await patch.json()) as { description?: string; enabled: boolean };
    expect(updated.description).toBe('обновлено');
    expect(updated.enabled).toBe(false);
  });
});

describe('ADR-052 (этап II): webhooks disabled (webhooks.enabled: false)', () => {
  let rootDir: string;
  let backend: BackendAppHandle;

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'synth-backend-webhooks-off-'));
    const configPath = join(rootDir, 'config.yaml');
    await writeFile(configPath, 'webhooks:\n  enabled: false\n', 'utf-8');
    backend = await createBackendApp({
      dataDir: join(rootDir, 'data'),
      authDebug: true,
      configPath,
    });
  });

  afterAll(async () => {
    backend.stopScheduler();
    backend.stopEphemeralSweeper();
    backend.stopEventJournalPruner();
    backend.stopWebhookService();
    backend.stopWebhookDeliveryPruner();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** Запрос к backend-app с опциональным Bearer-токеном. */
  const req = async (path: string, init: RequestInit = {}, token?: string): Promise<Response> =>
    backend.app.request(path, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });

  it('мастер выключен: GET список — 200, мутации/тест → 503 UNAVAILABLE', async () => {
    const list = await req('/api/v2/webhooks', {}, ADMIN_KEY);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ subscriptions: [] });

    const post = await req(
      '/api/v2/webhooks',
      jsonInit('POST', { label: 'off', url: PUBLIC_URL }),
      ADMIN_KEY,
    );
    expect(post.status).toBe(503);
    expect(((await post.json()) as { error: { code: string } }).error.code).toBe('UNAVAILABLE');

    const test = await req('/api/v2/webhooks/whk_x/test', { method: 'POST' }, ADMIN_KEY);
    expect(test.status).toBe(503);

    const patch = await req('/api/v2/webhooks/whk_x', jsonInit('PATCH', { enabled: true }), ADMIN_KEY);
    expect(patch.status).toBe(503);

    const del = await req('/api/v2/webhooks/whk_x', { method: 'DELETE' }, ADMIN_KEY);
    expect(del.status).toBe(503);
  });
});
