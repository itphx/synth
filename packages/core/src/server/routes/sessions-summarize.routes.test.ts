/**
 * ADR-119 + ADR-126 §1: `POST /api/v2/sessions/:id/summarize` — ручной запуск
 * сжатия контекста с явно заданным профилем.
 *
 * - без `mode` — `summarization` (значение по умолчанию);
 * - `mode: 'compaction'` — компактизация (ручной запуск `/compact`);
 * - неизвестный `mode` — 400 `VALIDATION_ERROR`;
 * - гейт доступности — по **явному** профилю (`canCompress(session, mode)`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import type { SessionRoutesAuth } from './sessions.js';

const AUTH = { authorization: 'Bearer owner' };

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

function createMockOrchestrator() {
  return {
    createProcessMessage: () => vi.fn().mockResolvedValue({}),
    cancel: vi.fn(),
    getPromptInfo: vi.fn().mockResolvedValue({}),
    getModelPricing: vi.fn().mockReturnValue(null),
    resolveMcpServers: vi.fn(async () => []),
  };
}

/** Мок оптимизатора: гейт доступности — по явно заданному профилю. */
function createMockOptimizer(can = true) {
  return {
    canCompress: vi.fn().mockReturnValue(can),
    canSummarize: vi.fn().mockReturnValue(can),
    shouldApplySlidingWindow: vi.fn().mockReturnValue({ triggered: false }),
    shouldSummarize: vi.fn().mockReturnValue({ triggered: false }),
    shouldCompress: vi.fn().mockReturnValue({ triggered: false }),
  };
}

function createAuth(): SessionRoutesAuth {
  return {
    requireAuth: async (c: Context, next: Next) => {
      if (!c.req.header('authorization')) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } }, 401);
      }
      await next();
    },
  } as unknown as SessionRoutesAuth;
}

function userOf(c: Context): string {
  const raw = (c.req.header('authorization') ?? '').replace(/^Bearer /, '').trim();
  return raw || 'owner';
}

describe('POST /:id/summarize — профиль сжатия (ADR-119, ADR-126 §1)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let optimizer: ReturnType<typeof createMockOptimizer>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-summarize-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    optimizer = createMockOptimizer();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeApp(): Hono {
    const app = new Hono();
    app.route('/api/v2/sessions', createSessionRoutes(
      createAuth(),
      {
        sessionManager,
        eventBus,
        queueManager: createMockQueueManager() as never,
        processMessage: (async () => undefined) as never,
        orchestrator: createMockOrchestrator() as never,
        contextOptimizer: optimizer as never,
      },
      {
        resolveUserId: userOf,
        canAccess: (session, _c, userId) => (session.ownerId ?? session.userId) === userId,
      },
    ));
    return app;
  }

  async function seed(): Promise<string> {
    const session = await sessionManager.createSession({
      title: 'S',
      userId: 'owner',
      ownerId: 'owner',
      // Провайдер/модель нужны для сжатия.
      settings: { provider: 'mock', model: 'mock-model' } as never,
    });
    return session.id;
  }

  function summarize(app: Hono, sessionId: string, init: { body?: unknown; query?: string } = {}): Promise<Response> {
    const url = `/api/v2/sessions/${sessionId}/summarize${init.query ?? ''}`;
    return Promise.resolve(app.request(url, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }));
  }

  /** Профиль в служебном сообщении, поставленном в очередь. */
  async function queuedMode(sessionId: string): Promise<string | undefined> {
    const session = (await sessionManager.getSession(sessionId))!;
    const sys = session.pendingMessages.find((m) => m.metadata?.type === 'summarization_request');
    return sys?.metadata?.mode as string | undefined;
  }

  it('без mode — summarization (значение по умолчанию)', async () => {
    const sessionId = await seed();
    const res = await summarize(makeApp(), sessionId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'enqueued' });
    expect(await queuedMode(sessionId)).toBe('summarization');
    // Гейт — по явно заданному профилю.
    expect(optimizer.canCompress).toHaveBeenCalledWith(expect.anything(), 'summarization');
  });

  it('mode=compaction в теле — ручная компактизация', async () => {
    const sessionId = await seed();
    const res = await summarize(makeApp(), sessionId, { body: { mode: 'compaction' } });
    expect(res.status).toBe(200);
    expect(await queuedMode(sessionId)).toBe('compaction');
    expect(optimizer.canCompress).toHaveBeenCalledWith(expect.anything(), 'compaction');
  });

  it('mode=compaction в query — то же', async () => {
    const sessionId = await seed();
    const res = await summarize(makeApp(), sessionId, { query: '?mode=compaction' });
    expect(res.status).toBe(200);
    expect(await queuedMode(sessionId)).toBe('compaction');
  });

  it('неизвестный mode → 400 VALIDATION_ERROR (сжатие не запускается)', async () => {
    const sessionId = await seed();
    const res = await summarize(makeApp(), sessionId, { body: { mode: 'unknown' } });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect(await queuedMode(sessionId)).toBeUndefined();
  });

  it('сжимать нечего → 400 (гейт по профилю)', async () => {
    const sessionId = await seed();
    optimizer.canCompress.mockReturnValue(false);
    const res = await summarize(makeApp(), sessionId, { body: { mode: 'compaction' } });
    expect(res.status).toBe(400);
    expect(await queuedMode(sessionId)).toBeUndefined();
  });

  it('неизвестная сессия → 404', async () => {
    const res = await summarize(makeApp(), 'unknown');
    expect(res.status).toBe(404);
  });
});
