import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole } from '@itphx/synth-shared';
import { FileStore } from '../storage/file-store.js';
import { SessionManager } from '../sessions/manager.js';
import { ProjectStore } from '../storage/project-store.js';
import type { RemoteBackendClient } from './client.js';
import {
  syncProjectToRemote,
  forkProjectToLocal,
  walkDir,
  remoteWalk,
  resolveLocalWorkspace,
  slugify,
  isBinaryBuffer,
} from './transfer.js';

function makeFakeRemoteClient(overrides: Record<string, unknown> = {}) {
  const client = {
    createProject: vi.fn(async (body: Record<string, unknown>) => ({ id: 'remote-1', ...body })),
    updateProject: vi.fn(async (id: string, body: Record<string, unknown>) => ({ id, ...body })),
    getProject: vi.fn(async () => ({ id: 'remote-1', name: 'Remote Project', description: 'desc', icon: null, color: null, repos: null, workspace: 'remote-project' })),
    fsWorkspaceMkdir: vi.fn(async () => ({ created: true })),
    importSession: vi.fn(async () => ({ id: 'new-session' })),
    listSessions: vi.fn(async () => [{ id: 'rs-1', project_id: 'remote-1' }]),
    exportSession: vi.fn(async () => ({
      title: 'RS1',
      engine: 'synth',
      sessionOrigin: 'user',
      settings: { temperature: 0.3 },
      messages: [
        { id: 'm1', role: 'user', seq: 1, origin: 'local', parts: [{ id: 'p1', type: 'text', data: 'привет' }], content: 'привет', createdAt: '2026-01-01T00:00:00.000Z', disabled: false, pinned: false, hidden: false },
        { id: 'm2', role: 'assistant', seq: 2, origin: 'local', parts: [{ id: 'p2', type: 'text', data: 'ответ' }], content: 'ответ', createdAt: '2026-01-01T00:00:01.000Z', disabled: false, pinned: false, hidden: false },
      ],
      todos: [{ id: 't1', content: 'task', status: 'pending', priority: 'medium' }],
      sticky_notes: [],
      references: [],
      checkpoints: [],
    })),
    fsList: vi.fn(async (params: { projectId: string; path?: string }) => {
      if (!params.path) {
        return {
          path: '',
          entries: [
            { name: 'src', path: 'src', isDirectory: true, size: 0, modifiedAt: 0 },
            { name: 'readme.md', path: 'readme.md', isDirectory: false, size: 10, modifiedAt: 0 },
            { name: 'node_modules', path: 'node_modules', isDirectory: true, size: 0, modifiedAt: 0 },
          ],
        };
      }
      if (params.path === 'src') {
        return {
          path: 'src',
          entries: [
            { name: 'main.ts', path: 'src/main.ts', isDirectory: false, size: 5, modifiedAt: 0 },
          ],
        };
      }
      return { path: params.path, entries: [] };
    }),
    fsDownload: vi.fn(async () => new Response(new Uint8Array([104, 105]), { status: 200 })),
    fsWrite: vi.fn(async () => ({ path: 'x', content: '', size: 0, encoding: 'utf-8' })),
    fsUpload: vi.fn(async () => ({ path: 'x', name: 'x' })),
    ...overrides,
  };
  return client as unknown as RemoteBackendClient & typeof client;
}

