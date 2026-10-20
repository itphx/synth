/**
 * ADR-089 / безопасность: backend-only роуты сессии (export/notes/optimization/
 * debug-system-message) обязаны проверять доступ пользователя к сессии, а не
 * только `requireAuth` + существование — иначе IDOR: USER читает и меняет чужую
 * сессию (история, план, настройки, карта обфускации, заметки).
 *
 * Единое правило видимости — `isSessionVisible` из core: elevated (ADMIN/LEAD) →
 * всё; владелец → да; сессия без владельца → да; иначе сессия проекта видна её
 * owner/участникам. Отказ → 403 FORBIDDEN (единый код для «сессия недоступна»
 * во всём ресурсе сессий; 404 остаётся только для реально отсутствующей сессии).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, FileStore, EventBus, ProjectStore } from '@itphx/synth-core';
import type { ChatOrchestrator } from '@itphx/synth-core';
import type { User } from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';

interface MockUser extends User {
  roles: string[];
}

/** Реальный секрет в карте обфускации сессии (плейсхолдер → значение). */
const REAL_SECRET = 'sk-live-DO-NOT-LEAK';
const PLACEHOLDER = '⟦SYNTH_SECRET_1⟧';

const USERS: Record<string, MockUser> = {
  owner: { id: 'owner', username: 'owner', roles: ['USER'] } as MockUser,
  other: { id: 'other', username: 'other', roles: ['USER'] } as MockUser,
  member: { id: 'member', username: 'member', roles: ['USER'] } as MockUser,
  projectOwner: { id: 'projectOwner', username: 'projectOwner', roles: ['USER'] } as MockUser,
  admin: { id: 'admin', username: 'admin', roles: ['ADMIN'] } as MockUser,
  lead: { id: 'lead', username: 'lead', roles: ['LEAD'] } as MockUser,
  auditor: { id: 'auditor', username: 'auditor', roles: ['AUDITOR'] } as MockUser,
};

function userFromHeader(header: string | undefined): MockUser | null {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return m ? USERS[m[1]!] ?? null : null;
}

function createMockKit() {
  const requireAuth = async (c: Context, next: Next) => {
    const user = userFromHeader(c.req.header('Authorization'));
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
    c.set('user', user);
    await next();
  };
  return {
    requireAuth,
    // Ролевой guard — как в backend (`requirePermission('ADMIN','AUDITOR')`).
    requirePermission: (...roles: string[]) => async (c: Context, next: Next) => {
      const user = userFromHeader(c.req.header('Authorization'));
      if (!user || !roles.some((r) => user.roles.includes(r))) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
      }
      c.set('user', user);
      await next();
    },
    getCurrentUser: async (c: Context) => userFromHeader(c.req.header('Authorization')),
    isAdmin: (c: { get(key: 'user'): unknown }): boolean => {
      const u = c.get('user') as MockUser | undefined;
      return !!u && u.roles.includes('ADMIN');
    },
    hasRole: (c: { get(key: 'user'): unknown }, ...roles: string[]): boolean => {
      const u = c.get('user') as MockUser | undefined;
      return !!u && roles.some((r) => u.roles.includes(r));
    },
  };
}

let tmpDir: string;

async function makeApp() {
  const app = new Hono();
  const kit = createMockKit();
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const processMessage = vi.fn().mockResolvedValue({});
  const orchestrator = {
    agentRegistry: { get: () => undefined },
    resolveMcpServers: vi.fn(async () => []),
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
  };
  const routes = createSessionRoutes(
    kit as never,
    sessionManager,
    new EventBus(),
    { createProcessor: vi.fn(), isRunning: vi.fn().mockReturnValue(false) } as never,
    processMessage,
    orchestrator as unknown as ChatOrchestrator,
    { subscribeToSession: vi.fn().mockResolvedValue(undefined), unsubscribeFromSession: vi.fn() } as never,
    undefined,
    projectStore,
    undefined,
  );
  app.route('/api/v2/sessions', routes);
  return { app, sessionManager, projectStore };
}

