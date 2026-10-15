import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { createProjectRoutes } from './projects.js';
import { createHybridRoutes } from './hybrid.js';
import { SessionManager, EventBus, FileStore } from '../../index.js';
import { ProjectStore } from '../../storage/project-store.js';
import type { AuthKit } from '../../auth/local.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import { RemoteError } from '../../remote/types.js';

// Реестр профилей изолируем: если граф теста дотянется до getHybridState/async
// hybrid-status (../../index.js реэкспортирует app.ts), чтение дефолтного пути
// ~/.config/synth/profiles.json не должно влиять на тесты. Мок = «реестр пуст».
vi.mock('../../profiles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../profiles.js')>();
  return {
    ...actual,
    listProfiles: async () => [],
    getLastProfile: async () => null,
  };
});

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
  };
}

function createMockOrchestrator() {
  const processMessage = vi.fn().mockResolvedValue({});
  return {
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
    obfuscateUserMessageForHistory: vi.fn().mockImplementation((_sid: string, msg: unknown) => Promise.resolve(msg)),
  };
}

/** Fake RemoteBackendClient: все вызовы записываются, ответы настраиваются. */
function createFakeRemoteClient(overrides: Record<string, unknown> = {}) {
  const fake = {
    listProjects: vi.fn().mockResolvedValue([
      { id: 'rp-1', name: 'Удалённый проект' },
    ]),
    listSessions: vi.fn().mockResolvedValue([
      { id: 'rs-1', name: 'Удалённая сессия', project_id: 'rp-1', parent_id: null, references: [{ session_id: 'rs-0' }] },
    ]),
    getSession: vi.fn().mockResolvedValue({ id: 'rs-1', name: 'Удалённая сессия', project_id: 'rp-1' }),
    createSession: vi.fn().mockResolvedValue({ id: 'rs-new', name: 'Создана на бэке', project_id: 'rp-1' }),
    createProject: vi.fn().mockResolvedValue({ id: 'rp-new', name: 'Проект на бэке' }),
    updateSession: vi.fn().mockResolvedValue({ id: 'rs-1', name: 'Обновлено' }),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn().mockResolvedValue({ id: 'rp-1', name: 'Удалённый проект' }),
    updateProject: vi.fn().mockResolvedValue({ id: 'rp-1', name: 'Обновлено' }),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    promptSession: vi.fn().mockResolvedValue(
      new Response('data: {"type":"stream.done","data":{"content":"привет"}}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'X-Upstream': 'yes' },
      }),
    ),
    abortSession: vi.fn().mockResolvedValue({ status: 'aborted' }),
    summarizeSession: vi.fn().mockResolvedValue({ status: 'enqueued' }),
    getSessionMessages: vi.fn().mockResolvedValue({
      messages: [{ index: 0, content: 'hi' }],
      session_id: 'rs-1',
    }),
    messagesBatch: vi.fn().mockResolvedValue({ ok: true }),
    messageToggle: vi.fn().mockResolvedValue({ disabled: true, success: true }),
    messagePin: vi.fn().mockResolvedValue({ pinned: true, success: true }),
    messageDelete: vi.fn().mockResolvedValue({ success: true }),
    messageRetry: vi.fn().mockResolvedValue({ content: 'hi', success: true }),
    messageDebug: vi.fn().mockResolvedValue({ role: 'user' }),
    queueClear: vi.fn().mockResolvedValue({ cleared: true }),
    queueReturn: vi.fn().mockResolvedValue({ texts: [] }),
    queueResume: vi.fn().mockResolvedValue({ resumed: true }),
    queueRetryNow: vi.fn().mockResolvedValue({ retried: true }),
    queueCancelRetry: vi.fn().mockResolvedValue({ cancelled: true }),
    fsList: vi.fn().mockResolvedValue({ path: '/', entries: [] }),
    fsRead: vi.fn().mockResolvedValue({ path: 'f', content: 'x', encoding: 'utf-8' }),
    fsWrite: vi.fn().mockResolvedValue({ path: 'f', content: 'x' }),
    fsDelete: vi.fn().mockResolvedValue({ deleted: true }),
    fsMkdir: vi.fn().mockResolvedValue({ created: true }),
    fsMove: vi.fn().mockResolvedValue({ moved: true }),
    fsDownload: vi.fn().mockResolvedValue(new Response('bytes', { status: 200 })),
    fsUpload: vi.fn().mockResolvedValue({ path: 'f', name: 'f' }),
    ...overrides,
  };
  return fake as unknown as RemoteBackendClient & Record<string, ReturnType<typeof vi.fn>>;
}

