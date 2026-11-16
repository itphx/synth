/**
 * PROP-132: атомарная отправка «вопрос + контекст терминала» одним
 * prompt-запросом (`POST /api/v2/sessions/:id/prompt`, поле `context`).
 *
 * Проверяется:
 *   • `queue` без активного хода: контекст материализуется **до** постановки
 *     вопроса (`ord` контекста < `ord` вопроса), публикуется `message.added`,
 *     вопрос стоит в очереди, ответ — прежний `202 {messageId, mode, position}`;
 *   • `queue` при активном ходе: контекст — в истории, вопрос — в очереди;
 *   • `steer` при активном ходе: контекст и вопрос — в `steerInbox` в порядке
 *     «контекст → вопрос», в историю сразу не пишутся;
 *   • лимит инъекций: контекст принят, вопрос отклонён → контекст снят, 429;
 *   • очередь полна: контекст откатан из истории, 429;
 *   • `mode=interrupt` + контекст → 400 (контекст нельзя вклинить перед
 *     interrupt-сообщением);
 *   • невалидный `context` → 400 `VALIDATION_ERROR` без частичной доставки;
 *   • без `context` поведение прежнее.
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
import type { BusEvent, Message } from '@itphx/synth-shared';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';

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
    obfuscateUserMessageForHistory: vi.fn(async (_sid: string, message: Message) => message),
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

type AcceptedBody = { messageId: string; mode: string; position: number | null };
type ErrorBody = { error: { code: string; message: string } };

/** Служебное сообщение для предзаполнения очередей (не контекст терминала). */
function makeServiceMessage(content: string): Message {
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
    author: 'Process',
    metadata: { type: 'background_run_result', kind: 'process' },
  };
}

/** Тело запроса с контекстом терминала. */
function promptBody(content: string, extra?: Record<string, unknown>) {
  return JSON.stringify({
    content,
    context: {
      terminal_id: 'term_ctx',
      content: 'вывод терминала',
      cwd: '/tmp',
      shell: 'bash',
      status: 'running',
      lines: 2,
    },
    ...(extra ?? {}),
  });
}

