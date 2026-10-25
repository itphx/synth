/**
 * Этап 1 roadmap 0.13 (блок 3): HTTP-контур вопросов пользователю.
 *
 * `GET /api/v2/sessions/:id/questions`, `POST /:id/questions/:qid/answer`,
 * `POST /:id/questions/:qid/cancel` — внутри фабрики сессий (доступ решает
 * prefix-guard, инвариант 16).
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
import { QuestionService } from '../../engine/question/service.js';
import { MemoryQuestionRepository } from '../../storage/memory/questions.js';
import type { AuthKit } from '../../auth/local.js';
import type { QuestionItem } from '@itphx/synth-shared';

const QUESTIONS: QuestionItem[] = [
  {
    question: 'Какой вариант?',
    header: 'Выбор',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  },
];

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
    getPromptInfo: vi.fn().mockResolvedValue({}),
    getModelPricing: vi.fn().mockReturnValue(null),
  };
}

type ErrorBody = { error: { code: string; message: string } };

describe('HTTP: вопросы пользователю (этап 1 roadmap 0.13)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-questions-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createApp() {
    const app = new Hono();
    const fileStore = new FileStore({ dataDir: tmpDir });
    const sessionManager = new SessionManager(fileStore);
    const eventBus = new EventBus();
    const queueManager = createMockQueueManager();
    const orchestrator = createMockOrchestrator();
    const repository = new MemoryQuestionRepository();
    let counter = 0;
    const questionService = new QuestionService({
      repository,
      eventBus,
      timeoutMs: 60_000,
      generateId: () => `id-${++counter}`,
    });

    app.route('/api/v2/sessions', createSessionRoutes(
      createMockAuth(),
      {
        sessionManager,
        eventBus,
        queueManager: queueManager as unknown as QueueProcessorManager,
        processMessage: orchestrator.createProcessMessage(),
        orchestrator: orchestrator as unknown as ChatOrchestrator,
        questionService,
      },
      {},
    ));
    return { app, sessionManager, questionService };
  }

  it('GET /:id/questions — 200 со списком (пусто по умолчанию)', async () => {
    const { app, sessionManager } = createApp();
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const res = await app.request(`/api/v2/sessions/${session.id}/questions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { questions: unknown[] };
    expect(Array.isArray(body.questions)).toBe(true);
    expect(body.questions).toHaveLength(0);
  });

  it('GET /:id/questions?status=pending — фильтр по статусу', async () => {
    const { app, sessionManager, questionService } = createApp();
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const pending = questionService.ask({ sessionId: session.id, questions: QUESTIONS });
    await new Promise((r) => setTimeout(r, 0));

    const res = await app.request(`/api/v2/sessions/${session.id}/questions?status=pending`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { questions: Array<{ status: string }> };
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0]!.status).toBe('pending');

    const res2 = await app.request(`/api/v2/sessions/${session.id}/questions?status=answered`);
    const body2 = (await res2.json()) as { questions: unknown[] };
    expect(body2.questions).toHaveLength(0);

    const records = await questionService.listPending(session.id);
    await questionService.cancel(records[0]!.id, 'test');
    await pending;
  });

  it('GET /:id/questions — невалидный status/limit → 400 VALIDATION_ERROR', async () => {
    const { app, sessionManager } = createApp();
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const res = await app.request(`/api/v2/sessions/${session.id}/questions?status=weird`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe('VALIDATION_ERROR');

    const res2 = await app.request(`/api/v2/sessions/${session.id}/questions?limit=0`);
    expect(res2.status).toBe(400);
    expect(((await res2.json()) as ErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /:id/questions/:qid/answer — 200 и вопрос переходит в answered', async () => {
    const { app, sessionManager, questionService } = createApp();
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const pending = questionService.ask({ sessionId: session.id, questions: QUESTIONS });
    await new Promise((r) => setTimeout(r, 0));
    const record = (await questionService.listPending(session.id))[0]!;

    const res = await app.request(`/api/v2/sessions/${session.id}/questions/${record.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [['a']] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { question: { status: string; answers: string[][] } };
    expect(body.question.status).toBe('answered');
    expect(body.question.answers).toEqual([['a']]);

    await pending;
  });

  it('POST answer — свой ответ (вне options) принимается', async () => {
    const { app, sessionManager, questionService } = createApp();
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const pending = questionService.ask({ sessionId: session.id, questions: QUESTIONS });
    await new Promise((r) => setTimeout(r, 0));
    const record = (await questionService.listPending(session.id))[0]!;

    const res = await app.request(`/api/v2/sessions/${session.id}/questions/${record.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [['свой ответ']] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { question: { status: string; answers: string[][] } };
    expect(body.question.status).toBe('answered');
    expect(body.question.answers).toEqual([['свой ответ']]);

    await pending;
  });

  it('POST answer — невалидный ответ → 400 VALIDATION_ERROR', async () => {
    const { app, sessionManager, questionService } = createApp();
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const pending = questionService.ask({ sessionId: session.id, questions: QUESTIONS });
    await new Promise((r) => setTimeout(r, 0));
    const record = (await questionService.listPending(session.id))[0]!;

    // Пустой ответ на вопрос.
    const res = await app.request(`/api/v2/sessions/${session.id}/questions/${record.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [['']] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe('VALIDATION_ERROR');

    // Некорректное тело.
    const res2 = await app.request(`/api/v2/sessions/${session.id}/questions/${record.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: 'nope' }),
    });
    expect(res2.status).toBe(400);
    expect(((await res2.json()) as ErrorBody).error.code).toBe('VALIDATION_ERROR');

    const records = await questionService.listPending(session.id);
    await questionService.cancel(records[0]!.id, 'test');
    await pending;
  });

  it('POST answer — чужой вопрос (другая сессия) → 404 NOT_FOUND', async () => {
    const { app, sessionManager, questionService } = createApp();
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const other = await sessionManager.createSession({ title: 'O', userId: 'local' });
    const pending = questionService.ask({ sessionId: other.id, questions: QUESTIONS });
    await new Promise((r) => setTimeout(r, 0));
    const record = (await questionService.listPending(other.id))[0]!;

    const res = await app.request(`/api/v2/sessions/${session.id}/questions/${record.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [['a']] }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe('NOT_FOUND');

    const records = await questionService.listPending(other.id);
    await questionService.cancel(records[0]!.id, 'test');
    await pending;
  });

  it('POST answer — повторный ответ → 409 CONFLICT', async () => {
    const { app, sessionManager, questionService } = createApp();
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const pending = questionService.ask({ sessionId: session.id, questions: QUESTIONS });
    await new Promise((r) => setTimeout(r, 0));
    const record = (await questionService.listPending(session.id))[0]!;

    const first = await app.request(`/api/v2/sessions/${session.id}/questions/${record.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [['a']] }),
    });
    expect(first.status).toBe(200);

    const second = await app.request(`/api/v2/sessions/${session.id}/questions/${record.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [['b']] }),
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as ErrorBody).error.code).toBe('CONFLICT');

    await pending;
  });

  it('POST cancel — 200 и вопрос переходит в cancelled', async () => {
    const { app, sessionManager, questionService } = createApp();
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const pending = questionService.ask({ sessionId: session.id, questions: QUESTIONS });
    await new Promise((r) => setTimeout(r, 0));
    const record = (await questionService.listPending(session.id))[0]!;

    const res = await app.request(`/api/v2/sessions/${session.id}/questions/${record.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'user' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { question: { status: string; cancelReason?: string } };
    expect(body.question.status).toBe('cancelled');
    expect(body.question.cancelReason).toBe('user');

    await pending;
  });

  it('POST cancel — несуществующий вопрос → 404', async () => {
    const { app, sessionManager } = createApp();
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const res = await app.request(`/api/v2/sessions/${session.id}/questions/qst-none/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('POST cancel — уже отменённый вопрос → 409 CONFLICT', async () => {
    const { app, sessionManager, questionService } = createApp();
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const pending = questionService.ask({ sessionId: session.id, questions: QUESTIONS });
    await new Promise((r) => setTimeout(r, 0));
    const record = (await questionService.listPending(session.id))[0]!;
    await questionService.cancel(record.id, 'first');

    const res = await app.request(`/api/v2/sessions/${session.id}/questions/${record.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe('CONFLICT');

    await pending;
  });

  it('без сервиса вопросов → 503', async () => {
    const app = new Hono();
    const fileStore = new FileStore({ dataDir: tmpDir });
    const sessionManager = new SessionManager(fileStore);
    const eventBus = new EventBus();
    const queueManager = createMockQueueManager();
    const orchestrator = createMockOrchestrator();
    app.route('/api/v2/sessions', createSessionRoutes(
      createMockAuth(),
      {
        sessionManager,
        eventBus,
        queueManager: queueManager as unknown as QueueProcessorManager,
        processMessage: orchestrator.createProcessMessage(),
        orchestrator: orchestrator as unknown as ChatOrchestrator,
      },
      {},
    ));
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const res = await app.request(`/api/v2/sessions/${session.id}/questions`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorBody).error.code).toBe('QUESTION_UNAVAILABLE');
  });
});