interface TestWorld {
  app: Hono;
  remote: ReturnType<typeof createFakeRemoteClient>;
  sessionManager: SessionManager;
  projectStore: ProjectStore;
}

function createTestApp(remote?: RemoteBackendClient, tmpDir?: string): TestWorld {
  const app = new Hono();
  const fileStore = new FileStore({ dataDir: tmpDir! });
  const sessionManager = new SessionManager(fileStore);
  const projectStore = new ProjectStore({ dataDir: tmpDir! });
  const eventBus = new EventBus();
  const queueManager = createMockQueueManager();
  const orchestrator = createMockOrchestrator();

  app.route('/api/v2/sessions', createSessionRoutes(
    createMockAuth(),
    {
      sessionManager,
      eventBus,
      queueManager: queueManager as any,
      processMessage: orchestrator.createProcessMessage(),
      orchestrator: orchestrator as any,
      projectStore,
      getRemoteClient: () => remote ?? null,
    },
  ));
  app.route('/api/v2/projects', createProjectRoutes(createMockAuth(), projectStore, remote ? () => remote : undefined));

  const fakeRemote = remote as unknown as ReturnType<typeof createFakeRemoteClient> | undefined;
  return { app, remote: fakeRemote!, sessionManager, projectStore };
}

describe('Hybrid routes: агрегация миров (remoteClient)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-hybrid-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('GET /api/v2/sessions', () => {
    it('без remoteClient: только локальные с origin=local (поведение не изменилось)', async () => {
      const { app, sessionManager } = createTestApp(undefined, tmpDir);
      const s = await sessionManager.createSession({ title: 'Локальная', userId: 'local' });

      const res = await app.request('/api/v2/sessions');
      const body = (await res.json()) as any[];
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe(s.id);
      expect(body[0].origin).toBe('local');
      expect(body[0].name).toBe('Локальная');
    });

    it('возвращает объединение локальных и удалённых с origin и remote-ссылками', async () => {
      const { app, sessionManager, remote } = createTestApp(createFakeRemoteClient(), tmpDir);
      const s = await sessionManager.createSession({ title: 'Локальная', userId: 'local' });

      const res = await app.request('/api/v2/sessions');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any[];
      expect(body).toHaveLength(2);

      const local = body.find((x) => x.origin === 'local')!;
      expect(local.id).toBe(s.id);
      expect(local.name).toBe('Локальная');

      const remoteSes = body.find((x) => x.origin === 'remote')!;
      expect(remoteSes.id).toBe('remote:rs-1');
      expect(remoteSes.project_id).toBe('remote:rp-1');
      expect(remoteSes.parent_id).toBeNull();
      expect(remoteSes.references[0].session_id).toBe('remote:rs-0');

      expect(remote.listSessions).toHaveBeenCalled();
    });

    it('?project_id=remote:xxx — только удалённые, префикс снят для backend', async () => {
      const { app, sessionManager, remote } = createTestApp(createFakeRemoteClient(), tmpDir);
      await sessionManager.createSession({ title: 'Локальная', userId: 'local', projectId: 'prj-1' });

      const res = await app.request('/api/v2/sessions?project_id=remote:rp-1');
      const body = (await res.json()) as any[];
      expect(body).toHaveLength(1);
      expect(body[0].origin).toBe('remote');
      expect(body[0].id).toBe('remote:rs-1');
      expect(remote.listSessions).toHaveBeenCalledWith('rp-1');
    });

    it('?project_id=remote:xxx без remoteClient → 502 REMOTE_UNAVAILABLE', async () => {
      const { app } = createTestApp(undefined, tmpDir);
      const res = await app.request('/api/v2/sessions?project_id=remote:rp-1');
      expect(res.status).toBe(502);
      const body: any = await res.json();
      expect(body.error.code).toBe('REMOTE_UNAVAILABLE');
    });
  });

  describe('GET /api/v2/sessions/:id', () => {
    it('remote-ref → возвращает удалённую с origin и переписанными ссылками', async () => {
      const { app, remote } = createTestApp(createFakeRemoteClient(), tmpDir);
      const res = await app.request('/api/v2/sessions/remote:rs-1');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.origin).toBe('remote');
      expect(body.id).toBe('remote:rs-1');
      expect(body.project_id).toBe('remote:rp-1');
      expect(remote.getSession).toHaveBeenCalledWith('rs-1');
    });

    it('локальный id не трогает remoteClient', async () => {
      const { app, sessionManager, remote } = createTestApp(createFakeRemoteClient(), tmpDir);
      const s = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${s.id}`);
      expect(res.status).toBe(200);
      expect(remote.getSession).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v2/sessions', () => {
    it('body.origin=remote → создание на backend, ответ annotate remote', async () => {
      const { app, remote } = createTestApp(createFakeRemoteClient(), tmpDir);
      const res = await app.request('/api/v2/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: 'remote', name: 'Создана на бэке', project_id: 'remote:rp-1' }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.origin).toBe('remote');
      expect(body.id).toBe('remote:rs-new');
      expect(body.project_id).toBe('remote:rp-1');
      // Префикс project_id снят перед отправкой на backend
      expect(remote.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Создана на бэке', project_id: 'rp-1' }),
      );
      // origin не пробрасывается на backend
      const forwarded = (remote.createSession as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(forwarded).not.toHaveProperty('origin');
    });

    it('без origin — создание локально, remoteClient не вызывается', async () => {
      const { app, remote } = createTestApp(createFakeRemoteClient(), tmpDir);
      const res = await app.request('/api/v2/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Локальная' }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.origin).toBe('local');
      expect(remote.createSession).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v2/sessions/:id/prompt (проброс SSE)', () => {
    it('remote-ref → возвращает upstream Response как есть', async () => {
      const { app, remote } = createTestApp(createFakeRemoteClient(), tmpDir);
      const res = await app.request('/api/v2/sessions/remote:rs-1/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'привет' }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('x-upstream')).toBe('yes');
      const text = await res.text();
      expect(text).toContain('stream.done');
      expect(remote.promptSession).toHaveBeenCalledWith('rs-1', { content: 'привет' }, expect.anything());
    });

    it('локальный id — обычный локальный промпт (не remoteClient)', async () => {
      const { app, sessionManager, remote } = createTestApp(createFakeRemoteClient(), tmpDir);
      const s = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${s.id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'привет' }),
      });
      expect(res.status).toBe(200);
      expect(remote.promptSession).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v2/projects', () => {
    it('возвращает объединение проектов с origin', async () => {
      const { app, projectStore, remote } = createTestApp(createFakeRemoteClient(), tmpDir);
      const p = projectStore.create('Локальный', 'local');
      await projectStore.save(p);

      const res = await app.request('/api/v2/projects');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any[];
      expect(body).toHaveLength(2);
      expect(body.find((x) => x.origin === 'local')!.name).toBe('Локальный');
      const remoteP = body.find((x) => x.origin === 'remote')!;
      expect(remoteP.id).toBe('remote:rp-1');
      expect(remoteP.name).toBe('Удалённый проект');
      expect(remote.listProjects).toHaveBeenCalled();
    });

    it('без remoteClient — только локальные', async () => {
      const { app, projectStore } = createTestApp(undefined, tmpDir);
      const p = projectStore.create('Локальный', 'local');
      await projectStore.save(p);
      const res = await app.request('/api/v2/projects');
      const body = (await res.json()) as any[];
      expect(body).toHaveLength(1);
      expect(body[0].origin).toBe('local');
    });
  });

  describe('PATCH / DELETE удалённых сессий', () => {
    it('PATCH remote-ref → форвард на backend', async () => {
      const { app, remote } = createTestApp(createFakeRemoteClient(), tmpDir);
      const res = await app.request('/api/v2/sessions/remote:rs-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Обновлено' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.id).toBe('remote:rs-1');
      expect(body.origin).toBe('remote');
      expect(remote.updateSession).toHaveBeenCalledWith('rs-1', { name: 'Обновлено' });
    });

    it('DELETE remote-ref → 204, backend вызван', async () => {
      const { app, remote } = createTestApp(createFakeRemoteClient(), tmpDir);
      const res = await app.request('/api/v2/sessions/remote:rs-1', { method: 'DELETE' });
      expect(res.status).toBe(204);
      expect(remote.deleteSession).toHaveBeenCalledWith('rs-1');
    });
  });

  describe('GET /api/v2/sessions/:id/messages (удалённая)', () => {
    it('форвард и переписывание session_id в remote-ref', async () => {
      const { app, remote } = createTestApp(createFakeRemoteClient(), tmpDir);
      const res = await app.request('/api/v2/sessions/remote:rs-1/messages');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.session_id).toBe('remote:rs-1');
      expect(body.messages[0].content).toBe('hi');
      expect(remote.getSessionMessages).toHaveBeenCalledWith('rs-1');
    });
  });
});

describe('Remote-роуты: единый маппинг ошибок через remoteErrorToHttp (Часть 9)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-hybrid-err-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('RemoteError(OFFLINE) при GET remote-сессии → 502 { error: { code: OFFLINE } }', async () => {
    const remote = createFakeRemoteClient({
      getSession: vi.fn().mockRejectedValue(new RemoteError('Сервер недоступен: network down', 'OFFLINE')),
    });
    const { app } = createTestApp(remote, tmpDir);

    const res = await app.request('/api/v2/sessions/remote:rs-1');
    expect(res.status).toBe(502);
    const body: any = await res.json();
    expect(body.error.code).toBe('OFFLINE');
    expect(body.error.message).toContain('Сервер недоступен');
  });

  it('RemoteError(UNAUTHORIZED) при GET remote-проекта → 401 { error: { code: UNAUTHORIZED } }', async () => {
    const remote = createFakeRemoteClient({
      getProject: vi.fn().mockRejectedValue(new RemoteError('Не авторизован на удалённом сервере', 'UNAUTHORIZED')),
    });
    const { app } = createTestApp(remote, tmpDir);

    const res = await app.request('/api/v2/projects/remote:rp-1');
    expect(res.status).toBe(401);
    const body: any = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('RemoteError(OFFLINE) при POST remote-создании сессии → 502, не 500', async () => {
    const remote = createFakeRemoteClient({
      createSession: vi.fn().mockRejectedValue(new RemoteError('Сервер недоступен: timeout', 'OFFLINE')),
    });
    const { app } = createTestApp(remote, tmpDir);

    const res = await app.request('/api/v2/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: 'remote', name: 'X' }),
    });
    expect(res.status).toBe(502);
    const body: any = await res.json();
    expect(body.error.code).toBe('OFFLINE');
  });

  it('не-RemoteError (внутренняя ошибка) → 500 (Hono error handler), НЕ 502 OFFLINE', async () => {
    const remote = createFakeRemoteClient({
      getSession: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const { app } = createTestApp(remote, tmpDir);

    const res = await app.request('/api/v2/sessions/remote:rs-1');
    // Внутренняя ошибка не маппится в OFFLINE — Hono отдаёт generic 500.
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('OFFLINE');
  });
});

describe('GET /api/v2/hybrid/status (статус гибридного режима, runtime-состояние)', () => {
  it('гибрид не настроен — { enabled: false, connected: false, backendUrl: null, serverConfigured: false }', async () => {
    const app = createHybridRoutes(() => ({
      enabled: false,
      connected: false,
      backendUrl: null,
      user: null,
      serverConfigured: false,
      serverLoginAvailable: false,
      knownServers: [],
      lastServer: null,
    }));
    const res = await app.request('/api/v2/hybrid/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      connected: false,
      backendUrl: null,
      user: null,
      serverConfigured: false,
      serverLoginAvailable: false,
      knownServers: [],
      lastServer: null,
    });
  });

  it('подключено и авторизовано — enabled/connected/backendUrl/user', async () => {
    const getState = vi.fn(() => ({
      enabled: true,
      connected: true,
      backendUrl: 'https://backend.example',
      user: { id: 'u1', username: 'dev', roles: ['USER'] },
      serverConfigured: false,
      serverLoginAvailable: true,
      knownServers: [],
      lastServer: null,
    }));
    const app = createHybridRoutes(getState);

    const res = await app.request('/api/v2/hybrid/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      connected: true,
      backendUrl: 'https://backend.example',
      user: { id: 'u1', username: 'dev', roles: ['USER'] },
      serverConfigured: false,
      serverLoginAvailable: true,
      knownServers: [],
      lastServer: null,
    });
    expect(getState).toHaveBeenCalled();
  });

  it('подключено, но user неизвестен — connected:true, user:null', async () => {
    const getState = () => ({
      enabled: true,
      connected: true,
      backendUrl: 'https://backend.example',
      user: null,
      serverConfigured: false,
      serverLoginAvailable: true,
      knownServers: [],
      lastServer: null,
    });
    const app = createHybridRoutes(getState);

    const res = await app.request('/api/v2/hybrid/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      connected: true,
      backendUrl: 'https://backend.example',
      user: null,
      serverConfigured: false,
      serverLoginAvailable: true,
      knownServers: [],
      lastServer: null,
    });
  });

  it('сервер известен (defaultBackendUrl), но не подключено — serverConfigured:true', async () => {
    const getState = () => ({
      enabled: true,
      connected: false,
      backendUrl: null,
      user: null,
      serverConfigured: true,
      serverLoginAvailable: true,
      knownServers: [],
      lastServer: null,
    });
    const app = createHybridRoutes(getState);

    const res = await app.request('/api/v2/hybrid/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      connected: false,
      backendUrl: null,
      user: null,
      serverConfigured: true,
      serverLoginAvailable: true,
      knownServers: [],
      lastServer: null,
    });
  });

  it('состояние читается на каждый запрос (getState вызывается повторно)', async () => {
    let connected = false;
    const getState = vi.fn(() => ({
      enabled: true,
      connected,
      backendUrl: connected ? 'https://backend.example' : null,
      user: connected ? { id: 'u1', username: 'dev', roles: ['USER'] } : null,
      serverConfigured: false,
      serverLoginAvailable: connected,
      knownServers: [],
      lastServer: null,
    }));
    const app = createHybridRoutes(getState);

    const first = await app.request('/api/v2/hybrid/status');
    expect(((await first.json()) as { connected: boolean }).connected).toBe(false);

    // Runtime-подключение произошло между запросами — статус изменился.
    connected = true;
    const second = await app.request('/api/v2/hybrid/status');
    const body = (await second.json()) as { connected: boolean; user: { username: string } | null };
    expect(body.connected).toBe(true);
    expect(body.user?.username).toBe('dev');
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it('асинхронное состояние (Promise) поддерживается; knownServers/lastServer проходят как есть', async () => {
    const getState = vi.fn(async () => ({
      enabled: true,
      connected: false,
      backendUrl: null,
      user: null,
      serverConfigured: false,
      serverLoginAvailable: true,
      knownServers: ['https://synth.k3s.itphx.loc', 'https://beta.example.loc'],
      lastServer: 'https://synth.k3s.itphx.loc',
    }));
    const app = createHybridRoutes(getState);

    const res = await app.request('/api/v2/hybrid/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      connected: false,
      backendUrl: null,
      user: null,
      serverConfigured: false,
      serverLoginAvailable: true,
      knownServers: ['https://synth.k3s.itphx.loc', 'https://beta.example.loc'],
      lastServer: 'https://synth.k3s.itphx.loc',
    });
    expect(getState).toHaveBeenCalled();
  });
});