function auth(user: string) {
  return { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' };
}

describe('Session access control для backend-only роутов (ADR-089, IDOR)', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-sess-access-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Сессия, принадлежащая 'owner' (с картой обфускации и секретом в metadata). */
  async function seedOwnedSession() {
    const { app, sessionManager } = await makeApp();
    const session = await sessionManager.createSession({
      title: 'S',
      ownerId: 'owner',
      userId: 'owner',
    });
    // ADR-036: карта обфускации сессии + реальные значения плейсхолдеров в
    // metadata сообщения — именно то, что не должно утекать через экспорт.
    session.obfuscationMap = { [PLACEHOLDER]: REAL_SECRET };
    session.messages = [
      {
        id: 'm1',
        role: MessageRole.ASSISTANT,
        seq: 1,
        origin: 'local',
        parts: [],
        content: 'ответ с секретом',
        createdAt: '2026-01-01T00:00:00.000Z',
        disabled: false,
        pinned: false,
        hidden: false,
        metadata: { secrets: { [PLACEHOLDER]: REAL_SECRET } },
      } as never,
    ];
    await sessionManager.saveSession(session);
    return { app, sessionManager, id: session.id };
  }

  const denied = 403;
  const ok = 200;

  describe('GET /:id/export', () => {
    it('владелец/ADMIN/LEAD → 200; чужая сессия → 403', async () => {
      const { app, id } = await seedOwnedSession();

      const foreign = await app.request(`/api/v2/sessions/${id}/export`, { headers: auth('other') });
      expect(foreign.status).toBe(denied);
      expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

      for (const u of ['owner', 'admin', 'lead']) {
        const res = await app.request(`/api/v2/sessions/${id}/export`, { headers: auth(u) });
        expect(res.status, u).toBe(ok);
      }
    });

    it('security-фикс 0.11.3: владелец/ADMIN/AUDITOR → полный экспорт (с картой обфускации)', async () => {
      const { app, id } = await seedOwnedSession();

      for (const u of ['owner', 'admin', 'auditor']) {
        const res = await app.request(`/api/v2/sessions/${id}/export`, { headers: auth(u) });
        expect(res.status, u).toBe(ok);
        const body = (await res.json()) as { obfuscationMap?: Record<string, string> };
        // Карта обфускации — реальные значения плейсхолдеров.
        expect(body.obfuscationMap, u).toEqual({ [PLACEHOLDER]: REAL_SECRET });
      }
    });

    it('security-фикс 0.11.3: LEAD (не владелец) → 200, но экспорт ОЧИЩЕН (без карты)', async () => {
      const { app, id } = await seedOwnedSession();

      const res = await app.request(`/api/v2/sessions/${id}/export`, { headers: auth('lead') });
      expect(res.status).toBe(ok);
      const body = (await res.json()) as { obfuscationMap?: unknown; messages?: Array<{ metadata?: unknown }> };
      expect(body.obfuscationMap).toBeUndefined();
      for (const message of body.messages ?? []) {
        expect((message.metadata as Record<string, unknown> | undefined)?.secrets).toBeUndefined();
      }
    });

    it('владелец проекта (не владелец сессии) → 200 с очищенным экспортом, разговор цел', async () => {
      const { app, sessionManager, projectStore } = await makeApp();
      const project = projectStore.create('P', 'projectOwner');
      await projectStore.save(project);
      const session = await sessionManager.createSession({
        title: 'shared', ownerId: 'owner', userId: 'owner', projectId: project.id,
      });
      session.obfuscationMap = { [PLACEHOLDER]: REAL_SECRET };
      session.messages = [{
        id: 'm1',
        role: MessageRole.ASSISTANT,
        seq: 1,
        origin: 'local',
        parts: [],
        content: 'ответ с секретом',
        createdAt: '2026-01-01T00:00:00.000Z',
        disabled: false,
        pinned: false,
        hidden: false,
        metadata: { secrets: { [PLACEHOLDER]: REAL_SECRET } },
      } as never];
      await sessionManager.saveSession(session);

      const res = await app.request(`/api/v2/sessions/${session.id}/export`, { headers: auth('projectOwner') });
      expect(res.status).toBe(ok);
      const body = (await res.json()) as {
        obfuscationMap?: unknown;
        messages?: Array<{ content?: string; metadata?: Record<string, unknown> }>;
      };
      expect(body.obfuscationMap).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(REAL_SECRET);
      expect(body.messages?.[0]?.content).toBe('ответ с секретом');
    });

    it('rate limit 10/60 c → 429 (11-й запрос владельца)', async () => {
      const { app, id } = await seedOwnedSession();

      for (let i = 0; i < 10; i++) {
        const res = await app.request(`/api/v2/sessions/${id}/export`, { headers: auth('owner') });
        expect(res.status, `запрос ${i + 1}`).toBe(ok);
      }
      const limited = await app.request(`/api/v2/sessions/${id}/export`, { headers: auth('owner') });
      expect(limited.status).toBe(429);
    });

    it('prefix-guard отклоняет ДО обработчика: посторонний всегда получает 403 (даже за rate limit)', async () => {
      // Доказательство, что маршрут покрыт общим prefix-guard'ом: решение о
      // доступе принимается guard'ом (404/403), а не кодом маршрута.
      const { app, id } = await seedOwnedSession();

      for (let i = 0; i < 12; i++) {
        const res = await app.request(`/api/v2/sessions/${id}/export`, { headers: auth('other') });
        expect(res.status, `запрос ${i + 1}`).toBe(denied);
      }
    });
  });

  describe('структура маршрута экспорта (инвариант 16)', () => {    it('маршрут экспорта зарегистрирован ПОСЛЕ prefix-guard\'а', async () => {
      const src = await readFile(new URL('./sessions.ts', import.meta.url), 'utf-8');
      const guardIdx = src.indexOf("app.use('/:id/*'");
      const exportIdx = src.indexOf("app.get('/:id/export'");
      expect(guardIdx, 'prefix-guard не найден').toBeGreaterThan(-1);
      expect(exportIdx, 'маршрут экспорта не найден').toBeGreaterThan(-1);
      expect(exportIdx, 'экспорт обязан быть зарегистрирован ПОСЛЕ guard\'а')
        .toBeGreaterThan(guardIdx);
    });

    it('в обработчике экспорта нет копии правила доступа', async () => {
      const src = await readFile(new URL('./sessions.ts', import.meta.url), 'utf-8');
      const start = src.indexOf("app.get('/:id/export'");
      expect(start).toBeGreaterThan(-1);
      const end = src.indexOf('\n  });', start);
      expect(end).toBeGreaterThan(start);
      const block = src.slice(start, end);
      // Решение о доступе — в guard'е; в обработчике остаётся только формат.
      expect(block).not.toContain('FORBIDDEN');
      expect(block).not.toContain('sessionAccessPredicate');
      expect(block).not.toContain('canRead');
    });
  });

  describe('роль AUDITOR: область исключения (инвариант 16)', () => {
    it('AUDITOR — читатель сессии ТОЛЬКО на маршруте экспорта; остальные `:id`-маршруты → 403', async () => {
      // Исключение в prefix-guard'е — path-scoped: `AUDITOR` проходит как
      // читатель только на `GET /:id/export` (где ему и так доступна карта
      // обфускации любой сессии через `GET /:id/secrets`). На всех прочих
      // `:id`-маршрутах правило не меняется.
      const { app, id } = await seedOwnedSession();

      const forbiddenForAuditor = [
        '/:id', '/:id/messages', '/:id/notes', '/:id/optimization', '/:id/mcp',
      ];
      for (const path of forbiddenForAuditor) {
        const url = `/api/v2/sessions/${id}${path.slice('/:id'.length)}`;
        const res = await app.request(url, { headers: auth('auditor') });
        expect(res.status, `AUDITOR ${path}`).toBe(denied);
      }

      // `/:id/secrets` — отдельный ролевой эндпоинт (`ADMIN`/`AUDITOR`), 200.
      const secrets = await app.request(`/api/v2/sessions/${id}/secrets`, { headers: auth('auditor') });
      expect(secrets.status).toBe(ok);

      // `/:id/export` — единственный маршрут, где AUDITOR читает чужую сессию.
      const exportRes = await app.request(`/api/v2/sessions/${id}/export`, { headers: auth('auditor') });
      expect(exportRes.status).toBe(ok);
      const body = (await exportRes.json()) as { obfuscationMap?: Record<string, string> };
      expect(body.obfuscationMap).toEqual({ [PLACEHOLDER]: REAL_SECRET });
    });
  });

  describe('notes', () => {
    it('GET /:id/notes: чужой → 403, владелец/ADMIN → 200', async () => {
      const { app, id } = await seedOwnedSession();
      expect((await app.request(`/api/v2/sessions/${id}/notes`, { headers: auth('other') })).status).toBe(denied);
      expect((await app.request(`/api/v2/sessions/${id}/notes`, { headers: auth('owner') })).status).toBe(ok);
      expect((await app.request(`/api/v2/sessions/${id}/notes`, { headers: auth('admin') })).status).toBe(ok);
    });

    it('POST /:id/notes: чужой → 403 (заметка не создаётся), владелец → 201', async () => {
      const { app, sessionManager, id } = await seedOwnedSession();

      const foreign = await app.request(`/api/v2/sessions/${id}/notes`, {
        method: 'POST',
        headers: auth('other'),
        body: JSON.stringify({ content: 'hack' }),
      });
      expect(foreign.status).toBe(denied);
      expect((await sessionManager.getSession(id))!.stickyNotes).toHaveLength(0);

      const ownerRes = await app.request(`/api/v2/sessions/${id}/notes`, {
        method: 'POST',
        headers: auth('owner'),
        body: JSON.stringify({ content: 'mine' }),
      });
      expect(ownerRes.status).toBe(201);
      expect((await sessionManager.getSession(id))!.stickyNotes).toHaveLength(1);
    });

    it('PATCH /:id/notes/:noteId: чужой → 403 (не меняется), владелец → 200', async () => {
      const { app, sessionManager, id } = await seedOwnedSession();
      const created = await app.request(`/api/v2/sessions/${id}/notes`, {
        method: 'POST',
        headers: auth('owner'),
        body: JSON.stringify({ content: 'note' }),
      });
      const noteId = ((await created.json()) as { note: { id: string } }).note.id;

      const foreign = await app.request(`/api/v2/sessions/${id}/notes/${noteId}`, {
        method: 'PATCH',
        headers: auth('other'),
        body: JSON.stringify({ content: 'tampered' }),
      });
      expect(foreign.status).toBe(denied);
      expect((await sessionManager.getSession(id))!.stickyNotes[0]!.content).toBe('note');

      const ownerRes = await app.request(`/api/v2/sessions/${id}/notes/${noteId}`, {
        method: 'PATCH',
        headers: auth('owner'),
        body: JSON.stringify({ content: 'updated' }),
      });
      expect(ownerRes.status).toBe(ok);
      expect((await sessionManager.getSession(id))!.stickyNotes[0]!.content).toBe('updated');
    });

    it('DELETE /:id/notes/:noteId: чужой → 403 (не удаляется), владелец → 200', async () => {
      const { app, sessionManager, id } = await seedOwnedSession();
      const created = await app.request(`/api/v2/sessions/${id}/notes`, {
        method: 'POST',
        headers: auth('owner'),
        body: JSON.stringify({ content: 'note' }),
      });
      const noteId = ((await created.json()) as { note: { id: string } }).note.id;

      const foreign = await app.request(`/api/v2/sessions/${id}/notes/${noteId}`, {
        method: 'DELETE',
        headers: auth('other'),
      });
      expect(foreign.status).toBe(denied);
      expect((await sessionManager.getSession(id))!.stickyNotes).toHaveLength(1);

      const ownerRes = await app.request(`/api/v2/sessions/${id}/notes/${noteId}`, {
        method: 'DELETE',
        headers: auth('owner'),
      });
      expect(ownerRes.status).toBe(ok);
      expect((await sessionManager.getSession(id))!.stickyNotes).toHaveLength(0);
    });
  });

  describe('optimization', () => {
    it('GET /:id/optimization: чужой → 403, владелец/ADMIN → 200', async () => {
      const { app, id } = await seedOwnedSession();
      expect((await app.request(`/api/v2/sessions/${id}/optimization`, { headers: auth('other') })).status).toBe(denied);
      expect((await app.request(`/api/v2/sessions/${id}/optimization`, { headers: auth('owner') })).status).toBe(ok);
      expect((await app.request(`/api/v2/sessions/${id}/optimization`, { headers: auth('admin') })).status).toBe(ok);
    });

    it('PATCH /:id/optimization: чужой → 403 (не меняется), владелец → 200', async () => {
      const { app, sessionManager, id } = await seedOwnedSession();

      const foreign = await app.request(`/api/v2/sessions/${id}/optimization`, {
        method: 'PATCH',
        headers: auth('other'),
        body: JSON.stringify({ summarization_enabled: true }),
      });
      expect(foreign.status).toBe(denied);
      expect((await sessionManager.getSession(id))!.settings.summarizationEnabled).toBeFalsy();

      const ownerRes = await app.request(`/api/v2/sessions/${id}/optimization`, {
        method: 'PATCH',
        headers: auth('owner'),
        body: JSON.stringify({ summarization_enabled: true }),
      });
      expect(ownerRes.status).toBe(ok);
      expect((await sessionManager.getSession(id))!.settings.summarizationEnabled).toBe(true);
    });

    it('POST /:id/optimization/check: чужой → 403, владелец → 200', async () => {
      const { app, id } = await seedOwnedSession();
      expect((await app.request(`/api/v2/sessions/${id}/optimization/check`, {
        method: 'POST', headers: auth('other'),
      })).status).toBe(denied);
      expect((await app.request(`/api/v2/sessions/${id}/optimization/check`, {
        method: 'POST', headers: auth('owner'),
      })).status).toBe(ok);
    });

    it('POST /:id/optimization/cancel-summarization: чужой → 403, владелец → 200', async () => {
      const { app, id } = await seedOwnedSession();
      expect((await app.request(`/api/v2/sessions/${id}/optimization/cancel-summarization`, {
        method: 'POST', headers: auth('other'),
      })).status).toBe(denied);
      expect((await app.request(`/api/v2/sessions/${id}/optimization/cancel-summarization`, {
        method: 'POST', headers: auth('owner'),
      })).status).toBe(ok);
    });
  });

  describe('POST /:id/debug-system-message', () => {
    it('чужой USER → 403, владелец/ADMIN → 200', async () => {
      const { app, id } = await seedOwnedSession();

      const foreign = await app.request(`/api/v2/sessions/${id}/debug-system-message`, {
        method: 'POST',
        headers: auth('other'),
        body: JSON.stringify({}),
      });
      expect(foreign.status).toBe(denied);

      const ownerRes = await app.request(`/api/v2/sessions/${id}/debug-system-message`, {
        method: 'POST',
        headers: auth('owner'),
        body: JSON.stringify({}),
      });
      expect(ownerRes.status).toBe(ok);

      const adminRes = await app.request(`/api/v2/sessions/${id}/debug-system-message`, {
        method: 'POST',
        headers: auth('admin'),
        body: JSON.stringify({}),
      });
      expect(adminRes.status).toBe(ok);
    });
  });

  describe('проектная видимость', () => {
    it('участник проекта читает сессию проекта (200), посторонний → 403', async () => {
      const { app, sessionManager, projectStore } = await makeApp();
      const project = projectStore.create('P', 'owner');
      project.members['member'] = 'viewer' as never;
      await projectStore.save(project);
      const session = await sessionManager.createSession({
        title: 'shared', ownerId: 'owner', userId: 'owner', projectId: project.id,
      });

      const memberRes = await app.request(`/api/v2/sessions/${session.id}`, { headers: auth('member') });
      expect(memberRes.status).toBe(ok);

      const outsiderRes = await app.request(`/api/v2/sessions/${session.id}`, { headers: auth('other') });
      expect(outsiderRes.status).toBe(denied);
    });

    it('security-фикс 0.11.3: экспорт сессии проекта — участник получает 200 БЕЗ секретов', async () => {
      // ИЗМЕНЕНО (security-фикс 0.11.3, уточнение правила): участник проекта
      // (VIEWER) по-прежнему имеет ДОСТУП НА ЧТЕНИЕ сессии, поэтому экспорт
      // доступен (200) — но ответ ОЧИЩЕН: без `obfuscationMap` и без
      // `messages[].metadata.secrets`. Раньше (до фикса) участник получал
      // полный экспорт с ЧУЖИМИ секретами.
      const { app, sessionManager, projectStore } = await makeApp();
      const project = projectStore.create('P', 'owner');
      project.members['member'] = 'viewer' as never;
      await projectStore.save(project);
      const session = await sessionManager.createSession({
        title: 'shared', ownerId: 'owner', userId: 'owner', projectId: project.id,
      });
      session.obfuscationMap = { [PLACEHOLDER]: REAL_SECRET };
      session.messages = [{
        id: 'm1',
        role: MessageRole.ASSISTANT,
        seq: 1,
        origin: 'local',
        parts: [],
        content: 'ответ с секретом',
        createdAt: '2026-01-01T00:00:00.000Z',
        disabled: false,
        pinned: false,
        hidden: false,
        metadata: { secrets: { [PLACEHOLDER]: REAL_SECRET } },
      } as never];
      await sessionManager.saveSession(session);

      const memberRes = await app.request(`/api/v2/sessions/${session.id}/export`, { headers: auth('member') });
      expect(memberRes.status).toBe(ok);
      const body = (await memberRes.json()) as {
        obfuscationMap?: unknown;
        messages?: Array<{ content?: string; metadata?: unknown }>;
      };
      // Ни карты обфускации, ни реальных значений плейсхолдеров в metadata.
      expect(body.obfuscationMap).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(REAL_SECRET);
      for (const message of body.messages ?? []) {
        expect((message.metadata as Record<string, unknown> | undefined)?.secrets).toBeUndefined();
      }
      // Переносимый разговор при этом цел — экспорт остаётся payload'ом переноса.
      expect(body.messages?.[0]?.content).toBe('ответ с секретом');
    });

    it('security-фикс 0.11.3: очищенный экспорт импортируется без потерь (round-trip)', async () => {
      const { app, sessionManager, projectStore } = await makeApp();
      const project = projectStore.create('P', 'owner');
      project.members['member'] = 'viewer' as never;
      await projectStore.save(project);
      const session = await sessionManager.createSession({
        title: 'shared', ownerId: 'owner', userId: 'owner', projectId: project.id,
      });
      session.obfuscationMap = { [PLACEHOLDER]: REAL_SECRET };
      session.messages = [{
        id: 'm1',
        role: MessageRole.ASSISTANT,
        seq: 1,
        origin: 'local',
        parts: [],
        content: 'ответ с секретом',
        createdAt: '2026-01-01T00:00:00.000Z',
        disabled: false,
        pinned: false,
        hidden: false,
        metadata: { secrets: { [PLACEHOLDER]: REAL_SECRET } },
      } as never];
      await sessionManager.saveSession(session);

      // Участник проекта забирает очищенный экспорт.
      const exported = await app.request(`/api/v2/sessions/${session.id}/export`, { headers: auth('member') });
      expect(exported.status).toBe(ok);
      const payload = (await exported.json()) as Record<string, unknown>;

      // Импортирует его обратно (publish/fork-сценарий) — импорт принимает
      // очищенный payload.
      const imported = await app.request('/api/v2/sessions/import', {
        method: 'POST',
        headers: auth('member'),
        body: JSON.stringify(payload),
      });
      expect(imported.status).toBe(201);

      const created = (await imported.json()) as { id: string };
      const local = (await sessionManager.getSession(created.id))!;
      expect(local.obfuscationMap).toBeUndefined();
      expect(local.messages).toHaveLength(1);
      expect(local.messages[0]?.content).toBe('ответ с секретом');
      expect(JSON.stringify(local)).not.toContain(REAL_SECRET);
    });
  });

  describe('несуществующая сессия', () => {
    it('GET /:id/export → 404', async () => {
      const { app } = await makeApp();
      const res = await app.request('/api/v2/sessions/nope/export', { headers: auth('owner') });
      expect(res.status).toBe(404);
    });
  });
});
