/**
 * `GET /api/v2/sessions/:id/messages` — best-effort ремонт «застрявшего»
 * шага: история могла остаться с `status: 'streaming'` после гонки/рестарта,
 * и UI принимает такую запись за живой ход. Ремонт идёт только при отсутствии
 * `currentStream` и не должен превращаться в запись на happy-path.
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

function makeMessage(partial: Partial<Message> & Pick<Message, 'role' | 'content'>): Message {
  return {
    id: generateId(),
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(partial.content)],
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    ...partial,
  };
}

describe('GET /api/v2/sessions/:id/messages — ремонт застрявшего streaming', () => {
  let tmpDir: string;
  let store: FileStore;
  let sessionManager: SessionManager;
  let app: Hono;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-messages-repair-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    app = new Hono();
    app.route('/api/v2/sessions', createSessionRoutes(
      createAuth(),
      {
        sessionManager,
        eventBus: new EventBus(),
        queueManager: createMockQueueManager() as never,
        processMessage: createMockOrchestrator().createProcessMessage() as never,
        orchestrator: createMockOrchestrator() as never,
      },
      { resolveUserId: () => 'local' },
    ));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Сессия с «застрявшим» assistant-шагом + парный tool-результат. */
  async function seedStuck(): Promise<string> {
    const session = await sessionManager.createSession({ title: 'S', userId: 'local', ownerId: 'local' });
    await sessionManager.addMessage(session.id, makeMessage({
      role: MessageRole.ASSISTANT,
      content: 'черновик шага',
      status: 'streaming',
      metadata: { stream_id: 's1', tool_results: [{ id: 'call_1', name: 'read_file' }] },
    }));
    await sessionManager.addMessage(session.id, makeMessage({
      role: MessageRole.TOOL,
      content: 'результат',
      toolCallId: 'call_1',
    }));
    return session.id;
  }

  it('отдаёт терминальный статус вместо streaming и чинит историю', async () => {
    const sessionId = await seedStuck();

    const res = await app.request(`/api/v2/sessions/${sessionId}/messages`, {
      headers: { authorization: 'Bearer test' },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { messages: Array<{ status: string | null }> };
    expect(body.messages[0]!.status).toBe('completed');

    const stored = (await sessionManager.getSession(sessionId))!;
    expect(stored.messages[0]!.status).toBe('completed');
  });

  it('happy-path (нет застрявших записей) не пишет сессию', async () => {
    const session = await sessionManager.createSession({ title: 'S', userId: 'local', ownerId: 'local' });
    await sessionManager.addMessage(session.id, makeMessage({
      role: MessageRole.ASSISTANT,
      content: 'готовый ответ',
      status: 'completed',
    }));

    const saveSpy = vi.spyOn(store, 'save');
    const res = await app.request(`/api/v2/sessions/${session.id}/messages`, {
      headers: { authorization: 'Bearer test' },
    });

    expect(res.status).toBe(200);
    expect(saveSpy).not.toHaveBeenCalled();
    saveSpy.mockRestore();
  });

  it('активный currentStream — историю не трогаем', async () => {
    const sessionId = await seedStuck();
    const session = (await sessionManager.getSession(sessionId))!;
    session.currentStream = {
      streamId: 's1',
      message: 'запрос',
      startedAt: nowISO(),
      cancelled: false,
    };
    await sessionManager.saveSession(session);

    const res = await app.request(`/api/v2/sessions/${sessionId}/messages`, {
      headers: { authorization: 'Bearer test' },
    });

    expect(res.status).toBe(200);
    const stored = (await sessionManager.getSession(sessionId))!;
    expect(stored.messages[0]!.status).toBe('streaming');
  });
});
