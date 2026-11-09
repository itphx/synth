/**
 * Backend-специфика HTTP-контура аудита LLM Gateway (ADR-036).
 *
 * Сама логика роута — в core-фабрике (`packages/core/src/server/routes/audit.ts`,
 * тесты там). Здесь проверяется **managed-обвязка**: RBAC-guard'ы
 * (`GET /` — ADMIN|AUDITOR, `POST /revealed` — любой аутентифицированный),
 * общий `AuditLogger` (тот же JSONL, что пишет оркестратор) и проверка
 * существования сессии для раскрытия плейсхолдера.
 *
 * Отдельно — backend-специфика `GET /api/v2/sessions/:id/secrets`
 * (role-map обфускации; маршрут — в backend-фабрике сессий).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditRoutes } from '@itphx/synth-core';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, EventBus, FileStore, AuditLogger, readAuditLog } from '@itphx/synth-core';
import type { User } from '@itphx/synth-shared';

const adminUser: User = {
  id: 'admin', username: 'admin', roles: ['ADMIN'], preferredLanguage: 'ru',
  createdAt: '', teamRole: 'ADMIN', notes: '', interviewCompleted: false,
};
const auditorUser: User = {
  id: 'auditor', username: 'auditor', roles: ['AUDITOR'], preferredLanguage: 'ru',
  createdAt: '', teamRole: 'AUDITOR', notes: '', interviewCompleted: false,
};
const userUser: User = {
  id: 'developer', username: 'developer', roles: ['USER'], preferredLanguage: 'ru',
  createdAt: '', teamRole: 'USER', notes: '', interviewCompleted: false,
};

function createMockKit(user: User | null) {
  return {
    requireAuth: async (c: Context, next: Next) => {
      if (!user) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
      }
      c.set('user', user);
      await next();
    },
    requirePermission: (...roles: string[]) => async (c: Context, next: Next) => {
      const u = c.get('user') as User | undefined;
      if (!u || !roles.some((r) => u.roles.includes(r))) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
      }
      await next();
    },
    getCurrentUser: () => user,
  };
}

function createMockQueueManager() {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    stop: vi.fn(),
    createProcessor: vi.fn(),
    stopAll: vi.fn(),
    getRingBuffer: vi.fn(),
    setContextOptimizer: vi.fn(),
  };
}

function createMockOrchestrator() {
  const processMessage = vi.fn().mockResolvedValue({});
  return {
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
  };
}

function createMockEventHub() {
  return {
    subscribeToSession: vi.fn().mockResolvedValue(undefined),
    unsubscribeFromSession: vi.fn(),
    registerClient: vi.fn().mockResolvedValue(undefined),
    unregisterClient: vi.fn(),
    shutdown: vi.fn(),
  };
}

const entry1 = {
  ts: '2026-08-05T10:00:00.000Z',
  type: 'obfuscated',
  sessionId: 'ses-1',
  userId: 'admin',
  provider: 'itphx',
  model: 'qwen3:14b',
  secretsFound: ['sk-****'],
  placeholders: ['⟦SYNTH_SECRET_1⟧'],
  tokensIn: 100,
  tokensOut: 50,
};

describe('routes/audit: managed-обвязка core-фабрики аудита LLM Gateway', () => {
  let tmpDir: string;
  let auditLogPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-audit-backend-'));
    await mkdir(join(tmpDir, 'audit'), { recursive: true });
    auditLogPath = join(tmpDir, 'audit', 'llm-gateway.jsonl');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeAuditEntry(entry: Record<string, unknown>): Promise<void> {
    await writeFile(auditLogPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
  }

  function createApp(user: User | null, sessionManager?: SessionManager) {
    const app = new Hono();
    const kit = createMockKit(user);
    const fileStore = new FileStore({ dataDir: tmpDir });
    const sm = sessionManager ?? new SessionManager(fileStore);
    const logger = new AuditLogger(auditLogPath);
    app.use('*', kit.requireAuth);
    app.route('/api/v2/audit', createAuditRoutes(
      { requireAuth: kit.requireAuth },
      {
        securityAudit: {
          append: async () => {},
          list: async () => [],
          clear: async () => 0,
        },
        egressRequests: {
          append: async () => {},
          list: async () => [],
          prune: async () => 0,
          clear: async () => 0,
        },
        gatewayAudit: {
          auditLogPath,
          sessionExists: async (sessionId: string) => (await sm.getSession(sessionId)) !== null,
          logger,
        },
      },
      {
        readGuard: kit.requirePermission('ADMIN', 'AUDITOR'),
        gatewayReadGuard: kit.requirePermission('ADMIN', 'AUDITOR'),
        revealedGuard: kit.requireAuth,
      },
    ));
    return app;
  }

  describe('GET /api/v2/audit', () => {
    it('USER → 403, ADMIN/AUDITOR → 200 (guard ADMIN|AUDITOR)', async () => {
      await writeAuditEntry(entry1);
      expect((await createApp(userUser).request('/api/v2/audit')).status).toBe(403);
      expect((await createApp(adminUser).request('/api/v2/audit')).status).toBe(200);
      expect((await createApp(auditorUser).request('/api/v2/audit')).status).toBe(200);
    });

    it('без креды → 401', async () => {
      const res = await createApp(null).request('/api/v2/audit');
      expect(res.status).toBe(401);
    });

    it('читает записи общего AuditLogger (тот же JSONL, что у оркестратора)', async () => {
      await writeAuditEntry(entry1);
      const res = await createApp(adminUser).request('/api/v2/audit');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.total).toBe(1);
      expect(body.entries[0].type).toBe('obfuscated');
    });
  });

  describe('POST /api/v2/audit/revealed', () => {
    it('доступен любому аутентифицированному (USER тоже) и пишет в общий JSONL', async () => {
      const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
      const session = await sessionManager.createSession({ title: 'S1', userId: 'developer' });
      const app = createApp(userUser, sessionManager);

      const res = await app.request('/api/v2/audit/revealed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, placeholder: '⟦SYNTH_SECRET_1⟧' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const { entries } = await readAuditLog(auditLogPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.type).toBe('revealed');
      expect(entries[0]!.userId).toBe('developer');
    });

    it('несуществующая сессия → 404 NOT_FOUND', async () => {
      const res = await createApp(userUser).request('/api/v2/audit/revealed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses-nope', placeholder: '⟦SYNTH_SECRET_1⟧' }),
      });
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });
});

describe('routes/audit: GET /api/v2/sessions/:id/secrets (backend-фабрика сессий)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-audit-secrets-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createSessionsApp(user: User) {
    const app = new Hono();
    const kit = createMockKit(user);
    const fileStore = new FileStore({ dataDir: tmpDir });
    const sessionManager = new SessionManager(fileStore);
    const eventBus = new EventBus();
    const queueManager = createMockQueueManager();
    const orchestrator = createMockOrchestrator();
    const eventHub = createMockEventHub();

    const sessionRoutes = createSessionRoutes(
      kit as any,
      sessionManager,
      eventBus,
      queueManager as any,
      orchestrator.createProcessMessage(),
      orchestrator as any,
      eventHub as any,
    );

    app.use('*', kit.requireAuth);
    app.route('/api/v2/sessions', sessionRoutes);
    return { app, sessionManager };
  }

  it('возвращает пустую карту для сессии без обфускации', async () => {
    const { app, sessionManager } = createSessionsApp(adminUser);
    const session = await sessionManager.createSession({ title: 'S1', userId: 'admin' });

    const res = await app.request(`/api/v2/sessions/${session.id}/secrets`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.sessionId).toBe(session.id);
    expect(body.secrets).toEqual({});
  });

  it('возвращает карту обфускации сессии', async () => {
    const { app, sessionManager } = createSessionsApp(adminUser);
    const session = await sessionManager.createSession({ title: 'S1', userId: 'admin' });
    session.obfuscationMap = { '⟦SYNTH_SECRET_1⟧': 'sk-abc123' };
    await sessionManager.updateSession(session);

    const res = await app.request(`/api/v2/sessions/${session.id}/secrets`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.secrets).toEqual({ '⟦SYNTH_SECRET_1⟧': 'sk-abc123' });
  });

  it('возвращает 404 для несуществующей сессии и 403 для USER', async () => {
    const { app } = createSessionsApp(adminUser);
    const notFound = await app.request('/api/v2/sessions/nope/secrets');
    expect(notFound.status).toBe(404);

    const denied = await createSessionsApp(userUser).app.request('/api/v2/sessions/nope/secrets');
    expect(denied.status).toBe(403);
  });
});
