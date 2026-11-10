import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateId,
  makeTextPart,
  MessageRole,
  ProjectRole,
  type Session,
  type ToolContext,
} from '@itphx/synth-shared';
import { listSessionsTool, getSessionInfoTool, sessionRenameTool } from './session-manage.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { EventBus } from '../../events/bus.js';
import { RemoteError } from '../../remote/types.js';

interface Viewer {
  userId: string;
  roles: string[];
}

describe('list_sessions / get_session_info / session_rename (Workstream B)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let current: Session;
  let ownOther: Session;
  let memberProjectSession: Session;
  let foreignProjectSession: Session;
  let foreignOwn: Session;
  let ownProjectId: string;
  let sharedProjectId: string;
  let foreignProjectId: string;

  async function createSession(title: string, ownerId: string, projectId?: string): Promise<Session> {
    const session = await sessionManager.createSession({
      title,
      ...(projectId ? { projectId } : {}),
      userId: ownerId,
      ownerId,
    });
    return session;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-manage-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();

    const own = projectStore.create('Alpha', 'u1');
    await projectStore.save(own);
    ownProjectId = own.id;

    const shared = projectStore.create('Beta', 'u2');
    shared.members = { u2: ProjectRole.OWNER, u1: ProjectRole.EDITOR };
    await projectStore.save(shared);
    sharedProjectId = shared.id;

    const foreign = projectStore.create('Gamma', 'u3');
    await projectStore.save(foreign);
    foreignProjectId = foreign.id;

    current = await createSession('Current work', 'u1', ownProjectId);
    ownOther = await createSession('Own notes', 'u1');
    memberProjectSession = await createSession('Team task', 'u2', sharedProjectId);
    foreignProjectSession = await createSession('Foreign task', 'u3', foreignProjectId);
    foreignOwn = await createSession('Foreign own', 'u3');

    // В историю кладём секретный текст — тулы сессий не должны его отдавать.
    await sessionManager.withLock(current.id, async (s) => {
      s.messages = [{
        id: generateId(),
        role: MessageRole.USER,
        seq: 0,
        origin: 'local',
        parts: [makeTextPart('DO-NOT-LEAK-MESSAGE')],
        content: 'DO-NOT-LEAK-MESSAGE',
        createdAt: s.createdAt,
        disabled: false,
        pinned: false,
        hidden: false,
      }];
      s.todos = [
        { id: 't1', content: 'open item', status: 'pending', priority: 'medium' },
        { id: 't2', content: 'done item', status: 'completed', priority: 'low' },
      ];
      await sessionManager.saveSession(s);
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(viewer: Viewer = { userId: 'u1', roles: ['USER'] }, sessionId = current.id): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: {
        sessionManager,
        projectStore,
        eventBus,
        sessionId,
        principal: viewer,
        isElevatedPrincipal: viewer.roles.some((role) => role === 'ADMIN' || role === 'LEAD'),
      },
    };
  }

  function ids(result: { metadata?: Record<string, unknown> }): string[] {
    return (result.metadata?.sessions as Array<{ id: string }>).map((session) => session.id);
  }

  it('list_sessions: свои + сессии проектов участия, чужие не видны', async () => {
    const result = await listSessionsTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();

    const list = ids(result);
    expect(list).toContain(current.id);
    expect(list).toContain(ownOther.id);
    expect(list).toContain(memberProjectSession.id);
    expect(list).not.toContain(foreignProjectSession.id);
    expect(list).not.toContain(foreignOwn.id);

    const currentItem = (result.metadata?.sessions as Array<Record<string, unknown>>)
      .find((session) => session.id === current.id)!;
    expect(currentItem.is_current).toBe(true);
    expect(currentItem.project_name).toBe('Alpha');
    expect(currentItem.todos_open).toBe(1);
    expect(currentItem.pending_count).toBe(0);
    expect(currentItem.status).toBeTypeOf('object');
    expect(currentItem.activity).toBeTypeOf('object');
  });

  it('list_sessions: elevated видит все сессии', async () => {
    const result = await listSessionsTool.execute({}, makeCtx({ userId: 'admin', roles: ['ADMIN'] }));
    const list = ids(result);
    expect(list).toContain(foreignProjectSession.id);
    expect(list).toContain(foreignOwn.id);
  });

  it('list_sessions: фильтр по проекту (id и точное имя)', async () => {
    const byId = await listSessionsTool.execute({ project: ownProjectId }, makeCtx());
    expect(ids(byId)).toEqual([current.id]);

    const byName = await listSessionsTool.execute({ project: 'beta' }, makeCtx());
    expect(ids(byName)).toEqual([memberProjectSession.id]);
  });

  it('list_sessions: фильтр по названию и пагинация', async () => {
    const query = await listSessionsTool.execute({ query: 'team' }, makeCtx());
    expect(ids(query)).toEqual([memberProjectSession.id]);

    const first = await listSessionsTool.execute({ limit: 1, offset: 0 }, makeCtx());
    expect((first.metadata?.sessions as unknown[]).length).toBe(1);
    expect(first.metadata?.next_offset).toBe(1);
  });

  it('list_sessions: не отдаёт историю сообщений', async () => {
    const result = await listSessionsTool.execute({}, makeCtx());
    const currentItem = (result.metadata?.sessions as Array<Record<string, unknown>>)
      .find((session) => session.id === current.id)!;
    expect(currentItem).not.toHaveProperty('messages');
    expect(currentItem).not.toHaveProperty('checkpoints');
    expect(JSON.stringify(result.metadata)).not.toContain('DO-NOT-LEAK-MESSAGE');
  });

  it('list_sessions: неизвестный проект — ошибка с подсказкой', async () => {
    const result = await listSessionsTool.execute({ project: 'nope' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.metadata?.found).toBe(false);
  });

  it('session_rename: меняет заголовок и публикует session.renamed + session.updated', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    eventBus.subscribe(current.id, (event) => {
      events.push({ type: event.type, data: event.data as Record<string, unknown> });
    });

    const result = await sessionRenameTool.execute({ title: 'New title' }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.title).toBe('New title');
    expect(result.metadata?.prev_title).toBe('Current work');

    const stored = (await sessionManager.getSession(current.id))!;
    expect(stored.title).toBe('New title');

    const renamed = events.find((event) => event.type === 'session.renamed');
    expect(renamed?.data).toMatchObject({
      session_id: current.id,
      title: 'New title',
      prev_title: 'Current work',
    });
    const updated = events.find((event) => event.type === 'session.updated');
    expect(updated?.data).toMatchObject({ session_id: current.id, name: 'New title', title: 'New title' });
    expect(updated?.data.updated_at).toBeTruthy();
  });

  it('session_rename: только текущая сессия (чужой id в аргументах игнорируется)', async () => {
    const ctx = makeCtx();
    await sessionRenameTool.execute({ title: 'Only current', sessionId: foreignOwn.id } as never, ctx);

    expect((await sessionManager.getSession(current.id))!.title).toBe('Only current');
    expect((await sessionManager.getSession(foreignOwn.id))!.title).toBe('Foreign own');
  });

  it('session_rename: пустой и слишком длинный заголовок — ошибка аргументов', async () => {
    const empty = await sessionRenameTool.execute({ title: '   ' }, makeCtx());
    expect(empty.isError).toBe(true);

    const tooLong = await sessionRenameTool.execute({ title: 'x'.repeat(201) }, makeCtx());
    expect(tooLong.isError).toBe(true);
    expect((await sessionManager.getSession(current.id))!.title).toBe('Current work');
  });

  it('get_session_info: проект, режим, todos, стрим, worktree — без сообщений', async () => {
    await sessionManager.withLock(current.id, async (s) => {
      s.mode = 'plan';
      s.settings.agentRole = 'leader';
      s.settings.provider = 'p';
      s.settings.model = 'm';
      s.currentStream = {
        streamId: 'stream_1',
        message: 'in progress text',
        startedAt: s.createdAt,
        cancelled: false,
        turnId: 'turn_1',
      };
      s.worktree = {
        worktreeId: 'wkt_1',
        projectId: ownProjectId,
        repoPath: '.',
        directory: join(tmpDir, 'worktrees', 'wt'),
        branch: 'feature/x',
      };
      await sessionManager.saveSession(s);
    });

    const result = await getSessionInfoTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.id).toBe(current.id);
    expect(result.metadata?.project).toEqual({ id: ownProjectId, name: 'Alpha' });
    expect(result.metadata?.workspace).toBeNull();
    expect(result.metadata?.mode).toBe('plan');
    expect(result.metadata?.agent_role).toBe('leader');
    expect(result.metadata?.provider).toBe('p');
    expect(result.metadata?.model).toBe('m');
    expect(result.metadata?.todos).toEqual({ total: 2, open: 1 });
    expect(result.metadata?.current_stream).toEqual({ stream_id: 'stream_1', turn_id: 'turn_1' });
    expect(result.metadata?.worktree).toEqual({ worktreeId: 'wkt_1', repoPath: '.' });

    const serialized = JSON.stringify(result.metadata);
    expect(serialized).not.toContain('DO-NOT-LEAK-MESSAGE');
    expect(serialized).not.toContain('in progress text');
    expect(result.metadata).not.toHaveProperty('messages');
  });
});

