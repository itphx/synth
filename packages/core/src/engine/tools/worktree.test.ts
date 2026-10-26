/**
 * Тесты тулов `git_worktree_*` (ADR-114 §5, этап 1 roadmap 0.13 — блок 1.4.2b).
 *
 * Работают на **настоящем** временном git-репозитории (`mkdtemp` + `git init`
 * + коммит): поведение `git worktree add/remove` и «грязного» дерева
 * заглушкой не проверить.
 *
 * Проверяется:
 *
 * - `git_worktree_list` — пустой инвентарь и список с вычисленными полями
 *   (`branch`/`dirty`/`exists`);
 * - `git_worktree_create` — каталог + ветка + запись; невалидные имя/ветка →
 *   `isError` с машинным кодом (`metadata.worktree_error`);
 * - `git_worktree_remove` — чистый/грязный (без `force` → отказ с упоминанием
 *   `force`, с `force` → удаляется), привязанная сессия → отказ;
 * - `git_worktree_prune` — `{recordsRemoved, gitPruned}`;
 * - проект берётся **только из сессии** (`ctx.projectId`), без него — отказ;
 * - capability: `list` — `GIT_READ`, мутации — `GIT_WRITE`;
 * - plan-режим: мутации блокируются permission-слоем (ADR-029), чтение — нет.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolCapability, type ToolContext } from '@itphx/synth-shared';
import {
  gitWorktreeCreateTool,
  gitWorktreeListTool,
  gitWorktreePruneTool,
  gitWorktreeRemoveTool,
} from './worktree.js';
import { WorktreeService } from '../worktree/service.js';
import { MemoryWorktreeRepository } from '../../storage/memory/worktrees.js';
import type { WorktreeRepository } from '../../storage/ports/worktree-repository.js';
import { ProjectStore } from '../../storage/project-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { PermissionEvaluator, isPlanBlockedTool } from '../permission/evaluator.js';
import { getToolGroups } from '../permission/groups.js';

const execFileAsync = promisify(execFile);

/** Прямой запуск git в тесте (подготовка репозиториев, проверки). */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

/** Инициализирует репозиторий и настраивает identity для коммитов. */
async function initRepoAt(dir: string, branch = 'main'): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '--initial-branch', branch]);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Тест']);
  await writeFile(join(dir, 'README.md'), 'hello\n');
  await git(dir, ['add', '--', 'README.md']);
  await git(dir, ['commit', '-m', 'initial']);
}

/** Каталог/файл на диске существует? */
async function exists(path: string): Promise<boolean> {
  try {
    await execFileAsync('test', ['-e', path]);
    return true;
  } catch {
    return false;
  }
}

