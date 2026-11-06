/**
 * Правая панель сессии: оптимизация контекста (ADR-119), MCP-скоуп (ADR-071
 * §2.4) и карта обфускации (ADR-036) — **общая core-реализация**.
 *
 * Раньше эти маршруты были только в backend, поэтому standalone/локальный core
 * в гибриде отвечал на них 404: вкладка «Контекст» рисовала дефолты, а тумблер
 * «Компактизация» откатывался с тостом «Не удалось сохранить настройки».
 *
 * Проверяем:
 * - GET/PATCH `/optimization` (200, значения записались в `session.settings`,
 *   ответ PATCH — DTO сессии, публикуется `session.updated`);
 * - `/optimization/check` (с оптимизатором и фоллбек без него);
 * - `/optimization/cancel-summarization` (снимает `summarizationPending`);
 * - `GET/PUT /:id/mcp` (точечный toggle, полная замена, неизвестное имя → 400);
 * - `GET /:id/secrets` (владелец видит карту, читатель без права → 403);
 * - remote-ветки: для `remote:<id>` вызывается соответствующий метод
 *   `RemoteBackendClient`, локальный `sessionManager` не трогается.
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
import type { BusEvent } from '@itphx/synth-shared';
import type { RemoteBackendClient } from '../../remote/client.js';
import { RemoteError } from '../../remote/types.js';

/** Известные MCP-серверы инстанса (мок `orchestrator.resolveMcpServers`). */
const KNOWN_MCP_SERVERS = ['alpha', 'beta'];

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

/** Оркестратор-мок: MCP-скоуп выводится из настроек сессии (как настоящий). */
function createMockOrchestrator() {
  const processMessage = vi.fn().mockResolvedValue({});
  return {
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
    getPromptInfo: vi.fn().mockResolvedValue({}),
    getModelPricing: vi.fn().mockReturnValue(null),
    resolveMcpServers: vi.fn(async (session: { settings: { mcpDisabledServers?: string[] } }) =>
      KNOWN_MCP_SERVERS.map((name) => ({
        name,
        level: 'system',
        enabled: !(session.settings.mcpDisabledServers ?? []).includes(name),
        origin: 'local',
        trust: 'trusted',
      }))),
  };
}

