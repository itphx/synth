/**
 * Тесты сервиса worktree'ов (ADR-114, этап 1 roadmap 0.13 — блок 1.4.1b).
 *
 * Работают на **настоящем** временном git-репозитории (`mkdtemp` + `git init`
 * + коммит) — поведение `git worktree add/remove/prune` и «грязного» дерева
 * нельзя проверить заглушкой.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Project } from '@itphx/synth-shared';
import { MemoryWorktreeRepository } from '../../storage/memory/worktrees.js';
import type { WorktreeRepository } from '../../storage/ports/worktree-repository.js';
import { WorktreeService } from './service.js';
import {
  WorktreeBranchInvalidError,
  WorktreeBusyError,
  WorktreeDirtyError,
  WorktreeNameInvalidError,
  WorktreeNotFoundError,
  isWorktreeError,
} from './errors.js';

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
  await git(dir, ['config', 'user.name', 'Тест Юникод']);
  await writeFile(join(dir, 'README.md'), 'hello\n');
  await git(dir, ['add', '--', 'README.md']);
  await git(dir, ['commit', '-m', 'initial']);
}

/** Минимальный проект для сервиса. */
function makeProject(id: string, workspace: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    ownerId: 'usr-1',
    members: {},
    description: '',
    currentTask: '',
    invariants: '',
    workspace,
    statusMessages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Каталог/файл на диске существует? */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('WorktreeService (ADR-114 §1, §6, §7)', () => {
  let root: string;
  let workspacesRoot: string;
  let projectDir: string;
  let repository: WorktreeRepository;
  let service: WorktreeService;
  let project: Project;
  let updated: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-worktree-'));
    workspacesRoot = join(root, 'workspaces');
    projectDir = join(workspacesRoot, 'projects', 'prj-1');
    await initRepoAt(projectDir);
    repository = new MemoryWorktreeRepository();
    updated = [];
    service = new WorktreeService({
      repository,
      workspacesRoot,
      defaultWorkingDir: projectDir,
      onUpdated: (projectId) => updated.push(projectId),
    });
    project = makeProject('prj-1', projectDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('create', () => {
    it('создаёт каталог, ветку и запись; worktree чистый', async () => {
      const result = await service.create('prj-1', project, { branch: 'feature/x' }, 'usr-1');

      expect(result.worktree.id).toMatch(/^wkt_/);
      expect(result.worktree.projectId).toBe('prj-1');
      expect(result.worktree.branch).toBe('feature/x');
      expect(result.worktree.name).toBe('feature-x');
      expect(result.worktree.strategy).toBe('git');
      expect(result.worktree.createdBy).toBe('usr-1');
      expect(result.worktree.directory).toBe(join(workspacesRoot, '.worktrees', 'prj-1', 'feature-x'));
      expect(result.worktree.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.worktree.updatedAt).toBe(result.worktree.createdAt);

      // Каталог на диске и ветка — в репозитории проекта.
      expect(await exists(result.worktree.directory)).toBe(true);
      const branch = (await git(result.worktree.directory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      expect(branch).toBe('feature/x');
      const branches = await git(projectDir, ['branch', '--format=%(refname:short)']);
      expect(branches).toContain('feature/x');

      // Запись сохранена в инвентаре, worktree чистый.
      const stored = await repository.get(result.worktree.id);
      expect(stored?.directory).toBe(result.worktree.directory);

      const list = await service.list('prj-1', project);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ exists: true, dirty: false });
      expect(updated).toEqual(['prj-1']);
    });

    it('коллизия имени → детерминированный суффикс -2', async () => {
      const first = await service.create('prj-1', project, { name: 'wt', branch: 'feature/a' });
      const second = await service.create('prj-1', project, { name: 'wt', branch: 'feature/b' });

      expect(first.worktree.name).toBe('wt');
      expect(second.worktree.name).toBe('wt-2');
      expect(second.worktree.directory).toBe(join(workspacesRoot, '.worktrees', 'prj-1', 'wt-2'));
      expect(await exists(second.worktree.directory)).toBe(true);
      expect((await git(second.worktree.directory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('feature/b');
    });

    it('невалидные имя/ветка/repoPath → ошибки с кодами', async () => {
      await expect(service.create('prj-1', project, { name: 'Bad Name' })).rejects.toBeInstanceOf(
        WorktreeNameInvalidError,
      );
      await expect(service.create('prj-1', project, { branch: 'bad branch' })).rejects.toBeInstanceOf(
        WorktreeBranchInvalidError,
      );
      await expect(service.create('prj-1', project, { repoPath: '../escape' })).rejects.toMatchObject({
        code: 'WORKTREE_NOT_A_REPO',
      });
      await expect(service.create('prj-1', project, { repoPath: '/abs/path' })).rejects.toMatchObject({
        code: 'WORKTREE_NOT_A_REPO',
      });
    });

    it('repoPath указывает на вложенный репозиторий проекта', async () => {
      const nested = join(projectDir, 'repos', 'app');
      await initRepoAt(nested);

      const created = await service.create('prj-1', project, {
        repoPath: 'repos/app',
        branch: 'feature/nested',
      });
      expect(created.worktree.repoPath).toBe('repos/app');
      expect((await git(created.worktree.directory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(
        'feature/nested',
      );
    });

    it('не-репозиторий → WORKTREE_NOT_A_REPO', async () => {
      const plain = join(workspacesRoot, 'plain');
      await mkdir(plain, { recursive: true });
      const plainProject = makeProject('prj-1', plain);
      await expect(service.create('prj-1', plainProject, { branch: 'feature/x' })).rejects.toMatchObject({
        code: 'WORKTREE_NOT_A_REPO',
      });
      expect(await repository.list()).toHaveLength(0);
    });

    it('имя без ветки/имени → wt-<hex> и ветка worktree/<name>', async () => {
      const result = await service.create('prj-1', project, {});
      expect(result.worktree.name).toMatch(/^wt-[0-9a-f]{8}$/);
      expect(result.worktree.branch).toBe(`worktree/${result.worktree.name}`);
    });

    it('существующая ветка → worktree на ней (без -b)', async () => {
      await git(projectDir, ['branch', 'existing']);
      const result = await service.create('prj-1', project, { branch: 'existing' });
      expect((await git(result.worktree.directory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('existing');
    });

    it('from задана и существует → новая ветка от неё', async () => {
      await git(projectDir, ['branch', 'base']);
      const result = await service.create('prj-1', project, { branch: 'feature/from', from: 'base' });
      expect(result.worktree.branch).toBe('feature/from');
      const head = (await git(result.worktree.directory, ['rev-parse', 'HEAD'])).trim();
      const base = (await git(projectDir, ['rev-parse', 'base'])).trim();
      expect(head).toBe(base);
    });

    it('from задана, но её нет → ошибка git (fail-closed, не подмена базы)', async () => {
      await expect(
        service.create('prj-1', project, { branch: 'feature/none', from: 'no-such-base' }),
      ).rejects.toMatchObject({ code: 'WORKTREE_GIT_FAILED' });
      expect(await repository.list()).toHaveLength(0);
    });

    it('ошибка git не оставляет записи в инвентаре', async () => {
      await git(projectDir, ['branch', 'busy']);
      const first = await service.create('prj-1', project, { branch: 'busy' });
      // Вторая попытка занять ту же ветку — git откажется (ветка уже в worktree).
      await expect(service.create('prj-1', project, { branch: 'busy' })).rejects.toMatchObject({
        code: 'WORKTREE_GIT_FAILED',
      });
      const records = await repository.list();
      expect(records).toHaveLength(1);
      expect(records[0]?.id).toBe(first.worktree.id);
    });
  });

  describe('list', () => {
    it('две записи: порядок (свежие первыми), dirty и exists', async () => {
      const first = await service.create('prj-1', project, { name: 'one', branch: 'feature/one' });
      // Разные метки времени — иначе порядок определялся бы тайбрейкером по id.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await service.create('prj-1', project, { name: 'two', branch: 'feature/two' });

      const list = await service.list('prj-1', project);
      expect(list.map((item) => item.id)).toEqual([second.worktree.id, first.worktree.id]);
      expect(list.every((item) => item.exists === true && item.dirty === false)).toBe(true);

      // Незакоммиченное изменение → dirty.
      await writeFile(join(first.worktree.directory, 'README.md'), 'changed\n');
      const dirtyList = await service.list('prj-1', project);
      expect(dirtyList.find((item) => item.id === first.worktree.id)?.dirty).toBe(true);
      expect(dirtyList.find((item) => item.id === second.worktree.id)?.dirty).toBe(false);

      // Каталог удалён вручную → exists:false, dirty:false, без исключения.
      await rm(first.worktree.directory, { recursive: true, force: true });
      const afterRm = await service.list('prj-1', project);
      const gone = afterRm.find((item) => item.id === first.worktree.id);
      expect(gone?.exists).toBe(false);
      expect(gone?.dirty).toBe(false);
    });

    it('привязанная сессия попадает в attachedSessionId', async () => {
      const created = await service.create('prj-1', project, { name: 'bound', branch: 'feature/bound' });
      const bound = new WorktreeService({
        repository,
        workspacesRoot,
        defaultWorkingDir: projectDir,
        resolveAttachedSession: async (worktreeId) =>
          worktreeId === created.worktree.id ? 'ses-1' : undefined,
      });
      const list = await bound.list('prj-1', project);
      expect(list).toHaveLength(1);
      expect(list[0]?.attachedSessionId).toBe('ses-1');
    });
  });

  describe('remove', () => {
    it('чистый worktree → каталог и запись удалены', async () => {
      const created = await service.create('prj-1', project, { name: 'wt', branch: 'feature/x' });
      await service.remove('prj-1', created.worktree.id, project);

      expect(await exists(created.worktree.directory)).toBe(false);
      expect(await repository.get(created.worktree.id)).toBeNull();
      expect(updated).toEqual(['prj-1', 'prj-1']);
    });

    it('грязный worktree без force → WORKTREE_DIRTY (forceRequired)', async () => {
      const created = await service.create('prj-1', project, { name: 'wt', branch: 'feature/x' });
      await writeFile(join(created.worktree.directory, 'README.md'), 'changed\n');

      const err = await service
        .remove('prj-1', created.worktree.id, project)
        .then(() => undefined)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorktreeDirtyError);
      expect((err as WorktreeDirtyError).code).toBe('WORKTREE_DIRTY');
      expect((err as WorktreeDirtyError).forceRequired).toBe(true);
      // Каталог и запись на месте — ничего не потеряно.
      expect(await exists(created.worktree.directory)).toBe(true);
      expect(await repository.get(created.worktree.id)).not.toBeNull();
    });

    it('грязный worktree с force → удаляется', async () => {
      const created = await service.create('prj-1', project, { name: 'wt', branch: 'feature/x' });
      await writeFile(join(created.worktree.directory, 'README.md'), 'changed\n');

      await service.remove('prj-1', created.worktree.id, project, { force: true });
      expect(await exists(created.worktree.directory)).toBe(false);
      expect(await repository.get(created.worktree.id)).toBeNull();
    });

    it('привязанная сессия → WORKTREE_BUSY', async () => {
      const busy = new WorktreeService({
        repository,
        workspacesRoot,
        defaultWorkingDir: projectDir,
        resolveAttachedSession: async () => 'ses-1',
      });
      const created = await busy.create('prj-1', project, { name: 'wt', branch: 'feature/x' });

      const err = await busy
        .remove('prj-1', created.worktree.id, project)
        .then(() => undefined)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorktreeBusyError);
      expect((err as WorktreeBusyError).code).toBe('WORKTREE_BUSY');
      expect((err as WorktreeBusyError).sessionId).toBe('ses-1');
      expect(await repository.get(created.worktree.id)).not.toBeNull();
    });

    it('несуществующая (или чужая) запись → WORKTREE_NOT_FOUND', async () => {
      await expect(service.remove('prj-1', 'wkt-none', project)).rejects.toBeInstanceOf(
        WorktreeNotFoundError,
      );
      const created = await service.create('prj-1', project, { name: 'wt', branch: 'feature/x' });
      await expect(service.remove('prj-other', created.worktree.id, project)).rejects.toMatchObject({
        code: 'WORKTREE_NOT_FOUND',
      });
    });

    it('запись без каталога (удалён вручную) → запись снимается без ошибки git', async () => {
      const created = await service.create('prj-1', project, { name: 'wt', branch: 'feature/x' });
      await rm(created.worktree.directory, { recursive: true, force: true });

      await service.remove('prj-1', created.worktree.id, project);
      expect(await repository.get(created.worktree.id)).toBeNull();
    });
  });

  describe('prune и sweep', () => {
    it('prune удаляет записи без каталога и не трогает посторонние каталоги', async () => {
      const alive = await service.create('prj-1', project, { name: 'alive', branch: 'feature/alive' });
      const orphan = await service.create('prj-1', project, { name: 'orphan', branch: 'feature/orphan' });
      await rm(orphan.worktree.directory, { recursive: true, force: true });

      // Посторонний каталог без записи — собственность пользователя.
      const foreign = join(workspacesRoot, '.worktrees', 'prj-1', 'foreign');
      await mkdir(foreign, { recursive: true });

      const result = await service.prune('prj-1', project);
      expect(result.recordsRemoved).toBe(1);
      expect(result.gitPruned).toBe(true);
      expect(await repository.get(orphan.worktree.id)).toBeNull();
      expect(await repository.get(alive.worktree.id)).not.toBeNull();
      expect(await exists(foreign)).toBe(true);
      expect(await exists(alive.worktree.directory)).toBe(true);
    });

    it('sweepOrphans удаляет осиротевшие записи по всем проектам', async () => {
      const alive = await service.create('prj-1', project, { name: 'alive', branch: 'feature/alive' });
      const orphan = await service.create('prj-1', project, { name: 'orphan', branch: 'feature/orphan' });
      await rm(orphan.worktree.directory, { recursive: true, force: true });

      const result = await service.sweepOrphans();
      expect(result.recordsRemoved).toBe(1);
      expect(await repository.get(orphan.worktree.id)).toBeNull();
      expect(await repository.get(alive.worktree.id)).not.toBeNull();
    });
  });

  describe('startup-скрипт проекта', () => {
    it('выполняется один раз, получает SYNTH_WORKTREE_BASE/PATH', async () => {
      const scripted = makeProject('prj-1', projectDir, {
        worktreeSetupScript: 'printf "%s|%s\\n" "$SYNTH_WORKTREE_BASE" "$SYNTH_WORKTREE_PATH" >> setup.log',
      });
      const created = await service.create('prj-1', scripted, { name: 'wt', branch: 'feature/x' });

      expect(created.setup?.ok).toBe(true);
      expect(created.setup?.exitCode).toBe(0);
      const log = await readFile(join(created.worktree.directory, 'setup.log'), 'utf8');
      const lines = log.trim().split('\n');
      expect(lines).toHaveLength(1);
      const [base, path] = lines[0]!.split('|');
      expect(base).toBe(join(workspacesRoot, '.worktrees', 'prj-1'));
      expect(path).toBe(created.worktree.directory);
    });

    it('падение скрипта не откатывает worktree и попадает в результат', async () => {
      const scripted = makeProject('prj-1', projectDir, { worktreeSetupScript: 'exit 3' });
      const created = await service.create('prj-1', scripted, { name: 'wt', branch: 'feature/x' });

      expect(created.setup?.ok).toBe(false);
      expect(created.setup?.exitCode).toBe(3);
      expect(await exists(created.worktree.directory)).toBe(true);
      expect(await repository.get(created.worktree.id)).not.toBeNull();
    });
  });

  describe('detectSecondary', () => {
    it('основной каталог → false, worktree → true', async () => {
      const main = await service.detectSecondary(projectDir);
      expect(main.isSecondary).toBe(false);
      expect(main.toplevel).toBe(projectDir);

      const created = await service.create('prj-1', project, { name: 'wt', branch: 'feature/x' });
      const secondary = await service.detectSecondary(created.worktree.directory);
      expect(secondary.isSecondary).toBe(true);
      expect(secondary.toplevel).toBe(created.worktree.directory);
      expect(secondary.commonDir).toContain('.git');
    });

    it('не-репозиторий → { isSecondary: false } без исключения', async () => {
      const plain = join(root, 'plain');
      await mkdir(plain, { recursive: true });
      await expect(service.detectSecondary(plain)).resolves.toEqual({ isSecondary: false });
    });
  });

  it('ошибки различаются структурно (isWorktreeError)', async () => {
    const err = await service
      .remove('prj-1', 'wkt-none', project)
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(isWorktreeError(err)).toBe(true);
    expect(isWorktreeError(new Error('plain'))).toBe(false);
  });
});
