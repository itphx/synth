// AD-052 (этап I): service-key на backend — сквозной срез через createBackendApp.
// Проверяем: аутентификацию по `synth_svc_…` (success/revoked/expired/unknown → 401),
// managed-RBAC CRUD (USER → 403, ADMIN → 200), scope-гейт (`requireScope` → 403
// SCOPE_REQUIRED), проектную проекцию (`allowedProjects` на sessions/bindings/schedules
// → 403 PROJECT_FORBIDDEN) и scope `llm:chat` на LLM Proxy.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

const ADMIN_KEY = 'admin-key-123';
const USER_KEY = 'user-key-456';

describe('AD-052 (этап I): service-key на backend', () => {
  let dataDir: string;
  let backend: BackendAppHandle;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-service-keys-'));
    backend = await createBackendApp({ dataDir, authDebug: true });
  });

  afterAll(async () => {
    backend.stopScheduler();
    backend.stopEphemeralSweeper();
    backend.stopEventJournalPruner();
    // maxRetries: фоновая атомарная запись store может пересечься с удалением.
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  interface CreatedKey {
    id: string;
    key: string;
    label: string;
    scopes: string[];
  }

  async function createServiceKey(body: Record<string, unknown>): Promise<CreatedKey> {
    const res = await req('/api/v2/service-keys', jsonInit('POST', body), ADMIN_KEY);
    expect(res.status).toBe(201);
    return (await res.json()) as CreatedKey;
  }

  async function createProject(name: string): Promise<string> {
    const res = await req('/api/v2/projects', jsonInit('POST', { name }), ADMIN_KEY);
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it('RBAC: USER → 403 на CRUD service-keys, ADMIN → 200', async () => {
    expect((await req('/api/v2/service-keys', {}, USER_KEY)).status).toBe(403);
    expect((await req('/api/v2/service-keys', {}, ADMIN_KEY)).status).toBe(200);
  });

  it('аутентификация: success 200; revoked/expired/unknown → 401', async () => {
    const key = await createServiceKey({
      label: 'svc-auth',
      roles: ['ADMIN'],
      scopes: ['events:ingest'],
    });
    expect(key.key.startsWith('synth_svc_')).toBe(true);
    // roles ADMIN у ключа → доступен admin-роут (успешная аутентификация).
    expect((await req('/api/v2/service-keys', {}, key.key)).status).toBe(200);

    // `/api/v2/sessions` — под `requireAuth` (в отличие от service-keys-CRUD,
    // где readGuard = requirePermission → 403): недействительный ключ → 401.
    // Мягкий отзыв → ключ недействителен.
    expect((await req(`/api/v2/service-keys/${key.id}/revoke`, { method: 'POST' }, ADMIN_KEY)).status).toBe(200);
    expect((await req('/api/v2/sessions', {}, key.key)).status).toBe(401);

    // Истёкший ключ → 401.
    const expired = await createServiceKey({
      label: 'svc-expired',
      roles: ['ADMIN'],
      scopes: ['events:ingest'],
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    expect((await req('/api/v2/sessions', {}, expired.key)).status).toBe(401);

    // Неизвестный секрет → 401.
    expect((await req('/api/v2/sessions', {}, 'synth_svc_unknown')).status).toBe(401);
  });

  it('scope: без routes:read → 403 SCOPE_REQUIRED; с scope → 200', async () => {
    const noScope = await createServiceKey({
      label: 'svc-no-scope',
      roles: ['ADMIN'],
      scopes: ['sessions:read'],
    });
    const denied = await req('/api/v2/events/routes', {}, noScope.key);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('SCOPE_REQUIRED');

    const scoped = await createServiceKey({
      label: 'svc-routes',
      roles: ['ADMIN'],
      scopes: ['routes:read'],
    });
    expect((await req('/api/v2/events/routes', {}, scoped.key)).status).toBe(200);
  });

  it('проектная проекция: allowedProjects ограничивает sessions/bindings/schedules', async () => {
    const p1 = await createProject('Проект A');
    const p2 = await createProject('Проект B');
    const key = await createServiceKey({
      label: 'svc-projections',
      roles: ['ADMIN'],
      scopes: ['sessions:create', 'schedules:write', 'bindings:write'],
      allowedProjects: [p1],
    });

    // getServiceCredential кладёт в контекст именно эту проекцию.
    const bindingsBody = (project: string) => ({
      source: 'telegram',
      chatKey: `chat:telegram:${project}`,
      mode: 'bound',
      sessionId: 's-x',
      project,
    });
    const denyBinding = await req('/api/v2/events/bindings', jsonInit('POST', bindingsBody(p2)), key.key);
    expect(denyBinding.status).toBe(403);
    expect(((await denyBinding.json()) as { error: { code: string } }).error.code).toBe('PROJECT_FORBIDDEN');
    expect((await req('/api/v2/events/bindings', jsonInit('POST', bindingsBody(p1)), key.key)).status).toBe(201);

    const scheduleBody = (project: string) => ({
      name: 'range',
      every: '1h',
      target: { mode: 'ephemeral', project },
      prompt: 'ping',
    });
    expect((await req('/api/v2/schedules', jsonInit('POST', scheduleBody(p2)), key.key)).status).toBe(403);
    expect((await req('/api/v2/schedules', jsonInit('POST', scheduleBody(p1)), key.key)).status).toBe(201);

    expect((await req('/api/v2/sessions', jsonInit('POST', { name: 's', project_id: p2 }), key.key)).status).toBe(403);
    expect((await req('/api/v2/sessions', jsonInit('POST', { name: 's', project_id: p1 }), key.key)).status).toBe(201);
  });

  it('per-key rate limit: rateLimitPerMinute=1 → второй запрос 429', async () => {
    const key = await createServiceKey({
      label: 'svc-ratelimited',
      roles: ['ADMIN'],
      scopes: ['routes:read'],
      rateLimitPerMinute: 1,
    });
    expect((await req('/api/v2/events/routes', {}, key.key)).status).toBe(200);
    const limited = await req('/api/v2/events/routes', {}, key.key);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('scope llm:chat на LLM Proxy: без scope → 403, с scope — не 403', async () => {
    const body = { model: 'ghost-model', messages: [{ role: 'user', content: 'hi' }] };

    const noScope = await createServiceKey({
      label: 'svc-llm-denied',
      roles: ['ADMIN'],
      scopes: ['sessions:read'],
    });
    const denied = await req('/api/v2/llm/chat/completions', jsonInit('POST', body), noScope.key);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('SCOPE_REQUIRED');

    const scoped = await createServiceKey({
      label: 'svc-llm-ok',
      roles: ['ADMIN'],
      scopes: ['llm:chat'],
    });
    // Модель не сконфигурирована → 404, но scope пройден (не 403).
    expect((await req('/api/v2/llm/chat/completions', jsonInit('POST', body), scoped.key)).status).toBe(404);
    // Обычные (не service-key) креды scope не ограничивают.
    expect((await req('/api/v2/llm/chat/completions', jsonInit('POST', body), ADMIN_KEY)).status).toBe(404);
  });
});
