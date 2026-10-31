/**
 * `GET /api/v2/sessions/:id/messages/:messageId` — целевая загрузка одного
 * сообщения: DTO как у элемента `GET /:id/messages`, 404 на чужой id,
 * доступ — граничный prefix-guard (гость 401, чужой 403).
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
import { generateId, makeTextPart, MessageRole, nowISO } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';

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
    getPromptInfo: vi.fn().mockResolvedValue({}),
    getModelPricing: vi.fn().mockReturnValue(null),
  };
}

/** 401 без `Authorization` — как у списка сообщений (requireAuth). */
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

function makeMessage(content: string): Message {
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
  };
}

describe('GET /api/v2/sessions/:id/messages/:messageId', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let app: Hono;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-message-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    const orchestrator = createMockOrchestrator();
    app = new Hono();
    app.route('/api/v2/sessions', createSessionRoutes(
      createAuth(),
      {
        sessionManager,
        eventBus: new EventBus(),
        queueManager: createMockQueueManager() as never,
        processMessage: orchestrator.createProcessMessage() as never,
        orchestrator: orchestrator as never,
      },
      { resolveUserId: () => 'local' },
    ));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function seed(ownerId = 'local'): Promise<{ sessionId: string; first: Message; second: Message }> {
    const session = await sessionManager.createSession({ title: 'S', userId: ownerId, ownerId });
    const first = makeMessage('first');
    const second = makeMessage('second');
    await sessionManager.addMessage(session.id, first);
    await sessionManager.addMessage(session.id, second);
    return { sessionId: session.id, first, second };
  }

  it('находит сообщение по id и отдаёт DTO как у списка', async () => {
    const { sessionId, second } = await seed();

    const res = await app.request(
      `/api/v2/sessions/${sessionId}/messages/${second.id}`,
      { headers: { authorization: 'Bearer test' } },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      id: string; role: string; content: string; index: number; parts: Array<{ type: string }>;
    };
    expect(body.id).toBe(second.id);
    expect(body.role).toBe(MessageRole.USER);
    expect(body.content).toBe('second');
    expect(body.index).toBe(1);
    expect(body.parts[0]!.type).toBe('text');
  });

  it('404 MESSAGE_NOT_FOUND на неизвестный id в своей сессии', async () => {
    const { sessionId } = await seed();

    const res = await app.request(
      `/api/v2/sessions/${sessionId}/messages/missing`,
      { headers: { authorization: 'Bearer test' } },
    );

    expect(res.status).toBe(404);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('401 без аутентификации (как у списка)', async () => {
    const { sessionId, second } = await seed();

    const res = await app.request(`/api/v2/sessions/${sessionId}/messages/${second.id}`);

    expect(res.status).toBe(401);
  });

  it('403 на чужую сессию (как у списка)', async () => {
    const { sessionId, second } = await seed('someone-else');

    const res = await app.request(
      `/api/v2/sessions/${sessionId}/messages/${second.id}`,
      { headers: { authorization: 'Bearer test' } },
    );

    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });
});
