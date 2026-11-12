/**
 * PROP-135 слайс 6b-1: профили и пулы исполнения на managed backend.
 *
 * Проверяется **RBAC-обвязка** managed-сборки (core-фабрика та же, что в
 * standalone):
 *
 * - каталог профилей — любой аутентифицированный (`USER`/`AUDITOR` тоже: профиль
 *   выбирается в настройках проекта, роль владельца может быть `USER`);
 * - пулы — `ADMIN`|`LEAD`, мутации пулов — только `ADMIN`;
 * - `USER`/`AUDITOR` получают `403` на пулах и мутациях (до разбора ключа и до
 *   обращения к провайдеру);
 * - аноним — `401` (fail-closed гейт `/api/v2/*`);
 * - `ADMIN` → `200`/`202` (202 — на смонтированной фабрике с фейковым
 *   провайдером: реальный `provider: http` требует provisioner'а).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  createExecutionRoutes,
  type ExecutionPoolKey,
  type ExecutionPoolProvider,
  type ExecutionPort,
  type ExecutionRouter,
} from '@itphx/synth-core';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

const ADMIN_KEY = 'admin-key-123';
const USER_KEY = 'user-key-456';
const LEAD_KEY = 'lead-key-789';
const AUDITOR_KEY = 'auditor-key-012';

/** Ключ пула в URL-кодировке (как его присылает клиент). */
const POOL_KEY = 'project:prj_1:exec:default';
const POOL_KEY_ENCODED = encodeURIComponent(POOL_KEY);

describe('PROP-135 Ф6b-1: профили и пулы исполнения — RBAC backend', () => {
  let dataDir: string;
  let backend: BackendAppHandle;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-execution-'));
    backend = await createBackendApp({ dataDir, authDebug: true });
  });

  afterAll(async () => {
    backend.stopScheduler();
    backend.stopEphemeralSweeper();
    backend.stopEventJournalPruner();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const req = (path: string, init: RequestInit = {}, token?: string): Promise<Response> =>
    Promise.resolve(
      backend.app.request(path, {
        ...init,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init.headers ?? {}),
        },
      }),
    );

  it('аноним → 401 на профилях, пулах, drain и release', async () => {
    expect((await req('/api/v2/execution/profiles')).status).toBe(401);
    expect((await req('/api/v2/execution/pools')).status).toBe(401);
    expect(
      (await req(`/api/v2/execution/pools/${POOL_KEY_ENCODED}/drain`, { method: 'POST' })).status,
    ).toBe(401);
    expect(
      (await req(`/api/v2/execution/pools/${POOL_KEY_ENCODED}`, { method: 'DELETE' })).status,
    ).toBe(401);
  });

  it('профили: любой аутентифицированный → 200 (inline — пустой каталог)', async () => {
    // Каталог читает и владелец проекта с ролью USER: профиль выбирается в
    // настройках проекта, поэтому роль на чтение каталога не влияет.
    for (const key of [ADMIN_KEY, LEAD_KEY, USER_KEY, AUDITOR_KEY]) {
      const res = await req('/api/v2/execution/profiles', {}, key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { provider: string; pooling: string; profiles: string[] };
      // dev/test-сборка без секции `execution` — inline.
      expect(body.provider).toBe('inline');
      expect(body.pooling).toBe('instance');
      expect(body.profiles).toEqual([]);
    }
  });

  it('пулы: ADMIN|LEAD → 200 (inline — пустой список), USER|AUDITOR → 403', async () => {
    for (const key of [ADMIN_KEY, LEAD_KEY]) {
      const res = await req('/api/v2/execution/pools', {}, key);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ provider: 'inline', pools: [] });
    }
    for (const key of [USER_KEY, AUDITOR_KEY]) {
      expect((await req('/api/v2/execution/pools', {}, key)).status).toBe(403);
    }
  });

  it('мутации пулов: USER|LEAD|AUDITOR → 403, ADMIN → 503 (inline: провайдера нет)', async () => {
    for (const key of [USER_KEY, LEAD_KEY, AUDITOR_KEY]) {
      expect(
        (await req(`/api/v2/execution/pools/${POOL_KEY_ENCODED}/drain`, { method: 'POST' }, key)).status,
      ).toBe(403);
      expect(
        (await req(`/api/v2/execution/pools/${POOL_KEY_ENCODED}`, { method: 'DELETE' }, key)).status,
      ).toBe(403);
    }
    const drain = await req(
      `/api/v2/execution/pools/${POOL_KEY_ENCODED}/drain`,
      { method: 'POST' },
      ADMIN_KEY,
    );
    expect(drain.status).toBe(503);
    const body = (await drain.json()) as { error: { code: string } };
    expect(body.error.code).toBe('EXECUTION_PROVIDER_UNAVAILABLE');
    expect(
      (await req(`/api/v2/execution/pools/${POOL_KEY_ENCODED}`, { method: 'DELETE' }, ADMIN_KEY)).status,
    ).toBe(503);
  });
});

