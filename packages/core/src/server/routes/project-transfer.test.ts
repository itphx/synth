import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createProjectTransferRoutes } from './project-transfer.js';
import { ProjectStore } from '../../storage/project-store.js';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import type { AuthKit } from '../../auth/local.js';
import { syncProjectToRemote, forkProjectToLocal } from '../../remote/transfer.js';

// Роуты лишь резолвят зависимости и вызывают transfer-функции — сами функции
// замоканы (их логика покрыта transfer.test.ts): здесь проверяем маршрутизацию,
// валидацию и параметры вызова.
vi.mock('../../remote/transfer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../remote/transfer.js')>();
  return {
    ...actual,
    syncProjectToRemote: vi.fn(async () => ({
      projectId: 'remote-1', sessionsImported: 0, filesUploaded: 0, filesDownloaded: 0, created: true,
    })),
    forkProjectToLocal: vi.fn(async () => ({
      projectId: 'forked-project', sessionsImported: 0, filesUploaded: 0, filesDownloaded: 0, created: true,
    })),
  };
});

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

function makeFakeRemoteClient() {
  return {} as never;
}

describe('Project transfer routes (publish / fork-local)', () => {
  let tmpDir: string;
  let workspacesRoot: string;
  let defaultWorkingDir: string;
  let store: ProjectStore;
  let sessionManager: SessionManager;
  let remoteClient: ReturnType<typeof makeFakeRemoteClient>;

  function createApp(withClient: boolean): Hono {
    const app = new Hono();
    app.route('/api/v2/projects', createProjectTransferRoutes(
      createMockAuth(),
      store,
      sessionManager,
      workspacesRoot,
      defaultWorkingDir,
      withClient ? () => remoteClient : undefined,
    ));
    return app;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-transfer-'));
    workspacesRoot = join(tmpDir, 'workspaces');
    defaultWorkingDir = join(workspacesRoot, 'default');
    await mkdir(defaultWorkingDir, { recursive: true });
    store = new ProjectStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    remoteClient = makeFakeRemoteClient();
    vi.mocked(syncProjectToRemote).mockClear();
    vi.mocked(forkProjectToLocal).mockClear();
    vi.mocked(syncProjectToRemote).mockResolvedValue({
      projectId: 'remote-1', sessionsImported: 0, filesUploaded: 0, filesDownloaded: 0, created: true,
    });
    vi.mocked(forkProjectToLocal).mockResolvedValue({
      projectId: 'forked-project', sessionsImported: 0, filesUploaded: 0, filesDownloaded: 0, created: true,
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('POST /:id/publish', () => {
    it('создаёт новый remote-проект (всегда сессии + файлы) и возвращает ok + remote-id', async () => {
      const app = createApp(true);
      const project = store.create('Local Proj', 'local', { workspace: 'local-proj' });
      await store.save(project);
      await mkdir(join(workspacesRoot, 'local-proj'), { recursive: true });
      const session = await sessionManager.createSession({ title: 'S1', projectId: project.id });

      const res = await app.request(`/api/v2/projects/${project.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { ok: boolean; project_id: string; created: boolean };
      expect(body).toMatchObject({ ok: true, project_id: 'remote:remote-1', created: true });

      expect(syncProjectToRemote).toHaveBeenCalledTimes(1);
      const call = vi.mocked(syncProjectToRemote).mock.calls[0]![0];
      expect(call.localProject.id).toBe(project.id);
      expect(call.remoteProjectId).toBeUndefined();
      expect(call.includeFiles).toBe(true);
      expect(call.includeSessions).toBe(true);
      expect(call.localProjectDir).toBe(join(workspacesRoot, 'local-proj'));
      expect(call.localSessions.map((s) => s.id)).toEqual([session.id]);
    });

    it('обновляет существующий remote-проект при remote_project_id (снимает remote: префикс)', async () => {
      const app = createApp(true);
      const project = store.create('Local Proj', 'local', { workspace: 'local-proj' });
      await store.save(project);
      await mkdir(join(workspacesRoot, 'local-proj'), { recursive: true });

      const res = await app.request(`/api/v2/projects/${project.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote_project_id: 'remote:abc-123' }),
      });
      expect(res.status).toBe(201);

      const call = vi.mocked(syncProjectToRemote).mock.calls[0]![0];
      expect(call.remoteProjectId).toBe('abc-123');
    });

    it('502 REMOTE_UNAVAILABLE без runtime-подключения', async () => {
      const app = createApp(false);
      const res = await app.request('/api/v2/projects/whatever/publish', { method: 'POST' });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('REMOTE_UNAVAILABLE');
    });

    it('400 для удалённого проекта (publish — только локальные)', async () => {
      const app = createApp(true);
      const res = await app.request('/api/v2/projects/remote:abc/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(syncProjectToRemote).not.toHaveBeenCalled();
    });

    it('404, если локальный проект не найден', async () => {
      const app = createApp(true);
      const res = await app.request('/api/v2/projects/missing-id/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });

    it('400, если каталог workspace локального проекта отсутствует', async () => {
      const app = createApp(true);
      const project = store.create('NoWs', 'local', { workspace: 'missing-ws' });
      await store.save(project);

      const res = await app.request(`/api/v2/projects/${project.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(syncProjectToRemote).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/fork-local', () => {
    it('клонирует удалённый проект и возвращает DTO локального проекта (201)', async () => {
      const app = createApp(true);
      // forkProjectToLocal замокан: имитируем созданный локальный проект.
      const local = store.create('Клон', 'local', { description: 'desc' });
      await store.save(local);
      vi.mocked(forkProjectToLocal).mockResolvedValue({
        projectId: local.id, sessionsImported: 0, filesUploaded: 0, filesDownloaded: 0, created: true,
      });

      const res = await app.request('/api/v2/projects/remote:rs-1/fork-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ local_name: 'Клон' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; origin: string; name: string };
      expect(body).toMatchObject({ id: local.id, origin: 'local', name: 'Клон' });

      expect(forkProjectToLocal).toHaveBeenCalledTimes(1);
      const call = vi.mocked(forkProjectToLocal).mock.calls[0]![0];
      expect(call.remoteProjectId).toBe('rs-1'); // remote:-префикс снят
      expect(call.localName).toBe('Клон');
      expect(call.includeFiles).toBe(true);
      expect(call.includeSessions).toBe(true);
      expect(call.localWorkspacesRoot).toBe(workspacesRoot);
      expect(call.localProjectStore).toBe(store);
      expect(call.localSessionManager).toBe(sessionManager);
    });

    it('500, если локальный проект не создан (fork вернул неизвестный id)', async () => {
      const app = createApp(true);
      const res = await app.request('/api/v2/projects/remote:rs-1/fork-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(500);
    });

    it('502 REMOTE_UNAVAILABLE без runtime-подключения', async () => {
      const app = createApp(false);
      const res = await app.request('/api/v2/projects/remote:rs-1/fork-local', { method: 'POST' });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('REMOTE_UNAVAILABLE');
    });

    it('400 для локального проекта (fork-local — только remote)', async () => {
      const app = createApp(true);
      const res = await app.request('/api/v2/projects/local-proj/fork-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(forkProjectToLocal).not.toHaveBeenCalled();
    });
  });
});
