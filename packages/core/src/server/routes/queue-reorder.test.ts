/**
 * `POST /api/v2/queue/:sessionId/reorder` — переупорядочивание обычной очереди
 * (DnD в UI): `{ids: string[]}` — желаемый порядок; состав обязан совпадать
 * с `pendingMessages`. Несовпадение → 409 `QUEUE_CHANGED`, невалидный список →
 * 400 `VALIDATION_ERROR`, успех → 200 `{status:'ok', order}` + `queue.state`.
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

function makeUserMessage(content: string): Message {
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
    metadata: { stream_id: generateId() },
  };
}

describe('POST /api/v2/queue/:sessionId/reorder', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let app: Hono;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-queue-reorder-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
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
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function seedPending(contents: string[]): Promise<Message[]> {
    const out: Message[] = [];
    for (const content of contents) {
      const message = makeUserMessage(content);
      await sessionManager.addPendingMessage(sessionId, message);
      out.push(message);
    }
    return out;
  }

  async function reorder(ids: unknown): Promise<Response> {
    return app.request(`/api/v2/queue/${sessionId}/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
  }

  it('успех: переставляет очередь в заданном порядке и публикует queue.state', async () => {
    const [first, second, third] = await seedPending(['one', 'two', 'three']);
    const events: BusEvent[] = [];
    eventBus.subscribe(sessionId, (event) => events.push(event));

    const res = await reorder([third!.id, first!.id, second!.id]);

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; order: string[] };
    expect(body.status).toBe('ok');
    expect(body.order).toEqual([third!.id, first!.id, second!.id]);

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.pendingMessages.map((m) => m.id)).toEqual([
      third!.id,
      first!.id,
      second!.id,
    ]);

    const state = events.filter((e) => e.type === 'queue.state').at(-1);
    expect(state).toBeTruthy();
    const payload = state!.data as { pendingCount: number; items: Array<{ id: string }> };
    expect(payload.pendingCount).toBe(3);
    expect(payload.items.map((item) => item.id)).toEqual([
      third!.metadata!.stream_id,
      first!.metadata!.stream_id,
      second!.metadata!.stream_id,
    ]);
  });

  it('mismatch: состав не совпал → 409 QUEUE_CHANGED, очередь не меняется', async () => {
    const [first, second] = await seedPending(['one', 'two']);
    const foreign = makeUserMessage('foreign');

    const res = await reorder([second!.id, foreign.id]);

    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('QUEUE_CHANGED');
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.pendingMessages.map((m) => m.id)).toEqual([first!.id, second!.id]);
  });

  it('mismatch: пропущен элемент → 409 QUEUE_CHANGED', async () => {
    const [first] = await seedPending(['one', 'two']);

    const res = await reorder([first!.id]);

    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('QUEUE_CHANGED');
  });

  it('дубли/пустые id/не-массив → 400 VALIDATION_ERROR', async () => {
    const [first] = await seedPending(['one', 'two']);

    for (const ids of [[first!.id, first!.id], [''], 'nope']) {
      const res = await reorder(ids);
      expect(res.status).toBe(400);
      expect((await res.json() as { error: { code: string } }).error.code).toBe(
        'VALIDATION_ERROR',
      );
    }
  });

  it('пустая очередь — no-op ok', async () => {
    const res = await reorder([]);

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; order: string[] };
    expect(body).toEqual({ status: 'ok', order: [] });
  });

  it('нет сессии → 404 (граничный guard)', async () => {
    const res = await app.request('/api/v2/queue/missing/reorder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });

    expect(res.status).toBe(404);
    expect(['NOT_FOUND', 'SESSION_NOT_FOUND']).toContain(
      (await res.json() as { error: { code: string } }).error.code,
    );
  });
});
