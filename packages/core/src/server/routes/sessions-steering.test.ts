/**
 * ADR-104: HTTP-контур режима отправки (`POST /api/v2/sessions/:id/prompt`):
 * `queue` (по умолчанию), `steer` (вмешательство в активный ход) и
 * `interrupt` (прерывание текущей генерации — ход продолжается, этап 2).
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
import { ProjectStore } from '../../storage/project-store.js';
import type { AuthKit } from '../../auth/local.js';
import {
  MessageRole,
  generateId,
  makeTextPart,
  nowISO,
  MAX_STEER_INJECTIONS_PER_TURN,
  STEERING_ERROR_CODES,
} from '@itphx/synth-shared';
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
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
    // ADR-104 (этап 2): прерывание текущей генерации без завершения хода.
    interrupt: vi.fn().mockReturnValue(true),
    // ADR-036: обфускация user-сообщения перед постановкой в очередь.
    obfuscateUserMessageForHistory: vi.fn(async (_sid: string, message: Message) => message),
    getPromptInfo: vi.fn().mockResolvedValue({
      manifest: { totalChars: 10, estTokens: 3, staticPrefixChars: 5, entries: [] },
      history: {
        messages: { count: 2, chars: 20, estTokens: 5 },
        stateMessages: [{ type: 'mode_change', count: 1, chars: 40, estTokens: 10 }],
        excluded: { disabled: 0, hidden: 0, info: 1 },
        attachments: { count: 0, chars: 0 },
        secretPlaceholders: 0,
      },
      promptState: null,
      lastPromptMeta: null,
    }),
    getModelPricing: vi.fn().mockReturnValue(null),
  };
}

function createTestApp(tmpDir: string, opts?: { running?: boolean }) {
  const app = new Hono();
  const fileStore = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(fileStore);
  const projectStore = new ProjectStore({ dataDir: tmpDir });
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
      projectStore,
    },
    {},
  );

  app.route('/api/v2/sessions', sessionRoutes);
  return { app, sessionManager, eventBus, queueManager, orchestrator };
}

function makeSteerMessage(content: string): Message {
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

/** Тело ошибки API: `{ error: { code, message } }`. */
type ErrorBody = { error: { code: string; message: string } };
/** Тело успешного ответа `mode=steer`: `{ status, stream_id, pending_count }`. */
type SteeredBody = { status: string; stream_id: string; pending_count: number };

describe('POST /api/v2/sessions/:id/prompt — режим отправки (ADR-104)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-steer-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('mode=interrupt при активном ходе → 202 interrupted, сообщение в очереди инъекций', async () => {
    const { app, sessionManager, orchestrator } = createTestApp(tmpDir, { running: true });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    // Живой стрим хода — `currentStream.streamId` (его прерывает оркестратор).
    await sessionManager.withLock(session.id, async (s) => {
      s.currentStream = {
        streamId: 'stream-live-1',
        message: 'работа',
        agentRole: undefined,
        startedAt: new Date().toISOString(),
        cancelled: false,
      };
      await sessionManager.saveSession(s);
    });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'прерви и сделай иначе', mode: 'interrupt' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as SteeredBody;
    expect(body.status).toBe('interrupted');
    expect(body.stream_id).toBeTruthy();
    expect(body.pending_count).toBe(1);

    const fresh = (await sessionManager.getSession(session.id))!;
    // В обычную очередь сообщение не попало — оно ждёт вплетения в ход.
    expect(fresh.pendingMessages).toHaveLength(0);
    expect(fresh.steerInbox).toHaveLength(1);
    expect(fresh.steerInbox![0]!.content).toBe('прерви и сделай иначе');
    // Маркер режима: `steer` + `interrupt` (UI рисует «прерывание хода»).
    expect(fresh.steerInbox![0]!.metadata?.steer).toBe(true);
    expect(fresh.steerInbox![0]!.metadata?.interrupt).toBe(true);
    // `stream_id` ответа — id стрима вплетаемого сообщения (как при `steer`).
    expect(fresh.steerInbox![0]!.metadata?.stream_id).toBe(body.stream_id);

    // Текущая генерация прервана — ход при этом НЕ завершается.
    expect(orchestrator.interrupt).toHaveBeenCalledWith('stream-live-1');
  });

  it('mode=interrupt без активного хода → обычная очередь (сообщение начнёт новый ход)', async () => {
    const { app, sessionManager, orchestrator } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const controller = new AbortController();
    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'обычное сообщение', mode: 'interrupt' }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    controller.abort();

    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.pendingMessages).toHaveLength(1);
    expect(fresh.steerInbox ?? []).toHaveLength(0);
    // Прерывать нечего — оркестратор не дёргали.
    expect(orchestrator.interrupt).not.toHaveBeenCalled();
  });

  it('mode=interrupt сверх лимита инъекций → 429 STEER_LIMIT_EXCEEDED', async () => {
    const { app, sessionManager, orchestrator } = createTestApp(tmpDir, { running: true });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    for (let i = 0; i < MAX_STEER_INJECTIONS_PER_TURN; i++) {
      await sessionManager.enqueueSteerMessage(session.id, makeSteerMessage(`инъекция ${i}`));
    }

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'лишняя', mode: 'interrupt' }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe(STEERING_ERROR_CODES.limitExceeded);
    // Генерацию не прерываем — сообщение не принято.
    expect(orchestrator.interrupt).not.toHaveBeenCalled();

    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.steerInbox).toHaveLength(MAX_STEER_INJECTIONS_PER_TURN);
  });

  it('без mode → обычная очередь (обратная совместимость)', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const controller = new AbortController();
    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'обычное сообщение' }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    controller.abort();

    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.pendingMessages).toHaveLength(1);
    expect(fresh.pendingMessages[0]!.content).toBe('обычное сообщение');
    // В очередь инъекций ничего не попало.
    expect(fresh.steerInbox ?? []).toHaveLength(0);
  });

  it('mode=steer без активного хода → обычная очередь (сообщение начнёт новый ход)', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const controller = new AbortController();
    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'вмешательство', mode: 'steer' }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    controller.abort();

    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.pendingMessages).toHaveLength(1);
    expect(fresh.steerInbox ?? []).toHaveLength(0);
  });

  it('mode=steer при активном ходе → 202 steered, сообщение в очереди инъекций', async () => {
    const { app, sessionManager } = createTestApp(tmpDir, { running: true });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'вмешательство', mode: 'steer' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as SteeredBody;
    expect(body.status).toBe('steered');
    expect(body.pending_count).toBe(1);

    const fresh = (await sessionManager.getSession(session.id))!;
    // В обычную очередь сообщение не попало — оно ждёт вплетения в ход.
    expect(fresh.pendingMessages).toHaveLength(0);
    expect(fresh.steerInbox).toHaveLength(1);
    expect(fresh.steerInbox![0]!.content).toBe('вмешательство');
    expect(fresh.steerInbox![0]!.metadata?.steer).toBe(true);
  });

  it('mode=steer сверх лимита инъекций → 429 STEER_LIMIT_EXCEEDED', async () => {
    const { app, sessionManager } = createTestApp(tmpDir, { running: true });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    // Заполняем очередь инъекций до лимита хода.
    for (let i = 0; i < MAX_STEER_INJECTIONS_PER_TURN; i++) {
      await sessionManager.enqueueSteerMessage(session.id, makeSteerMessage(`инъекция ${i}`));
    }

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'лишняя', mode: 'steer' }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe(STEERING_ERROR_CODES.limitExceeded);

    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.steerInbox).toHaveLength(MAX_STEER_INJECTIONS_PER_TURN);
  });
});
