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
import type { SessionRoutesDeps } from './sessions.js';
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

function createTestApp(tmpDir: string, opts?: { running?: boolean; extraDeps?: Partial<SessionRoutesDeps> }) {
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
      ...(opts?.extraDeps ?? {}),
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
/**
 * ADR-118 §3: тело ответа приёма — `{ messageId, mode, position }`.
 * `position` — `null` для вмешательств (`steer`/`interrupt`).
 */
type AcceptedBody = { messageId: string; mode: string; position: number | null };

describe('POST /api/v2/sessions/:id/prompt — режим отправки (ADR-104)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-steer-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('mode=interrupt при активном ходе → 202 interrupt, сообщение в очереди инъекций', async () => {
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
    const body = (await res.json()) as AcceptedBody;
    expect(body.mode).toBe('interrupt');
    expect(body.messageId).toBeTruthy();
    // Вмешательство не занимает позицию в обычной очереди.
    expect(body.position).toBeNull();

    const fresh = (await sessionManager.getSession(session.id))!;
    // В обычную очередь сообщение не попало — оно ждёт вплетения в ход.
    expect(fresh.pendingMessages).toHaveLength(0);
    expect(fresh.steerInbox).toHaveLength(1);
    expect(fresh.steerInbox![0]!.content).toBe('прерви и сделай иначе');
    // Маркер режима: `steer` + `interrupt` (UI рисует «прерывание хода»).
    expect(fresh.steerInbox![0]!.metadata?.steer).toBe(true);
    expect(fresh.steerInbox![0]!.metadata?.interrupt).toBe(true);
    // id стрима вплетаемого сообщения — серверный (в ответе его нет).
    expect(fresh.steerInbox![0]!.metadata?.stream_id).toBeTruthy();

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
    // ADR-118 §3: контракт приёма — всегда `202 {messageId, mode, position}`.
    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;
    expect(body.mode).toBe('queue');
    expect(body.position).toBe(1);
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
    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;
    expect(body.mode).toBe('queue');
    expect(body.position).toBe(1);
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
    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;
    expect(body.mode).toBe('queue');
    expect(body.position).toBe(1);
    controller.abort();

    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.pendingMessages).toHaveLength(1);
    expect(fresh.steerInbox ?? []).toHaveLength(0);
  });

  it('mode=steer при активном ходе → 202 steer, сообщение в очереди инъекций', async () => {
    const { app, sessionManager } = createTestApp(tmpDir, { running: true });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'вмешательство', mode: 'steer' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;
    expect(body.mode).toBe('steer');
    expect(body.messageId).toBeTruthy();
    // Вмешательство не занимает позицию в обычной очереди.
    expect(body.position).toBeNull();

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

describe('POST /api/v2/sessions/:id/abort — снятие очереди инъекций (ADR-104)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-steer-abort-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('«Стоп» возвращает неприменённые инъекции в очередь (без автозапуска, без steer.dropped)', async () => {
    const { app, sessionManager, eventBus } = createTestApp(tmpDir, { running: true });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    await sessionManager.enqueueSteerMessage(session.id, makeSteerMessage('вмешательство 1'));
    await sessionManager.enqueueSteerMessage(session.id, makeSteerMessage('вмешательство 2'));

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    eventBus.subscribe(session.id, (event) => {
      events.push({ type: event.type, data: event.data as Record<string, unknown> });
    });

    const res = await app.request(`/api/v2/sessions/${session.id}/abort`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('aborted');

    // Очередь инъекций снята, но сообщения не потеряны — вернулись в
    // `pendingMessages` (FIFO) и ждут решения пользователя.
    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.steerInbox ?? []).toHaveLength(0);
    expect(fresh.pendingMessages.map((m) => m.content)).toEqual([
      'вмешательство 1', 'вмешательство 2',
    ]);

    // Ни одно сообщение не потеряно — события дропа нет.
    expect(events.some((e) => e.type === 'steer.dropped')).toBe(false);
  });

  it('пустая очередь — ответ 200 без события steer.dropped', async () => {
    const { app, sessionManager, eventBus } = createTestApp(tmpDir, { running: true });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

    const events: string[] = [];
    eventBus.subscribe(session.id, (event) => {
      events.push(event.type);
    });

    const res = await app.request(`/api/v2/sessions/${session.id}/abort`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(events).not.toContain('steer.dropped');
  });
});

