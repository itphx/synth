import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { createSessionSkillScopeRoutes } from './skill-scope.js';
import { SessionManager, EventBus, FileStore } from '../../index.js';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { AuthKit } from '../../auth/local.js';

/**
 * Регресс: read-modify-write сессии в HTTP-роутах — только под
 * `SessionManager.withLock` (ADR-005). Без лока два параллельных запроса к одной
 * сессии читают один снапшот и сохраняют его целиком — правки «побеждённого»
 * теряются (lost update).
 *
 * Каждый тест ловил бы старую реализацию: обе параллельные правки должны
 * присутствовать в хранилище, тогда как «снапшотная» запись оставляла бы
 * только одну.
 *
 * Параллельность: `Promise.all` двух `app.request` — оба хендлера стартуют
 * синхронно до первого `await`, то есть оба читают сессию до первой записи.
 */

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

function makeApp(tmpDir: string) {
  const fileStore = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(fileStore);
  const eventBus = new EventBus();
  const queueManager = {
    isRunning: vi.fn().mockReturnValue(false),
    stop: vi.fn(),
    createProcessor: vi.fn(),
    stopAll: vi.fn(),
    getRingBuffer: vi.fn(),
    setContextOptimizer: vi.fn(),
    requestStop: vi.fn().mockReturnValue(false),
  };
  const processMessage = vi.fn().mockResolvedValue({});
  const orchestrator = {
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
    getPromptInfo: vi.fn().mockResolvedValue({}),
    getModelPricing: vi.fn().mockReturnValue(null),
  };

  const app = new Hono();
  app.route('/api/v2/sessions', createSessionRoutes(
    createMockAuth(),
    {
      sessionManager,
      eventBus,
      queueManager: queueManager as never,
      processMessage,
      orchestrator: orchestrator as never,
    },
  ));
  // Skill-scope-роуты монтируются отдельной фабрикой (база не важна — путь `/:id/skills`).
  app.route('/api/v2/skill-scope', createSessionSkillScopeRoutes(
    createMockAuth(),
    { sessionManager } as never,
    {},
  ));

  return { app, sessionManager, eventBus };
}

const patch = (app: Hono, id: string, body: Record<string, unknown>) =>
  app.request(`/api/v2/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const putSkill = (app: Hono, id: string, body: Record<string, unknown>) =>
  app.request(`/api/v2/skill-scope/${id}/skills`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('read-modify-write сессии в HTTP-роутах — под withLock (lost update)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-rmw-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('PATCH: две параллельные правки разных полей не теряются', async () => {
    const { app, sessionManager } = makeApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

    const [r1, r2] = await Promise.all([
      patch(app, session.id, { icon: 'folder' }),
      patch(app, session.id, { color: 'a1' }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const stored = await sessionManager.getSession(session.id);
    // Старая реализация: победитель сохранял свой снапшот целиком — одно из полей пропадало.
    expect(stored?.icon).toBe('folder');
    expect(stored?.color).toBe('a1');
  });

  it('POST /clear: очистка не теряется при конкурентной правке сессии', async () => {
    const { app, sessionManager } = makeApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const mk = (pinned: boolean, text: string) => ({
      id: generateId(), role: MessageRole.ASSISTANT, seq: 0, origin: 'local' as const,
      parts: [makeTextPart(text)], content: text, createdAt: nowISO(),
      disabled: false, pinned, hidden: false,
    });
    await sessionManager.addMessage(session.id, mk(true, 'keep'));
    await sessionManager.addMessage(session.id, mk(false, 'drop'));

    const [clearRes, patchRes] = await Promise.all([
      app.request(`/api/v2/sessions/${session.id}/clear`, { method: 'POST' }),
      patch(app, session.id, { icon: 'folder' }),
    ]);
    expect(clearRes.status).toBe(200);
    expect(patchRes.status).toBe(200);

    const stored = await sessionManager.getSession(session.id);
    // Старая реализация: либо clear затирал конкурентный icon, либо PATCH
    // «воскрешал» удалённые сообщения (lost update в одну из сторон).
    expect(stored?.messages).toHaveLength(1);
    expect(stored?.messages[0]?.content).toBe('keep');
    expect(stored?.icon).toBe('folder');
  });

  it('PUT /skills: два параллельных включения не теряются', async () => {
    const { app, sessionManager } = makeApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

    const [r1, r2] = await Promise.all([
      putSkill(app, session.id, { name: 'alpha', enabled: true }),
      putSkill(app, session.id, { name: 'beta', enabled: true }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const stored = await sessionManager.getSession(session.id);
    // Старая реализация: оба запроса читали пустой список — оставался только один.
    expect(stored?.settings.skills).toEqual(expect.arrayContaining(['alpha', 'beta']));
    expect(stored?.settings.skills).toHaveLength(2);
  });

  it('PATCH: невалидный mode → 400, сессия не меняется (валидация до лока)', async () => {
    const { app, sessionManager } = makeApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

    const res = await patch(app, session.id, { mode: 'bogus', title: 'Новый' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    const stored = await sessionManager.getSession(session.id);
    expect(stored?.title).toBe('S');
    expect(stored?.mode).toBeUndefined();
  });

  it('PATCH: session.renamed публикуется при смене title (порядок событий сохранён)', async () => {
    const { app, sessionManager, eventBus } = makeApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

    const order: string[] = [];
    eventBus.subscribe(session.id, (e) => { order.push(e.type); });

    const res = await patch(app, session.id, { title: 'New' });
    expect(res.status).toBe(200);

    expect(order).toContain('session.renamed');
    expect(order).toContain('session.updated');
    expect(order.indexOf('session.renamed')).toBeLessThan(order.indexOf('session.updated'));
  });

  it('POST /clear: несуществующая сессия → 404', async () => {
    const { app } = makeApp(tmpDir);
    const res = await app.request('/api/v2/sessions/missing/clear', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
