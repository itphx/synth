import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQueueRoutes } from './queue.js';
import { SessionManager, EventBus, FileStore } from '@itphx/synth-core';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';

function makeMessage(content = 'Привет'): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

function createMockKit() {
  return {
    requireAuth: async (_c: Context, next: Next) => { await next(); },
    requirePermission: () => async (_c: Context, next: Next) => { await next(); },
    getCurrentUser: () => ({
      id: 'test-user',
      username: 'test-user',
      roles: ['USER'],
      preferredLanguage: 'ru',
      createdAt: '',
      teamRole: 'USER',
      notes: '',
      interviewCompleted: false,
    }),
  };
}

function createMockQueueManager() {
  return {
    stop: vi.fn(),
    createProcessor: vi.fn(),
    retryNow: vi.fn().mockReturnValue(false),
    cancelRetry: vi.fn().mockResolvedValue(false),
    isRunning: vi.fn().mockReturnValue(false),
    stopAll: vi.fn(),
    getRingBuffer: vi.fn(),
    setContextOptimizer: vi.fn(),
  };
}

function createTestApp(tmpDir: string) {
  const app = new Hono();
  const kit = createMockKit();
  const fileStore = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(fileStore);
  const eventBus = new EventBus();
  const queueManager = createMockQueueManager();
  const processMessage = vi.fn().mockResolvedValue({});

  const queueRoutes = createQueueRoutes(
    kit as any,
    sessionManager,
    queueManager as any,
    eventBus,
    processMessage as any,
  );

  app.route('/api/v2/queue', queueRoutes);
  return { app, sessionManager, eventBus, queueManager };
}

