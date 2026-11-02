/**
 * `POST /api/v2/queue/:sessionId/return` — возврат сообщений из очереди в поле
 * ввода. Возвращённые user-сообщения удаляются из истории (иначе дубль при
 * повторной отправке) — другие клиенты должны убрать их по `id`
 * (`message.deleted`, ADR-118 §4/§7).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQueueRoutes } from './queue.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import type { QueueProcessorManager, ChatOrchestrator } from '../../index.js';
import type { AuthKit } from '../../auth/local.js';
import { generateId, makeTextPart, MessageRole, nowISO } from '@itphx/synth-shared';
import type { BusEvent, Message } from '@itphx/synth-shared';

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

function makeUserMessage(content: string, streamId: string): Message {
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
    author: 'local',
    metadata: { stream_id: streamId },
  };
}

describe('POST /api/v2/queue/:sessionId/return — message.deleted', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let app: Hono;
  let sessionId: string;
  let events: BusEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-queue-return-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    events = [];
    app = new Hono();
    app.route('/api/v2/queue', createQueueRoutes(
      createMockAuth(),
      sessionManager,
      createMockQueueManager() as unknown as QueueProcessorManager,
      eventBus,
      (async () => ({})) as unknown as ReturnType<ChatOrchestrator['createProcessMessage']>,
    ));
    const session = await sessionManager.createSession({ title: 'Q' });
    sessionId = session.id;
    eventBus.subscribe(sessionId, (e) => { events.push(e); });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('удалённые из истории user-сообщения получают message.deleted на каждый id', async () => {
    const streamA = generateId();
    const streamB = generateId();
    const msgA = makeUserMessage('a', streamA);
    const msgB = makeUserMessage('b', streamB);
    await sessionManager.addMessage(sessionId, msgA);
    await sessionManager.addMessage(sessionId, msgB);

    await sessionManager.safeUpdate(sessionId, async (s) => {
      s.pendingMessages = [
        { ...makeUserMessage('a', streamA), id: `p-${msgA.id}` },
        { ...makeUserMessage('b', streamB), id: `p-${msgB.id}` },
      ];
    });

    const res = await app.request(`/api/v2/queue/${sessionId}/return`, { method: 'POST' });
    expect(res.status).toBe(200);

    const deleted = events
      .filter((e) => e.type === 'message.deleted')
      .map((e) => (e.data as { message_id: string }).message_id);
    expect(deleted).toEqual([msgA.id, msgB.id]);

    const remaining = await sessionManager.getSession(sessionId);
    expect(remaining!.messages).toEqual([]);

    // Счётчики очереди тоже обновлены.
    expect(events.some((e) => e.type === 'queue.state')).toBe(true);
  });

  it('сообщение активного стрима из истории не удаляется и события не получает', async () => {
    const activeStream = generateId();
    const queuedStream = generateId();
    const activeMsg = makeUserMessage('running', activeStream);
    const queuedMsg = makeUserMessage('queued', queuedStream);
    await sessionManager.addMessage(sessionId, activeMsg);
    await sessionManager.addMessage(sessionId, queuedMsg);

    await sessionManager.safeUpdate(sessionId, async (s) => {
      s.currentStream = { streamId: activeStream, cancelled: false } as never;
      s.pendingMessages = [{ ...makeUserMessage('queued', queuedStream), id: `p-${queuedMsg.id}` }];
    });

    const res = await app.request(`/api/v2/queue/${sessionId}/return`, { method: 'POST' });
    expect(res.status).toBe(200);

    const deleted = events
      .filter((e) => e.type === 'message.deleted')
      .map((e) => (e.data as { message_id: string }).message_id);
    expect(deleted).toEqual([queuedMsg.id]);

    const remaining = await sessionManager.getSession(sessionId);
    expect(remaining!.messages.map((m) => m.id)).toEqual([activeMsg.id]);
  });
});
