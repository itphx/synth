/**
 * PROP-142 §1/§3: HTTP-контур дочерней сессии саб-агента.
 *
 * 1. `POST /api/v2/sessions/:id/prompt` для **дочерней** сессии — явная
 *    семантика вместо «скрытой третьей» (обычный процессор очереди сессии):
 *    свободный ребёнок — продолжение с текстом указаний (`startSubagentResume`),
 *    занятый — сообщение в очередь ребёнка (`pendingMessages`, без автозапуска),
 *    `steer`/`interrupt` при активном ходе — прежняя ветка вмешательства.
 * 2. `POST /api/v2/sessions/:id/recovery/retry` — ручной повтор восстановления:
 *    дочерняя сессия — resume-путём саб-агента, основная — продолжение
 *    in-flight хода или очереди; «восстанавливать нечего» → 200.
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
import type { AuthKit } from '../../auth/local.js';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

function createMockQueueManager(opts?: { running?: boolean }) {
  return {
    isRunning: vi.fn().mockReturnValue(opts?.running ?? false),
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
    agentRegistry: { get: () => undefined },
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
    interrupt: vi.fn().mockReturnValue(true),
    // ADR-036: обфускация user-сообщения перед постановкой в очередь.
    obfuscateUserMessageForHistory: vi.fn(async (_sid: string, message: Message) => message),
    getPromptInfo: vi.fn().mockResolvedValue({}),
    getModelPricing: vi.fn().mockReturnValue(null),
    // PROP-142 §1/§3: продолжение дочерней сессии.
    startSubagentResume: vi.fn().mockResolvedValue({
      status: 'started',
      child_session_id: 'child-1',
      parent_session_id: 'parent-1',
      stream_id: 'stream-1',
    }),
  };
}

function createTestApp(tmpDir: string, opts?: { running?: boolean }) {
  const app = new Hono();
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const eventBus = new EventBus();
  const queueManager = createMockQueueManager(opts);
  const orchestrator = createMockOrchestrator();

  const sessionRoutes = createSessionRoutes(
    createMockAuth(),
    {
      sessionManager,
      eventBus,
      queueManager: queueManager as unknown as QueueProcessorManager,
      processMessage: orchestrator.createProcessMessage(),
      orchestrator: orchestrator as unknown as ChatOrchestrator,
    },
    {},
  );

  app.route('/api/v2/sessions', sessionRoutes);
  return { app, sessionManager, eventBus, queueManager, orchestrator };
}

type ErrorBody = { error: { code: string; message: string } };
type AcceptedBody = { messageId: string; mode: string; position: number | null };

/** Родитель + дочерняя сессия саб-агента (`sessionOrigin: 'subagent'`). */
async function createChild(sessionManager: SessionManager): Promise<{ parent: string; child: string }> {
  const parent = await sessionManager.createSession({ title: 'Parent', userId: 'local' });
  const child = await sessionManager.createSession({
    title: 'Subtask',
    parentId: parent.id,
    sessionOrigin: 'subagent',
    userId: 'local',
    settings: { provider: 'mockres', model: 'm', agentRole: 'explore' },
  });
  return { parent: parent.id, child: child.id };
}

/** Пометить прогон ребёнка активным (`currentStream` — маркер прогона). */
async function markChildBusy(sessionManager: SessionManager, childId: string): Promise<void> {
  await sessionManager.mutateMeta(childId, (meta) => {
    meta.currentStream = {
      streamId: 'stream-child',
      message: 'работа',
      agentRole: 'explore',
      startedAt: nowISO(),
      cancelled: false,
    };
  });
}

