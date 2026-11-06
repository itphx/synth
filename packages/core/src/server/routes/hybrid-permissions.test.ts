// Гибрид: ответ на подтверждение прав (`permission_reply`/HTTP
// `permissions/:approvalId`) для удалённой сессии должен уходить на удалённый
// backend — там живёт ожидающий ask (`remote:<id>`). Иначе грант не выдаётся и
// `session.updated` не возвращается в UI.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, EventBus, FileStore } from '../../index.js';
import { ProjectStore } from '../../storage/project-store.js';
import type { AuthKit } from '../../auth/local.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import { RemoteError } from '../../remote/types.js';

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

/** Fake RemoteBackendClient: интересующий метод + настраиваемые ответы. */
function createFakeRemoteClient(result: unknown = { status: 200, body: { status: 'ok', action: 'allow' } }) {
  const fake = {
    permissionReply: vi.fn().mockResolvedValue(result),
  };
  return fake as unknown as RemoteBackendClient & Record<string, ReturnType<typeof vi.fn>>;
}

interface TestWorld {
  app: Hono;
  remote: ReturnType<typeof createFakeRemoteClient>;
  sessionManager: SessionManager;
  eventBus: EventBus;
}

function createTestApp(
  tmpDir: string,
  remote: RemoteBackendClient | null,
  opts: { withRemoteGetter?: boolean } = {},
): TestWorld {
  const app = new Hono();
  const fileStore = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(fileStore);
  const projectStore = new ProjectStore({ dataDir: tmpDir });
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
      ...(opts.withRemoteGetter === false ? {} : { getRemoteClient: () => remote }),
    },
  ));

  return { app, remote: remote as never, sessionManager, eventBus };
}

describe('Гибрид: ответ на подтверждение прав удалённой сессии', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-hybrid-perm-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('allow/once на remote-сессию → пересылка на backend (префикс снят), 200', async () => {
    const remote = createFakeRemoteClient();
    const { app } = createTestApp(tmpDir, remote);

    const res = await app.request('/api/v2/sessions/remote:rs-1/permissions/ap-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'allow', once: false }),
    });

    expect(res.status).toBe(200);
    expect(remote.permissionReply).toHaveBeenCalledWith('rs-1', 'ap-1', { action: 'allow', once: false });
    expect(await res.json()).toEqual({ status: 'ok', action: 'allow' });
  });

  it('hold на remote-сессию → пересылает {action:"hold"}', async () => {
    const remote = createFakeRemoteClient({ status: 200, body: { status: 'ok', action: 'hold' } });
    const { app } = createTestApp(tmpDir, remote);

    const res = await app.request('/api/v2/sessions/remote:rs-1/permissions/ap-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'hold' }),
    });

    expect(res.status).toBe(200);
    expect(remote.permissionReply).toHaveBeenCalledWith('rs-1', 'ap-1', { action: 'hold' });
  });

  it('turn_id/digest пробрасываются на backend', async () => {
    const remote = createFakeRemoteClient();
    const { app } = createTestApp(tmpDir, remote);

    await app.request('/api/v2/sessions/remote:rs-1/permissions/ap-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'deny', turn_id: 'turn-1', digest: 'd-1' }),
    });

    expect(remote.permissionReply).toHaveBeenCalledWith('rs-1', 'ap-1', {
      action: 'deny',
      turn_id: 'turn-1',
      digest: 'd-1',
    });
  });

  it('403 удалённой стороны → проброшен клиенту как есть', async () => {
    const remote = createFakeRemoteClient({
      status: 403,
      body: { error: { code: 'APPROVAL_DENIED', message: 'нет гранта' } },
    });
    const { app } = createTestApp(tmpDir, remote);

    const res = await app.request('/api/v2/sessions/remote:rs-1/permissions/ap-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'allow' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'APPROVAL_DENIED', message: 'нет гранта' } });
  });

  it('RemoteError(OFFLINE) → 502 через remoteErrorToHttp', async () => {
    const remote = createFakeRemoteClient();
    const { app } = createTestApp(tmpDir, remote);
    remote.permissionReply = vi.fn().mockRejectedValue(new RemoteError('Сервер недоступен', 'OFFLINE')) as never;

    const res = await app.request('/api/v2/sessions/remote:rs-1/permissions/ap-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'allow' }),
    });

    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.code).toBe('OFFLINE');
  });

  it('remote-сессия без клиента → 502 REMOTE_UNAVAILABLE', async () => {
    const { app } = createTestApp(tmpDir, null);
    const res = await app.request('/api/v2/sessions/remote:rs-1/permissions/ap-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'allow' }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.code).toBe('REMOTE_UNAVAILABLE');
  });

  it('локальная сессия — прежний путь, fake не вызывается', async () => {
    const remote = createFakeRemoteClient();
    const { app, sessionManager, eventBus } = createTestApp(tmpDir, remote);
    const session = await sessionManager.createSession({ title: 'Локальная', userId: 'local' });
    const received: Array<{ type: string; data?: Record<string, unknown> }> = [];
    eventBus.subscribe(session.id, (event) => { received.push({ type: event.type, data: event.data }); });

    const res = await app.request(`/api/v2/sessions/${session.id}/permissions/ap-1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'allow' }),
    });

    expect(res.status).toBe(200);
    expect(remote.permissionReply).not.toHaveBeenCalled();
    expect(received).toContainEqual({
      type: 'permission.replied',
      data: expect.objectContaining({ approval_id: 'ap-1', session_id: session.id, approved: true }),
    });
  });

  it('локальный hold — прежний путь permission.hold, fake не вызывается', async () => {
    const remote = createFakeRemoteClient();
    const { app, sessionManager, eventBus } = createTestApp(tmpDir, remote);
    const session = await sessionManager.createSession({ title: 'Локальная', userId: 'local' });
    const received: Array<{ type: string; data?: Record<string, unknown> }> = [];
    eventBus.subscribe(session.id, (event) => { received.push({ type: event.type, data: event.data }); });

    const res = await app.request(`/api/v2/sessions/${session.id}/permissions/ap-1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'hold' }),
    });

    expect(res.status).toBe(200);
    expect(remote.permissionReply).not.toHaveBeenCalled();
    expect(received).toContainEqual({
      type: 'permission.hold',
      data: expect.objectContaining({ approval_id: 'ap-1', session_id: session.id }),
    });
  });

  it('без remote-геттера remote-id — обычный путь (сессия не найдена → 404)', async () => {
    const { app } = createTestApp(tmpDir, null, { withRemoteGetter: false });
    const res = await app.request('/api/v2/sessions/remote:rs-1/permissions/ap-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'allow' }),
    });
    expect(res.status).toBe(404);
  });
});
