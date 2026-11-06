/**
 * Гибрид (ADR-042): панельные `:id`-маршруты сессии origin-aware.
 *
 * Для `remote:<id>` запрос уходит на удалённый backend (`RemoteBackendClient`
 * с **локальным** id), локальный `sessionManager`/`questionService` не
 * трогается; вложенные id снимают/получают префикс (`remote:`), ответы
 * возвращаются с `remote:`-ссылками. Без клиента — 502 `REMOTE_UNAVAILABLE`,
 * ошибка удалённой стороны маппится в HTTP (`mapRemoteError`).
 *
 * Покрывает: status, prompt, stats, notes* (CRUD), messages/:messageId, clear,
 * resume-subagent, children, tree, fork, references* (CRUD), messages/merge,
 * questions* (список/ответ/отмена).
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
import type { RemoteBackendClient } from '../../remote/client.js';
import { RemoteError } from '../../remote/types.js';

/** Методы клиента, которые подменяет фейк (все — шпионы). */
type FakeRemoteMethod =
  | 'getSessionStatus' | 'getSessionPrompt' | 'getSessionStats'
  | 'getSessionNotes' | 'createSessionNote' | 'updateSessionNote' | 'deleteSessionNote'
  | 'getSessionMessage' | 'clearSession' | 'resumeSubagent'
  | 'getSessionChildren' | 'getSessionTree' | 'forkSession'
  | 'getSessionReferences' | 'addSessionReference' | 'removeSessionReference'
  | 'mergeSessionMessages'
  | 'listSessionQuestions' | 'answerSessionQuestion' | 'cancelSessionQuestion';

type FakeRemote = Record<FakeRemoteMethod, ReturnType<typeof vi.fn>>;

function createFakeRemote(): FakeRemote {
  return {
    getSessionStatus: vi.fn(),
    getSessionPrompt: vi.fn(),
    getSessionStats: vi.fn(),
    getSessionNotes: vi.fn(),
    createSessionNote: vi.fn(),
    updateSessionNote: vi.fn(),
    deleteSessionNote: vi.fn(),
    getSessionMessage: vi.fn(),
    clearSession: vi.fn(),
    resumeSubagent: vi.fn(),
    getSessionChildren: vi.fn(),
    getSessionTree: vi.fn(),
    forkSession: vi.fn(),
    getSessionReferences: vi.fn(),
    addSessionReference: vi.fn(),
    removeSessionReference: vi.fn(),
    mergeSessionMessages: vi.fn(),
    listSessionQuestions: vi.fn(),
    answerSessionQuestion: vi.fn(),
    cancelSessionQuestion: vi.fn(),
  };
}

function asClient(remote: FakeRemote | null): RemoteBackendClient | null {
  return remote as unknown as RemoteBackendClient | null;
}