describe('transfer helpers', () => {
  let tmpDir: string;
  let workspacesRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-transfer-'));
    workspacesRoot = join(tmpDir, 'workspaces');
    await mkdir(workspacesRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('slugify', () => {
    it('преобразует имя в безопасный slug', () => {
      expect(slugify('My Cool Project!')).toBe('my-cool-project');
      expect(slugify('Кириллица')).toBe('project'); // не-латиница → дефолт
      expect(slugify('')).toBe('project');
    });
  });

  describe('isBinaryBuffer', () => {
    it('распознаёт бинарные буферы по NUL-байту', () => {
      expect(isBinaryBuffer(Buffer.from([1, 2, 0, 3]))).toBe(true);
      expect(isBinaryBuffer(Buffer.from('text'))).toBe(false);
      expect(isBinaryBuffer(Buffer.from([0xff, 0xfe, 0x68, 0x00]))).toBe(false); // UTF-16 BOM
    });
  });

  describe('resolveLocalWorkspace', () => {
    it('абсолютный workspace — как есть, относительный — от workspacesRoot', () => {
      const project = { workspace: 'rel/ws' } as Parameters<typeof resolveLocalWorkspace>[0];
      expect(resolveLocalWorkspace(project, '/root', '/def')).toBe('/root/rel/ws');
      const absProject = { workspace: '/abs/ws' } as Parameters<typeof resolveLocalWorkspace>[0];
      expect(resolveLocalWorkspace(absProject, '/root', '/def')).toBe('/abs/ws');
      const noWs = {} as Parameters<typeof resolveLocalWorkspace>[0];
      expect(resolveLocalWorkspace(noWs, '/root', '/def')).toBe('/def');
    });
  });

  describe('walkDir', () => {
    it('обходит файлы рекурсивно, исключая node_modules/.git/скрытые', async () => {
      const ws = join(tmpDir, 'ws');
      await mkdir(join(ws, 'src', 'nested'), { recursive: true });
      await mkdir(join(ws, 'node_modules'), { recursive: true });
      await mkdir(join(ws, '.git'), { recursive: true });
      await mkdir(join(ws, '.synth'), { recursive: true });
      await writeFile(join(ws, 'readme.md'), 'hi');
      await writeFile(join(ws, 'src', 'main.ts'), 'code');
      await writeFile(join(ws, 'src', 'nested', 'a.json'), '{}');
      await writeFile(join(ws, 'node_modules', 'pkg.js'), 'x');
      await writeFile(join(ws, '.git', 'config'), 'x');
      await writeFile(join(ws, '.env'), 'SECRET=1');
      await writeFile(join(ws, '.hidden.ts'), 'x');

      const files = await walkDir(ws);
      expect(files).toEqual(['readme.md', 'src/main.ts', 'src/nested/a.json']);
    });
  });

  describe('remoteWalk', () => {
    it('обходит удалённые файлы, исключая node_modules', async () => {
      const client = makeFakeRemoteClient();
      const files = await remoteWalk(client, 'remote-1', '', []);
      expect(files).toEqual(['readme.md', 'src/main.ts']);
    });
  });

  describe('syncProjectToRemote', () => {
    it('создаёт проект, импортирует сессии и загружает файлы', async () => {
      const client = makeFakeRemoteClient();
      const projectStore = new ProjectStore({ dataDir: tmpDir });
      const project = projectStore.create('My Project', 'local', {
        description: 'desc', icon: '🚀', color: 'red',
        repos: [{ path: 'repo1' }],
        workspace: 'my-project',
      });
      await projectStore.save(project);

      const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
      const session = await sessionManager.createSession({ title: 'S1', projectId: project.id });
      await sessionManager.addMessage(session.id, {
        id: 'm1', role: MessageRole.USER, seq: 1, origin: 'local' as const,
        parts: [{ id: 'p1', type: 'text' as const, data: 'hello' }],
        content: 'hello', createdAt: new Date().toISOString(),
        disabled: false, pinned: false, hidden: false,
      });

      const localProjectDir = join(tmpDir, 'ws');
      await mkdir(join(localProjectDir, 'sub'), { recursive: true });
      await mkdir(join(localProjectDir, 'node_modules'), { recursive: true });
      await writeFile(join(localProjectDir, 'a.txt'), 'text');
      await writeFile(join(localProjectDir, 'sub', 'b.ts'), 'code');
      await writeFile(join(localProjectDir, 'node_modules', 'x.js'), 'x');
      await mkdir(join(localProjectDir, '.git'), { recursive: true });
      await writeFile(join(localProjectDir, '.git', 'config'), 'x');
      await writeFile(join(localProjectDir, 'image.bin'), Buffer.from([1, 0, 2]));

      const stats = await syncProjectToRemote({
        localProject: project,
        remoteClient: client,
        includeFiles: true,
        includeSessions: true,
        localProjectDir,
        localSessions: [session],
      });

      expect(client.createProject).toHaveBeenCalledWith(expect.objectContaining({
        name: 'My Project',
        description: 'desc',
        icon: '🚀',
        color: 'red',
        workspace: 'my-project',
      }));
      expect(client.fsWorkspaceMkdir).toHaveBeenCalledWith({ path: 'my-project' });
      // Каталог workspace создаётся ДО createProject (backend валидирует его наличие).
      const mkdirOrder = (client.fsWorkspaceMkdir as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? 0;
      const createOrder = (client.createProject as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? 0;
      expect(mkdirOrder).toBeLessThan(createOrder);
      expect(client.importSession).toHaveBeenCalledWith(
        expect.objectContaining({ import: { project_id: 'remote-1' } }),
      );
      // текстовые файлы — fsWrite, бинарный — fsUpload; node_modules/.git исключены
      expect(client.fsWrite).toHaveBeenCalledWith({ projectId: 'remote-1', path: 'a.txt', content: 'text' });
      expect(client.fsWrite).toHaveBeenCalledWith({ projectId: 'remote-1', path: 'sub/b.ts', content: 'code' });
      expect(client.fsUpload).toHaveBeenCalledTimes(1);
      expect(stats).toMatchObject({ projectId: 'remote-1', sessionsImported: 1, filesUploaded: 3, created: true });
    });

    it('обновляет существующий проект при remoteProjectId', async () => {
      const client = makeFakeRemoteClient();
      const projectStore = new ProjectStore({ dataDir: tmpDir });
      const project = projectStore.create('P', 'local', { description: 'd' });
      await projectStore.save(project);

      const stats = await syncProjectToRemote({
        localProject: project,
        remoteClient: client,
        remoteProjectId: 'remote-1',
        includeFiles: false,
        includeSessions: false,
        localProjectDir: join(tmpDir, 'ws'),
        localSessions: [],
      });

      expect(client.createProject).not.toHaveBeenCalled();
      expect(client.updateProject).toHaveBeenCalledWith('remote-1', expect.objectContaining({ name: 'P' }));
      expect(stats.created).toBe(false);
    });

    it('бросает ошибку, если локальный workspace не существует и нужны файлы', async () => {
      const client = makeFakeRemoteClient();
      const projectStore = new ProjectStore({ dataDir: tmpDir });
      const project = projectStore.create('P', 'local', { workspace: 'missing' });
      await projectStore.save(project);

      await expect(syncProjectToRemote({
        localProject: project,
        remoteClient: client,
        includeFiles: true,
        includeSessions: false,
        localProjectDir: join(tmpDir, 'ws', 'missing'),
        localSessions: [],
      })).rejects.toThrow(/не найден/);
    });
  });

  describe('forkProjectToLocal', () => {
    it('создаёт локальный проект, сессии с историей и скачивает файлы', async () => {
      const client = makeFakeRemoteClient();
      const projectStore = new ProjectStore({ dataDir: tmpDir });
      const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));

      const stats = await forkProjectToLocal({
        remoteProjectId: 'remote-1',
        remoteClient: client,
        localProjectStore: projectStore,
        localSessionManager: sessionManager,
        includeFiles: true,
        includeSessions: true,
        localWorkspacesRoot: workspacesRoot,
      });

      expect(stats.projectId).toBeTruthy();
      expect(stats.sessionsImported).toBe(1);
      expect(stats.filesDownloaded).toBe(2); // readme.md + src/main.ts

      const localProject = await projectStore.load(stats.projectId);
      expect(localProject?.name).toBe('Remote Project');
      expect(localProject?.workspace).toBe('remote-project');

      const sessions = await sessionManager.listSessions({ projectId: stats.projectId });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.title).toBe('RS1');
      expect(sessions[0]!.messages).toHaveLength(2);
      expect(sessions[0]!.messages[1]!.content).toBe('ответ');
      expect(sessions[0]!.messages[1]!.seq).toBe(2);
      expect(sessions[0]!.todos).toEqual([{ id: 't1', content: 'task', status: 'pending', priority: 'medium' }]);

      const downloaded = await readFile(join(workspacesRoot, 'remote-project', 'src', 'main.ts'));
      expect(downloaded.toString()).toBe('hi');
      const wsStat = await stat(join(workspacesRoot, 'remote-project'));
      expect(wsStat.isDirectory()).toBe(true);
    });

    it('фильтрует сессии не из этого проекта', async () => {
      const client = makeFakeRemoteClient({
        listSessions: async () => [
          { id: 'rs-1', project_id: 'remote-1' },
          { id: 'rs-2', project_id: 'other-project' },
        ],
      });
      const projectStore = new ProjectStore({ dataDir: tmpDir });
      const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));

      const stats = await forkProjectToLocal({
        remoteProjectId: 'remote-1',
        remoteClient: client,
        localProjectStore: projectStore,
        localSessionManager: sessionManager,
        includeFiles: false,
        includeSessions: true,
        localWorkspacesRoot: workspacesRoot,
      });

      expect(stats.sessionsImported).toBe(1);
      expect(client.exportSession).toHaveBeenCalledTimes(1);
      expect(client.exportSession).toHaveBeenCalledWith('rs-1');
    });
  });
});
