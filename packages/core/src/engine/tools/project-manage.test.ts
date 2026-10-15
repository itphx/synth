import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectCreateTool, projectAttachTool, projectUpdateTool, projectWorkspaceSetTool, projectLogWriteTool, projectLogReadTool, projectInvariantsReadTool, projectInvariantsWriteTool } from './project-manage.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { EventBus } from '../../events/bus.js';
import type { ToolContext } from '@itphx/synth-shared';
import { generateId, ProjectRole } from '@itphx/synth-shared';

describe('project_create / project_attach', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-manage-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();

    const session = await sessionManager.createSession({ title: 'No project' });
    sessionId = session.id;
    // createSession без userId оставляет ownerId пустым — задаём явно, как это делает app.ts
    await sessionManager.withLock(sessionId, async (s) => {
      s.ownerId = 'u1';
      await sessionManager.saveSession(s);
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: { sessionManager, projectStore, sessionId, eventBus, workspacesRoot: join(tmpDir, 'workspaces') },
    };
  }

  it('project_create создаёт проект и привязывает сессию', async () => {
    const result = await projectCreateTool.execute({ name: 'My Project' }, makeCtx());
    expect(result.isError).toBeUndefined();

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.projectId).toBeTruthy();
    const project = (await projectStore.load(session.projectId!))!;
    expect(project.name).toBe('My Project');
    expect(project.ownerId).toBe('u1');
  });

  it('project_create возвращает id/name/workspace и публикует session.moved', async () => {
    let moved: Record<string, unknown> | undefined;
    eventBus.subscribe(sessionId, (e) => {
      if (e.type === 'session.moved') moved = e.data as Record<string, unknown>;
    });

    // Абсолютный путь внутри workspacesRoot нормализуется в относительный
    // (ADR-075: provisioning общий с HTTP-роутом — политика/containment соблюдены).
    const absWs = join(tmpDir, 'workspaces', 'abs-ws');
    const result = await projectCreateTool.execute({ name: 'P', workspace: absWs }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.name).toBe('P');
    expect(result.metadata?.workspace).toBe('abs-ws');
    expect(result.metadata?.id).toBeTruthy();
    expect((await stat(absWs)).isDirectory()).toBe(true);

    expect(moved).toBeTruthy();
    expect(moved?.session_id).toBe(sessionId);
    expect(moved?.project_id).toBe(result.metadata?.id);
  });

  it('project_create создаёт каталог workspace (ADR-075)', async () => {
    const ctx = makeCtx();
    const result = await projectCreateTool.execute({ name: 'WS', workspace: 'rel-ws' }, ctx);
    expect(result.isError).toBeUndefined();

    const dir = join(tmpDir, 'workspaces', 'rel-ws');
    expect((await stat(dir)).isDirectory()).toBe(true);

    const session = (await sessionManager.getSession(sessionId))!;
    const project = (await projectStore.load(session.projectId!))!;
    expect(project.workspace).toBe('rel-ws');
  });

  it('project_create без projectStore — ошибка', async () => {
    const ctx = makeCtx();
    delete (ctx.extra as Record<string, unknown>).projectStore;
    const result = await projectCreateTool.execute({ name: 'X' }, ctx);
    expect(result.isError).toBe(true);
  });

  it('project_attach привязывает сессию к существующему проекту и сбрасывает planApproved', async () => {
    const project = projectStore.create('Existing', 'u1');
    await projectStore.save(project);

    // предварительно ставим planApproved, чтобы проверить сброс
    await sessionManager.withLock(sessionId, async (s) => {
      s.planApproved = true;
      await sessionManager.saveSession(s);
    });

    const result = await projectAttachTool.execute({ projectId: project.id }, makeCtx());
    expect(result.isError).toBeUndefined();

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.projectId).toBe(project.id);
    expect(session.planApproved).toBe(false);
  });

  it('project_attach к несуществующему проекту — ошибка', async () => {
    const result = await projectAttachTool.execute({ projectId: 'missing' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('project_attach к чужому проекту — отказ (write_forbidden), сессия не привязана', async () => {
    const foreign = projectStore.create('Foreign', 'someone-else');
    await projectStore.save(foreign);

    const result = await projectAttachTool.execute({ projectId: foreign.id }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toEqual({ key: 'project.write_forbidden' });

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.projectId).toBeUndefined();
  });

  it('project_attach публикует session.moved', async () => {
    const project = projectStore.create('Target', 'u1');
    await projectStore.save(project);

    let moved: Record<string, unknown> | undefined;
    eventBus.subscribe(sessionId, (e) => {
      if (e.type === 'session.moved') moved = e.data as Record<string, unknown>;
    });

    await projectAttachTool.execute({ projectId: project.id }, makeCtx());
    expect(moved).toBeTruthy();
    expect(moved?.project_id).toBe(project.id);
  });
});

describe('project_log / project_invariants', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let sessionId: string;
  let projectId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-log-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();

    const session = await sessionManager.createSession({ title: 'No project' });
    sessionId = session.id;
    await sessionManager.withLock(sessionId, async (s) => {
      s.ownerId = 'u1';
      await sessionManager.saveSession(s);
    });

    // привязываем сессию к проекту
    const project = projectStore.create('Log Project', 'u1');
    await projectStore.save(project);
    projectId = project.id;
    await sessionManager.withLock(sessionId, async (s) => {
      s.projectId = projectId;
      await sessionManager.saveSession(s);
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: { sessionManager, projectStore, sessionId, eventBus, workspacesRoot: join(tmpDir, 'workspaces') },
    };
  }

  it('project_log_write добавляет запись в project.log', async () => {
    const result = await projectLogWriteTool.execute({ text: 'Сделал X' }, makeCtx());
    expect(result.isError).toBeUndefined();

    const project = (await projectStore.load(projectId))!;
    expect(project.log).toHaveLength(1);
    const log = project.log!;
    const entry = log[0]!;
    expect(entry.text).toBe('Сделал X');
    expect(entry.id).toBeTruthy();
    expect(entry.createdAt).toBeTruthy();
    expect(entry.sessionId).toBe(sessionId);
  });

  it('project_log_write без проекта — ошибка', async () => {
    await sessionManager.withLock(sessionId, async (s) => {
      s.projectId = undefined;
      await sessionManager.saveSession(s);
    });

    const result = await projectLogWriteTool.execute({ text: 'X' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No project');
  });

  it('project_log_read рендерит markdown', async () => {
    await projectLogWriteTool.execute({ text: 'Запись 1' }, makeCtx());
    await projectLogWriteTool.execute({ text: 'Запись 2' }, makeCtx());

    const result = await projectLogReadTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Project log (2)');
    expect(result.content).toContain('— Запись 1');
    expect(result.content).toContain('— Запись 2');
  });

  it('project_log_read пустой лог → «Лог пуст»', async () => {
    const result = await projectLogReadTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('Log is empty');
  });

  it('project_invariants_read возвращает инварианты', async () => {
    await projectInvariantsWriteTool.execute({ invariants: 'Не коммитить без тестов' }, makeCtx());

    const result = await projectInvariantsReadTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('Не коммитить без тестов');
  });

  it('project_invariants_read пустые → «Инварианты не заданы»', async () => {
    const result = await projectInvariantsReadTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('Invariants are not set');
  });

  it('project_invariants_write устанавливает project.invariants', async () => {
    const result = await projectInvariantsWriteTool.execute({ invariants: 'Правило 1' }, makeCtx());
    expect(result.isError).toBeUndefined();

    const project = (await projectStore.load(projectId))!;
    expect(project.invariants).toBe('Правило 1');
  });
});

// ---------------------------------------------------------------------------
// ADR-075/D5: доступ к записи проектных данных (invariants/log) — owner/EDITOR
// разрешены, VIEWER/посторонний — нет, неатрибутированный синтетический
// контекст — back-compat.
// ---------------------------------------------------------------------------
describe('project_log / project_invariants: RBAC (ADR-075/D5)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let sessionId: string;
  let projectId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-rbac-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();

    const project = projectStore.create('RBAC Project', 'owner');
    project.members['editor'] = ProjectRole.EDITOR;
    project.members['viewer'] = ProjectRole.VIEWER;
    await projectStore.save(project);
    projectId = project.id;

    const session = await sessionManager.createSession({ title: 'RBAC' });
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Привязывает сессию к проекту с заданной атрибуцией (userId/ownerId). */
  async function bindSession(userId?: string, ownerId?: string, targetProjectId = projectId): Promise<void> {
    await sessionManager.withLock(sessionId, async (s) => {
      s.projectId = targetProjectId;
      s.userId = userId;
      s.ownerId = ownerId;
      await sessionManager.saveSession(s);
    });
  }

  function makeCtx(): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: { sessionManager, projectStore, sessionId, eventBus },
    };
  }

  it('owner (session.userId === project.ownerId) пишет log и invariants', async () => {
    await bindSession('owner');

    const log = await projectLogWriteTool.execute({ text: 'запись' }, makeCtx());
    expect(log.isError).toBeUndefined();
    const inv = await projectInvariantsWriteTool.execute({ invariants: 'правило' }, makeCtx());
    expect(inv.isError).toBeUndefined();

    const stored = (await projectStore.load(projectId))!;
    expect(stored.log).toHaveLength(1);
    expect(stored.invariants).toBe('правило');
  });

  it('session.ownerId используется как fallback к userId', async () => {
    await bindSession(undefined, 'owner');

    const log = await projectLogWriteTool.execute({ text: 'запись' }, makeCtx());
    expect(log.isError).toBeUndefined();
    const stored = (await projectStore.load(projectId))!;
    expect(stored.log).toHaveLength(1);
  });

  it('EDITOR пишет log и invariants', async () => {
    await bindSession('editor');

    const log = await projectLogWriteTool.execute({ text: 'запись' }, makeCtx());
    expect(log.isError).toBeUndefined();
    const inv = await projectInvariantsWriteTool.execute({ invariants: 'правило' }, makeCtx());
    expect(inv.isError).toBeUndefined();

    const stored = (await projectStore.load(projectId))!;
    expect(stored.log).toHaveLength(1);
    expect(stored.invariants).toBe('правило');
  });

  it('VIEWER — отказ, проект не изменён', async () => {
    await bindSession('viewer');

    const log = await projectLogWriteTool.execute({ text: 'нельзя' }, makeCtx());
    expect(log.isError).toBe(true);
    expect(log.metadata?.i18n).toEqual({ key: 'project.write_forbidden' });

    const inv = await projectInvariantsWriteTool.execute({ invariants: 'нельзя' }, makeCtx());
    expect(inv.isError).toBe(true);
    expect(inv.metadata?.i18n).toEqual({ key: 'project.write_forbidden' });

    const stored = (await projectStore.load(projectId))!;
    expect(stored.log).toHaveLength(0);
    expect(stored.invariants).toBe('');
  });

  it('не-участник — отказ, проект не изменён', async () => {
    await bindSession('outsider');

    const log = await projectLogWriteTool.execute({ text: 'нельзя' }, makeCtx());
    expect(log.isError).toBe(true);
    const inv = await projectInvariantsWriteTool.execute({ invariants: 'нельзя' }, makeCtx());
    expect(inv.isError).toBe(true);

    const stored = (await projectStore.load(projectId))!;
    expect(stored.log).toHaveLength(0);
    expect(stored.invariants).toBe('');
  });

  it('неидентифицируемый контекст (нет userId, ownerId пуст) — разрешено', async () => {
    const bare = projectStore.create('Bare', '');
    await projectStore.save(bare);
    await bindSession(undefined, undefined, bare.id);

    const log = await projectLogWriteTool.execute({ text: 'можно' }, makeCtx());
    expect(log.isError).toBeUndefined();
    const inv = await projectInvariantsWriteTool.execute({ invariants: 'можно' }, makeCtx());
    expect(inv.isError).toBeUndefined();

    const stored = (await projectStore.load(bare.id))!;
    expect(stored.log).toHaveLength(1);
    expect(stored.invariants).toBe('можно');
  });
});

