/**
 * ADR-118 §3/§4: контракт приёма сообщения.
 *
 * `POST /api/v2/sessions/:id/prompt` **всегда** отвечает `202
 * {messageId, mode, position}` — поток хода больше не возвращается в теле
 * ответа (`text/event-stream` не используется): наблюдение за ходом идёт по
 * шине событий (ADR-024/ADR-118).
 *
 * Проверяется:
 *   • ответ приёма — `202` с телом `{messageId, mode, position}`, без SSE;
 *   • ответ приходит **сразу**, даже когда ход активен (не ждёт финала хода);
 *   • `message.accepted` — **адресное** событие (получатель — отправитель);
 *   • `queue.state` несёт **только счётчики** — без текста и без автора;
 *   • `message.delivered` приходит при материализации сообщения в истории и
 *     несёт `ord` (монотонный порядок записи, ADR-118 §2);
 *   • клиентский `messageId` становится id сохранённого сообщения и всех
 *     связанных событий (регресс на двойную реплику в standalone).
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
import { QueueProcessorManager as RealQueueProcessorManager } from '../../queue/processor.js';
import { ProjectStore } from '../../storage/project-store.js';
import type { AuthKit } from '../../auth/local.js';
import type { BusEvent } from '@itphx/synth-shared';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

/** Мок менеджера очереди: активный ход (`isRunning`) и пустой `createProcessor`. */
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
    interrupt: vi.fn().mockReturnValue(true),
    obfuscateUserMessageForHistory: vi.fn(async (_sid: string, message: unknown) => message),
    getPromptInfo: vi.fn().mockResolvedValue({
      manifest: { totalChars: 10, estTokens: 3, stablePrefixChars: 5, entries: [] },
      history: {
        messages: { count: 0, chars: 0, estTokens: 0 },
        stateMessages: [],
        excluded: { disabled: 0, hidden: 0, info: 0 },
        attachments: { count: 0, chars: 0 },
        secretPlaceholders: 0,
      },
      promptState: null,
      lastPromptMeta: null,
    }),
    getModelPricing: vi.fn().mockReturnValue(null),
  };
}

function createTestApp(
  tmpDir: string,
  opts?: { running?: boolean; userId?: string; realQueue?: boolean },
) {
  const app = new Hono();
  const fileStore = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(fileStore);
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const eventBus = new EventBus();
  const queueManager = opts?.realQueue
    ? new RealQueueProcessorManager()
    : createMockQueueManager(opts);
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
    {
      // Отправитель запроса — адресат адресного события `message.accepted`.
      ...(opts?.userId ? { resolveUserId: () => opts.userId as string } : {}),
    },
  );

  app.route('/api/v2/sessions', sessionRoutes);
  return { app, sessionManager, eventBus, queueManager, orchestrator };
}

/** Тело ответа приёма (ADR-118 §3). */
type AcceptedBody = { messageId: string; mode: string; position: number | null };

