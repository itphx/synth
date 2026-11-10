import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateId, ProjectRole, type ToolContext } from '@itphx/synth-shared';
import { listProjectsTool, getProjectTool } from './project-query.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { RemoteError } from '../../remote/types.js';

interface Viewer {
  userId: string;
  roles: string[];
}

describe('list_projects / get_project (Workstream B)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let sessionId: string;
  let ownId: string;
  let memberId: string;
  let foreignId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-query-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });

    const session = await sessionManager.createSession({ title: 'Current' });
    sessionId = session.id;
    await sessionManager.withLock(sessionId, async (s) => {
      s.ownerId = 'u1';
      s.userId = 'u1';
      await sessionManager.saveSession(s);
    });

    const own = projectStore.create('Alpha', 'u1', { description: 'First project' });
    own.invariants = 'TOP-SECRET-INVARIANT';
    own.log = [{ id: 'log1', text: 'SECRET-LOG', createdAt: own.createdAt }];
    own.workspace = 'alpha-ws';
    await projectStore.save(own);
    ownId = own.id;

    const member = projectStore.create('Beta', 'u2', { description: 'Team project' });
    member.members = { u2: ProjectRole.OWNER, u1: ProjectRole.EDITOR };
    member.workspace = 'beta-ws';
    await projectStore.save(member);
    memberId = member.id;

    const viewer = projectStore.create('Delta', 'u2');
    viewer.members = { u2: ProjectRole.OWNER, u1: ProjectRole.VIEWER };
    await projectStore.save(viewer);

    const foreign = projectStore.create('Gamma', 'u3');
    await projectStore.save(foreign);
    foreignId = foreign.id;

    const alphaTwo = projectStore.create('Alpha Two', 'u1');
    await projectStore.save(alphaTwo);

    // Два видимых проекта с одинаковым именем — неоднозначность.
    const dupA = projectStore.create('Dup', 'u1');
    const dupB = projectStore.create('Dup', 'u1');
    await projectStore.save(dupA);
    await projectStore.save(dupB);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(viewer: Viewer = { userId: 'u1', roles: ['USER'] }): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: {
        sessionManager,
        projectStore,
        sessionId,
        principal: viewer,
        isElevatedPrincipal: viewer.roles.some((role) => role === 'ADMIN' || role === 'LEAD'),
      },
    };
  }

  function names(result: { metadata?: Record<string, unknown> }): string[] {
    const projects = (result.metadata?.projects ?? []) as Array<{ name: string }>;
    return projects.map((project) => project.name);
  }

  it('list_projects: свои и проекты участия видны, чужие — нет', async () => {
    const result = await listProjectsTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();

    const list = names(result);
    expect(list).toContain('Alpha');
    expect(list).toContain('Beta');
    expect(list).toContain('Delta');
    expect(list).not.toContain('Gamma');

    const projects = result.metadata?.projects as Array<Record<string, unknown>>;
    const alpha = projects.find((project) => project.id === ownId)!;
    const beta = projects.find((project) => project.id === memberId)!;
    const delta = projects.find((project) => project.name === 'Delta')!;

    expect(alpha.my_role).toBe('OWNER');
    expect(alpha.members_count).toBe(1);
    expect(alpha.repos_count).toBe(0);
    expect(beta.my_role).toBe('EDITOR');
    expect(delta.my_role).toBe('VIEWER');
    expect(result.metadata?.total).toBeGreaterThan(0);
  });

  it('list_projects: elevated (ADMIN) видит все проекты', async () => {
    const result = await listProjectsTool.execute({}, makeCtx({ userId: 'admin', roles: ['ADMIN'] }));
    expect(names(result)).toContain('Gamma');
    expect(result.metadata?.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: foreignId, owner_id: 'u3' })]),
    );
  });

  it('list_projects: query по имени и описанию, без учёта регистра', async () => {
    const byName = await listProjectsTool.execute({ query: 'aLPha' }, makeCtx());
    expect(names(byName).sort()).toEqual(['Alpha', 'Alpha Two']);

    const byDescription = await listProjectsTool.execute({ query: 'team' }, makeCtx());
    expect(names(byDescription)).toEqual(['Beta']);
  });

  it('list_projects: пагинация limit/offset/next_offset', async () => {
    const first = await listProjectsTool.execute({ limit: 2, offset: 0 }, makeCtx());
    expect((first.metadata?.projects as unknown[]).length).toBe(2);
    expect(first.metadata?.limit).toBe(2);
    expect(first.metadata?.offset).toBe(0);
    expect(first.metadata?.next_offset).toBe(2);

    const second = await listProjectsTool.execute({ limit: 2, offset: 2 }, makeCtx());
    expect(second.metadata?.offset).toBe(2);

    const last = await listProjectsTool.execute({ limit: 100, offset: 0 }, makeCtx());
    expect(last.metadata?.next_offset).toBeNull();
  });

  it('list_projects: сводки без log/invariants и секретов', async () => {
    const result = await listProjectsTool.execute({}, makeCtx());
    const projects = result.metadata?.projects as Array<Record<string, unknown>>;
    const alpha = projects.find((project) => project.id === ownId)!;

    expect(alpha).not.toHaveProperty('invariants');
    expect(alpha).not.toHaveProperty('log');
    const serialized = JSON.stringify(result.metadata);
    expect(serialized).not.toContain('TOP-SECRET-INVARIANT');
    expect(serialized).not.toContain('SECRET-LOG');
  });

  it('get_project: резолв по имени без учёта регистра + my_role/can_edit/workspace', async () => {
    const own = await getProjectTool.execute({ project: 'aLPHA' }, makeCtx());
    expect(own.isError).toBeUndefined();
    expect(own.metadata?.id).toBe(ownId);
    expect(own.metadata?.my_role).toBe('OWNER');
    expect(own.metadata?.can_edit).toBe(true);
    expect(own.metadata?.workspace).toBe('alpha-ws');
    expect(own.metadata?.sessions_count).toBe(0);

    const member = await getProjectTool.execute({ project: memberId }, makeCtx());
    expect(member.metadata?.my_role).toBe('EDITOR');
    expect(member.metadata?.can_edit).toBe(true);

    const viewer = await getProjectTool.execute({ project: 'delta' }, makeCtx());
    expect(viewer.metadata?.my_role).toBe('VIEWER');
    expect(viewer.metadata?.can_edit).toBe(false);
  });

  it('get_project: sessions_count считает сессии проекта', async () => {
    const project = projectStore.create('WithSessions', 'u1');
    await projectStore.save(project);
    const first = await sessionManager.createSession({ title: 's1', projectId: project.id, userId: 'u1' });
    await sessionManager.saveSession(first);

    const result = await getProjectTool.execute({ project: project.id }, makeCtx());
    expect(result.metadata?.sessions_count).toBe(1);
  });

  it('get_project: не найден — понятная ошибка со ссылкой на list_projects', async () => {
    const result = await getProjectTool.execute({ project: 'nope' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
    expect(result.content).toContain('list_projects');
    expect(result.metadata?.found).toBe(false);
  });

  it('get_project: чужие проекты не видны', async () => {
    const byName = await getProjectTool.execute({ project: 'Gamma' }, makeCtx());
    expect(byName.isError).toBe(true);
    expect(byName.metadata?.found).toBe(false);

    const byId = await getProjectTool.execute({ project: foreignId }, makeCtx());
    expect(byId.isError).toBe(true);
    expect(byId.metadata?.found).toBe(false);
  });

  it('get_project: неоднозначное имя возвращает кандидатов и не выбирает первый', async () => {
    const result = await getProjectTool.execute({ project: 'Dup' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.metadata?.ambiguous).toBe(true);
    const candidates = result.metadata?.candidates as Array<Record<string, unknown>>;
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.name)).toEqual(['Dup', 'Dup']);
  });

  it('get_project: детали без log и полного invariants', async () => {
    const result = await getProjectTool.execute({ project: 'Alpha' }, makeCtx());
    const serialized = JSON.stringify(result.metadata);
    expect(serialized).not.toContain('TOP-SECRET-INVARIANT');
    expect(serialized).not.toContain('SECRET-LOG');
    expect(result.metadata).not.toHaveProperty('log');
    expect(result.metadata).not.toHaveProperty('invariants');
  });
});

