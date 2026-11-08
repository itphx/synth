import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole } from '@itphx/synth-shared';
import { FileStore } from '../storage/file-store.js';
import { SessionManager } from '../sessions/manager.js';
import { ProjectStore } from '../storage/project-store.js';
import { EventBus } from '../events/bus.js';
import type { RemoteBackendClient } from './client.js';
import { RemoteError } from './types.js';
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
  const client: Record<string, unknown> = {
    createProject: vi.fn(async (body: Record<string, unknown>) => ({ id: 'remote-1', ...body })),
    updateProject: vi.fn(async (id: string, body: Record<string, unknown>) => ({ id, ...body })),
    getProject: vi.fn(async () => ({ id: 'remote-1', name: 'Remote Project', description: 'desc', icon: null, color: null, repos: null, workspace: 'remote-project' })),
    fsWorkspaceMkdir: vi.fn(async () => ({ created: true })),
    importSession: vi.fn(async () => ({ id: 'new-session' })),
    // Контракт v2: список сессий удалённого мира — объект `{sessions, total, ...}`.
    listSessions: vi.fn(async () => ({
      sessions: [{ id: 'rs-1', project_id: 'remote-1' }],
      total: 1,
      offset: 0,
      limit: 100,
      next_offset: null,
      paginationSupported: true,
    })),
    exportSession: vi.fn(async () => ({
      title: 'RS1',
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
  // Дефолтный `importSessions` (батч) делегирует поштучному `importSession`
  // **эффективного** клиента: тесты, переопределяющие `importSession`, видят
  // прежнюю последовательность вызовов и id, а новые тесты батча могут
  // переопределить `importSessions` целиком.
  if (typeof overrides.importSessions !== 'function') {
    client.importSessions = vi.fn(async (bodies: Record<string, unknown>[]) => {
      const sessions: Array<{ id?: string; source_session_id?: string; updated?: boolean }> = [];
      for (const body of bodies) {
        const importOne = client.importSession as (b: Record<string, unknown>) => Promise<unknown>;
        const created = (await importOne(body)) as Record<string, unknown> | null;
        const imp = body.import as Record<string, unknown> | undefined;
        sessions.push({
          ...(typeof imp?.source_session_id === 'string'
            ? { source_session_id: imp.source_session_id }
            : {}),
          ...(created && typeof created.id === 'string' ? { id: created.id } : {}),
          updated: false,
        });
      }
      return { sessions };
    });
  }
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
        description: 'desc', icon: 'rocket', color: 'a1',
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
        icon: 'rocket',
        color: 'a1',
        workspace: 'my-project',
      }));
      expect(client.fsWorkspaceMkdir).toHaveBeenCalledWith({ path: 'my-project' });
      // Каталог workspace создаётся ДО createProject (backend валидирует его наличие).
      const mkdirOrder = (client.fsWorkspaceMkdir as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? 0;
      const createOrder = (client.createProject as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? 0;
      expect(mkdirOrder).toBeLessThan(createOrder);
      expect(client.importSession).toHaveBeenCalledWith(
        expect.objectContaining({ import: expect.objectContaining({ project_id: 'remote-1' }) }),
      );
      // текстовые файлы — fsWrite, бинарный — fsUpload; node_modules/.git исключены
      expect(client.fsWrite).toHaveBeenCalledWith(
        { projectId: 'remote-1', path: 'a.txt', content: 'text' },
        { timeoutMs: 120_000 },
      );
      expect(client.fsWrite).toHaveBeenCalledWith(
        { projectId: 'remote-1', path: 'sub/b.ts', content: 'code' },
        { timeoutMs: 120_000 },
      );
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

    it('publish передаёт plan проекта в createProject и updateProject', async () => {
      const plan = {
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        columns: [{ id: 'c1', name: 'Колонка', order: 0 }],
        items: [],
      };
      const projectStore = new ProjectStore({ dataDir: tmpDir });
      const project = projectStore.create('PlanPublish', 'local');
      project.plan = plan;
      await projectStore.save(project);
      const baseOpts = {
        includeFiles: false,
        includeSessions: false,
        localProjectDir: join(tmpDir, 'ws'),
        localSessions: [],
      };

      const createClient = makeFakeRemoteClient();
      await syncProjectToRemote({ ...baseOpts, localProject: project, remoteClient: createClient });
      expect(createClient.createProject).toHaveBeenCalledWith(expect.objectContaining({ plan }));

      const updateClient = makeFakeRemoteClient();
      await syncProjectToRemote({
        ...baseOpts,
        localProject: project,
        remoteClient: updateClient,
        remoteProjectId: 'remote-1',
      });
      expect(updateClient.updateProject).toHaveBeenCalledWith('remote-1', expect.objectContaining({ plan }));
    });

    it('publish: parentId/references переписываются на новые remote-id, чужие ссылки зануляются', async () => {
      const importedIds = ['remote-ses-A', 'remote-ses-B'];
      let importCall = 0;
      const client = makeFakeRemoteClient({
        importSession: vi.fn(async (body: Record<string, unknown>) => ({
          ...body,
          id: importedIds[importCall++] ?? 'remote-ses-unknown',
        })),
      });
      const projectStore = new ProjectStore({ dataDir: tmpDir });
      const project = projectStore.create('PublishRefs', 'local');
      await projectStore.save(project);

      const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
      const parent = await sessionManager.createSession({ title: 'Parent', projectId: project.id });
      const child = await sessionManager.createSession({ title: 'Child', projectId: project.id, parentId: parent.id });
      // Ссылка на переносимую сессию + ссылка на непереносимую (вне проекта).
      child.references = [
        { type: 'session_reference' as const, sessionId: parent.id, label: 'parent', messageRange: [1, 2], createdAt: new Date().toISOString() },
        { type: 'session_reference' as const, sessionId: 'outside-session', label: 'outside', messageRange: [1, 2], createdAt: new Date().toISOString() },
      ];
      // Сохраняем references ДО addMessage (иначе addMessage перезапишет их в store).
      await sessionManager.saveSession(child);
      // session_reference-часть в сообщении + sourceMsgId на сообщение, которого нет в наборе.
      await sessionManager.addMessage(child.id, {
        id: 'child-m1', role: MessageRole.USER, seq: 1, origin: 'local' as const,
        parts: [
          { id: 'p1', type: 'text' as const, data: 'hello' },
          { id: 'p2', type: 'session_reference' as const, data: { sessionId: parent.id, label: 'ref-in-msg' } },
        ],
        content: 'hello', sourceMsgId: 'ghost-message', createdAt: new Date().toISOString(),
        disabled: false, pinned: false, hidden: false,
      });
      // addMessage не мутирует in-memory объект — берём свежие копии из store.
      const freshChild = (await sessionManager.getSession(child.id))!;
      const freshParent = (await sessionManager.getSession(parent.id))!;

      const stats = await syncProjectToRemote({
        localProject: project,
        remoteClient: client,
        includeFiles: false,
        includeSessions: true,
        localProjectDir: join(tmpDir, 'ws'),
        localSessions: [freshChild, freshParent],
      });

      expect(stats.sessionsImported).toBe(2);
      // Топологический порядок: родитель импортируется раньше ребёнка.
      const bodies = (client.importSession as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as Record<string, unknown>);
      expect(bodies[0]!.id).toBe(parent.id);
      expect(bodies[1]!.id).toBe(child.id);

      // parentId ребёнка → новый remote-id родителя.
      expect(bodies[1]!.parentId).toBe('remote-ses-A');
      // references: переносимая → remote-id, непереносимая → null.
      const refs = bodies[1]!.references as Array<{ sessionId: string | null }>;
      expect(refs[0]!.sessionId).toBe('remote-ses-A');
      expect(refs[1]!.sessionId).toBeNull();
      // session_reference-часть сообщения → remote-id; sourceMsgId вне набора → null.
      const childMsgParts = (bodies[1]!.messages as Array<{ parts: Array<{ type: string; data: Record<string, unknown> }> }>)[0]!.parts;
      const refPart = childMsgParts.find((p) => p.type === 'session_reference')!;
      expect(refPart.data.sessionId).toBe('remote-ses-A');
      expect((bodies[1]!.messages as Array<{ sourceMsgId: string | null }>)[0]!.sourceMsgId).toBeNull();
    });

    it('publish: пакетный импорт — один importSessions на уровень зависимостей, mapping по source_session_id', async () => {
      const importSessions = vi.fn(async (bodies: Record<string, unknown>[]) => ({
        sessions: bodies.map((b, i) => ({
          source_session_id: (b.import as Record<string, unknown>).source_session_id as string,
          id: `remote-batch-${i}`,
          updated: false,
        })),
      }));
      const client = makeFakeRemoteClient({ importSessions });
      const projectStore = new ProjectStore({ dataDir: tmpDir });
      const project = projectStore.create('BatchPublish', 'local');
      await projectStore.save(project);

      const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
      const parent = await sessionManager.createSession({ title: 'Parent', projectId: project.id });
      const child = await sessionManager.createSession({
        title: 'Child', projectId: project.id, parentId: parent.id,
      });
      const freshParent = (await sessionManager.getSession(parent.id))!;
      const freshChild = (await sessionManager.getSession(child.id))!;

      const stats = await syncProjectToRemote({
        localProject: project,
        remoteClient: client,
        includeFiles: false,
        includeSessions: true,
        localProjectDir: join(tmpDir, 'ws'),
        // Намеренно обратный порядок: уровни всё равно parent → child.
        localSessions: [freshChild, freshParent],
        log: () => {},
      });

      expect(stats.sessionsImported).toBe(2);
      // Два уровня зависимостей — два запроса; поштучный импорт не вызывался.
      expect(importSessions).toHaveBeenCalledTimes(2);
      expect(client.importSession).not.toHaveBeenCalled();

      const firstLevel = importSessions.mock.calls[0]![0] as Array<Record<string, unknown>>;
      const secondLevel = importSessions.mock.calls[1]![0] as Array<Record<string, unknown>>;
      expect(firstLevel.map((b) => b.id)).toEqual([parent.id]);
      expect(secondLevel.map((b) => b.id)).toEqual([child.id]);
      // parentId ребёнка переписан на remote-id родителя из ответа первого уровня.
      expect(secondLevel[0]!.parentId).toBe('remote-batch-0');
      // Маркер источника задаёт вызывающий — локальный id сессии.
      expect((firstLevel[0]!.import as Record<string, unknown>).source_session_id).toBe(parent.id);
      expect((firstLevel[0]!.import as Record<string, unknown>).project_id).toBe('remote-1');
    });

    it('publish: унаследованный sourceSessionId вырезан из тела (маркер не уезжает по цепочке)', async () => {
      const importSessions = vi.fn(async (bodies: Record<string, unknown>[]) => ({
        sessions: bodies.map((b) => ({
          source_session_id: (b.import as Record<string, unknown>).source_session_id as string,
          id: 'remote-marked',
          updated: false,
        })),
      }));
      const client = makeFakeRemoteClient({ importSessions });
      const projectStore = new ProjectStore({ dataDir: tmpDir });
      const project = projectStore.create('MarkerPublish', 'local');
      await projectStore.save(project);

      const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
      const session = await sessionManager.createSession({ title: 'FromA', projectId: project.id });
      session.sourceSessionId = 'origin-session-42';
      await sessionManager.saveSession(session);
      const fresh = (await sessionManager.getSession(session.id))!;

      await syncProjectToRemote({
        localProject: project,
        remoteClient: client,
        includeFiles: false,
        includeSessions: true,
        localProjectDir: join(tmpDir, 'ws'),
        localSessions: [fresh],
        log: () => {},
      });

      const body = (importSessions.mock.calls[0]![0] as Array<Record<string, unknown>>)[0]!;
      expect(body).not.toHaveProperty('sourceSessionId');
      expect(body).not.toHaveProperty('source_session_id');
      expect((body.import as Record<string, unknown>).source_session_id).toBe(session.id);
    });

    it('publish: старый backend без import-batch (HTTP_404) — переключение на поштучный импорт', async () => {
      const importSessions = vi.fn(async (_bodies: Record<string, unknown>[], _opts?: { timeoutMs?: number }) => {
        throw new RemoteError('not found', 'HTTP_404');
      });
      const importSession = vi.fn(async (body: Record<string, unknown>, _opts?: { timeoutMs?: number }) => ({
        id: `per-${(body.import as Record<string, unknown>).source_session_id as string}`,
      }));
      const client = makeFakeRemoteClient({ importSessions, importSession });
      const projectStore = new ProjectStore({ dataDir: tmpDir });
      const project = projectStore.create('FallbackPublish', 'local');
      await projectStore.save(project);

      const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
      const parent = await sessionManager.createSession({ title: 'Parent', projectId: project.id });
      const child = await sessionManager.createSession({
        title: 'Child', projectId: project.id, parentId: parent.id,
      });
      const freshParent = (await sessionManager.getSession(parent.id))!;
      const freshChild = (await sessionManager.getSession(child.id))!;

      const stats = await syncProjectToRemote({
        localProject: project,
        remoteClient: client,
        includeFiles: false,
        includeSessions: true,
        localProjectDir: join(tmpDir, 'ws'),
        localSessions: [freshParent, freshChild],
        log: () => {},
      });

      expect(stats.sessionsImported).toBe(2);
      // Батч попробован один раз (первый уровень), дальше — только поштучно.
      expect(importSessions).toHaveBeenCalledTimes(1);
      expect(importSession).toHaveBeenCalledTimes(2);
      // Поштучный путь получает увеличенный таймаут переноса.
      expect(importSession.mock.calls[0]?.[1]).toEqual({ timeoutMs: 120_000 });
      const childBody = importSession.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .find((body) => body.id === child.id)!;
      expect(childBody.parentId).toBe(`per-${parent.id}`);
    });

    it('publish: уровень больше IMPORT_BATCH_CHUNK режется на чанки 20/20/5 с таймаутом переноса', async () => {
      const importSessions = vi.fn(
        async (bodies: Record<string, unknown>[], _opts?: { timeoutMs?: number }) => ({
          sessions: bodies.map((b) => {
            const sourceId = (b.import as Record<string, unknown>).source_session_id as string;
            return { source_session_id: sourceId, id: `remote-${sourceId}`, updated: false };
          }),
        }),
      );
      const client = makeFakeRemoteClient({ importSessions });
      const projectStore = new ProjectStore({ dataDir: tmpDir });
      const project = projectStore.create('ChunkedPublish', 'local');
      await projectStore.save(project);

      const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
      // 45 независимых сессий → один уровень зависимостей → 3 чанка (20/20/5).
      const sessions = [];
      for (let i = 0; i < 45; i++) {
        sessions.push(await sessionManager.createSession({ title: `S${i}`, projectId: project.id }));
      }

      const stats = await syncProjectToRemote({
        localProject: project,
        remoteClient: client,
        includeFiles: false,
        includeSessions: true,
        localProjectDir: join(tmpDir, 'ws'),
        localSessions: sessions,
        log: () => {},
      });

      expect(stats.sessionsImported).toBe(45);
      expect(importSessions).toHaveBeenCalledTimes(3);
      const chunkSizes = importSessions.mock.calls.map(
        (call) => (call[0] as Array<Record<string, unknown>>).length,
      );
      expect(chunkSizes).toEqual([20, 20, 5]);
      // Каждый чанк — с увеличенным таймаутом переноса (дефолт 15 с не подходит).
      for (const call of importSessions.mock.calls) {
        expect(call[1]).toEqual({ timeoutMs: 120_000 });
      }

      // Mapping собран по всем: каждая сессия получила свой remote-id.
      const mappedIds = new Set(
        importSessions.mock.calls.flatMap((call) =>
          (call[0] as Array<Record<string, unknown>>).map(
            (b) => (b.import as Record<string, unknown>).source_session_id as string,
          ),
        ),
      );
      expect(mappedIds.size).toBe(45);
      expect(client.importSession as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });

    it('publish: файлы (fsWrite/fsUpload) тоже идут с таймаутом переноса', async () => {
      const client = makeFakeRemoteClient();
      const projectStore = new ProjectStore({ dataDir: tmpDir });
      const project = projectStore.create('FilesTimeout', 'local', { workspace: 'files-timeout' });
      await projectStore.save(project);

      const localProjectDir = join(tmpDir, 'ws-files');
      await mkdir(localProjectDir, { recursive: true });
      await writeFile(join(localProjectDir, 'a.txt'), 'text');
      await writeFile(join(localProjectDir, 'image.bin'), Buffer.from([1, 0, 2]));

      await syncProjectToRemote({
        localProject: project,
        remoteClient: client,
        includeFiles: true,
        includeSessions: false,
        localProjectDir,
        localSessions: [],
        log: () => {},
      });

      const fsWriteMock = client.fsWrite as unknown as ReturnType<typeof vi.fn>;
      const fsUploadMock = client.fsUpload as unknown as ReturnType<typeof vi.fn>;
      expect(fsWriteMock.mock.calls[0]?.[1]).toEqual({ timeoutMs: 120_000 });
      expect(fsUploadMock.mock.calls[0]?.[1]).toEqual({ timeoutMs: 120_000 });
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

      const sessions = await sessionManager.listSessionsWithMessages({ projectId: stats.projectId });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.title).toBe('RS1');
      expect(sessions[0]!.messages).toHaveLength(2);
      expect(sessions[0]!.messages[1]!.content).toBe('ответ');
      expect(sessions[0]!.messages[1]!.seq).toBe(2);
      expect(sessions[0]!.todos).toEqual([{ id: 't1', content: 'task', status: 'pending', priority: 'medium' }]);

      const downloaded = await readFile(join(workspacesRoot, 'remote-project', 'src', 'main.ts'));
      expect(downloaded.toString()).toBe('hi');
      // Скачивание в fork идёт с увеличенным таймаутом переноса (не дефолт 15 с).
      const fsDownloadMock = client.fsDownload as unknown as ReturnType<typeof vi.fn>;
      expect(fsDownloadMock.mock.calls.length).toBeGreaterThan(0);
      for (const call of fsDownloadMock.mock.calls) {
        expect(call[1]).toEqual({ timeoutMs: 120_000 });
      }
      const wsStat = await stat(join(workspacesRoot, 'remote-project'));
      expect(wsStat.isDirectory()).toBe(true);
    });

    it('публикует session.created для импортированной сессии при заданном eventBus (ADR-089)', async () => {
      const client = makeFakeRemoteClient();
      const projectStore = new ProjectStore({ dataDir: tmpDir });
      const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
      const eventBus = new EventBus();
      const seen: Array<{ type: string; sessionId: string; data: Record<string, unknown> }> = [];
      eventBus.subscribeAll((e) => { seen.push({ type: e.type, sessionId: e.sessionId, data: e.data }); });

      const stats = await forkProjectToLocal({
        remoteProjectId: 'remote-1',
        remoteClient: client,
        localProjectStore: projectStore,
        localSessionManager: sessionManager,
        includeFiles: false,
        includeSessions: true,
        localWorkspacesRoot: workspacesRoot,
        eventBus,
      });

      const sessions = await sessionManager.listSessionsWithMessages({ projectId: stats.projectId });
      expect(sessions).toHaveLength(1);
      const created = seen.filter((e) => e.type === 'session.created');
      expect(created).toHaveLength(1);
      // Событие — в собственный канал сессии, payload `serializeSession` с владельцем.
      expect(created[0]!.sessionId).toBe(sessions[0]!.id);
      expect(created[0]!.data.id).toBe(sessions[0]!.id);
      expect(created[0]!.data.owner_id).toBe('local');
    });

    it('PROP-054: журнал удалённого проекта догружается страницами (в детали его нет)', async () => {
      const getProjectLog = vi.fn(async (_id: string, params?: { limit?: number; offset?: number }) => {
        const offset = params?.offset ?? 0;
        if (offset === 0) {
          return {
            entries: [
              {
                id: 'log-2',
                text: 'вторая',
                created_at: '2026-01-02T00:00:00.000Z',
                session_id: 'rs-1',
                author: 'local',
                updated_at: null,
                updated_by: null,
              },
            ],
            total: 2,
            offset: 0,
            limit: 200,
            next_offset: 1,
          };
        }
        return {
          entries: [
            {
              id: 'log-1',
              text: 'первая',
              created_at: '2026-01-01T00:00:00.000Z',
              session_id: null,
              author: 'local',
              updated_at: null,
              updated_by: null,
            },
          ],
          total: 2,
          offset: 1,
          limit: 200,
          next_offset: null,
        };
      });
      const client = makeFakeRemoteClient({ getProjectLog });
      const projectStore = new ProjectStore({ dataDir: tmpDir });
      const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));

      const stats = await forkProjectToLocal({
        remoteProjectId: 'remote-1',
        remoteClient: client,
        localProjectStore: projectStore,
        localSessionManager: sessionManager,
        includeFiles: false,
        includeSessions: false,
        localWorkspacesRoot: workspacesRoot,
      });

      // Страницы обходятся по `next_offset` — журнал не теряется.
      expect(getProjectLog).toHaveBeenCalledTimes(2);
      expect(getProjectLog.mock.calls[0]?.[1]).toMatchObject({ limit: 200, offset: 0 });
      expect(getProjectLog.mock.calls[1]?.[1]).toMatchObject({ limit: 200, offset: 1 });

      const localProject = await projectStore.load(stats.projectId);
      expect(localProject?.log).toHaveLength(2);
      // DTO (snake_case) разворачивается в доменную форму (camelCase).
      expect(localProject?.log?.[0]).toMatchObject({
        id: 'log-2',
        text: 'вторая',
        createdAt: '2026-01-02T00:00:00.000Z',
        sessionId: 'rs-1',
        author: 'local',
      });
      expect(localProject?.log?.[1]?.id).toBe('log-1');
      expect(localProject?.log?.[1]?.sessionId).toBeUndefined();
    });

    it('фильтрует сессии не из этого проекта', async () => {
      const client = makeFakeRemoteClient({
        listSessions: async () => ({
          sessions: [
            { id: 'rs-1', project_id: 'remote-1' },
            { id: 'rs-2', project_id: 'other-project' },
          ],
          total: 2,
          offset: 0,
          limit: 100,
          next_offset: null,
          paginationSupported: true,
        }),
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

    it('fork: parentId/references переписываются на новые локальные id, чужие ссылки зануляются', async () => {
      const exportsBySession: Record<string, Record<string, unknown>> = {
        'rs-parent': {
          title: 'Parent',
          sessionOrigin: 'user',
          settings: { temperature: 0.3 },
          messages: [
            { id: 'pm1', role: 'user', seq: 1, origin: 'local', parts: [{ id: 'pp1', type: 'text', data: 'hi' }], content: 'hi', createdAt: '2026-01-01T00:00:00.000Z', disabled: false, pinned: false, hidden: false },
          ],
          todos: [],
          sticky_notes: [],
          references: [],
          checkpoints: [],
        },
        'rs-child': {
          title: 'Child',
          sessionOrigin: 'user',
          parentId: 'rs-parent',
          settings: { temperature: 0.3 },
          messages: [
            { id: 'cm1', role: 'user', seq: 1, origin: 'local', parts: [{ id: 'cp1', type: 'text', data: 'hello' }], content: 'hello', createdAt: '2026-01-01T00:00:00.000Z', disabled: false, pinned: false, hidden: false },
          ],
          todos: [],
          sticky_notes: [],
          references: [
            { type: 'session_reference', sessionId: 'rs-parent', label: 'parent', messageRange: [1, 1], createdAt: '2026-01-01T00:00:00.000Z' },
            { type: 'session_reference', sessionId: 'outside-session', label: 'outside', messageRange: [1, 1], createdAt: '2026-01-01T00:00:00.000Z' },
          ],
          checkpoints: [],
        },
      };
      const client = makeFakeRemoteClient({
        listSessions: async () => ({
          sessions: [
            { id: 'rs-parent', project_id: 'remote-1' },
            { id: 'rs-child', project_id: 'remote-1' },
          ],
          total: 2,
          offset: 0,
          limit: 100,
          next_offset: null,
          paginationSupported: true,
        }),
        exportSession: vi.fn(async (id: string) => exportsBySession[id] ?? {}),
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

      expect(stats.sessionsImported).toBe(2);
      const sessions = await sessionManager.listSessionsWithMessages({ projectId: stats.projectId });
      const parent = sessions.find((s) => s.title === 'Parent')!;
      const child = sessions.find((s) => s.title === 'Child')!;
      expect(parent).toBeDefined();
      expect(child).toBeDefined();

      // parentId ребёнка → новый локальный id родителя.
      expect(child.parentId).toBe(parent.id);
      // references: переносимая → локальный id, непереносимая → null.
      expect(child.references[0]!.sessionId).toBe(parent.id);
      expect(child.references[1]!.sessionId).toBeNull();
      expect(parent.parentId).toBeUndefined();
    });
  });
});