// ---------------------------------------------------------------------------
// project_update / project_workspace_set (ADR-075/D5/D8)
// ---------------------------------------------------------------------------
describe('project_update', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let sessionId: string;
  let projectId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-update-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();

    const project = projectStore.create('Old name', 'u1');
    await projectStore.save(project);
    projectId = project.id;

    const session = await sessionManager.createSession({ title: 'Update' });
    sessionId = session.id;
    await sessionManager.withLock(sessionId, async (s) => {
      s.projectId = projectId;
      s.ownerId = 'u1';
      await sessionManager.saveSession(s);
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: { sessionManager, projectStore, sessionId, eventBus, workspacesRoot: join(tmpDir, 'workspaces') },
    };
  }

  it('обновляет переданные поля и публикует project.updated', async () => {
    let updated: Record<string, unknown> | undefined;
    eventBus.subscribe(sessionId, (e) => {
      if (e.type === 'project.updated') updated = e.data as Record<string, unknown>;
    });

    const result = await projectUpdateTool.execute({ name: 'New name', description: 'desc' }, makeCtx());
    expect(result.isError).toBeUndefined();

    const stored = (await projectStore.load(projectId))!;
    expect(stored.name).toBe('New name');
    expect(stored.description).toBe('desc');
    expect(stored.updatedAt).toBeTruthy();
    expect(updated?.project_id).toBe(projectId);
  });

  it('без проекта — ошибка project.no_project', async () => {
    await sessionManager.withLock(sessionId, async (s) => {
      s.projectId = undefined;
      await sessionManager.saveSession(s);
    });

    const result = await projectUpdateTool.execute({ name: 'X' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toEqual({ key: 'project.no_project' });
  });

  it('не владелец/редактор — project.write_forbidden, проект не изменён', async () => {
    await sessionManager.withLock(sessionId, async (s) => {
      s.ownerId = 'outsider';
      await sessionManager.saveSession(s);
    });

    const result = await projectUpdateTool.execute({ name: 'Hacked' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toEqual({ key: 'project.write_forbidden' });

    const stored = (await projectStore.load(projectId))!;
    expect(stored.name).toBe('Old name');
  });

  it('обновляет валидные icon/color', async () => {
    const result = await projectUpdateTool.execute({ icon: 'rocket', color: 'a11' }, makeCtx());
    expect(result.isError).toBeUndefined();

    const stored = (await projectStore.load(projectId))!;
    expect(stored.icon).toBe('rocket');
    expect(stored.color).toBe('a11');
  });

  it('невалидный icon → project.invalid_icon с перечнем ключей, проект не изменён', async () => {
    const result = await projectUpdateTool.execute({ icon: '🚀' }, makeCtx());
    expect(result.isError).toBe(true);
    const meta = result.metadata as { i18n?: { key: string; params?: Record<string, string> } } | undefined;
    expect(meta?.i18n).toMatchObject({ key: 'project.invalid_icon' });
    expect(meta?.i18n?.params?.allowed).toContain('rocket');

    const stored = (await projectStore.load(projectId))!;
    expect(stored.icon).toBeUndefined();
  });

  it('невалидный color → project.invalid_color с перечнем ключей, проект не изменён', async () => {
    const result = await projectUpdateTool.execute({ color: 'blue' }, makeCtx());
    expect(result.isError).toBe(true);
    const meta = result.metadata as { i18n?: { key: string; params?: Record<string, string> } } | undefined;
    expect(meta?.i18n).toMatchObject({ key: 'project.invalid_color' });
    expect(meta?.i18n?.params?.allowed).toContain('a1');

    const stored = (await projectStore.load(projectId))!;
    expect(stored.color).toBeUndefined();
  });
});

describe('project_workspace_set', () => {
  let tmpDir: string;
  let workspacesRoot: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let sessionId: string;
  let projectId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-ws-'));
    workspacesRoot = join(tmpDir, 'workspaces');
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();

    const project = projectStore.create('WS Project', 'u1');
    await projectStore.save(project);
    projectId = project.id;

    const session = await sessionManager.createSession({ title: 'Workspace' });
    sessionId = session.id;
    await sessionManager.withLock(sessionId, async (s) => {
      s.projectId = projectId;
      s.ownerId = 'u1';
      await sessionManager.saveSession(s);
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Record<string, unknown> = {}): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: {
        sessionManager,
        projectStore,
        sessionId,
        eventBus,
        workspacesRoot,
        getWorkspaceOutsideRootPolicy: () => 'confirm',
        ...overrides,
      },
    };
  }

  it('относительный путь: создаёт каталог, сохраняет workspace, публикует событие', async () => {
    let updated: Record<string, unknown> | undefined;
    eventBus.subscribe(sessionId, (e) => {
      if (e.type === 'project.updated') updated = e.data as Record<string, unknown>;
    });

    const result = await projectWorkspaceSetTool.execute({ workspace: 'ws-new' }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect((await stat(join(workspacesRoot, 'ws-new'))).isDirectory()).toBe(true);

    const stored = (await projectStore.load(projectId))!;
    expect(stored.workspace).toBe('ws-new');
    expect(stored.updatedAt).toBeTruthy();
    expect(updated?.project_id).toBe(projectId);
  });

  it('managed: абсолютный путь вне root → project.workspace_denied', async () => {
    const result = await projectWorkspaceSetTool.execute(
      { workspace: join(tmpDir, 'outside-ws') },
      makeCtx({ workspaceManaged: true }),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toEqual({ key: 'project.workspace_denied' });

    const stored = (await projectStore.load(projectId))!;
    expect(stored.workspace).toBeUndefined();
  });

  it('standalone: абсолютный путь вне root без подтверждения → project.workspace_confirm_required', async () => {
    const result = await projectWorkspaceSetTool.execute({ workspace: join(tmpDir, 'outside-ws') }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toEqual({ key: 'project.workspace_confirm_required' });
  });

  it('standalone: confirmOutsideRoot=true разрешает абсолютный путь вне root', async () => {
    const outside = join(tmpDir, 'outside-ws');
    const result = await projectWorkspaceSetTool.execute(
      { workspace: outside, confirmOutsideRoot: true },
      makeCtx(),
    );
    expect(result.isError).toBeUndefined();

    const stored = (await projectStore.load(projectId))!;
    expect(stored.workspace).toBe(outside);
  });

  it('пустой workspace → project.workspace_invalid', async () => {
    const result = await projectWorkspaceSetTool.execute({ workspace: '   ' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toEqual({ key: 'project.workspace_invalid' });
  });
});