describe('Queue API Routes', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-queue-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('POST /api/v2/queue/:sessionId/return', () => {
    it('без index возвращает все тексты, очищает очередь и удаляет user-сообщения из истории', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'R' });
      const msg1 = makeMessage('первое');
      const msg2 = makeMessage('второе');
      await sessionManager.addPendingMessage(session.id, msg1);
      await sessionManager.addPendingMessage(session.id, msg2);
      await sessionManager.addMessage(session.id, msg1);
      await sessionManager.addMessage(session.id, msg2);

      const res = await app.request(`/api/v2/queue/${session.id}/return`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.texts).toEqual(['первое', 'второе']);

      const s = await sessionManager.getSession(session.id);
      expect(s!.pendingMessages).toHaveLength(0);
      expect(s!.messages.filter((m) => m.role === MessageRole.USER)).toHaveLength(0);
    });

    it('с index=N возвращает одно сообщение и удаляет только его', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'R' });
      const msg1 = makeMessage('первое');
      const msg2 = makeMessage('второе');
      await sessionManager.addPendingMessage(session.id, msg1);
      await sessionManager.addPendingMessage(session.id, msg2);
      await sessionManager.addMessage(session.id, msg1);
      await sessionManager.addMessage(session.id, msg2);

      const res = await app.request(`/api/v2/queue/${session.id}/return?index=0`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.texts).toEqual(['первое']);

      const s = await sessionManager.getSession(session.id);
      expect(s!.pendingMessages).toHaveLength(1);
      expect(s!.pendingMessages[0]!.content).toBe('второе');
      expect(s!.messages.filter((m) => m.role === MessageRole.USER && m.content === 'первое')).toHaveLength(0);
      expect(s!.messages.filter((m) => m.role === MessageRole.USER && m.content === 'второе')).toHaveLength(1);
    });

    it('не удаляет из истории сообщение активного (не отменённого) стрима', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'R' });
      const active = makeMessage('активное');
      const queued = makeMessage('в очереди');
      await sessionManager.addPendingMessage(session.id, active);
      await sessionManager.addPendingMessage(session.id, queued);
      await sessionManager.addMessage(session.id, active);
      await sessionManager.addMessage(session.id, queued);

      const activeStreamId = active.metadata!.stream_id as string;
      await sessionManager.safeUpdate(session.id, async (s) => {
        s.currentStream = {
          streamId: activeStreamId,
          message: active.content,
          agentRole: active.agentRole,
          startedAt: nowISO(),
          cancelled: false,
        };
      });

      const res = await app.request(`/api/v2/queue/${session.id}/return`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.texts).toEqual(['активное', 'в очереди']);

      const s = await sessionManager.getSession(session.id);
      expect(s!.pendingMessages).toHaveLength(0);
      // Активный стрим остаётся в истории, queued — удаляется
      expect(s!.messages.filter((m) => m.role === MessageRole.USER && m.content === 'активное')).toHaveLength(1);
      expect(s!.messages.filter((m) => m.role === MessageRole.USER && m.content === 'в очереди')).toHaveLength(0);
    });

    it('при зависшей сессии (currentStream.cancelled=true) возвращает все тексты, удаляет сообщения и разблокирует', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Stalled' });
      const msg = makeMessage('зависшее');
      await sessionManager.addPendingMessage(session.id, msg);
      await sessionManager.addMessage(session.id, msg);

      // Имитация «зависшей» сессии: currentStream не null, но cancelled=true
      await sessionManager.safeUpdate(session.id, async (s) => {
        s.status.blocked = session.id;
        s.status.blockedAt = nowISO();
        s.currentStream = {
          streamId: msg.metadata!.stream_id as string,
          message: msg.content,
          agentRole: msg.agentRole,
          startedAt: nowISO(),
          cancelled: true,
        };
      });

      const res = await app.request(`/api/v2/queue/${session.id}/return`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.texts).toEqual(['зависшее']);

      const s = await sessionManager.getSession(session.id);
      expect(s!.pendingMessages).toHaveLength(0);
      expect(s!.status.blocked).toBeUndefined();
      expect(s!.currentStream).toBeUndefined();
      expect(s!.messages.filter((m) => m.role === MessageRole.USER)).toHaveLength(0);
    });

    it('возвращает 404 для несуществующего index', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'R' });
      const msg = makeMessage('первое');
      await sessionManager.addPendingMessage(session.id, msg);

      const res = await app.request(`/api/v2/queue/${session.id}/return?index=5`, { method: 'POST' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v2/queue/:sessionId/resume', () => {
    it('не дублирует: не публикует message.queued, если сообщение уже в истории', async () => {
      const { app, sessionManager, eventBus } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Resume' });
      const msg = makeMessage('зависшее');
      const streamId = msg.metadata!.stream_id as string;
      await sessionManager.addPendingMessage(session.id, msg);
      await sessionManager.addMessage(session.id, msg);

      const events: any[] = [];
      eventBus.subscribe(session.id, (e) => events.push(e));

      const res = await app.request(`/api/v2/queue/${session.id}/resume`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.resumed).toBe(true);
      expect(body.pending_count).toBe(1);

      // stream_id не перегенерирован
      const s = await sessionManager.getSession(session.id);
      expect(s!.pendingMessages[0]!.metadata?.stream_id).toBe(streamId);
      // message.queued не опубликован (сообщение уже в истории)
      expect(events.filter((e) => e.type === 'message.queued')).toHaveLength(0);
    });

    it('публикует message.queued с существующим stream_id, если сообщение не в истории', async () => {
      const { app, sessionManager, eventBus } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Resume' });
      const msg = makeMessage('новое');
      const streamId = msg.metadata!.stream_id as string;
      await sessionManager.addPendingMessage(session.id, msg);

      const events: any[] = [];
      eventBus.subscribe(session.id, (e) => events.push(e));

      const res = await app.request(`/api/v2/queue/${session.id}/resume`, { method: 'POST' });
      expect(res.status).toBe(200);

      const queued = events.find((e) => e.type === 'message.queued');
      expect(queued).toBeDefined();
      expect(queued.data.stream_id).toBe(streamId);

      const s = await sessionManager.getSession(session.id);
      expect(s!.pendingMessages[0]!.metadata?.stream_id).toBe(streamId);
    });

    it('возвращает pending_count 0 для пустой очереди', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Resume' });

      const res = await app.request(`/api/v2/queue/${session.id}/resume`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.resumed).toBe(true);
      expect(body.pending_count).toBe(0);
    });
  });
});