describe('POST /api/v2/sessions/:id/prompt — контракт приёма (ADR-118 §3)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-prompt-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('режим queue → 202 {messageId, mode, position}, без SSE в ответе', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'привет' }),
    });

    expect(res.status).toBe(202);
    // Контракт приёма — JSON, поток хода в теле ответа не возвращается.
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).not.toContain('text/event-stream');
    expect(contentType).toContain('application/json');

    const body = (await res.json()) as AcceptedBody;
    expect(body.messageId).toBeTruthy();
    expect(body.mode).toBe('queue');
    expect(body.position).toBe(1);

    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.pendingMessages).toHaveLength(1);
  });

  it('ответ приходит сразу, даже когда ход активен (не ждёт финала хода)', async () => {
    // Активный ход: сессия заблокирована, процессор «работает», а сам ход не
    // завершается — ответа ждать нечего.
    const { app, sessionManager } = createTestApp(tmpDir, { running: true });
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });
    await sessionManager.withLock(session.id, async (s) => {
      s.currentStream = {
        streamId: 'stream-live-1',
        message: 'работа',
        agentRole: undefined,
        startedAt: new Date().toISOString(),
        cancelled: false,
      };
      s.status.blocked = 'running';
      await sessionManager.saveSession(s);
    });

    const res = await Promise.race([
      app.request(`/api/v2/sessions/${session.id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'ещё одно' }),
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('ответ не пришёл — ждёт финала хода')), 1000);
      }),
    ]);

    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;
    expect(body.mode).toBe('queue');
    // Ход ещё активен — ответ пришёл не после его завершения.
    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.currentStream).toBeDefined();
    expect(fresh.status.blocked).toBe('running');
  });
});

describe('POST /api/v2/sessions/:id/prompt — события приёма (ADR-118 §4)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-prompt-ev-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('message.accepted — адресное событие: получатель — отправитель', async () => {
    const { app, sessionManager, eventBus } = createTestApp(tmpDir, { userId: 'user-1' });
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });

    const forSender: BusEvent[] = [];
    const forOther: BusEvent[] = [];
    eventBus.subscribe(session.id, (e) => forSender.push(e), { userId: 'user-1' });
    eventBus.subscribe(session.id, (e) => forOther.push(e), { userId: 'user-2' });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'привет' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;

    const accepted = forSender.find((e) => e.type === 'message.accepted');
    expect(accepted).toBeDefined();
    // Адресная доставка: `recipient` — id отправителя.
    expect(accepted!.recipient).toBe('user-1');
    expect(accepted!.data).toMatchObject({
      messageId: body.messageId,
      mode: 'queue',
      position: 1,
    });
    // Чужой подписчик адресное событие не получает.
    expect(forOther.some((e) => e.type === 'message.accepted')).toBe(false);
  });

  it('queue.state несёт только счётчики — без текста и без автора', async () => {
    const { app, sessionManager, eventBus } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });

    const events: BusEvent[] = [];
    eventBus.subscribe(session.id, (e) => events.push(e));

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'секретный текст' }),
    });
    expect(res.status).toBe(202);

    const state = events.find((e) => e.type === 'queue.state');
    expect(state).toBeDefined();
    expect(state!.data).toMatchObject({ pendingCount: 1, steerCount: 0 });
    // Ни текста сообщения, ни автора в payload нет (ADR-118 §4).
    expect(state!.data.content).toBeUndefined();
    expect(state!.data.text).toBeUndefined();
    expect(state!.data.author).toBeUndefined();
    expect(JSON.stringify(state!.data)).not.toContain('секретный текст');
  });

  it('message.delivered приходит при материализации сообщения в истории и несёт ord', async () => {
    // Настоящий менеджер очереди: материализацию сообщения в истории делает
    // процессор очереди (он же публикует `message.delivered`).
    const { app, sessionManager, eventBus } = createTestApp(tmpDir, { realQueue: true });
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });

    const events: BusEvent[] = [];
    eventBus.subscribe(session.id, (e) => events.push(e));

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'привет' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;

    // Ждём события материализации.
    const deadline = Date.now() + 5000;
    let delivered: BusEvent | undefined;
    while (Date.now() < deadline && !delivered) {
      delivered = events.find((e) => e.type === 'message.delivered');
      if (!delivered) await new Promise((r) => setTimeout(r, 20));
    }

    expect(delivered).toBeDefined();
    expect(delivered!.data).toMatchObject({
      messageId: body.messageId,
      role: 'user',
    });
    // `ord` — монотонный порядок записи (первое сообщение сессии → 1).
    expect(delivered!.data.ord).toBe(1);

    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.messages).toHaveLength(1);
    expect(fresh.messages[0]!.ord).toBe(1);
  });

  it('клиентский messageId становится id сохранённого сообщения и всех событий', async () => {
    // Регресс: в standalone UI передаёт клиентский `messageId` и сразу рисует
    // по нему оптимистичный пузырь. Если сервер сохранит сообщение с другим id,
    // `message.delivered` не найдёт его и клиент загрузит вторую копию — в ленте
    // появляются две одинаковые реплики (ADR-118 §3).
    const { app, sessionManager, eventBus } = createTestApp(tmpDir, { realQueue: true });
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });
    const clientId = 'stream-1-1700000000000';

    const events: BusEvent[] = [];
    eventBus.subscribe(session.id, (e) => events.push(e));

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'привет', messageId: clientId }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;
    // 1. Ответ приёма несёт клиентский id.
    expect(body.messageId).toBe(clientId);

    // 2. В истории сохранено ровно одно user-сообщение — с тем же id.
    //    Материализацию делает процессор очереди (он же публикует `message.delivered`).
    const deadline = Date.now() + 5000;
    let delivered: BusEvent | undefined;
    while (Date.now() < deadline && !delivered) {
      delivered = events.find((e) => e.type === 'message.delivered');
      if (!delivered) await new Promise((r) => setTimeout(r, 20));
    }
    expect(delivered).toBeDefined();
    const fresh = (await sessionManager.getSession(session.id))!;
    const userMessages = fresh.messages.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.id).toBe(clientId);
    expect(userMessages[0]!.metadata?.stream_id).toBe(clientId);

    // 3. Список истории отдаёт сообщение под этим id (без пары-двойника).
    const listRes = await app.request(`/api/v2/sessions/${session.id}/messages`);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { messages: Array<{ id: string; role: string }> };
    expect(list.messages.filter((m) => m.role === 'user').map((m) => m.id)).toEqual([clientId]);

    // 4. Точечная загрузка по клиентскому id находит сообщение (раньше — 404).
    const oneRes = await app.request(`/api/v2/sessions/${session.id}/messages/${clientId}`);
    expect(oneRes.status).toBe(200);
    const one = (await oneRes.json()) as { id: string };
    expect(one.id).toBe(clientId);

    // 5. `message.delivered` несёт тот же id — дедуп в клиенте срабатывает.
    expect(delivered!.data).toMatchObject({ messageId: clientId, role: 'user' });
  });

  it('непригодный messageId (пробелы/пусто/не строка) → серверный id во всех ответах и событиях', async () => {
    // До появления `normalizeClientMessageId` строка из пробелов truthy-проходила
    // в `streamId`, и сообщение сохранялось с id `'   '`.
    const { app, sessionManager, eventBus } = createTestApp(tmpDir, { realQueue: true });

    for (const invalid of ['   ', '', 42]) {
      const session = await sessionManager.createSession({ title: 'P', userId: 'local' });
      const events: BusEvent[] = [];
      eventBus.subscribe(session.id, (e) => events.push(e));

      const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'привет', messageId: invalid }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as AcceptedBody;
      // Серверный id непустой, без внешних пробелов и не совпадает с мусором.
      expect(body.messageId).toBeTruthy();
      expect(body.messageId.trim()).toBe(body.messageId);
      if (typeof invalid === 'string') expect(body.messageId).not.toBe(invalid);

      // Тот же id — в истории и в `message.delivered`.
      const deadline = Date.now() + 5000;
      let delivered: BusEvent | undefined;
      while (Date.now() < deadline && !delivered) {
        delivered = events.find((e) => e.type === 'message.delivered');
        if (!delivered) await new Promise((r) => setTimeout(r, 20));
      }
      expect(delivered).toBeDefined();
      const fresh = (await sessionManager.getSession(session.id))!;
      const userMessages = fresh.messages.filter((m) => m.role === 'user');
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]!.id).toBe(body.messageId);
      expect(userMessages[0]!.metadata?.stream_id).toBe(body.messageId);
      expect(delivered!.data).toMatchObject({ messageId: body.messageId, role: 'user' });
    }
  });
});
