import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMessageRoutes } from './messages.js';
import { SessionManager, EventBus, FileStore } from '@itphx/synth-core';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';

function makeMessage(content = 'Привет'): Message {
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
    author: 'user',
  };
}

function createMockKit() {
  const user = {
    id: 'test-user',
    username: 'test-user',
    roles: ['USER'],
    preferredLanguage: 'ru',
    createdAt: '',
    teamRole: 'USER',
    notes: '',
    interviewCompleted: false,
  };
  return {
    requireAuth: async (_c: Context, next: Next) => { await next(); },
    getCurrentUser: () => user,
    isAdmin: () => false,
    hasRole: () => false,
  };
}

function createTestApp(tmpDir: string, contextOptimizer: unknown) {
  const app = new Hono();
  const fileStore = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(fileStore);
  const eventBus = new EventBus();

  app.route('/api/v2/messages', createMessageRoutes(
    createMockKit() as any,
    sessionManager,
    contextOptimizer as any,
    eventBus,
  ));

  return { app, sessionManager, eventBus };
}

describe('Messages API Routes (core-фабрика через backend-обёртку)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-messages-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('DELETE перенумеровывает seq удалённых сообщений (core-поведение)', async () => {
    const { app, sessionManager } = createTestApp(tmpDir, null);
    const session = await sessionManager.createSession({ title: 'M', userId: 'test-user' });
    await sessionManager.addMessage(session.id, makeMessage('a'));
    await sessionManager.addMessage(session.id, makeMessage('b'));
    await sessionManager.addMessage(session.id, makeMessage('c'));

    const res = await app.request(`/api/v2/messages/${session.id}/0`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    const s = await sessionManager.getSession(session.id);
    expect(s!.messages.map((m) => m.content)).toEqual(['b', 'c']);
    expect(s!.messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('404 при неверном индексе — локализованное ru-сообщение', async () => {
    const { app, sessionManager } = createTestApp(tmpDir, null);
    const session = await sessionManager.createSession({ title: 'M', userId: 'test-user' });
    await sessionManager.addMessage(session.id, makeMessage('a'));

    const res = await app.request(`/api/v2/messages/${session.id}/5/pin`, { method: 'PATCH' });
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error.message).toBe('Сообщение не найдено');
  });

  it('после мутации ожидает onMessagesChanged: canSummarize пересчитан, session.updated опубликован', async () => {
    const contextOptimizer = {
      canSummarize: vi.fn().mockReturnValue(true),
      shouldSummarize: vi.fn().mockReturnValue({ triggered: false }),
    };
    const { app, sessionManager, eventBus } = createTestApp(tmpDir, contextOptimizer);
    const session = await sessionManager.createSession({ title: 'M', userId: 'test-user' });
    await sessionManager.addMessage(session.id, makeMessage('a'));

    const events: any[] = [];
    eventBus.subscribe(session.id, (e) => events.push(e));

    const res = await app.request(`/api/v2/messages/${session.id}/0/toggle`, { method: 'PATCH' });
    expect(res.status).toBe(200);

    // Хук вызван с await — к моменту ответа состояние уже сохранено (гонка устранена).
    const s = await sessionManager.getSession(session.id);
    expect(s!.canSummarize).toBe(true);
    expect(events.some((e) => e.type === 'session.updated')).toBe(true);
  });

  it('чужой USER → 403 (guard доступа к сессии в backend-обёртке)', async () => {
    const { app, sessionManager } = createTestApp(tmpDir, null);
    const session = await sessionManager.createSession({ title: 'Foreign', userId: 'owner' });

    const res = await app.request(`/api/v2/messages/${session.id}/0/pin`, { method: 'PATCH' });
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('POST /:sessionId/batch с пустым телом → 400 (не 500)', async () => {
    const { app, sessionManager } = createTestApp(tmpDir, null);
    const session = await sessionManager.createSession({ title: 'M', userId: 'test-user' });

    const res = await app.request(`/api/v2/messages/${session.id}/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('INVALID_ACTION');
  });

  it('managed (нет getRemoteClient): remote:<id> → 404, а не 502', async () => {
    const { app } = createTestApp(tmpDir, null);
    const res = await app.request('/api/v2/messages/remote:abc/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pin', indices: [0] }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});
