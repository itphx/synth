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
    // MCP-скоуп сессии (PUT /:id/mcp) — список известных серверов инстанса.
    resolveMcpServers: vi.fn(async () => [{ name: 'files', enabled: true }]),
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

  return { app, sessionManager, eventBus, fileStore, queueManager };
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

/**
 * Этап 2b-2a: META-правки HTTP-роутов — через порт `mutateMeta`.
 *
 * Каждый тест проверяет две вещи одновременно:
 *  1. **свидетель** в истории (`addMessage`) не теряется: полная запись снимка
 *     (`saveSession`) затирала бы сообщение, добавленное параллельно;
 *  2. **паритет `updatedAt`**: `updateSession` двигал время, `saveSession` — нет.
 */
describe('META-правки сессии — mutateMeta (свидетель в истории и паритет updatedAt)', () => {
  let tmpDir: string;
  /** Заведомо старая метка: любое движение `updatedAt` видно однозначно. */
  const OLD_STAMP = '2020-01-01T00:00:00.000Z';

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-meta-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeMessage(text: string) {
    return {
      id: generateId(), role: MessageRole.USER, seq: 0, origin: 'local' as const,
      parts: [makeTextPart(text)], content: text, createdAt: nowISO(),
      disabled: false, pinned: false, hidden: false,
    };
  }

  /** Зафиксировать «старое» `updatedAt` прямо в хранилище. */
  async function stamp(
    world: ReturnType<typeof makeApp>,
    sessionId: string,
    value = OLD_STAMP,
  ): Promise<void> {
    const current = await world.sessionManager.getSession(sessionId);
    await world.fileStore.save({ ...current!, updatedAt: value });
  }

  const contents = (session: { messages: Array<{ content: string }> } | null) =>
    (session?.messages ?? []).map((m) => m.content);

  it('PATCH: несколько полей + settings не теряют параллельную дозапись, updatedAt двигается', async () => {
    const world = makeApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    await stamp(world, session.id);

    const [res] = await Promise.all([
      patch(world.app, session.id, {
        name: 'Новое имя',
        title: 'Новое имя',
        icon: 'folder',
        color: 'a1',
        mode: 'plan',
        settings: { provider: 'p1', model: 'm1' },
      }),
      world.sessionManager.addMessage(session.id, makeMessage('свидетель')),
    ]);
    expect(res.status).toBe(200);

    const stored = await world.sessionManager.getSession(session.id);
    expect(stored?.title).toBe('Новое имя');
    expect(stored?.icon).toBe('folder');
    expect(stored?.color).toBe('a1');
    expect(stored?.mode).toBe('plan');
    // `settings` — те же семантика (merge поверх текущих), что и раньше.
    expect(stored?.settings.provider).toBe('p1');
    expect(stored?.settings.model).toBe('m1');
    // Свидетель цел (прежний `saveSession` затирал историю снимком).
    expect(contents(stored)).toContain('свидетель');
    // Паритет: `updateSession` двигал `updatedAt`.
    expect(stored?.updatedAt).not.toBe(OLD_STAMP);
  });

  it('PATCH /:id/optimization: настройки сохранены, свидетель цел, updatedAt НЕ двигается', async () => {
    const world = makeApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    // Свидетель — до запроса: полная запись снимка не должна его потерять.
    // (`updatedAt` фиксируем после, чтобы паритет проверялся однозначно.)
    await world.sessionManager.addMessage(session.id, makeMessage('свидетель'));
    await stamp(world, session.id);

    const res = await world.app.request(`/api/v2/sessions/${session.id}/optimization`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summarization_enabled: true, compaction_keep_tokens: 4096 }),
    });
    expect(res.status).toBe(200);

    const stored = await world.sessionManager.getSession(session.id);
    expect(stored?.settings.summarizationEnabled).toBe(true);
    expect(stored?.settings.compactionKeepTokens).toBe(4096);
    expect(contents(stored)).toContain('свидетель');
    // Паритет: прежний `saveSession` `updatedAt` не менял.
    expect(stored?.updatedAt).toBe(OLD_STAMP);
  });

  it('POST /:id/optimization/cancel-summarization: флаг снят, свидетель цел, updatedAt НЕ двигается', async () => {
    const world = makeApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    await world.sessionManager.mutateMeta(session.id, (meta) => {
      meta.summarizationPending = true;
    }, { touchUpdatedAt: false });
    // Свидетель — до запроса (полная запись снимка не должна его потерять).
    await world.sessionManager.addMessage(session.id, makeMessage('свидетель'));
    await stamp(world, session.id);

    const res = await world.app.request(`/api/v2/sessions/${session.id}/optimization/cancel-summarization`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const stored = await world.sessionManager.getSession(session.id);
    expect(stored?.summarizationPending).toBe(false);
    expect(contents(stored)).toContain('свидетель');
    expect(stored?.updatedAt).toBe(OLD_STAMP);
  });

  it('PUT /:id/mcp: скоуп сохранён, свидетель цел, updatedAt двигается', async () => {
    const world = makeApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    await stamp(world, session.id);

    const [res] = await Promise.all([
      world.app.request(`/api/v2/sessions/${session.id}/mcp`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'files', enabled: true }),
      }),
      world.sessionManager.addMessage(session.id, makeMessage('свидетель')),
    ]);
    expect(res.status).toBe(200);
    const body = await res.json() as { mcpServers: string[] };
    expect(body.mcpServers).toEqual(['files']);

    const stored = await world.sessionManager.getSession(session.id);
    expect(stored?.settings.mcpServers).toEqual(['files']);
    expect(contents(stored)).toContain('свидетель');
    // Паритет: `updateSession` двигал `updatedAt`.
    expect(stored?.updatedAt).not.toBe(OLD_STAMP);
  });

  it('PUT /:id/mcp: неизвестный сервер → 400, состояние не меняется', async () => {
    const world = makeApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    await stamp(world, session.id);

    const res = await world.app.request(`/api/v2/sessions/${session.id}/mcp`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'unknown', enabled: true }),
    });
    expect(res.status).toBe(400);

    const stored = await world.sessionManager.getSession(session.id);
    expect(stored?.settings.mcpServers).toBeUndefined();
    expect(stored?.updatedAt).toBe(OLD_STAMP);
  });

  it('POST /:id/abort: флаги/очередь сохранены, свидетель и очередь целы, updatedAt НЕ двигается', async () => {
    const world = makeApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    await world.sessionManager.addMessage(session.id, makeMessage('свидетель'));
    await world.sessionManager.addPendingMessage(session.id, makeMessage('в очереди'));
    await stamp(world, session.id);

    const res = await world.app.request(`/api/v2/sessions/${session.id}/abort`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'aborted' });

    const stored = await world.sessionManager.getSession(session.id);
    // Процессора нет (`requestStop` → false) — флаг снят, «Стоп» отмечен.
    expect(stored?.status.cancelRequested).toBeUndefined();
    expect(stored?.status.queueStopped).toBe(true);
    expect(contents(stored)).toContain('свидетель');
    expect((stored?.pendingMessages ?? []).map((m) => m.content)).toContain('в очереди');
    expect(stored?.updatedAt).toBe(OLD_STAMP);
  });

  it('PUT /skills: параллельное включение не теряется, updatedAt двигается', async () => {
    const world = makeApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    await stamp(world, session.id);

    const [r1] = await Promise.all([
      putSkill(world.app, session.id, { name: 'gamma', enabled: true }),
      world.sessionManager.addMessage(session.id, makeMessage('свидетель')),
    ]);
    expect(r1.status).toBe(200);

    const stored = await world.sessionManager.getSession(session.id);
    expect(stored?.settings.skills).toEqual(['gamma']);
    expect(contents(stored)).toContain('свидетель');
    // Паритет: `updateSession` двигал `updatedAt`.
    expect(stored?.updatedAt).not.toBe(OLD_STAMP);
  });
});
