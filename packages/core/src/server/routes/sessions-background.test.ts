/**
 * `POST /api/v2/sessions/:id/background` — перевод идущих блокирующих прогонов
 * в фон (ADR-111 §detach).
 *
 * Проверяем контракт роута: 200 со сводкой (пустой `detached` — не ошибка),
 * `failed` только при непустом массиве, `400 VALIDATION_ERROR` на неизвестный
 * `type`, `400 DETACH_UNSUPPORTED` для удалённой (гибридной) сессии и `404` для
 * несуществующей.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, EventBus, FileStore } from '../../index.js';
import { ActiveRunRegistry } from '../../engine/background/active-runs.js';
import type { AuthKit } from '../../auth/local.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

function createMockQueueManager() {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    stop: vi.fn(),
    createProcessor: vi.fn(),
    stopAll: vi.fn(),
    getRingBuffer: vi.fn(),
    setContextOptimizer: vi.fn(),
    requestStop: vi.fn().mockReturnValue(false),
  };
}

describe('POST /api/v2/sessions/:id/background — detach (ADR-111)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let registry: ActiveRunRegistry;
  let app: Hono;

  function createApp(opts: { withRemote?: boolean } = {}) {
    const fileStore = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(fileStore);
    registry = new ActiveRunRegistry();
    const eventBus = new EventBus();
    const queueManager = createMockQueueManager();
    const orchestrator = {
      activeRuns: registry,
      createProcessMessage: () => vi.fn().mockResolvedValue({}),
      cancel: vi.fn(),
    };
    const routes = createSessionRoutes(
      createMockAuth(),
      {
        sessionManager,
        eventBus,
        queueManager: queueManager as never,
        processMessage: vi.fn().mockResolvedValue({}) as never,
        orchestrator: orchestrator as never,
        ...(opts.withRemote ? { getRemoteClient: () => null } : {}),
      },
      {},
    );
    const hono = new Hono();
    hono.route('/api/v2/sessions', routes);
    return hono;
  }

  /** Хэндл активного прогона с наблюдаемым `detach`. */
  function makeRun(id: string, kind: 'subagent' | 'process' = 'subagent', title?: string) {
    const detach = vi.fn(async () => {});
    return { handle: { id, kind, ...(title ? { title } : {}), detach }, detach };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-detach-'));
    app = createApp({ withRemote: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function post(sessionId: string, body?: string) {
    return app.request(`/api/v2/sessions/${sessionId}/background`, {
      method: 'POST',
      ...(body !== undefined
        ? { headers: { 'Content-Type': 'application/json' }, body }
        : {}),
    });
  }

  it('200: переводит зарегистрированный прогон и отдаёт сводку', async () => {
    const session = await sessionManager.createSession({ title: 'S' });
    const run = makeRun('child-1', 'subagent', 'Изучить репозиторий');
    registry.register(session.id, run.handle);

    const res = await post(session.id);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toEqual({
      sessionId: session.id,
      detached: [{ id: 'child-1', kind: 'subagent', title: 'Изучить репозиторий' }],
    });
    // Пустой `failed` в ответ не попадает.
    expect('failed' in body).toBe(false);
    expect(run.detach).toHaveBeenCalledTimes(1);
  });

  it('200: нечего переводить — пустой detached, без failed', async () => {
    const session = await sessionManager.createSession({ title: 'S' });
    const res = await post(session.id);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toEqual({ sessionId: session.id, detached: [] });
    expect('failed' in body).toBe(false);
  });

  it('200: тело `{type}` сужает выборку по виду прогона', async () => {
    const session = await sessionManager.createSession({ title: 'S' });
    const sub = makeRun('child-1', 'subagent');
    const proc = makeRun('proc-1', 'process');
    registry.register(session.id, sub.handle);
    registry.register(session.id, proc.handle);

    const res = await post(session.id, JSON.stringify({ type: 'process' }));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.detached).toEqual([{ id: 'proc-1', kind: 'process' }]);
    expect(sub.detach).not.toHaveBeenCalled();
    expect(proc.detach).toHaveBeenCalledTimes(1);
  });

  it('200 + failed: отказ перевода попадает в failed (BACKGROUND_LIMIT)', async () => {
    const session = await sessionManager.createSession({ title: 'S' });
    const { BackgroundLimitExceededError } = await import('../../engine/background/types.js');
    const run = makeRun('child-1');
    run.detach.mockRejectedValue(
      new BackgroundLimitExceededError('subagents', 2, 'Превышен лимит фоновых саб-агентов'),
    );
    registry.register(session.id, run.handle);

    const res = await post(session.id);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.detached).toEqual([]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]).toMatchObject({ id: 'child-1', kind: 'subagent', code: 'BACKGROUND_LIMIT' });
  });

  it('400 VALIDATION_ERROR: неизвестный type', async () => {
    const session = await sessionManager.createSession({ title: 'S' });
    const res = await post(session.id, JSON.stringify({ type: 'shell' }));
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR: тело не JSON', async () => {
    const session = await sessionManager.createSession({ title: 'S' });
    const res = await post(session.id, '{not-json');
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR');
  });

  it('400 DETACH_UNSUPPORTED: удалённая (гибридная) сессия', async () => {
    const res = await post('remote:00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('DETACH_UNSUPPORTED');
  });

  it('404 NOT_FOUND: сессии нет', async () => {
    const res = await post('missing-session');
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe('NOT_FOUND');
  });
});
