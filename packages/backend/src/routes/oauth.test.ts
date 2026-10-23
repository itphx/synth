/**
 * ADR-105 (Ф4): HTTP-контур внешних доступов — сквозной срез по **смонтированному**
 * backend-приложению (`createBackendApp`).
 *
 * Проверяется: 401 без аутентификации; обычный пользователь видит только свои
 * метаданные; `ADMIN`/`LEAD` — все метаданные инстанса; в ответе нет полей с
 * токеном (`secretEnc`/`refreshEnc`/`access_token`) и самого значения токена.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalCredentialStore, McpRegistryStore } from '@itphx/synth-core';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

// Debug-пользователи backend: `user.id === user.username` (ADR-089).
const USER_KEY = 'user-key-456';   // developer (USER)
const ADMIN_KEY = 'admin-key-123'; // admin (ADMIN)
const LEAD_KEY = 'lead-key-789';   // lead (LEAD)

// Фикстуры токенов — плейсхолдеры (не настоящие креды).
const ACCESS_TOKEN = 'placeholder-access-token';
const REFRESH_TOKEN = 'placeholder-refresh-token';

describe('ADR-105 (Ф4): внешние доступы — смонтированный backend', () => {
  let rootDir: string;
  let backend: BackendAppHandle;
  /** id личного доступа пользователя `developer` (владелец привязки). */
  let developerCredentialId: string;

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'synth-backend-oauth-'));
    backend = await createBackendApp({ dataDir: join(rootDir, 'data'), authDebug: true });

    // Доступы создаём прямо в порту (тот же файл, что у приложения): выдача
    // через OAuth требует сети и зарегистрированного провайдера, а тест —
    // чтения метаданных (видимость по владельцу и роли).
    const store = new ExternalCredentialStore({ dataDir: backend.dataDir });
    const common = {
      provider: 'demo',
      clientId: 'client-demo',
      scopes: ['read'],
      accessToken: ACCESS_TOKEN,
    };
    const own = await store.create({
      ...common,
      owner: { kind: 'user', id: 'developer' },
      refreshToken: REFRESH_TOKEN,
      createdBy: 'developer',
    });
    developerCredentialId = own.id;
    await store.create({
      ...common,
      owner: { kind: 'user', id: 'lead' },
      createdBy: 'lead',
    });
    await store.create({
      ...common,
      owner: { kind: 'instance', id: 'instance' },
      createdBy: 'admin',
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

  const req = async (
    path: string,
    opts: { token?: string; method?: string; body?: unknown } = {},
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return backend.app.request(path, {
      ...(opts.method ? { method: opts.method } : {}),
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  };

  it('GET /api/v2/oauth/credentials без аутентификации → 401 UNAUTHORIZED', async () => {
    const res = await req('/api/v2/oauth/credentials');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/v2/oauth/credentials обычным пользователем → только свои метаданные', async () => {
    const res = await req('/api/v2/oauth/credentials', { token: USER_KEY });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      credentials: Array<{ id: string; owner: { kind: string; id: string } }>;
      count: number;
    };
    expect(body.count).toBe(1);
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0]?.owner).toEqual({ kind: 'user', id: 'developer' });
  });

  it('GET /api/v2/oauth/credentials — ADMIN/LEAD видят все метаданные инстанса', async () => {
    for (const token of [ADMIN_KEY, LEAD_KEY]) {
      const res = await req('/api/v2/oauth/credentials', { token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { credentials: unknown[]; count: number };
      expect(body.count).toBe(3);
      expect(body.credentials).toHaveLength(3);
    }
  });

  it('в ответе нет полей с токеном и самого токена', async () => {
    const res = await req('/api/v2/oauth/credentials', { token: ADMIN_KEY });
    expect(res.status).toBe(200);
    const raw = await res.text();
    for (const forbidden of ['secretEnc', 'refreshEnc', 'access_token', 'refresh_token']) {
      expect(raw).not.toContain(forbidden);
    }
    expect(raw).not.toContain(ACCESS_TOKEN);
    expect(raw).not.toContain(REFRESH_TOKEN);
    // Наружу — только метаданные с маской секрета.
    const body = JSON.parse(raw) as { credentials: Array<{ secretMask: string; hasRefreshToken: boolean }> };
    for (const credential of body.credentials) {
      expect(credential.secretMask).toMatch(/^mask:[0-9a-f]{16}$/);
      expect(typeof credential.hasRefreshToken).toBe('boolean');
    }
  });

  it('POST /credentials/:id/bind → реестр MCP обновлён, менеджер MCP получил свежий конфиг', async () => {
    // Запись реестра MCP — автором `developer` (иначе привязать нельзя:
    // запись реестра меняет автор или ADMIN).
    const registry = new McpRegistryStore({ dataDir: backend.dataDir });
    const entry = await registry.add({
      name: 'demo-conn',
      config: { type: 'http', url: 'https://mcp.test' },
      origin: 'user',
      author: { userId: 'developer', username: 'developer' },
    });

    const res = await req(`/api/v2/oauth/credentials/${developerCredentialId}/bind`, {
      token: USER_KEY,
      method: 'POST',
      body: { connectorId: entry.id },
    });
    expect(res.status).toBe(200);

    // В реестре у коннектора появилась ссылка на доступ (без самого токена).
    const updated = await registry.get(entry.id);
    expect(updated?.config.auth).toEqual({ kind: 'credential', credentialId: developerCredentialId });

    // Менеджер MCP не остался со старым конфигом: коннектор получил `auth`
    // (иначе клиент ходил бы к провайдеру без токена).
    expect(backend.mcpManager.getConfig()['demo-conn']?.auth).toEqual({
      kind: 'credential',
      credentialId: developerCredentialId,
    });
  });
});
