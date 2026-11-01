/**
 * Заметки сессии (`/api/v2/sessions/:id/notes`) — единая реализация в
 * core-фабрике (перенесена из backend).
 *
 * Проверяем: CRUD, события `context.sticky_note_*`, лимиты инстанса
 * (`context.stickyNotes`): 409 `LIMIT_EXCEEDED` при превышении `maxCount`,
 * 400 `VALIDATION_ERROR` при превышении `maxChars` (POST и PATCH),
 * существующие заметки не обрезаются/не удаляются, дефолты 50/2000.
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
import type { BusEvent, StickyNotesLimits } from '@itphx/synth-shared';

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

const AUTH = { authorization: 'Bearer test' };

describe('заметки сессии (core-фабрика)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let app: Hono;
  let limits: StickyNotesLimits;
  let events: Array<{ type: string; data: unknown }>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-notes-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    limits = { maxCount: 50, maxChars: 2000 };
    events = [];
    const orchestrator = createMockOrchestrator();
    app = new Hono();
    app.route('/api/v2/sessions', createSessionRoutes(
      createAuth(),
      {
        sessionManager,
        eventBus,
        queueManager: createMockQueueManager() as never,
        processMessage: orchestrator.createProcessMessage() as never,
        orchestrator: orchestrator as never,
      },
      {
        resolveUserId: () => 'local',
        getStickyNoteLimits: () => limits,
      },
    ));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function seed(): Promise<string> {
    const session = await sessionManager.createSession({ title: 'S', userId: 'local', ownerId: 'local' });
    eventBus.subscribe(session.id, (event: BusEvent) => {
      events.push({ type: event.type, data: event.data });
    });
    return session.id;
  }

  function post(sessionId: string, body: unknown): Promise<Response> {
    return Promise.resolve(app.request(`/api/v2/sessions/${sessionId}/notes`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  function patch(sessionId: string, noteId: string, body: unknown): Promise<Response> {
    return Promise.resolve(app.request(`/api/v2/sessions/${sessionId}/notes/${noteId}`, {
      method: 'PATCH',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  it('CRUD: создание → список → изменение → удаление, события на каждую мутацию', async () => {
    const sessionId = await seed();

    // Пустой список.
    const empty = await app.request(`/api/v2/sessions/${sessionId}/notes`, { headers: AUTH });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ notes: [] });

    // Создание: content тримится, ответ 201 `{note, notes}`.
    const created = await post(sessionId, { content: '  Важное решение  ' });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { note: { id: string; content: string; disabled: boolean }; notes: unknown[] };
    expect(createdBody.note.content).toBe('Важное решение');
    expect(createdBody.note.disabled).toBe(false);
    expect(createdBody.notes).toHaveLength(1);

    // PATCH: контент и disabled, ответ `{notes}`.
    const patched = await patch(sessionId, createdBody.note.id, { content: 'Обновлено', disabled: true });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json() as { notes: Array<{ id: string; content: string; disabled: boolean }> };
    expect(patchedBody.notes).toHaveLength(1);
    expect(patchedBody.notes[0]).toMatchObject({ id: createdBody.note.id, content: 'Обновлено', disabled: true });

    // DELETE: ответ `{notes}`, заметка исчезла.
    const deleted = await app.request(`/api/v2/sessions/${sessionId}/notes/${createdBody.note.id}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ notes: [] });

    expect(events.map((e) => e.type)).toEqual([
      'context.sticky_note_added',
      'context.sticky_note_updated',
      'context.sticky_note_deleted',
    ]);
  });

  it('пустой content → 400 VALIDATION_ERROR (заметка не создаётся)', async () => {
    const sessionId = await seed();
    for (const body of [{}, { content: '' }, { content: '   ' }, { content: 42 }]) {
      const res = await post(sessionId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    }
    expect((await sessionManager.getSession(sessionId))!.stickyNotes).toHaveLength(0);
  });

  it('PATCH неизвестной заметки → 404 NOT_FOUND', async () => {
    const sessionId = await seed();
    const res = await patch(sessionId, 'missing', { content: 'x' });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('maxChars: POST длиннее лимита → 400 VALIDATION_ERROR с пределом', async () => {
    const sessionId = await seed();
    limits = { maxCount: 50, maxChars: 5 };
    const res = await post(sessionId, { content: '123456' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('5');
    expect((await sessionManager.getSession(sessionId))!.stickyNotes).toHaveLength(0);

    // Ровно предел — можно.
    expect((await post(sessionId, { content: '12345' })).status).toBe(201);
  });

  it('maxChars: PATCH длиннее лимита → 400 VALIDATION_ERROR, заметка не меняется', async () => {
    const sessionId = await seed();
    limits = { maxCount: 50, maxChars: 5 };
    const created = await post(sessionId, { content: 'ok' });
    const noteId = ((await created.json()) as { note: { id: string } }).note.id;

    const res = await patch(sessionId, noteId, { content: '123456' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('5');
    expect((await sessionManager.getSession(sessionId))!.stickyNotes[0]!.content).toBe('ok');
  });

  it('maxCount: превышение → 409 LIMIT_EXCEEDED с пределом', async () => {
    const sessionId = await seed();
    limits = { maxCount: 2, maxChars: 2000 };
    expect((await post(sessionId, { content: 'one' })).status).toBe(201);
    expect((await post(sessionId, { content: 'two' })).status).toBe(201);

    const res = await post(sessionId, { content: 'three' });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('LIMIT_EXCEEDED');
    expect(body.error.message).toContain('2');
    expect((await sessionManager.getSession(sessionId))!.stickyNotes).toHaveLength(2);
  });

  it('понижение лимита не удаляет и не обрезает существующие заметки', async () => {
    const sessionId = await seed();
    await post(sessionId, { content: 'first' });
    await post(sessionId, { content: 'second' });

    limits = { maxCount: 1, maxChars: 3 };
    const list = await app.request(`/api/v2/sessions/${sessionId}/notes`, { headers: AUTH });
    const body = await list.json() as { notes: Array<{ content: string }> };
    expect(body.notes.map((n) => n.content)).toEqual(['first', 'second']);

    // Новая заметка уже не проходит по count, существующие остались целы.
    expect((await post(sessionId, { content: 'x' })).status).toBe(409);
    expect((await sessionManager.getSession(sessionId))!.stickyNotes).toHaveLength(2);
  });

  it('дефолтные лимиты без опции: 50 заметок / 2000 символов', async () => {
    const sessionId = await seed();
    const orchestrator = createMockOrchestrator();
    const defaultApp = new Hono();
    defaultApp.route('/api/v2/sessions', createSessionRoutes(
      createAuth(),
      {
        sessionManager,
        eventBus,
        queueManager: createMockQueueManager() as never,
        processMessage: orchestrator.createProcessMessage() as never,
        orchestrator: orchestrator as never,
      },
      { resolveUserId: () => 'local' },
    ));

    const tooLong = await defaultApp.request(`/api/v2/sessions/${sessionId}/notes`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(2001) }),
    });
    expect(tooLong.status).toBe(400);

    const ok = await defaultApp.request(`/api/v2/sessions/${sessionId}/notes`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(2000) }),
    });
    expect(ok.status).toBe(201);
  });

  it('401 без аутентификации', async () => {
    const sessionId = await seed();
    const res = await app.request(`/api/v2/sessions/${sessionId}/notes`);
    expect(res.status).toBe(401);
  });
});