/** Мок-сервис вопросов: локальные методы не должны вызываться на remote-ветке. */
function createMockQuestionService() {
  return {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    answer: vi.fn(),
    cancel: vi.fn(),
    ask: vi.fn(),
    listPending: vi.fn(async () => []),
    cancelSession: vi.fn(),
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

const AUTH = { authorization: 'Bearer local' };

describe('гибрид: панельные :id-маршруты сессии форвардятся для remote:', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let questionService: ReturnType<typeof createMockQuestionService>;
  let localSpies: Array<{ mock: { calls: unknown[] } }>;

  /** Приложение с переданным клиентом (геттер всегда есть — ветки активны). */
  function makeApp(remote: FakeRemote | null): Hono {
    const built = new Hono();
    built.route('/api/v2/sessions', createSessionRoutes(
      createAuth(),
      {
        sessionManager,
        eventBus,
        queueManager: {
          isRunning: vi.fn().mockReturnValue(false),
          stop: vi.fn(),
          requestStop: vi.fn().mockReturnValue(false),
        } as never,
        processMessage: (async () => undefined) as never,
        orchestrator: {
          agentRegistry: undefined,
          createProcessMessage: () => async () => undefined,
          getPromptInfo: vi.fn(),
          startSubagentResume: vi.fn(),
        } as never,
        questionService: questionService as never,
        getRemoteClient: () => asClient(remote),
      },
      { resolveUserId: () => 'local' },
    ));
    return built;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-remote-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    questionService = createMockQuestionService();
    // Локальные швы: на remote-ветке не должны вызываться.
    localSpies = [
      vi.spyOn(sessionManager, 'getSession'),
      vi.spyOn(sessionManager, 'getChildren'),
      vi.spyOn(sessionManager, 'getSessionTree'),
      vi.spyOn(sessionManager, 'getReferences'),
      vi.spyOn(sessionManager, 'addReference'),
      vi.spyOn(sessionManager, 'removeReference'),
      vi.spyOn(sessionManager, 'mergeMessages'),
      vi.spyOn(sessionManager, 'forkSession'),
      vi.spyOn(sessionManager, 'withLock'),
    ];
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function expectLocalUntouched(): void {
    for (const spy of localSpies) expect(spy.mock.calls).toEqual([]);
    expect(questionService.list.mock.calls).toEqual([]);
    expect(questionService.get.mock.calls).toEqual([]);
    expect(questionService.answer.mock.calls).toEqual([]);
    expect(questionService.cancel.mock.calls).toEqual([]);
  }

  // ─────────────── Простые GET: id снимается, ответ как есть ───────────────

  const GET_CASES: Array<{ name: string; path: string; method: FakeRemoteMethod; result: unknown }> = [
    { name: 'status', path: '/status', method: 'getSessionStatus', result: { blocked: false, pending_count: 2 } },
    { name: 'prompt', path: '/prompt', method: 'getSessionPrompt', result: { manifest: { entries: [] } } },
    { name: 'stats', path: '/stats', method: 'getSessionStats', result: { total_tokens: 10 } },
    { name: 'notes', path: '/notes', method: 'getSessionNotes', result: { notes: [{ id: 'n1', content: 'x' }] } },
    {
      name: 'messages/:messageId',
      path: '/messages/m1',
      method: 'getSessionMessage',
      result: { id: 'm1', content: 'hi' },
    },
  ];

  for (const c of GET_CASES) {
    it(`GET ${c.path}: вызывает ${c.method} с локальным id, ответ как есть`, async () => {
      const remote = createFakeRemote();
      remote[c.method].mockResolvedValue(c.result);
      const res = await makeApp(remote).request(`/api/v2/sessions/remote:s1${c.path}`, { headers: AUTH });
      expect(res.status).toBe(200);
      if (c.name === 'messages/:messageId') {
        expect(remote.getSessionMessage).toHaveBeenCalledWith('s1', 'm1');
      } else {
        expect(remote[c.method]).toHaveBeenCalledWith('s1');
      }
      expect(await res.json()).toEqual(c.result);
      expectLocalUntouched();
    });
  }

  it('GET /children: id детей получают remote:', async () => {
    const remote = createFakeRemote();
    remote.getSessionChildren.mockResolvedValue([
      { id: 'c1', project_id: 'p1' },
      { id: 'c2', project_id: null },
    ]);
    const res = await makeApp(remote).request('/api/v2/sessions/remote:s1/children', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(remote.getSessionChildren).toHaveBeenCalledWith('s1');
    const body = (await res.json()) as Array<{ id: string; project_id: string | null; origin?: string }>;
    expect(body[0]?.id).toBe('remote:c1');
    expect(body[0]?.project_id).toBe('remote:p1');
    expect(body[0]?.origin).toBe('remote');
    expect(body[1]?.id).toBe('remote:c2');
    expectLocalUntouched();
  });

  it('GET /tree: узлы переписываются рекурсивно (id/projectId/parentId)', async () => {
    const remote = createFakeRemote();
    remote.getSessionTree.mockResolvedValue({
      session: { id: 's1', projectId: 'p1', parentId: 'p0', title: 'root' },
      children: [
        { session: { id: 'c1', projectId: 'p1', parentId: 's1' }, children: [] },
      ],
    });
    const res = await makeApp(remote).request('/api/v2/sessions/remote:s1/tree', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(remote.getSessionTree).toHaveBeenCalledWith('s1');
    const body = (await res.json()) as {
      session: { id: string; projectId: string; parentId: string };
      children: Array<{ session: { id: string; projectId: string; parentId: string } }>;
    };
    expect(body.session).toMatchObject({
      id: 'remote:s1',
      projectId: 'remote:p1',
      parentId: 'remote:p0',
    });
    expect(body.children[0]?.session).toMatchObject({
      id: 'remote:c1',
      projectId: 'remote:p1',
      parentId: 'remote:s1',
    });
    expectLocalUntouched();
  });

  // ─────────────── Заметки ───────────────

  it('POST /notes: тело форвардится, ответ 201', async () => {
    const remote = createFakeRemote();
    remote.createSessionNote.mockResolvedValue({ note: { id: 'n1' }, notes: [{ id: 'n1' }] });
    const res = await makeApp(remote).request('/api/v2/sessions/remote:s1/notes', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'note' }),
    });
    expect(res.status).toBe(201);
    expect(remote.createSessionNote).toHaveBeenCalledWith('s1', { content: 'note' });
    expectLocalUntouched();
  });

  it('PATCH /notes/:noteId: id заметки не префиксуется', async () => {
    const remote = createFakeRemote();
    remote.updateSessionNote.mockResolvedValue({ notes: [{ id: 'n1', disabled: true }] });
    const res = await makeApp(remote).request('/api/v2/sessions/remote:s1/notes/n1', {
      method: 'PATCH',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    expect(res.status).toBe(200);
    expect(remote.updateSessionNote).toHaveBeenCalledWith('s1', 'n1', { disabled: true });
    expectLocalUntouched();
  });

  it('DELETE /notes/:noteId: удаление на стороне сессии', async () => {
    const remote = createFakeRemote();
    remote.deleteSessionNote.mockResolvedValue({ notes: [] });
    const res = await makeApp(remote).request('/api/v2/sessions/remote:s1/notes/n1', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(remote.deleteSessionNote).toHaveBeenCalledWith('s1', 'n1');
    expectLocalUntouched();
  });

  // ─────────────── clear / resume-subagent / fork ───────────────

  it('POST /clear: DTO удалённой стороны с remote:-id', async () => {
    const remote = createFakeRemote();
    remote.clearSession.mockResolvedValue({ id: 's1', project_id: 'p1', settings: {} });
    const res = await makeApp(remote).request('/api/v2/sessions/remote:s1/clear', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(remote.clearSession).toHaveBeenCalledWith('s1');
    const body = (await res.json()) as { id: string; project_id: string; origin?: string };
    expect(body.id).toBe('remote:s1');
    expect(body.project_id).toBe('remote:p1');
    expect(body.origin).toBe('remote');
    expectLocalUntouched();
  });

  it('POST /resume-subagent: 202, ответ как есть', async () => {
    const remote = createFakeRemote();
    remote.resumeSubagent.mockResolvedValue({ status: 'resumed', child_session_id: 'c1' });
    const res = await makeApp(remote).request('/api/v2/sessions/remote:s1/resume-subagent', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(202);
    expect(remote.resumeSubagent).toHaveBeenCalledWith('s1');
    expect(await res.json()).toEqual({ status: 'resumed', child_session_id: 'c1' });
    expectLocalUntouched();
  });

  it('POST /fork: тело форвардится, ответ 201 с remote:-id', async () => {
    const remote = createFakeRemote();
    remote.forkSession.mockResolvedValue({ id: 'f1', parent_id: 's1', settings: {} });
    const res = await makeApp(remote).request('/api/v2/sessions/remote:s1/fork', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: 'm1', title: 'Fork' }),
    });
    expect(res.status).toBe(201);
    expect(remote.forkSession).toHaveBeenCalledWith('s1', { message_id: 'm1', title: 'Fork' });
    const body = (await res.json()) as { id: string; parent_id: string; origin?: string };
    expect(body.id).toBe('remote:f1');
    expect(body.parent_id).toBe('remote:s1');
    expect(body.origin).toBe('remote');
    expectLocalUntouched();
  });

  // ─────────────── Ссылки ───────────────

  it('GET /references: sessionId каждой ссылки получает remote:', async () => {
    const remote = createFakeRemote();
    remote.getSessionReferences.mockResolvedValue({
      references: [{ sessionId: 's2', label: 'L', messageRange: [1, 2] }],
    });
    const res = await makeApp(remote).request('/api/v2/sessions/remote:s1/references', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(remote.getSessionReferences).toHaveBeenCalledWith('s1');
    const body = (await res.json()) as { references: Array<{ sessionId: string }> };
    expect(body.references[0]?.sessionId).toBe('remote:s2');
    expectLocalUntouched();
  });

  it('POST /references: source_session_id снимает префикс, ответ с remote:', async () => {
    const remote = createFakeRemote();
    remote.addSessionReference.mockResolvedValue({
      reference: { sessionId: 's2', label: 'L', messageRange: [1, 2] },
    });
    const res = await makeApp(remote).request('/api/v2/sessions/remote:s1/references', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_session_id: 'remote:s2', label: 'L' }),
    });
    expect(res.status).toBe(201);
    expect(remote.addSessionReference).toHaveBeenCalledWith('s1', {
      source_session_id: 's2',
      label: 'L',
    });
    const body = (await res.json()) as { reference: { sessionId: string } };
    expect(body.reference.sessionId).toBe('remote:s2');
    expectLocalUntouched();
  });

  it('DELETE /references/:refSid: refSid снимает префикс, 204', async () => {
    const remote = createFakeRemote();
    remote.removeSessionReference.mockResolvedValue(undefined);
    const res = await makeApp(remote).request('/api/v2/sessions/remote:s1/references/remote:s2', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(204);
    expect(remote.removeSessionReference).toHaveBeenCalledWith('s1', 's2');
    expectLocalUntouched();
  });

  // ─────────────── Слияние истории ───────────────

  it('POST /messages/merge: source_session_id снимает префикс, 201', async () => {
    const remote = createFakeRemote();
    remote.mergeSessionMessages.mockResolvedValue({ messages: [{ id: 'm2' }] });
    const res = await makeApp(remote).request('/api/v2/sessions/remote:s1/messages/merge', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_session_id: 'remote:s2', source_range: [1, 2], summarize: true }),
    });
    expect(res.status).toBe(201);
    expect(remote.mergeSessionMessages).toHaveBeenCalledWith('s1', {
      source_session_id: 's2',
      source_range: [1, 2],
      summarize: true,
    });
    expectLocalUntouched();
  });

  // ─────────────── Вопросы пользователю ───────────────

  it('GET /questions: query уходит как есть, sessionId получает remote:', async () => {
    const remote = createFakeRemote();
    remote.listSessionQuestions.mockResolvedValue({
      questions: [{ id: 'q1', sessionId: 's1', status: 'pending' }],
    });
    const res = await makeApp(remote).request(
      '/api/v2/sessions/remote:s1/questions?status=pending&limit=10',
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(remote.listSessionQuestions).toHaveBeenCalledWith('s1', { status: 'pending', limit: '10' });
    const body = (await res.json()) as { questions: Array<{ id: string; sessionId: string }> };
    expect(body.questions[0]?.id).toBe('q1');
    expect(body.questions[0]?.sessionId).toBe('remote:s1');
    expectLocalUntouched();
  });

  it('POST /questions/:qid/answer: ответ принимает удалённая сторона (не 503)', async () => {
    const remote = createFakeRemote();
    remote.answerSessionQuestion.mockResolvedValue({
      question: { id: 'q1', sessionId: 's1', status: 'answered' },
    });
    const res = await makeApp(remote).request('/api/v2/sessions/remote:s1/questions/q1/answer', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [['yes']] }),
    });
    expect(res.status).toBe(200);
    expect(remote.answerSessionQuestion).toHaveBeenCalledWith('s1', 'q1', { answers: [['yes']] });
    const body = (await res.json()) as { question: { id: string; sessionId: string } };
    expect(body.question.id).toBe('q1');
    expect(body.question.sessionId).toBe('remote:s1');
    expectLocalUntouched();
  });

  it('POST /questions/:qid/cancel: отмена на удалённой стороне (не 503)', async () => {
    const remote = createFakeRemote();
    remote.cancelSessionQuestion.mockResolvedValue({
      question: { id: 'q1', sessionId: 's1', status: 'cancelled' },
    });
    const res = await makeApp(remote).request('/api/v2/sessions/remote:s1/questions/q1/cancel', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'user' }),
    });
    expect(res.status).toBe(200);
    expect(remote.cancelSessionQuestion).toHaveBeenCalledWith('s1', 'q1', { reason: 'user' });
    expectLocalUntouched();
  });

  // ─────────────── Без клиента / ошибки ───────────────

  it('getRemoteClient вернул null → 502 REMOTE_UNAVAILABLE на каждом маршруте', async () => {
    const noClientApp = makeApp(null);
    const paths: Array<{ method: string; path: string }> = [
      { method: 'GET', path: '/status' },
      { method: 'GET', path: '/prompt' },
      { method: 'GET', path: '/stats' },
      { method: 'GET', path: '/notes' },
      { method: 'POST', path: '/notes' },
      { method: 'PATCH', path: '/notes/n1' },
      { method: 'DELETE', path: '/notes/n1' },
      { method: 'GET', path: '/messages/m1' },
      { method: 'POST', path: '/clear' },
      { method: 'POST', path: '/resume-subagent' },
      { method: 'GET', path: '/children' },
      { method: 'GET', path: '/tree' },
      { method: 'POST', path: '/fork' },
      { method: 'GET', path: '/references' },
      { method: 'POST', path: '/references' },
      { method: 'DELETE', path: '/references/remote:s2' },
      { method: 'POST', path: '/messages/merge' },
      { method: 'GET', path: '/questions' },
      { method: 'POST', path: '/questions/q1/answer' },
      { method: 'POST', path: '/questions/q1/cancel' },
    ];
    for (const p of paths) {
      const res = await noClientApp.request(`/api/v2/sessions/remote:s1${p.path}`, {
        method: p.method,
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        ...(p.method === 'GET' || p.method === 'DELETE' ? {} : { body: JSON.stringify({}) }),
      });
      expect(res.status, `${p.method} ${p.path}`).toBe(502);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('REMOTE_UNAVAILABLE');
    }
    expectLocalUntouched();
  });

  it('ошибка клиента маппится в HTTP, локальная логика не выполняется', async () => {
    const remote = createFakeRemote();
    remote.getSessionStats.mockRejectedValue(new RemoteError('не найдено', 'HTTP_404'));
    remote.getSessionPrompt.mockRejectedValue(new RemoteError('сбой', 'HTTP_500'));
    const appWithError = makeApp(remote);

    const notFound = await appWithError.request('/api/v2/sessions/remote:s1/stats', { headers: AUTH });
    expect(notFound.status).toBe(404);
    expect((await notFound.json() as { error: { code: string } }).error.code).toBe('HTTP_404');

    const failed = await appWithError.request('/api/v2/sessions/remote:s1/prompt', { headers: AUTH });
    expect(failed.status).toBe(500);
    expect((await failed.json() as { error: { code: string } }).error.code).toBe('HTTP_500');

    expectLocalUntouched();
  });
});
