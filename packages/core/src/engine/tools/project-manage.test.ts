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
import { RemoteError } from '../../remote/types.js';

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

/**
 * ADR-114 §3.4: привязка к worktree принадлежит проекту — при переносе сессии
 * в другой проект она снимается (иначе рабочий каталог сессии оказался бы
 * вне её нового проекта). Факт снятия виден в ответе тула и в событии
 * `session.moved` — оба под одним wire-ключом `worktree_detached`
 * (snake_case — как `session_id`/`project_id` в событии).
 */
describe('project_attach — снятие привязки к worktree (ADR-114 §3.4)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let sessionId: string;
  let targetProjectId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-worktree-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();

    const current = projectStore.create('Current', 'u1');
    const target = projectStore.create('Target', 'u1');
    await projectStore.save(current);
    await projectStore.save(target);
    targetProjectId = target.id;

    const session = await sessionManager.createSession({
      title: 'Bound',
      projectId: current.id,
      userId: 'u1',
    });
    sessionId = session.id;
    await sessionManager.withLock(sessionId, async (s) => {
      s.ownerId = 'u1';
      s.worktree = {
        worktreeId: 'wkt_test',
        projectId: current.id,
        directory: join(tmpDir, 'worktrees', 'feature-x'),
        branch: 'feature/x',
      };
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

  it('привязка к worktree снимается, в metadata — worktree_detached: true', async () => {
    const result = await projectAttachTool.execute({ projectId: targetProjectId }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.worktree_detached).toBe(true);

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.projectId).toBe(targetProjectId);
    expect(session.worktree).toBeUndefined();
  });

  it('в опубликованном session.moved — worktree_detached: true', async () => {
    let moved: Record<string, unknown> | undefined;
    eventBus.subscribe(sessionId, (e) => {
      if (e.type === 'session.moved') moved = e.data as Record<string, unknown>;
    });

    await projectAttachTool.execute({ projectId: targetProjectId }, makeCtx());

    expect(moved).toBeTruthy();
    expect(moved?.project_id).toBe(targetProjectId);
    expect(moved?.worktree_detached).toBe(true);
  });

  it('сессия без привязки: worktree_detached не выставляется (прежнее поведение)', async () => {
    await sessionManager.withLock(sessionId, async (s) => {
      s.worktree = undefined;
      await sessionManager.saveSession(s);
    });

    let moved: Record<string, unknown> | undefined;
    eventBus.subscribe(sessionId, (e) => {
      if (e.type === 'session.moved') moved = e.data as Record<string, unknown>;
    });

    const result = await projectAttachTool.execute({ projectId: targetProjectId }, makeCtx());

    expect(result.isError).toBeUndefined();
    expect(result.metadata?.worktree_detached).toBeUndefined();
    expect(moved?.worktree_detached).toBeUndefined();
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

  // Дегенеративные пути проходили trim-проверку, но `normalizeWorkspace` давал
  // `undefined` → workspace молча очищался (ответ «workspace set» с пустым путём).
  // Очистка workspace тулом не поддерживается — это отказ.
  it.each(['.', '..', '/', ' / '])(
    'дегенеративный workspace %j → project.workspace_invalid, workspace не очищается',
    async (workspace) => {
      // Непустой workspace, который не должен пропасть.
      await projectStore.mutate(projectId, (project) => {
        project.workspace = 'keep-me';
      });

      const result = await projectWorkspaceSetTool.execute({ workspace }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.metadata?.i18n).toEqual({ key: 'project.workspace_invalid' });

      const stored = (await projectStore.load(projectId))!;
      expect(stored.workspace).toBe('keep-me');
    },
  );
});

/**
 * Workstream B: `project_attach` по имени проекта (агент не просит id у
 * пользователя), идемпотентность, предупреждение об отсутствии workspace.
 * Общий резолвер имени — тот же, что у `get_project` (`project-resolve.ts`).
 */
describe('project_attach — по имени (Workstream B)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-attach-name-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();

    const session = await sessionManager.createSession({ title: 'No project' });
    sessionId = session.id;
    await sessionManager.withLock(sessionId, async (s) => {
      s.ownerId = 'u1';
      s.userId = 'u1';
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

  function collectMoved(): Array<Record<string, unknown>> {
    const moved: Array<Record<string, unknown>> = [];
    eventBus.subscribe(sessionId, (event) => {
      if (event.type === 'session.moved') moved.push(event.data as Record<string, unknown>);
    });
    return moved;
  }

  it('привязывает по точному имени без учёта регистра и публикует session.moved', async () => {
    const project = projectStore.create('Named Project', 'u1', { workspace: 'named-ws' });
    await projectStore.save(project);
    const moved = collectMoved();

    const result = await projectAttachTool.execute({ project: 'named project' }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.id).toBe(project.id);
    expect(result.metadata?.name).toBe('Named Project');
    expect(result.metadata?.workspace).toBe('named-ws');
    expect(result.metadata?.my_role).toBe('OWNER');
    expect(result.metadata?.warning).toBeUndefined();

    expect((await sessionManager.getSession(sessionId))!.projectId).toBe(project.id);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.project_id).toBe(project.id);
  });

  it('projectId приоритетнее project, если переданы оба', async () => {
    const byId = projectStore.create('ById', 'u1');
    const byName = projectStore.create('ByName', 'u1');
    await projectStore.save(byId);
    await projectStore.save(byName);

    const result = await projectAttachTool.execute({ projectId: byId.id, project: 'ByName' }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect((await sessionManager.getSession(sessionId))!.projectId).toBe(byId.id);
  });

  it('неоднозначное имя — кандидаты, сессия не переносится', async () => {
    const a = projectStore.create('Dup', 'u1');
    const b = projectStore.create('Dup', 'u1');
    await projectStore.save(a);
    await projectStore.save(b);
    const moved = collectMoved();

    const result = await projectAttachTool.execute({ project: 'Dup' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.metadata?.ambiguous).toBe(true);
    expect((result.metadata?.candidates as unknown[]).length).toBe(2);
    expect((await sessionManager.getSession(sessionId))!.projectId).toBeUndefined();
    expect(moved).toHaveLength(0);
  });

  it('несуществующее имя — ошибка без переноса', async () => {
    const result = await projectAttachTool.execute({ project: 'Missing' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.metadata?.found).toBe(false);
    expect(result.content).toContain('not found');
    expect((await sessionManager.getSession(sessionId))!.projectId).toBeUndefined();
  });

  it('чужой проект по имени не резолвится (fail-closed), по id — write_forbidden', async () => {
    const foreign = projectStore.create('Foreign', 'someone-else');
    await projectStore.save(foreign);

    const byName = await projectAttachTool.execute({ project: 'Foreign' }, makeCtx());
    expect(byName.isError).toBe(true);
    expect(byName.metadata?.found).toBe(false);

    const byId = await projectAttachTool.execute({ projectId: foreign.id }, makeCtx());
    expect(byId.isError).toBe(true);
    expect(byId.metadata?.i18n).toEqual({ key: 'project.write_forbidden' });

    expect((await sessionManager.getSession(sessionId))!.projectId).toBeUndefined();
  });

  it('сессия уже в этом проекте — no-op без session.moved', async () => {
    const project = projectStore.create('Same', 'u1', { workspace: 'same-ws' });
    await projectStore.save(project);
    await sessionManager.withLock(sessionId, async (s) => {
      s.projectId = project.id;
      s.planApproved = true;
      await sessionManager.saveSession(s);
    });
    const moved = collectMoved();

    const result = await projectAttachTool.execute({ project: 'Same' }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.same_project).toBe(true);
    expect(moved).toHaveLength(0);

    const stored = (await sessionManager.getSession(sessionId))!;
    expect(stored.projectId).toBe(project.id);
    // no-op не сбрасывает утверждённый план.
    expect(stored.planApproved).toBe(true);
  });

  it('проект без workspace — предупреждение project_has_no_workspace', async () => {
    const project = projectStore.create('No Workspace', 'u1');
    await projectStore.save(project);

    const result = await projectAttachTool.execute({ project: 'No Workspace' }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.workspace).toBeNull();
    expect(result.metadata?.warning).toBe('project_has_no_workspace');
    expect(result.content).toContain('no workspace');
  });

  it('привязка к worktree снимается и при переносе по имени', async () => {
    const current = projectStore.create('Current', 'u1');
    const target = projectStore.create('Target', 'u1');
    await projectStore.save(current);
    await projectStore.save(target);
    await sessionManager.withLock(sessionId, async (s) => {
      s.projectId = current.id;
      s.worktree = {
        worktreeId: 'wkt_name',
        projectId: current.id,
        directory: join(tmpDir, 'worktrees', 'feature'),
        branch: 'feature/x',
      };
      await sessionManager.saveSession(s);
    });
    const moved = collectMoved();

    const result = await projectAttachTool.execute({ project: 'Target' }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.worktree_detached).toBe(true);
    expect(moved[0]?.worktree_detached).toBe(true);

    const stored = (await sessionManager.getSession(sessionId))!;
    expect(stored.projectId).toBe(target.id);
    expect(stored.worktree).toBeUndefined();
  });

  it('ни projectId, ни project — ошибка аргументов', async () => {
    const result = await projectAttachTool.execute({}, makeCtx());
    expect(result.isError).toBe(true);
  });
});

/**
 * Workstream A1: cross-world attach запрещён; локальный attach не блокируется
 * offline-деградацией remote, но одноимённый remote-проект даёт hybrid_ambiguous.
 */
describe('project_attach — hybrid awareness', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-hybrid-attach-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();
    const session = await sessionManager.createSession({ title: 'No project' });
    sessionId = session.id;
    await sessionManager.withLock(sessionId, async (s) => {
      s.ownerId = 'u1';
      s.userId = 'u1';
      await sessionManager.saveSession(s);
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(remote?: unknown): ToolContext {
    const ctx: ToolContext = {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: { sessionManager, projectStore, sessionId, eventBus, workspacesRoot: join(tmpDir, 'workspaces') },
    };
    if (remote) (ctx.extra as Record<string, unknown>).getRemoteClient = () => remote;
    return ctx;
  }

  function remoteClient(items: Array<Record<string, unknown>>, fail = false) {
    return {
      listAllProjects: async () => {
        if (fail) throw new RemoteError('offline', 'OFFLINE');
        return { items, total: items.length, truncated: false };
      },
    };
  }

  it('remote: id → cross_instance, сессия не привязана', async () => {
    const moved: unknown[] = [];
    eventBus.subscribe(sessionId, (event) => { if (event.type === 'session.moved') moved.push(event); });
    const result = await projectAttachTool.execute({ projectId: 'remote:rp1' }, makeCtx(remoteClient([])));
    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ cross_instance: true, project_id: 'remote:rp1' });
    expect((await sessionManager.getSession(sessionId))!.projectId).toBeUndefined();
    expect(moved).toHaveLength(0);
  });

  it('имя есть только в remote → cross_instance с кандидатами', async () => {
    const result = await projectAttachTool.execute(
      { project: 'Remote Only' },
      makeCtx(remoteClient([{ id: 'rp1', name: 'Remote Only', workspace: 'rw' }])),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata?.cross_instance).toBe(true);
    const candidates = result.metadata?.candidates as Array<Record<string, unknown>>;
    expect(candidates).toEqual([
      expect.objectContaining({ origin: 'remote', id: 'remote:rp1', name: 'Remote Only', workspace: 'rw' }),
    ]);
    expect((await sessionManager.getSession(sessionId))!.projectId).toBeUndefined();
  });

  it('локальный и remote с одним именем → hybrid_ambiguous', async () => {
    const local = projectStore.create('Shared', 'u1');
    await projectStore.save(local);
    const result = await projectAttachTool.execute(
      { project: 'Shared' },
      makeCtx(remoteClient([{ id: 'rp1', name: 'Shared', workspace: 'rw' }])),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toMatchObject({ key: 'project.hybrid_ambiguous' });
    const candidates = result.metadata?.candidates as Array<Record<string, unknown>>;
    expect(candidates.map((candidate) => candidate.origin).sort()).toEqual(['local', 'remote']);
    expect((await sessionManager.getSession(sessionId))!.projectId).toBeUndefined();
  });

  it('локальный projectId привязывается без remote-проверки', async () => {
    const local = projectStore.create('Shared', 'u1');
    await projectStore.save(local);
    const result = await projectAttachTool.execute(
      { projectId: local.id },
      makeCtx(remoteClient([{ id: 'rp1', name: 'Shared' }])),
    );
    expect(result.isError).toBeUndefined();
    expect((await sessionManager.getSession(sessionId))!.projectId).toBe(local.id);
  });

  it('remote offline не блокирует локальный attach по имени', async () => {
    const local = projectStore.create('Solo', 'u1');
    await projectStore.save(local);
    const result = await projectAttachTool.execute(
      { project: 'Solo' },
      makeCtx(remoteClient([], true)),
    );
    expect(result.isError).toBeUndefined();
    expect((await sessionManager.getSession(sessionId))!.projectId).toBe(local.id);
  });
});