describe('ADR-111 §detach: авто-detach блокирующих прогонов при steer', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-steer-detach-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Активный ход сессии (пометка `currentStream`). */
  async function markTurnActive(sessionManager: SessionManager, sessionId: string): Promise<void> {
    await sessionManager.withLock(sessionId, async (s) => {
      s.currentStream = {
        streamId: 'stream-live-1',
        message: 'работа',
        agentRole: undefined,
        startedAt: new Date().toISOString(),
        cancelled: false,
      };
      await sessionManager.saveSession(s);
    });
  }

  it('steer в занятую сессию вызывает авто-detach (живой мастер-выключатель)', async () => {
    const autoDetach = vi.fn().mockResolvedValue({ detached: [], failed: [] });
    const { app, sessionManager } = createTestApp(tmpDir, {
      running: true,
      extraDeps: { autoDetachOnSteer: autoDetach },
    });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    await markTurnActive(sessionManager, session.id);

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'вмешательство', mode: 'steer' }),
    });

    expect(res.status).toBe(202);
    expect(autoDetach).toHaveBeenCalledTimes(1);
    expect(autoDetach).toHaveBeenCalledWith({ sessionId: session.id, enabled: true, reason: 'message' });
  });

  it('queue при свободной сессии авто-detach не запускает', async () => {
    const autoDetach = vi.fn().mockResolvedValue({ detached: [], failed: [] });
    const { app, sessionManager } = createTestApp(tmpDir, {
      extraDeps: { autoDetachOnSteer: autoDetach },
    });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const controller = new AbortController();

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'обычное сообщение', mode: 'queue' }),
      signal: controller.signal,
    });
    controller.abort();

    expect(res.status).toBe(202);
    expect(autoDetach).not.toHaveBeenCalled();
  });

  it('queue с текстом при активном ходе: прогоны НЕ переводятся — сообщение ждёт хода', async () => {
    const autoDetach = vi.fn().mockResolvedValue({ detached: [], failed: [] });
    const { app, sessionManager } = createTestApp(tmpDir, {
      running: true,
      extraDeps: { autoDetachOnSteer: autoDetach },
    });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

    // `mode` не задан — режим по умолчанию `queue` (обратная совместимость).
    // Ход занят (`running: true`), но очередь — не вмешательство: блокирующие
    // прогоны не переводим, сообщение просто ждёт завершения хода.
    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'добавь задачу' }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;
    expect(body.mode).toBe('queue');
    expect(autoDetach).not.toHaveBeenCalled();
    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.pendingMessages).toHaveLength(1);
  });

  it('queue с текстом при полной очереди (429 QUEUE_FULL): detach не вызывается', async () => {
    const autoDetach = vi.fn().mockResolvedValue({ detached: [], failed: [] });
    const { app, sessionManager } = createTestApp(tmpDir, {
      running: true,
      extraDeps: { autoDetachOnSteer: autoDetach },
    });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    // Очередь заполнена до лимита (5) — постановка будет отклонена.
    await sessionManager.withLock(session.id, async (s) => {
      s.pendingMessages = Array.from({ length: 5 }, (_, i) => makeSteerMessage(`ожидает ${i}`));
      await sessionManager.saveSession(s);
    });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'лишнее сообщение' }),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('QUEUE_FULL');
    // Сообщение не принято — вмешательства нет, переводить нечего.
    expect(autoDetach).not.toHaveBeenCalled();
  });

  it('interrupt без агентской части (только @user) при активном ходе: detach вызывается', async () => {
    const autoDetach = vi.fn().mockResolvedValue({ detached: [], failed: [] });
    const { app, sessionManager, orchestrator } = createTestApp(tmpDir, {
      running: true,
      extraDeps: { autoDetachOnSteer: autoDetach },
    });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

    // Вся реплика адресована человеку: агентская часть (`content`) пуста —
    // прерывание без сообщения всё равно вмешательство в занятую сессию.
    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '@local проверь позже', mode: 'interrupt' }),
    });

    expect(res.status).toBe(202);
    expect(autoDetach).toHaveBeenCalledTimes(1);
    expect(autoDetach).toHaveBeenCalledWith({ sessionId: session.id, enabled: true, reason: 'message' });
    // В очередь инъекций пустая агентская часть не попадает.
    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.steerInbox ?? []).toHaveLength(0);
    expect(orchestrator.interrupt).not.toHaveBeenCalled();
  });

  it('@user-only в queue при активном ходе: detach не вызывается', async () => {
    const autoDetach = vi.fn().mockResolvedValue({ detached: [], failed: [] });
    const { app, sessionManager } = createTestApp(tmpDir, {
      running: true,
      extraDeps: { autoDetachOnSteer: autoDetach },
    });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '@local посмотри позже' }),
    });

    // Агент не участвует (только сообщение человеку) — прогоны не трогаем.
    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;
    expect(body.position).toBeNull();
    expect(autoDetach).not.toHaveBeenCalled();
    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.pendingMessages).toHaveLength(0);
    expect(fresh.messages.some((m) => m.metadata?.userDirected === true)).toBe(true);
  });

  it('interrupt с текстом: порядок detach → steerInbox → orchestrator.interrupt', async () => {
    const autoDetach = vi.fn().mockResolvedValue({ detached: [], failed: [] });
    const { app, sessionManager, orchestrator } = createTestApp(tmpDir, {
      running: true,
      extraDeps: { autoDetachOnSteer: autoDetach },
    });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    await markTurnActive(sessionManager, session.id);

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'прерви и сделай иначе', mode: 'interrupt' }),
    });

    expect(res.status).toBe(202);
    // Detach — до всего остального, прерывание генерации — последним:
    // процесс продолжает жить в фоне, ход не завершается.
    expect(autoDetach).toHaveBeenCalledWith({ sessionId: session.id, enabled: true, reason: 'message' });
    expect(autoDetach.mock.invocationCallOrder[0]).toBeLessThan(
      orchestrator.interrupt.mock.invocationCallOrder[0]!,
    );
    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.steerInbox).toHaveLength(1);
    expect(orchestrator.interrupt).toHaveBeenCalledWith('stream-live-1');
  });

  it('background.enabled=false (живой мастер-выключатель): detachAll не вызывается', async () => {
    const detachAll = vi.fn().mockResolvedValue({ detached: [], failed: [] });
    const { app, sessionManager, orchestrator } = createTestApp(tmpDir, { running: true });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    await markTurnActive(sessionManager, session.id);
    // Реальный авто-detach (шов не подменён) + выключенная фоновая работа.
    Object.assign(orchestrator, {
      activeRuns: { detachAll },
      isBackgroundEnabled: () => false,
    });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'вмешательство', mode: 'steer' }),
    });

    expect(res.status).toBe(202);
    expect(detachAll).not.toHaveBeenCalled();
  });

  it('ошибка авто-detach не мешает приёму steer', async () => {    const autoDetach = vi.fn().mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { app, sessionManager } = createTestApp(tmpDir, {
      running: true,
      extraDeps: { autoDetachOnSteer: autoDetach },
    });
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    await markTurnActive(sessionManager, session.id);

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'вмешательство', mode: 'steer' }),
    });
    warn.mockRestore();

    expect(res.status).toBe(202);
    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.steerInbox).toHaveLength(1);
  });
});