/**
 * `202` достижим только с живым провайдером пулов, которого нет без
 * provisioner'а. Поэтому та же RBAC-обвязка (те же guard'ы backend-монтажа)
 * проверяется на отдельном Hono с фейковым провайдером: `ADMIN` → `202`,
 * остальные роли — `403` и ни одного вызова провайдера.
 */
describe('PROP-135 Ф6b-1: drain/release с провайдером пулов (RBAC)', () => {
  let dataDir: string;
  let backend: BackendAppHandle;
  let app: Hono;
  const drained: string[] = [];
  const released: string[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-execution-pools-'));
    backend = await createBackendApp({ dataDir, authDebug: true });

    const provider: ExecutionPoolProvider = {
      ensure: async () => ({ url: 'http://pool-1:8080' }),
      list: async () => [{ key: POOL_KEY, profile: 'default', state: 'ready' }],
      drain: async (key: ExecutionPoolKey) => {
        drained.push(key.profile);
      },
      release: async (key: ExecutionPoolKey) => {
        released.push(key.profile);
      },
    };
    const router: ExecutionRouter = {
      portFor: () => ({}) as ExecutionPort,
      profiles: () => ['default'],
      defaultProfile: () => 'default',
      poolProvider: () => provider,
    };

    app = new Hono();
    // Тот же порядок, что в `createBackendApp`: `attachUser` кладёт пользователя
    // в контекст, ролевые guard'ы читают его.
    app.use('*', backend.auth.attachUser);
    app.route(
      '/api/v2/execution',
      createExecutionRoutes(
        { requireAuth: backend.auth.requireAuth },
        { executionRouter: router },
        {
          profilesReadGuard: backend.auth.requireAuth,
          poolsReadGuard: backend.auth.requirePermission('ADMIN', 'LEAD'),
          writeGuard: backend.auth.requirePermission('ADMIN'),
        },
      ),
    );
  });

  afterAll(async () => {
    backend.stopScheduler();
    backend.stopEphemeralSweeper();
    backend.stopEventJournalPruner();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const req = (path: string, init: RequestInit = {}, token?: string): Promise<Response> =>
    Promise.resolve(
      app.request(path, {
        ...init,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init.headers ?? {}),
        },
      }),
    );

  it('ADMIN → 202 на drain и release; провайдер вызван', async () => {
    const drain = await req(`/api/v2/execution/pools/${POOL_KEY_ENCODED}/drain`, { method: 'POST' }, ADMIN_KEY);
    expect(drain.status).toBe(202);
    expect(await drain.json()).toEqual({ ok: true });

    const release = await req(`/api/v2/execution/pools/${POOL_KEY_ENCODED}`, { method: 'DELETE' }, ADMIN_KEY);
    expect(release.status).toBe(202);
    // Идемпотентность: повторный DELETE — снова 202.
    expect(
      (await req(`/api/v2/execution/pools/${POOL_KEY_ENCODED}`, { method: 'DELETE' }, ADMIN_KEY)).status,
    ).toBe(202);

    expect(drained).toEqual(['default']);
    expect(released).toEqual(['default', 'default']);
  });

  it('LEAD читает пулы (200), но не мутирует (403); вызывать провайдера запрещено', async () => {
    expect((await req('/api/v2/execution/pools', {}, LEAD_KEY)).status).toBe(200);
    // Неизвестный ключ не должен «доходить» до провайдера у чужой роли.
    const unknown = encodeURIComponent('session:ses_9:exec:default');
    expect((await req(`/api/v2/execution/pools/${unknown}/drain`, { method: 'POST' }, LEAD_KEY)).status).toBe(403);
    expect((await req(`/api/v2/execution/pools/${unknown}`, { method: 'DELETE' }, LEAD_KEY)).status).toBe(403);
    expect(drained).toEqual(['default']);
    expect(released).toEqual(['default', 'default']);
  });

  it('USER: профили читает (200), пулы — 403 без обращения к провайдеру', async () => {
    expect((await req('/api/v2/execution/profiles', {}, USER_KEY)).status).toBe(200);
    expect((await req('/api/v2/execution/pools', {}, USER_KEY)).status).toBe(403);
    expect(drained).toEqual(['default']);
    expect(released).toEqual(['default', 'default']);
  });

  it('ADMIN: неизвестный ключ реестра → 404, невалидный ключ → 400', async () => {
    const unknown = encodeURIComponent('session:ses_9:exec:default');
    const notFound = await req(`/api/v2/execution/pools/${unknown}/drain`, { method: 'POST' }, ADMIN_KEY);
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');

    const invalid = await req('/api/v2/execution/pools/not-a-key/drain', { method: 'POST' }, ADMIN_KEY);
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });
});