/**
 * Workstream A1: read-only hybrid awareness — merged local + remote sessions.
 */
describe('hybrid awareness — list_sessions', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let localProjectId: string;
  let currentId: string;

  const remoteSession = {
    id: 'rs1',
    name: 'Remote Session',
    project_id: 'rp1',
    owner_id: 'u9',
    settings: { agentRole: 'leader', provider: 'p', model: 'm' },
    status: { blocked: null, cancel_requested: false, queue_stopped: false },
    activity: { type: 'idle' },
    pending_count: 2,
    todos: [{ id: 't1', content: 'x', status: 'pending', priority: 'medium' }],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2027-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-hybrid-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });

    const project = projectStore.create('Local Project', 'u1');
    await projectStore.save(project);
    localProjectId = project.id;

    const current = await sessionManager.createSession({
      title: 'Current', projectId: localProjectId, userId: 'u1', ownerId: 'u1',
    });
    currentId = current.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(remote?: unknown): ToolContext {
    return {
      sessionId: currentId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: {
        sessionManager,
        projectStore,
        sessionId: currentId,
        principal: { userId: 'u1', roles: ['USER'] },
        isElevatedPrincipal: false,
        ...(remote ? { getRemoteClient: () => remote } : {}),
      },
    };
  }

  function remoteClient(overrides: Record<string, unknown> = {}) {
    return {
      listAllSessions: vi.fn(async () => ({ items: [remoteSession], total: 1, truncated: false })),
      listAllProjects: async () => ({ items: [], total: 0, truncated: false }),
      ...overrides,
    };
  }

  it('merged: local + remote, remote: id, is_current только локальная', async () => {
    const result = await listSessionsTool.execute({}, makeCtx(remoteClient()));
    const sessions = result.metadata?.sessions as Array<Record<string, unknown>>;
    const local = sessions.find((session) => session.id === currentId)!;
    const remote = sessions.find((session) => session.id === 'remote:rs1')!;

    expect(local.origin).toBe('local');
    expect(local.cross_instance).toBe(false);
    expect(local.is_current).toBe(true);

    expect(remote.origin).toBe('remote');
    expect(remote.cross_instance).toBe(true);
    expect(remote.is_current).toBe(false);
    expect(remote.project_id).toBe('remote:rp1');
    expect(remote.title).toBe('Remote Session');
    expect(remote.pending_count).toBe(2);
    expect(remote.todos_open).toBe(1);
    expect(result.metadata?.total).toBe(2);
  });

  it('remote-проект: только удалённые сессии, toLocalId в запросе', async () => {
    const client = remoteClient();
    const result = await listSessionsTool.execute({ project: 'remote:rp1' }, makeCtx(client));
    const sessions = result.metadata?.sessions as Array<Record<string, unknown>>;
    expect(sessions.map((session) => session.id)).toEqual(['remote:rs1']);
    expect(client.listAllSessions).toHaveBeenCalledWith('rp1');
  });

  it('локальный проект: только локальные, remote не запрашивается', async () => {
    const client = remoteClient();
    const result = await listSessionsTool.execute({ project: localProjectId }, makeCtx(client));
    const sessions = result.metadata?.sessions as Array<Record<string, unknown>>;
    expect(sessions.map((session) => session.id)).toEqual([currentId]);
    expect(client.listAllSessions).not.toHaveBeenCalled();
  });

  it('remote offline: локальные + flag', async () => {
    const client = remoteClient({
      listAllSessions: async () => { throw new RemoteError('offline', 'OFFLINE'); },
    });
    const result = await listSessionsTool.execute({}, makeCtx(client));
    expect((result.metadata?.sessions as Array<Record<string, unknown>>).map((s) => s.id)).toEqual([currentId]);
    expect(result.metadata?.remote_offline).toBe(true);
  });

  it('query по title обоих миров', async () => {
    const result = await listSessionsTool.execute({ query: 'remote sess' }, makeCtx(remoteClient()));
    expect((result.metadata?.sessions as Array<Record<string, unknown>>).map((s) => s.id)).toEqual(['remote:rs1']);
  });
});
