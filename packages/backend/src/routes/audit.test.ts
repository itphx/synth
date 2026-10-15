import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditRoutes } from './audit.js';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, EventBus, FileStore, AuditLogger, readAuditLog } from '@itphx/synth-core';
import type { User } from '@itphx/synth-shared';

const adminUser: User = {
  id: 'admin',
  username: 'admin',
  roles: ['ADMIN'],
  preferredLanguage: 'ru',
  createdAt: '',
  teamRole: 'ADMIN',
  notes: '',
  interviewCompleted: false,
};

const auditorUser: User = {
  id: 'auditor',
  username: 'auditor',
  roles: ['AUDITOR'],
  preferredLanguage: 'ru',
  createdAt: '',
  teamRole: 'AUDITOR',
  notes: '',
  interviewCompleted: false,
};

const userUser: User = {
  id: 'developer',
  username: 'developer',
  roles: ['USER'],
  preferredLanguage: 'ru',
  createdAt: '',
  teamRole: 'USER',
  notes: '',
  interviewCompleted: false,
};

function createMockKit(user: User) {
  return {
    requireAuth: async (c: Context, next: Next) => {
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

async function writeAuditEntry(logPath: string, entry: Record<string, unknown>): Promise<void> {
  await writeFile(logPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
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

const entry2 = {
  ts: '2026-08-05T11:00:00.000Z',
  type: 'rate_limited',
  sessionId: 'ses-2',
  userId: 'developer',
  provider: 'itphx',
  model: 'qwen3:14b',
  reason: 'Rate limit exceeded',
};

const entry3 = {
  ts: '2026-08-05T12:00:00.000Z',
  type: 'blocked',
  sessionId: 'ses-1',
  userId: 'admin',
  provider: 'itphx',
  model: 'qwen3:14b',
  secretsFound: ['sk-****'],
  reason: 'Запрос заблокирован',
};

describe('Audit API Routes (ADR-036)', () => {
  let tmpDir: string;
  let auditLogPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-audit-'));
    await mkdir(join(tmpDir, 'audit'), { recursive: true });
    auditLogPath = join(tmpDir, 'audit', 'llm-gateway.jsonl');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createApp(user: User, sessionManager?: SessionManager) {
    const app = new Hono();
    const kit = createMockKit(user);
    const fileStore = new FileStore({ dataDir: tmpDir });
    const sm = sessionManager ?? new SessionManager(fileStore);
    const logger = new AuditLogger(auditLogPath);
    app.use('*', kit.requireAuth);
    app.route('/api/v2/audit', createAuditRoutes(kit as any, {
      auditLogPath,
      sessionExists: async (sessionId: string) => (await sm.getSession(sessionId)) !== null,
      logger,
    }));
    return app;
  }

  describe('GET /api/v2/audit', () => {
    it('возвращает пустой список если файла аудита нет', async () => {
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/audit');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({ entries: [], total: 0 });
    });

    it('возвращает все записи и total', async () => {
      await writeAuditEntry(auditLogPath, entry1);
      await writeAuditEntry(auditLogPath, entry2);
      await writeAuditEntry(auditLogPath, entry3);

      const app = createApp(adminUser);
      const res = await app.request('/api/v2/audit');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.total).toBe(3);
      expect(body.entries).toHaveLength(3);
      expect(body.entries[0].type).toBe('obfuscated');
      expect(body.entries[2].type).toBe('blocked');
    });

    it('фильтрует по userId и sessionId', async () => {
      await writeAuditEntry(auditLogPath, entry1);
      await writeAuditEntry(auditLogPath, entry2);
      await writeAuditEntry(auditLogPath, entry3);

      const app = createApp(adminUser);
      const res = await app.request('/api/v2/audit?userId=admin&sessionId=ses-1');
      const body: any = await res.json();
      expect(body.total).toBe(2);
      expect(body.entries.map((e: any) => e.type)).toEqual(['obfuscated', 'blocked']);
    });

    it('фильтрует по since/until и ограничивает limit (хвост)', async () => {
      await writeAuditEntry(auditLogPath, entry1);
      await writeAuditEntry(auditLogPath, entry2);
      await writeAuditEntry(auditLogPath, entry3);

      const app = createApp(adminUser);

      const sinceRes = await app.request('/api/v2/audit?since=2026-08-05T11:00:00.000Z');
      const sinceBody: any = await sinceRes.json();
      expect(sinceBody.total).toBe(2);

      const untilRes = await app.request('/api/v2/audit?until=2026-08-05T10:30:00.000Z');
      const untilBody: any = await untilRes.json();
      expect(untilBody.total).toBe(1);

      const limitRes = await app.request('/api/v2/audit?limit=2');
      const limitBody: any = await limitRes.json();
      expect(limitBody.total).toBe(3);
      expect(limitBody.entries).toHaveLength(2);
      expect(limitBody.entries[0].type).toBe('rate_limited');
      expect(limitBody.entries[1].type).toBe('blocked');
    });

    it('доступен только ADMIN и AUDITOR (USER получает 403)', async () => {
      await writeAuditEntry(auditLogPath, entry1);

      const denied = await createApp(userUser).request('/api/v2/audit');
      expect(denied.status).toBe(403);

      const adminOk = await createApp(adminUser).request('/api/v2/audit');
      expect(adminOk.status).toBe(200);

      const auditorOk = await createApp(auditorUser).request('/api/v2/audit');
      expect(auditorOk.status).toBe(200);
    });
  });

  describe('POST /api/v2/audit/revealed', () => {
    it('логирует раскрытие плейсхолдера в audit-файле', async () => {
      const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
      const session = await sessionManager.createSession({ title: 'S1', userId: 'developer' });
      const app = createApp(userUser, sessionManager);

      const res = await app.request('/api/v2/audit/revealed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, placeholder: '⟦SYNTH_SECRET_1⟧' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({ ok: true });

      const { entries } = await readAuditLog(auditLogPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.type).toBe('revealed');
      expect(entries[0]!.sessionId).toBe(session.id);
      expect(entries[0]!.userId).toBe('developer');
      expect(entries[0]!.placeholder).toBe('⟦SYNTH_SECRET_1⟧');
    });

    it('возвращает 400 для невалидного placeholder', async () => {
      const app = createApp(userUser);
      const res = await app.request('/api/v2/audit/revealed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses-any', placeholder: 'не-плейсхолдер' }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('возвращает 404 для несуществующей сессии', async () => {
      const app = createApp(userUser);
      const res = await app.request('/api/v2/audit/revealed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses-nope', placeholder: '⟦SYNTH_SECRET_1⟧' }),
      });
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/v2/sessions/:id/secrets', () => {
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
});