describe('POST /api/v2/sessions/:id/prompt — дочерняя сессия саб-агента (PROP-142 §1)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-subagent-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('занятый ребёнок + mode=queue → сообщение в его очередь, процессор НЕ поднимается', async () => {
    const { app, sessionManager, queueManager, orchestrator } = createTestApp(tmpDir);
    const { child } = await createChild(sessionManager);
    await markChildBusy(sessionManager, child);

    const res = await app.request(`/api/v2/sessions/${child}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'доделай и покажи результат' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;
    expect(body.mode).toBe('queue');
    expect(body.messageId).toBeTruthy();
    expect(body.position).toBe(1);

    const fresh = (await sessionManager.getSession(child))!;
    expect(fresh.pendingMessages).toHaveLength(1);
    expect(fresh.pendingMessages[0]!.content).toBe('доделай и покажи результат');
    // Никакой «скрытой третьей семантики»: процессор очереди сессии не создаётся.
    expect(queueManager.createProcessor).not.toHaveBeenCalled();
    expect(orchestrator.startSubagentResume).not.toHaveBeenCalled();
  });

  it('свободный ребёнок + текст → продолжение циклом саб-агента (startSubagentResume)', async () => {
    const { app, sessionManager, queueManager, orchestrator } = createTestApp(tmpDir);
    const { child } = await createChild(sessionManager);

    const res = await app.request(`/api/v2/sessions/${child}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'теперь сделай вот это' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; stream_id: string; child_session_id: string };
    expect(body.status).toBe('resumed');
    expect(body.stream_id).toBe('stream-1');
    expect(body.child_session_id).toBe('child-1');

    // Продолжение запущено с текстом указаний.
    expect(orchestrator.startSubagentResume).toHaveBeenCalledWith(child, { prompt: 'теперь сделай вот это' });
    // Процессор очереди обычной сессии не поднимается.
    expect(queueManager.createProcessor).not.toHaveBeenCalled();
    const fresh = (await sessionManager.getSession(child))!;
    expect(fresh.pendingMessages).toHaveLength(0);
  });

  it('занятый ребёнок + mode=steer → прежняя ветка вмешательства (steerInbox)', async () => {
    const { app, sessionManager, queueManager, orchestrator } = createTestApp(tmpDir);
    const { child } = await createChild(sessionManager);
    await markChildBusy(sessionManager, child);

    const res = await app.request(`/api/v2/sessions/${child}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'подправь курс', mode: 'steer' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;
    expect(body.mode).toBe('steer');
    expect(body.position).toBeNull();

    const fresh = (await sessionManager.getSession(child))!;
    expect(fresh.steerInbox).toHaveLength(1);
    expect(fresh.steerInbox![0]!.content).toBe('подправь курс');
    expect(fresh.pendingMessages).toHaveLength(0);
    expect(queueManager.createProcessor).not.toHaveBeenCalled();
    expect(orchestrator.startSubagentResume).not.toHaveBeenCalled();
  });

  it('не-дочерняя сессия — поведение не изменилось (обычная очередь)', async () => {
    const { app, sessionManager, queueManager, orchestrator } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'обычное сообщение' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;
    expect(body.mode).toBe('queue');
    expect(body.position).toBe(1);
    expect(queueManager.createProcessor).toHaveBeenCalled();
    expect(orchestrator.startSubagentResume).not.toHaveBeenCalled();
  });
});

describe('POST /api/v2/sessions/:id/recovery/retry (PROP-142 §3.7)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-recovery-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('дочерняя сессия → resume-путём саб-агента (202 started)', async () => {
    const { app, sessionManager, queueManager, orchestrator } = createTestApp(tmpDir);
    const { child } = await createChild(sessionManager);

    const res = await app.request(`/api/v2/sessions/${child}/recovery/retry`, { method: 'POST' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; child_session_id: string; stream_id: string };
    expect(body.status).toBe('started');
    expect(body.stream_id).toBe('stream-1');
    expect(orchestrator.startSubagentResume).toHaveBeenCalledWith(child);
    expect(queueManager.createProcessor).not.toHaveBeenCalled();
  });

  it('основная сессия с незавершённым in-flight ходом → 202 resumed (resumeMessage)', async () => {
    const { app, sessionManager, queueManager } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const message: Message = {
      id: 'in-flight-1',
      role: MessageRole.USER,
      seq: 1,
      origin: 'local',
      parts: [makeTextPart('вопрос')],
      content: 'вопрос',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      metadata: { stream_id: 'stream-inflight' },
    };
    // Сообщение уже материализовано в истории (in-flight) и осталось в очереди.
    await sessionManager.addMessage(session.id, message);
    await sessionManager.addPendingMessage(session.id, { ...message }, 5);

    const res = await app.request(`/api/v2/sessions/${session.id}/recovery/retry`, { method: 'POST' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; stream_id: string };
    expect(body.status).toBe('resumed');
    expect(body.stream_id).toBe('stream-inflight');
    expect(queueManager.createProcessor).toHaveBeenCalledTimes(1);
    const call = queueManager.createProcessor.mock.calls[0]!;
    expect(call[0]).toBe(session.id);
    expect((call[4] as { resumeMessage?: Message }).resumeMessage?.id).toBe('in-flight-1');
  });

  it('основная сессия с обычной очередью → 202 queued (без resumeMessage)', async () => {
    const { app, sessionManager, queueManager } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    await sessionManager.addPendingMessage(session.id, {
      id: generateId(),
      role: MessageRole.USER,
      seq: 1,
      origin: 'local',
      parts: [makeTextPart('в очереди')],
      content: 'в очереди',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
    }, 5);

    const res = await app.request(`/api/v2/sessions/${session.id}/recovery/retry`, { method: 'POST' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('queued');
    expect(queueManager.createProcessor).toHaveBeenCalledTimes(1);
    const call = queueManager.createProcessor.mock.calls[0]!;
    expect(call[4]).toBeUndefined();
  });

  it('основная сессия без чего восстанавливать → 200 nothing_to_resume', async () => {
    const { app, sessionManager, queueManager } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

    const res = await app.request(`/api/v2/sessions/${session.id}/recovery/retry`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('nothing_to_resume');
    expect(queueManager.createProcessor).not.toHaveBeenCalled();
  });

  it('занятая сессия → 409 LOCKED (повтор во время активного хода невозможен)', async () => {
    const { app, sessionManager, queueManager } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    await sessionManager.mutateMeta(session.id, (meta) => {
      meta.currentStream = {
        streamId: 'stream-live',
        message: 'работа',
        agentRole: undefined,
        startedAt: nowISO(),
        cancelled: false,
      };
    });

    const res = await app.request(`/api/v2/sessions/${session.id}/recovery/retry`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('LOCKED');
    expect(queueManager.createProcessor).not.toHaveBeenCalled();
  });

  it('несуществующая сессия → 404 NOT_FOUND', async () => {
    const { app } = createTestApp(tmpDir);
    const res = await app.request('/api/v2/sessions/nope/recovery/retry', { method: 'POST' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
