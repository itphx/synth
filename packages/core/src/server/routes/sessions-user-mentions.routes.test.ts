/**
 * ADR-126 §2: `@user` — граница «агенту / пользователю».
 *
 * - текст до первого `@user` уходит в очередь;
 * - хвост от `@user` сохраняется сразу как user-directed, публикует
 *   `message.mentioned` и не запускает ход;
 * - сообщение, начинающееся с `@user`, не ставит ничего в очередь;
 * - неизвестный явный user-id — 400 без частичной доставки.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, EventBus, FileStore } from '../../index.js';
import type { QueueProcessorManager, ChatOrchestrator } from '../../index.js';
import type { BusEvent } from '@itphx/synth-shared';
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

function createMockOrchestrator() {
  const processMessage = vi.fn().mockResolvedValue({});
  return {
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
    interrupt: vi.fn().mockReturnValue(true),
    obfuscateUserMessageForHistory: vi.fn(async (_sid: string, message: unknown) => message),
    getPromptInfo: vi.fn().mockResolvedValue({}),
    getModelPricing: vi.fn().mockReturnValue(null),
  };
}

describe('POST /api/v2/sessions/:id/prompt — @user (ADR-126 §2)', () => {
  let tmpDir: string;
  let events: BusEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-user-mentions-'));
    events = [];
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createTestApp() {
    const app = new Hono();
    const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    const eventBus = new EventBus();
    eventBus.subscribeAll((event) => events.push(event));
    const queueManager = createMockQueueManager();
    const orchestrator = createMockOrchestrator();

    const routes = createSessionRoutes(
      createMockAuth(),
      {
        sessionManager,
        eventBus,
        queueManager: queueManager as unknown as QueueProcessorManager,
        processMessage: orchestrator.createProcessMessage(),
        orchestrator: orchestrator as unknown as ChatOrchestrator,
      },
      {
        resolveUserId: () => 'bob',
        canAccess: (session: { ownerId?: string; userId?: string }, _c: Context, userId: string) =>
          (session.ownerId ?? session.userId) === userId,
      },
    );
    app.route('/api/v2/sessions', routes);
    return { app, sessionManager };
  }

  async function seed() {
    const { app, sessionManager } = createTestApp();
    const session = await sessionManager.createSession({
      title: 'P',
      userId: 'bob',
      ownerId: 'bob',
    });
    session.participants = [{ userId: 'alice', role: 'viewer' }];
    await sessionManager.saveSession(session);
    return { app, sessionManager, session };
  }

  async function prompt(
    app: Hono,
    sessionManager: SessionManager,
    sessionId: string,
    body: Record<string, unknown>,
  ) {
    const res = await app.request(`/api/v2/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const fresh = (await sessionManager.getSession(sessionId))!;
    return { res, fresh };
  }

  it('до @user — в очередь, хвост — user-directed без хода', async () => {
    const { app, sessionManager, session } = await seed();
    const { res, fresh } = await prompt(app, sessionManager, session.id, {
      content: 'Исправь X @alice проверь исправление',
    });

    expect(res.status).toBe(202);
    expect(fresh.pendingMessages).toHaveLength(1);
    expect(fresh.pendingMessages[0]?.content).toBe('Исправь X');

    const tail = fresh.messages.find((message) => message.metadata?.userDirected === true);
    expect(tail?.content).toBe('@alice проверь исправление');
    expect(tail?.mentions?.[0]).toMatchObject({ kind: 'user', id: 'alice' });

    const mentioned = events.find((event) => event.type === 'message.mentioned');
    expect(mentioned?.data).toMatchObject({
      session_id: session.id,
      message_id: tail?.id,
      user_ids: ['alice'],
    });
  });

  it('сообщение, начинающееся с @user, не ставит ничего в очередь', async () => {
    const { app, sessionManager, session } = await seed();
    const { res, fresh } = await prompt(app, sessionManager, session.id, {
      content: '@alice проверь исправление',
    });

    expect(res.status).toBe(202);
    expect(fresh.pendingMessages).toHaveLength(0);
    const tail = fresh.messages.find((message) => message.metadata?.userDirected === true);
    expect(tail?.content).toBe('@alice проверь исправление');
  });

  it('неизвестный явный user-id → 400 без частичной доставки', async () => {
    const { app, sessionManager, session } = await seed();
    const { res, fresh } = await prompt(app, sessionManager, session.id, {
      content: 'привет @nobody',
      mentions: [{ kind: 'user', id: 'nobody', label: 'nobody', span: { start: 6, end: 13 } }],
    });

    expect(res.status).toBe(400);
    expect(fresh.pendingMessages).toHaveLength(0);
    expect(fresh.messages).toHaveLength(0);
  });

  it('$ и # в user-хвосте — обычный текст (не исполняются)', async () => {
    const { app, sessionManager, session } = await seed();
    const { res, fresh } = await prompt(app, sessionManager, session.id, {
      content: '@alice посмотри $skill и #snippet',
    });

    expect(res.status).toBe(202);
    expect(fresh.pendingMessages).toHaveLength(0);
    const tail = fresh.messages.find((message) => message.metadata?.userDirected === true);
    expect(tail?.content).toBe('@alice посмотри $skill и #snippet');
    expect(tail?.metadata?.dollarSkills).toBeUndefined();
    expect(tail?.metadata?.snippetExpansions).toBeUndefined();
  });
});