/**
 * Workstream A1: read-only hybrid awareness — merged local + remote lists and
 * remote project details. Cross-world attach запрещён (проверяется в
 * project-manage.test.ts).
 */
describe('hybrid awareness — list_projects/get_project', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let sessionId: string;
  let localProjectId: string;

  const remoteDto = {
    id: 'rp1',
    name: 'Remote Project',
    description: 'From backend',
    owner_id: 'u9',
    members: { u9: 'owner', u1: 'viewer' },
    workspace: 'remote-ws',
    current_task: 'remote task',
    repos: [{ path: 'repo', name: 'repo' }],
    mcp: { enabled: ['srv'] },
    memory: { enabled: true },
    created_at: '2026-02-01T00:00:00.000Z',
    updated_at: '2027-01-01T00:00:00.000Z',
    plan: { secret: true },
    log: [{ text: 'SECRET-LOG' }],
    invariants: 'SECRET-INV',
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-hybrid-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    const session = await sessionManager.createSession({ title: 'Current' });
    sessionId = session.id;
    await sessionManager.withLock(sessionId, async (s) => {
      s.ownerId = 'u1';
      s.userId = 'u1';
      await sessionManager.saveSession(s);
    });
    const project = projectStore.create('Local Project', 'u1');
    await projectStore.save(project);
    localProjectId = project.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(remote?: unknown): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: {
        sessionManager,
        projectStore,
        sessionId,
        principal: { userId: 'u1', roles: ['USER'] },
        isElevatedPrincipal: false,
        ...(remote ? { getRemoteClient: () => remote } : {}),
      },
    };
  }

  function remoteClient(overrides: Record<string, unknown> = {}) {
    return {
      listAllProjects: async () => ({ items: [remoteDto], total: 1, truncated: false }),
      getProject: async () => remoteDto,
      listAllSessions: async () => ({ items: [], total: 0, truncated: false }),
      ...overrides,
    };
  }

  it('list_projects: merged local+remote с origin/can_attach и remote: id', async () => {
    const result = await listProjectsTool.execute({}, makeCtx(remoteClient()));
    const projects = result.metadata?.projects as Array<Record<string, unknown>>;
    const local = projects.find((project) => project.id === localProjectId)!;
    const remote = projects.find((project) => project.id === 'remote:rp1')!;

    expect(local.origin).toBe('local');
    expect(local.can_attach).toBe(true);
    expect(local.cross_instance).toBe(false);
    expect(remote.origin).toBe('remote');
    expect(remote.can_attach).toBe(false);
    expect(remote.cross_instance).toBe(true);
    expect(remote.my_role).toBeNull();
    expect(remote.members_count).toBe(2);
    expect(result.metadata?.total).toBe(2);
  });

  it('list_projects: query и пагинация по merged-списку', async () => {
    const query = await listProjectsTool.execute({ query: 'remote' }, makeCtx(remoteClient()));
    expect((query.metadata?.projects as Array<Record<string, unknown>>).map((p) => p.id)).toEqual(['remote:rp1']);

    const page = await listProjectsTool.execute({ limit: 1, offset: 0 }, makeCtx(remoteClient()));
    expect((page.metadata?.projects as unknown[]).length).toBe(1);
    expect(page.metadata?.total).toBe(2);
    expect(page.metadata?.next_offset).toBe(1);
  });

  it('list_projects: remote offline → локальный список + flag', async () => {
    const client = remoteClient({
      listAllProjects: async () => { throw new RemoteError('offline', 'OFFLINE'); },
    });
    const result = await listProjectsTool.execute({}, makeCtx(client));
    expect((result.metadata?.projects as Array<Record<string, unknown>>).map((p) => p.id)).toEqual([localProjectId]);
    expect(result.metadata?.remote_offline).toBe(true);
    expect(result.metadata?.warnings).toContain('remote_offline');
  });

  it('get_project: remote: ref и безопасная деталь без plan/log/invariants', async () => {
    const result = await getProjectTool.execute({ project: 'remote:rp1' }, makeCtx(remoteClient()));
    expect(result.isError).toBeUndefined();
    expect(result.metadata).toMatchObject({
      id: 'remote:rp1',
      name: 'Remote Project',
      origin: 'remote',
      cross_instance: true,
      can_attach: false,
      can_edit: false,
      sessions_count: null,
    });
    const serialized = JSON.stringify(result.metadata);
    expect(serialized).not.toContain('SECRET-LOG');
    expect(serialized).not.toContain('SECRET-INV');
    expect(result.metadata).not.toHaveProperty('plan');
    expect(result.metadata).not.toHaveProperty('log');
    expect(result.metadata).not.toHaveProperty('invariants');
  });

  it('get_project: локальный не найден → поиск по имени в remote', async () => {
    const result = await getProjectTool.execute({ project: 'Remote Project' }, makeCtx(remoteClient()));
    expect(result.isError).toBeUndefined();
    expect(result.metadata).toMatchObject({ id: 'remote:rp1', origin: 'remote' });
  });

  it('get_project: неоднозначное имя в remote → кандидаты remote:', async () => {
    const client = remoteClient({
      listAllProjects: async () => ({
        items: [
          { ...remoteDto, id: 'rp1' },
          { ...remoteDto, id: 'rp2' },
        ],
        total: 2,
        truncated: false,
      }),
    });
    const result = await getProjectTool.execute({ project: 'Remote Project' }, makeCtx(client));
    expect(result.isError).toBe(true);
    expect(result.metadata?.ambiguous).toBe(true);
    const candidates = result.metadata?.candidates as Array<Record<string, unknown>>;
    expect(candidates.map((candidate) => candidate.id)).toEqual(['remote:rp1', 'remote:rp2']);
  });

  it('get_project: remote offline при локальном not found → not found + flag', async () => {
    const client = remoteClient({
      listAllProjects: async () => { throw new RemoteError('offline', 'OFFLINE'); },
    });
    const result = await getProjectTool.execute({ project: 'Nope' }, makeCtx(client));
    expect(result.isError).toBe(true);
    expect(result.metadata?.found).toBe(false);
    expect(result.metadata?.remote_offline).toBe(true);
  });
});