describe('POST /api/v2/sessions/:id/prompt — контекст терминала (PROP-132)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-prompt-ctx-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('queue без активного хода: контекст в истории ДО вопроса, ord контекста < ord вопроса', async () => {
    const { app, sessionManager, eventBus } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });

    const events: BusEvent[] = [];
    // Адресные события (`message.enqueued`/`message.accepted`) доходят только
    // получателю — подписка владельцем сессии (`local`).
    eventBus.subscribe(session.id, (event) => { events.push(event); }, { userId: 'local' });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: promptBody('вопрос'),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;
    expect(body.mode).toBe('queue');
    expect(body.position).toBe(1);
    // `messageId` — вопрос, а не контекст.
    expect(body.messageId).toBeTruthy();

    const fresh = (await sessionManager.getSession(session.id))!;
    const context = fresh.messages.find((m) => m.author === 'Terminal');
    expect(context).toBeDefined();
    expect(context!.metadata?.type).toBe('background_run_result');
    expect(context!.content).toContain('[CONTENT terminal=term_ctx');

    // Вопрос — в очереди, его `ord` больше `ord` контекста (контекст
    // материализован до постановки вопроса в очередь).
    expect(fresh.pendingMessages).toHaveLength(1);
    const question = fresh.pendingMessages[0]!;
    expect(question.content).toBe('вопрос');
    expect(question.ord!).toBeGreaterThan(context!.ord!);

    // Контекст виден UI сразу: `message.added` опубликован **до** событий
    // постановки вопроса в очередь.
    const contextAddedIndex = events.findIndex(
      (e) => e.type === 'message.added' && (e.data.message as { id?: string })?.id === context!.id,
    );
    const questionEnqueuedIndex = events.findIndex((e) => e.type === 'message.enqueued');
    expect(contextAddedIndex).toBeGreaterThanOrEqual(0);
    expect(questionEnqueuedIndex).toBeGreaterThan(contextAddedIndex);
    // `session.updated` — тоже (fallback как у уведомления фонового прогона).
    expect(events.some((e) => e.type === 'session.updated')).toBe(true);
  });

  it('queue при активном ходе: контекст в истории, вопрос в очереди', async () => {
    const { app, sessionManager } = createTestApp(tmpDir, { running: true });
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: promptBody('вопрос'),
    });

    expect(res.status).toBe(202);
    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.messages.some((m) => m.author === 'Terminal')).toBe(true);
    expect(fresh.pendingMessages).toHaveLength(1);
    expect(fresh.pendingMessages[0]!.content).toBe('вопрос');
    // В `steerInbox` контекста нет — режим `queue`.
    expect(fresh.steerInbox ?? []).toHaveLength(0);
  });

  it('steer при активном ходе: контекст и вопрос в steerInbox (контекст → вопрос), в историю не пишутся', async () => {
    const { app, sessionManager } = createTestApp(tmpDir, { running: true });
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: promptBody('вопрос', { mode: 'steer' }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;
    expect(body.mode).toBe('steer');
    expect(body.position).toBeNull();

    const fresh = (await sessionManager.getSession(session.id))!;
    const inbox = fresh.steerInbox ?? [];
    expect(inbox).toHaveLength(2);
    expect(inbox[0]!.author).toBe('Terminal');
    expect(inbox[0]!.content).toContain('[CONTENT terminal=term_ctx');
    expect(inbox[1]!.content).toBe('вопрос');
    // В историю сразу не пишутся — инъекции материализуются на границе шага.
    expect(fresh.messages).toHaveLength(0);
  });

  it('лимит инъекций: контекст принят, вопрос отклонён → контекст снят, 429', async () => {
    const { app, sessionManager, eventBus } = createTestApp(tmpDir, { running: true });
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });
    const events: BusEvent[] = [];
    eventBus.subscribe(session.id, (event) => { events.push(event); }, { userId: 'local' });
    // Лимит инъекций на ход — 5: кладём 4, контекст станет пятым, вопрос —
    // шестым (его отклонят).
    await sessionManager.withLock(session.id, async (s) => {
      s.steerInbox = [makeServiceMessage('i1'), makeServiceMessage('i2'),
        makeServiceMessage('i3'), makeServiceMessage('i4')];
      await sessionManager.saveSession(s);
    });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: promptBody('вопрос', { mode: 'steer' }),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('STEER_LIMIT_EXCEEDED');

    const fresh = (await sessionManager.getSession(session.id))!;
    const inbox = fresh.steerInbox ?? [];
    // Контекст снят — в очереди инъекций остались только исходные 4.
    expect(inbox).toHaveLength(4);
    expect(inbox.some((m) => m.author === 'Terminal')).toBe(false);
    expect(fresh.messages).toHaveLength(0);
    // Клиенту сообщаем, что инъекция снята.
    expect(events.some((e) => e.type === 'steer.dropped')).toBe(true);
  });

  it('очередь полна: контекст откатан из истории, 429', async () => {
    const { app, sessionManager, eventBus } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });
    const events: BusEvent[] = [];
    eventBus.subscribe(session.id, (event) => { events.push(event); }, { userId: 'local' });
    // Очередь полна (макс. 5) — вопрос не приметься.
    await sessionManager.withLock(session.id, async (s) => {
      s.pendingMessages = [
        makeServiceMessage('p1'), makeServiceMessage('p2'), makeServiceMessage('p3'),
        makeServiceMessage('p4'), makeServiceMessage('p5'),
      ];
      await sessionManager.saveSession(s);
    });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: promptBody('вопрос'),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('QUEUE_FULL');

    const fresh = (await sessionManager.getSession(session.id))!;
    // Контекст откатан — в истории его нет.
    expect(fresh.messages.some((m) => m.author === 'Terminal')).toBe(false);
    expect(fresh.pendingMessages).toHaveLength(5);
    // Откат виден клиенту: удаление контекста по id (ADR-118 §7).
    expect(events.some((e) => e.type === 'message.deleted')).toBe(true);
  });

  it('mode=interrupt + контекст → 400 (контекст нельзя вклинить перед interrupt)', async () => {
    const { app, sessionManager } = createTestApp(tmpDir, { running: true });
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: promptBody('вопрос', { mode: 'interrupt' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('interrupt');

    const fresh = (await sessionManager.getSession(session.id))!;
    // Ни контекста, ни вопроса — частичной доставки нет.
    expect(fresh.messages).toHaveLength(0);
    expect(fresh.pendingMessages).toHaveLength(0);
    expect(fresh.steerInbox ?? []).toHaveLength(0);
  });

  it('невалидный context → 400 VALIDATION_ERROR без частичной доставки', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'вопрос', context: { terminal_id: '', content: 'x' } }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');

    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.messages).toHaveLength(0);
    expect(fresh.pendingMessages).toHaveLength(0);
  });

  it('без context поведение прежнее: 202, вопрос в очереди, история пуста', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'вопрос' }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as AcceptedBody;
    expect(body.mode).toBe('queue');
    expect(body.position).toBe(1);

    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.messages).toHaveLength(0);
    expect(fresh.pendingMessages).toHaveLength(1);
    expect(fresh.pendingMessages[0]!.content).toBe('вопрос');
  });
});