describe('git_worktree_* tools (ADR-114 §5)', () => {
  let root: string;
  let workspacesRoot: string;
  let projectDir: string;
  let repository: WorktreeRepository;
  let service: WorktreeService;
  let projectStore: ProjectStore;
  let sessionManager: SessionManager;
  let sessionId: string;
  let projectId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-worktree-tools-'));
    workspacesRoot = join(root, 'workspaces');
    projectDir = join(workspacesRoot, 'projects', 'prj-1');
    await initRepoAt(projectDir);

    repository = new MemoryWorktreeRepository();
    service = new WorktreeService({
      repository,
      workspacesRoot,
      defaultWorkingDir: projectDir,
    });

    projectStore = new ProjectStore({ dataDir: join(root, 'data') });
    sessionManager = new SessionManager(new FileStore({ dataDir: join(root, 'data') }));
    const project = projectStore.create('Worktrees', 'usr-1', { workspace: projectDir });
    await projectStore.save(project);
    projectId = project.id;
    const session = await sessionManager.createSession({
      title: 'S',
      userId: 'usr-1',
      ownerId: 'usr-1',
      projectId: project.id,
    });
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Контекст хода сессии проекта. */
  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId,
      messageId: 'm1',
      workingDir: projectDir,
      projectId,
      extra: { worktreeService: service, projectStore, sessionManager },
      ...overrides,
    };
  }

  describe('capability и группы permission-слоя', () => {
    it('list — GIT_READ, мутации — GIT_WRITE', () => {
      expect(gitWorktreeListTool.capabilities).toEqual([ToolCapability.GIT_READ]);
      expect(gitWorktreeCreateTool.capabilities).toEqual([ToolCapability.GIT_WRITE]);
      expect(gitWorktreeRemoveTool.capabilities).toEqual([ToolCapability.GIT_WRITE]);
      expect(gitWorktreePruneTool.capabilities).toEqual([ToolCapability.GIT_WRITE]);
    });

    it('группы permission-слоя: list → git_read, мутации → git_write', () => {
      expect(getToolGroups('git_worktree_list', gitWorktreeListTool.capabilities)).toContain('git_read');
      expect(getToolGroups('git_worktree_create', gitWorktreeCreateTool.capabilities)).toContain('git_write');
      expect(getToolGroups('git_worktree_remove', gitWorktreeRemoveTool.capabilities)).toContain('git_write');
      expect(getToolGroups('git_worktree_prune', gitWorktreePruneTool.capabilities)).toContain('git_write');
    });
  });

  describe('git_worktree_list', () => {
    it('пустой инвентарь → понятный текст без записей', async () => {
      const result = await gitWorktreeListTool.execute({}, makeCtx());

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('The project has no git worktrees');
    });

    it('после создания — строка с веткой, dirty и exists', async () => {
      await gitWorktreeCreateTool.execute({ branch: 'feature/x', name: 'wt' }, makeCtx());

      const result = await gitWorktreeListTool.execute({}, makeCtx());

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('Git worktrees of the project (1)');
      expect(result.content).toContain('branch: feature/x');
      expect(result.content).toContain('dirty: no');
      expect(result.content).toContain('exists: yes');
      expect(result.content).toContain('attached session: none');
    });

    it('грязный worktree → dirty: yes', async () => {
      const created = await gitWorktreeCreateTool.execute({ branch: 'feature/x', name: 'wt' }, makeCtx());
      const id = created.metadata?.worktree_id as string;
      const record = await repository.get(id);
      await writeFile(join(record!.directory, 'README.md'), 'changed\n');

      const result = await gitWorktreeListTool.execute({}, makeCtx());

      expect(result.content).toContain('dirty: yes');
    });

    it('нет проекта у сессии → отказ (проект только из сессии)', async () => {
      const result = await gitWorktreeListTool.execute({}, makeCtx({ projectId: undefined }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('the session has no project');
      expect((result.metadata?.i18n as { key?: string })?.key).toBe('worktree.tool.no_project');
    });

    it('сервис не подключён → отказ deps_unavailable', async () => {
      const result = await gitWorktreeListTool.execute({}, makeCtx({
        extra: { projectStore, sessionManager },
      }));

      expect(result.isError).toBe(true);
      expect((result.metadata?.i18n as { key?: string })?.key).toBe('worktree.tool.deps_unavailable');
    });
  });

  describe('git_worktree_create', () => {
    it('создаёт каталог и ветку, возвращает запись', async () => {
      const result = await gitWorktreeCreateTool.execute(
        { branch: 'feature/x', name: 'wt' },
        makeCtx(),
      );

      expect(result.isError).toBeFalsy();
      const id = result.metadata?.worktree_id as string;
      expect(id).toMatch(/^wkt_/);
      expect(result.content).toContain('feature/x');

      const record = await repository.get(id);
      expect(record).not.toBeNull();
      expect(record?.branch).toBe('feature/x');
      expect(record?.name).toBe('wt');
      expect(record?.createdBy).toBe('usr-1');
      expect(await exists(record!.directory)).toBe(true);

      const branches = await git(projectDir, ['branch', '--format=%(refname:short)']);
      expect(branches).toContain('feature/x');
    });

    it('невалидная ветка → isError с кодом WORKTREE_BRANCH_INVALID', async () => {
      const result = await gitWorktreeCreateTool.execute({ branch: 'bad branch' }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.metadata?.worktree_error).toBe('WORKTREE_BRANCH_INVALID');
      expect(await repository.list()).toHaveLength(0);
    });

    it('невалидное имя → isError с кодом WORKTREE_NAME_INVALID', async () => {
      const result = await gitWorktreeCreateTool.execute({ name: 'Bad Name' }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.metadata?.worktree_error).toBe('WORKTREE_NAME_INVALID');
      expect(await repository.list()).toHaveLength(0);
    });

    it('не-репозиторий → isError с кодом WORKTREE_NOT_A_REPO', async () => {
      const plain = join(root, 'plain');
      await mkdir(plain, { recursive: true });
      const project = projectStore.create('Plain', 'usr-1', { workspace: plain });
      await projectStore.save(project);

      const result = await gitWorktreeCreateTool.execute(
        { branch: 'feature/x' },
        makeCtx({ projectId: project.id }),
      );

      expect(result.isError).toBe(true);
      expect(result.metadata?.worktree_error).toBe('WORKTREE_NOT_A_REPO');
    });

    it('аргументы вне схемы → отказ разбора аргументов', async () => {
      const result = await gitWorktreeCreateTool.execute({ branch: 42 }, makeCtx());

      expect(result.isError).toBe(true);
      expect((result.metadata?.i18n as { key?: string })?.key).toBe('tool.args_error');
    });
  });

  describe('git_worktree_remove', () => {
    it('чистый worktree удаляется (по имени и по id)', async () => {
      const created = await gitWorktreeCreateTool.execute({ branch: 'feature/x', name: 'wt' }, makeCtx());
      const id = created.metadata?.worktree_id as string;

      const byName = await gitWorktreeRemoveTool.execute({ name: 'wt' }, makeCtx());
      expect(byName.isError).toBeFalsy();
      expect(byName.content).toContain('removed');
      expect(await repository.get(id)).toBeNull();

      const second = await gitWorktreeCreateTool.execute({ branch: 'feature/y', name: 'wt2' }, makeCtx());
      const secondId = second.metadata?.worktree_id as string;
      const byId = await gitWorktreeRemoveTool.execute({ worktreeId: secondId }, makeCtx());
      expect(byId.isError).toBeFalsy();
      expect(await repository.get(secondId)).toBeNull();
    });

    it('грязный worktree без force → isError с упоминанием force', async () => {
      const created = await gitWorktreeCreateTool.execute({ branch: 'feature/x', name: 'wt' }, makeCtx());
      const id = created.metadata?.worktree_id as string;
      const record = await repository.get(id);
      await writeFile(join(record!.directory, 'README.md'), 'changed\n');

      const result = await gitWorktreeRemoveTool.execute({ name: 'wt' }, makeCtx());

      expect(result.isError).toBe(true);
      expect(result.content).toContain('force');
      expect(result.metadata?.force_required).toBe(true);
      // Запись и каталог на месте — ничего не потеряно.
      expect(await repository.get(id)).not.toBeNull();
    });

    it('грязный worktree с force → удаляется', async () => {
      const created = await gitWorktreeCreateTool.execute({ branch: 'feature/x', name: 'wt' }, makeCtx());
      const id = created.metadata?.worktree_id as string;
      const record = await repository.get(id);
      await writeFile(join(record!.directory, 'README.md'), 'changed\n');

      const result = await gitWorktreeRemoveTool.execute({ name: 'wt', force: true }, makeCtx());

      expect(result.isError).toBeFalsy();
      expect(await repository.get(id)).toBeNull();
      expect(await exists(record!.directory)).toBe(false);
    });

    it('привязанная сессия → isError про привязанную сессию', async () => {
      const busyService = new WorktreeService({
        repository,
        workspacesRoot,
        defaultWorkingDir: projectDir,
        resolveAttachedSession: async () => 'ses-live',
      });
      const created = await gitWorktreeCreateTool.execute(
        { branch: 'feature/x', name: 'wt' },
        makeCtx({ extra: { worktreeService: busyService, projectStore, sessionManager } }),
      );
      const id = created.metadata?.worktree_id as string;

      const result = await gitWorktreeRemoveTool.execute(
        { name: 'wt' },
        makeCtx({ extra: { worktreeService: busyService, projectStore, sessionManager } }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('attached to a live session');
      expect(result.content).toContain('ses-live');
      expect(await repository.get(id)).not.toBeNull();
    });

    it('неизвестное имя → isError (not_found)', async () => {
      const result = await gitWorktreeRemoveTool.execute({ name: 'nope' }, makeCtx());

      expect(result.isError).toBe(true);
      expect((result.metadata?.i18n as { key?: string })?.key).toBe('worktree.tool.not_found');
    });

    it('worktree чужого проекта → isError (not_found), чужая запись цела', async () => {
      const other = projectStore.create('Other', 'usr-1', { workspace: projectDir });
      await projectStore.save(other);
      const foreign = await service.create(other.id, other, { branch: 'feature/foreign', name: 'foreign' });

      const result = await gitWorktreeRemoveTool.execute(
        { worktreeId: foreign.worktree.id },
        makeCtx(),
      );

      expect(result.isError).toBe(true);
      expect(result.metadata?.worktree_error).toBe('WORKTREE_NOT_FOUND');
      expect(await repository.get(foreign.worktree.id)).not.toBeNull();
    });

    it('без name и worktreeId → отказ разбора аргументов', async () => {
      const result = await gitWorktreeRemoveTool.execute({}, makeCtx());

      expect(result.isError).toBe(true);
      expect((result.metadata?.i18n as { key?: string })?.key).toBe('tool.args_error');
    });
  });

  describe('git_worktree_prune', () => {
    it('возвращает {recordsRemoved, gitPruned}', async () => {
      const result = await gitWorktreePruneTool.execute({}, makeCtx());

      expect(result.isError).toBeFalsy();
      expect(result.metadata?.records_removed).toBe(0);
      expect(result.metadata?.git_pruned).toBe(true);
    });

    it('удаляет записи без каталога, живые не трогает', async () => {
      const alive = await gitWorktreeCreateTool.execute({ branch: 'feature/a', name: 'alive' }, makeCtx());
      const orphan = await gitWorktreeCreateTool.execute({ branch: 'feature/b', name: 'orphan' }, makeCtx());
      const orphanRecord = await repository.get(orphan.metadata?.worktree_id as string);
      await rm(orphanRecord!.directory, { recursive: true, force: true });

      const result = await gitWorktreePruneTool.execute({}, makeCtx());

      expect(result.isError).toBeFalsy();
      expect(result.metadata?.records_removed).toBe(1);
      expect(result.metadata?.git_pruned).toBe(true);
      expect(await repository.get(alive.metadata?.worktree_id as string)).not.toBeNull();
      expect(await repository.get(orphan.metadata?.worktree_id as string)).toBeNull();
    });

    it('лишние аргументы → отказ разбора аргументов (строгая схема)', async () => {
      const result = await gitWorktreePruneTool.execute({ force: true }, makeCtx());

      expect(result.isError).toBe(true);
      expect((result.metadata?.i18n as { key?: string })?.key).toBe('tool.args_error');
    });
  });

  describe('plan-режим (ADR-025/ADR-029)', () => {
    it('мутации блокируются permission-слоем, чтение — нет', () => {
      expect(isPlanBlockedTool('git_worktree_create', gitWorktreeCreateTool.capabilities)).toBe(true);
      expect(isPlanBlockedTool('git_worktree_remove', gitWorktreeRemoveTool.capabilities)).toBe(true);
      expect(isPlanBlockedTool('git_worktree_prune', gitWorktreePruneTool.capabilities)).toBe(true);
      expect(isPlanBlockedTool('git_worktree_list', gitWorktreeListTool.capabilities)).toBe(false);
    });

    it('PermissionEvaluator: plan → deny на мутацию, allow на список', () => {
      const evaluator = new PermissionEvaluator({ rules: {}, askTimeoutMs: 0 });

      const denied = evaluator.check({
        toolName: 'git_worktree_create',
        params: {},
        workingDir: projectDir,
        capabilities: gitWorktreeCreateTool.capabilities,
        sessionMode: 'plan',
      });
      expect(denied.action).toBe('deny');
      expect(denied.unavailable?.reason).toBe('mode');

      const allowed = evaluator.check({
        toolName: 'git_worktree_list',
        params: {},
        workingDir: projectDir,
        capabilities: gitWorktreeListTool.capabilities,
        sessionMode: 'plan',
      });
      expect(allowed.action).toBe('allow');
    });

    it('в act-режиме мутация не блокируется режимом', () => {
      const evaluator = new PermissionEvaluator({ rules: {}, askTimeoutMs: 0 });
      const decision = evaluator.check({
        toolName: 'git_worktree_create',
        params: {},
        workingDir: projectDir,
        capabilities: gitWorktreeCreateTool.capabilities,
        sessionMode: 'act',
      });
      expect(decision.action).toBe('allow');
    });
  });
});