/** Мок оптимизатора контекста (движок читает `session.settings`). */
function createMockOptimizer() {
  return {
    canSummarize: vi.fn().mockReturnValue(true),
    shouldApplySlidingWindow: vi.fn().mockReturnValue({ triggered: false }),
    shouldSummarize: vi.fn().mockReturnValue({ triggered: true, reason: 'messages', userCount: 12, limit: 10 }),
    shouldCompress: vi.fn().mockReturnValue({ triggered: true, reason: 'tokens', mode: 'compaction', currentTokens: 9000, threshold: 8000 }),
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

/** Имя пользователя запроса: `Bearer owner` / `Bearer reader` / `Bearer other`. */
function userOf(c: Context): string {
  const raw = (c.req.header('authorization') ?? '').replace(/^Bearer /, '').trim();
  return raw || 'owner';
}

/** Фейковый удалённый клиент: набор шпионов по методам панели. */
type FakeRemote = Record<
  | 'getSessionOptimization' | 'updateSessionOptimization'
  | 'checkSessionOptimization' | 'cancelSessionSummarization'
  | 'getSessionMcp' | 'updateSessionMcp' | 'getSessionSecrets',
  ReturnType<typeof vi.fn>
>;

function createFakeRemote(): FakeRemote {
  return {
    getSessionOptimization: vi.fn(),
    updateSessionOptimization: vi.fn(),
    checkSessionOptimization: vi.fn(),
    cancelSessionSummarization: vi.fn(),
    getSessionMcp: vi.fn(),
    updateSessionMcp: vi.fn(),
    getSessionSecrets: vi.fn(),
  };
}

function asClient(remote: FakeRemote | null): RemoteBackendClient | null {
  return remote as unknown as RemoteBackendClient | null;
}

const AUTH = { authorization: 'Bearer owner' };

describe('панель сессии: core-маршруты (оптимизация, MCP, секреты)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let orchestrator: ReturnType<typeof createMockOrchestrator>;
  let optimizer: ReturnType<typeof createMockOptimizer>;
  let events: Array<{ type: string; data: unknown }>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-panel-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    orchestrator = createMockOrchestrator();
    optimizer = createMockOptimizer();
    events = [];
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /**
   * Приложение сессий.
   *
   * @param opts.remote — фейковый клиент удалённого мира (геттер всегда передан).
   * @param opts.optimizer — подключать `contextOptimizer` (иначе — фоллбек `/check`).
   * @param opts.canAccessAll — правило доступа «любой аутентифицированный»
   *   (нужно, чтобы отличать отказ guard'а от отказа права раскрытия карты).
   */
  function makeApp(opts: {
    remote?: FakeRemote | null;
    optimizer?: boolean;
    canAccessAll?: boolean;
  } = {}): Hono {
    const app = new Hono();
    app.route('/api/v2/sessions', createSessionRoutes(
      createAuth(),
      {
        sessionManager,
        eventBus,
        queueManager: createMockQueueManager() as never,
        processMessage: (async () => undefined) as never,
        orchestrator: orchestrator as never,
        ...(opts.optimizer ? { contextOptimizer: optimizer as never } : {}),
        getRemoteClient: () => asClient(opts.remote ?? null),
      },
      {
        resolveUserId: userOf,
        // Базовое правило как у менеджера настоящего приложения: владелец сессии.
        // `canAccessAll` — «доступ есть у всех» (проверяем именно право карты).
        canAccess: opts.canAccessAll
          ? () => true
          : (session, _c, userId) => (session.ownerId ?? session.userId) === userId,
      },
    ));
    return app;
  }

  /** Локальная сессия владельца `owner` + подписка на её события. */
  async function seed(): Promise<string> {
    const session = await sessionManager.createSession({ title: 'S', userId: 'owner', ownerId: 'owner' });
    eventBus.subscribe(session.id, (event: BusEvent) => {
      events.push({ type: event.type, data: event.data });
    });
    return session.id;
  }

  function optimization(app: Hono, sessionId: string, body: unknown): Promise<Response> {
    return Promise.resolve(app.request(`/api/v2/sessions/${sessionId}/optimization`, {
      method: 'PATCH',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  // ─────────────── Оптимизация контекста ───────────────

  describe('GET /:id/optimization', () => {
    it('отдаёт все поля вкладки «Контекст» из настроек сессии', async () => {
      const sessionId = await seed();
      const stored = (await sessionManager.getSession(sessionId))!;

      const res = await makeApp().request(`/api/v2/sessions/${sessionId}/optimization`, { headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;

      expect(Object.keys(body).sort()).toEqual([
        'compaction_keep_tokens',
        'compaction_token_threshold',
        'context_optimization',
        'sliding_window_message_limit',
        'sliding_window_mode',
        'sliding_window_token_threshold',
        'summarization_enabled',
        'summarization_head_messages',
        'summarization_keep_tokens',
        'summarization_tail_messages',
        'summarization_trigger_mode',
        'summarize_after_n',
        'summarize_token_threshold',
      ]);
      expect(body.context_optimization).toBe(stored.settings.contextOptimization);
      expect(body.summarization_enabled).toBe(stored.settings.summarizationEnabled);
      expect(body.compaction_keep_tokens).toBe(stored.settings.compactionKeepTokens);
      expect(body.compaction_token_threshold).toBe(stored.settings.compactionTokenThreshold);
    });

    it('неизвестная сессия → 404', async () => {
      const res = await makeApp().request('/api/v2/sessions/unknown/optimization', { headers: AUTH });
      expect(res.status).toBe(404);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    });

    it('чужая сессия → 403 (доступ решает prefix-guard)', async () => {
      const sessionId = await seed();
      const res = await makeApp().request(`/api/v2/sessions/${sessionId}/optimization`, {
        headers: { authorization: 'Bearer other' },
      });
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /:id/optimization', () => {
    it('записывает значения в session.settings и публикует session.updated', async () => {
      const sessionId = await seed();

      const res = await optimization(makeApp(), sessionId, {
        context_optimization: 'compaction',
        summarization_enabled: true,
        compaction_keep_tokens: 15000,
        compaction_token_threshold: 85,
        sliding_window_mode: 'tokens',
        sliding_window_token_threshold: 70,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { settings: Record<string, unknown> };
      expect(body.settings.contextOptimization).toBe('compaction');
      expect(body.settings.compactionKeepTokens).toBe(15000);

      const stored = (await sessionManager.getSession(sessionId))!;
      expect(stored.settings.contextOptimization).toBe('compaction');
      expect(stored.settings.summarizationEnabled).toBe(true);
      expect(stored.settings.compactionKeepTokens).toBe(15000);
      expect(stored.settings.compactionTokenThreshold).toBe(85);
      expect(stored.settings.slidingWindowMode).toBe('tokens');
      expect(stored.settings.slidingWindowTokenThreshold).toBe(70);
      // История в DTO ответа не нужна (сводка).
      expect(body).not.toHaveProperty('messages');

      expect(events.map((e) => e.type)).toContain('session.updated');
    });

    it('частичный патч не сбрасывает остальные поля', async () => {
      const sessionId = await seed();
      const app = makeApp();
      await optimization(app, sessionId, { context_optimization: 'summarization', summarize_after_n: 7 });

      const res = await optimization(app, sessionId, { compaction_keep_tokens: 1000 });
      expect(res.status).toBe(200);

      const stored = (await sessionManager.getSession(sessionId))!;
      expect(stored.settings.contextOptimization).toBe('summarization');
      expect(stored.settings.summarizeAfterN).toBe(7);
      expect(stored.settings.compactionKeepTokens).toBe(1000);
    });

    it('чужая сессия → 403, настройки не меняются', async () => {
      const sessionId = await seed();
      const before = (await sessionManager.getSession(sessionId))!.settings.contextOptimization;

      const res = await makeApp().request(`/api/v2/sessions/${sessionId}/optimization`, {
        method: 'PATCH',
        headers: { authorization: 'Bearer other', 'Content-Type': 'application/json' },
        body: JSON.stringify({ context_optimization: 'none' }),
      });
      expect(res.status).toBe(403);
      expect((await sessionManager.getSession(sessionId))!.settings.contextOptimization).toBe(before);
    });
  });

  describe('POST /:id/optimization/check', () => {
    it('с оптимизатором отдаёт триггеры и summarization_pending', async () => {
      const sessionId = await seed();
      await sessionManager.withLock(sessionId, async (s) => {
        s.summarizationPending = true;
        await sessionManager.saveSession(s);
      });

      const res = await makeApp({ optimizer: true })
        .request(`/api/v2/sessions/${sessionId}/optimization/check`, { method: 'POST', headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sliding_window: { triggered: boolean };
        summarization: { triggered: boolean };
        compression: { triggered: boolean; mode: string | null };
        summarization_pending: boolean;
      };
      expect(body.sliding_window.triggered).toBe(false);
      expect(body.summarization.triggered).toBe(true);
      expect(body.compression).toMatchObject({ triggered: true, mode: 'compaction' });
      expect(body.summarization_pending).toBe(true);
      expect(optimizer.shouldCompress).toHaveBeenCalledTimes(1);
    });

    it('без оптимизатора — прежний фоллбек backend', async () => {
      const sessionId = await seed();
      const res = await makeApp()
        .request(`/api/v2/sessions/${sessionId}/optimization/check`, { method: 'POST', headers: AUTH });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        sliding_window: { triggered: false },
        summarization: { triggered: false },
        compression: { triggered: false, reason: 'none', mode: null },
      });
    });
  });

  describe('POST /:id/optimization/cancel-summarization', () => {
    it('снимает summarizationPending и пересчитывает canSummarize', async () => {
      const sessionId = await seed();
      await sessionManager.withLock(sessionId, async (s) => {
        s.summarizationPending = true;
        await sessionManager.saveSession(s);
      });

      const res = await makeApp({ optimizer: true })
        .request(`/api/v2/sessions/${sessionId}/optimization/cancel-summarization`, { method: 'POST', headers: AUTH });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      expect((await sessionManager.getSession(sessionId))!.summarizationPending).toBe(false);
      const updated = events.find((e) => e.type === 'session.updated');
      expect(updated?.data).toMatchObject({ session_id: sessionId, summarization_pending: false, can_summarize: true });
    });
  });

  // ─────────────── MCP-скоуп сессии ───────────────

  describe('GET/PUT /:id/mcp', () => {
    it('GET отдаёт эффективный скоуп и списки настроек', async () => {
      const sessionId = await seed();
      const res = await makeApp().request(`/api/v2/sessions/${sessionId}/mcp`, { headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        servers: Array<{ name: string; enabled: boolean }>;
        enabled: string[];
        disabled: string[];
        mcpServers: string[];
        mcpDisabledServers: string[];
      };
      expect(body.servers.map((s) => s.name)).toEqual(KNOWN_MCP_SERVERS);
      expect(body.enabled).toEqual(KNOWN_MCP_SERVERS);
      expect(body.disabled).toEqual([]);
      expect(body.mcpServers).toEqual([]);
      expect(body.mcpDisabledServers).toEqual([]);
    });

    it('PUT точечный toggle выключает и снова включает сервер', async () => {
      const sessionId = await seed();
      const app = makeApp();

      const off = await app.request(`/api/v2/sessions/${sessionId}/mcp`, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'beta', enabled: false }),
      });
      expect(off.status).toBe(200);
      const offBody = (await off.json()) as { enabled: string[]; disabled: string[] };
      expect(offBody.enabled).toEqual(['alpha']);
      expect(offBody.disabled).toEqual(['beta']);
      const storedOff = (await sessionManager.getSession(sessionId))!;
      expect(storedOff.settings.mcpServers).toEqual([]);
      expect(storedOff.settings.mcpDisabledServers).toEqual(['beta']);

      const on = await app.request(`/api/v2/sessions/${sessionId}/mcp`, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'beta', enabled: true }),
      });
      expect(on.status).toBe(200);
      const onBody = (await on.json()) as { enabled: string[]; disabled: string[] };
      expect(onBody.enabled).toEqual(['alpha', 'beta']);
      expect(onBody.disabled).toEqual([]);
      expect((await sessionManager.getSession(sessionId))!.settings.mcpDisabledServers).toEqual([]);
      expect(events.map((e) => e.type)).toContain('session.updated');
    });

    it('PUT полная замена списков', async () => {
      const sessionId = await seed();
      const res = await makeApp().request(`/api/v2/sessions/${sessionId}/mcp`, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpServers: ['alpha'], mcpDisabledServers: ['beta'] }),
      });
      expect(res.status).toBe(200);
      const stored = (await sessionManager.getSession(sessionId))!;
      expect(stored.settings.mcpServers).toEqual(['alpha']);
      expect(stored.settings.mcpDisabledServers).toEqual(['beta']);
    });

    it('PUT неизвестное имя сервера → 400 VALIDATION_ERROR', async () => {
      const sessionId = await seed();
      const res = await makeApp().request(`/api/v2/sessions/${sessionId}/mcp`, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ghost', enabled: true }),
      });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    });

    it('PUT пустое тело → 400 (валидация схемы)', async () => {
      const sessionId = await seed();
      const res = await makeApp().request(`/api/v2/sessions/${sessionId}/mcp`, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  // ─────────────── Карта обфускации ───────────────

  describe('GET /:id/secrets', () => {
    it('владелец видит карту обфускации', async () => {
      const sessionId = await seed();
      await sessionManager.withLock(sessionId, async (s) => {
        s.obfuscationMap = { '⟦SYNTH_SECRET_1⟧': 'sk-real' };
        await sessionManager.saveSession(s);
      });

      // `canAccess: () => true` — доступ к сессии есть у всех, проверяем ИМЕННО
      // право раскрытия карты (владелец сессии).
      const res = await makeApp({ canAccessAll: true })
        .request(`/api/v2/sessions/${sessionId}/secrets`, { headers: AUTH });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        sessionId,
        secrets: { '⟦SYNTH_SECRET_1⟧': 'sk-real' },
      });
    });

    it('читатель без права раскрытия → 403 FORBIDDEN', async () => {
      const sessionId = await seed();
      const res = await makeApp({ canAccessAll: true }).request(`/api/v2/sessions/${sessionId}/secrets`, {
        headers: { authorization: 'Bearer reader' },
      });
      expect(res.status).toBe(403);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    });

    it('неизвестная сессия → 404', async () => {
      const res = await makeApp({ canAccessAll: true })
        .request('/api/v2/sessions/unknown/secrets', { headers: AUTH });
      expect(res.status).toBe(404);
    });
  });

  // ─────────────── Гибрид: remote-ветки ───────────────

  describe('гибрид: remote:<id> форвардится на удалённый backend', () => {
    it('GET/PATCH/check/cancel оптимизации вызывают клиент (локальный стор не трогается)', async () => {
      const remote = createFakeRemote();
      remote.getSessionOptimization.mockResolvedValue({ context_optimization: 'none' });
      remote.updateSessionOptimization.mockResolvedValue({
        id: 's1',
        project_id: 'p1',
        settings: { contextOptimization: 'compaction' },
      });
      remote.checkSessionOptimization.mockResolvedValue({ sliding_window: { triggered: false } });
      remote.cancelSessionSummarization.mockResolvedValue({ success: true });

      const app = makeApp({ remote });
      const getSessionSpy = vi.spyOn(sessionManager, 'getSession');

      const get = await app.request('/api/v2/sessions/remote:s1/optimization', { headers: AUTH });
      expect(get.status).toBe(200);
      expect(remote.getSessionOptimization).toHaveBeenCalledWith('s1');

      const patch = await optimization(app, 'remote:s1', { context_optimization: 'compaction' });
      expect(patch.status).toBe(200);
      expect(remote.updateSessionOptimization).toHaveBeenCalledWith('s1', { context_optimization: 'compaction' });
      const patchBody = (await patch.json()) as { id?: string; project_id?: string };
      expect(patchBody.id).toBe('remote:s1');
      expect(patchBody.project_id).toBe('remote:p1');

      const check = await app.request('/api/v2/sessions/remote:s1/optimization/check', {
        method: 'POST',
        headers: AUTH,
      });
      expect(check.status).toBe(200);
      expect(remote.checkSessionOptimization).toHaveBeenCalledWith('s1');

      const cancel = await app.request('/api/v2/sessions/remote:s1/optimization/cancel-summarization', {
        method: 'POST',
        headers: AUTH,
      });
      expect(cancel.status).toBe(200);
      expect(remote.cancelSessionSummarization).toHaveBeenCalledWith('s1');

      expect(getSessionSpy).not.toHaveBeenCalled();
    });

    it('GET/PUT mcp и GET secrets вызывают клиент', async () => {
      const remote = createFakeRemote();
      remote.getSessionMcp.mockResolvedValue({ servers: [], enabled: [], disabled: [], mcpServers: [], mcpDisabledServers: [] });
      remote.updateSessionMcp.mockResolvedValue({ servers: [], enabled: ['alpha'], disabled: [], mcpServers: ['alpha'], mcpDisabledServers: [] });
      remote.getSessionSecrets.mockResolvedValue({ sessionId: 's1', secrets: { '⟦S⟧': 'sk' } });

      const app = makeApp({ remote });

      const mcp = await app.request('/api/v2/sessions/remote:s1/mcp', { headers: AUTH });
      expect(mcp.status).toBe(200);
      expect(remote.getSessionMcp).toHaveBeenCalledWith('s1');

      const put = await app.request('/api/v2/sessions/remote:s1/mcp', {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'alpha', enabled: true }),
      });
      expect(put.status).toBe(200);
      expect(remote.updateSessionMcp).toHaveBeenCalledWith('s1', { name: 'alpha', enabled: true });

      const secrets = await app.request('/api/v2/sessions/remote:s1/secrets', { headers: AUTH });
      expect(secrets.status).toBe(200);
      expect(remote.getSessionSecrets).toHaveBeenCalledWith('s1');
      expect(await secrets.json()).toEqual({ sessionId: 'remote:s1', secrets: { '⟦S⟧': 'sk' } });
    });

    it('ошибка удалённой стороны маппится в HTTP (404)', async () => {
      const remote = createFakeRemote();
      remote.getSessionOptimization.mockRejectedValue(new RemoteError('не найдено', 'HTTP_404'));
      const res = await makeApp({ remote }).request('/api/v2/sessions/remote:s1/optimization', { headers: AUTH });
      expect(res.status).toBe(404);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('HTTP_404');
    });

    it('remote без клиента → 502 REMOTE_UNAVAILABLE', async () => {
      const res = await makeApp({ remote: null }).request('/api/v2/sessions/remote:s1/optimization', { headers: AUTH });
      expect(res.status).toBe(502);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('REMOTE_UNAVAILABLE');
    });
  });
});
