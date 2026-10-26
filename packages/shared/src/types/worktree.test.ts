import { describe, it, expect } from 'vitest';
import {
  WORKTREE_NAME_MAX_LENGTH,
  WORKTREE_NAME_REGEX,
  isValidWorktreeBranch,
  isValidWorktreeRepoPath,
  worktreeCreateSchema,
  worktreePruneSchema,
  worktreeRecordSchema,
  type WorktreeRecord,
} from './worktree.js';

describe('worktree: контракт записи и HTTP-входа (ADR-114)', () => {
  const record: WorktreeRecord = {
    id: 'wkt-1',
    projectId: 'prj-1',
    repoPath: 'repos/app',
    directory: '/workspaces/.worktrees/prj-1/feature-x',
    branch: 'feature/x',
    name: 'feature-x',
    strategy: 'git',
    createdAt: '2026-10-26T09:12:03.114Z',
    updatedAt: '2026-10-26T09:12:03.114Z',
    createdBy: 'usr-42',
  };

  it('запись проходит схему без потерь', () => {
    expect(worktreeRecordSchema.parse(record)).toEqual(record);
  });

  it('запись без необязательных полей — валидна', () => {
    const sparse = {
      id: 'wkt-2',
      projectId: 'prj-1',
      directory: '/workspaces/.worktrees/prj-1/sparse',
      branch: 'HEAD',
      name: 'sparse',
      strategy: 'git' as const,
      createdAt: '2026-10-26T09:12:03.114Z',
      updatedAt: '2026-10-26T09:12:03.114Z',
    };
    expect(worktreeRecordSchema.parse(sparse)).toEqual(sparse);
  });

  it('имя записи — slug', () => {
    expect(worktreeRecordSchema.safeParse({ ...record, name: 'Feature' }).success).toBe(false);
    expect(worktreeRecordSchema.safeParse({ ...record, name: '-feature' }).success).toBe(false);
    expect(worktreeRecordSchema.safeParse({ ...record, name: 'a/b' }).success).toBe(false);
    expect(worktreeRecordSchema.safeParse({ ...record, name: 'a'.repeat(65) }).success).toBe(false);
    expect(worktreeRecordSchema.safeParse({ ...record, name: 'a'.repeat(64) }).success).toBe(true);
    expect(WORKTREE_NAME_MAX_LENGTH).toBe(64);
    expect(WORKTREE_NAME_REGEX.test('feature-x_1.2')).toBe(true);
  });

  it('стратегия записи — только git', () => {
    expect(worktreeRecordSchema.safeParse({ ...record, strategy: 'submodule' }).success).toBe(false);
  });

  it('тело создания: валидный набор полей принимается', () => {
    expect(
      worktreeCreateSchema.parse({
        branch: 'feature/x',
        name: 'feature-x',
        repoPath: 'repos/app',
        from: 'main',
      }),
    ).toEqual({ branch: 'feature/x', name: 'feature-x', repoPath: 'repos/app', from: 'main' });
    // Пустое тело — валидно (сервис подставит дефолты).
    expect(worktreeCreateSchema.parse({})).toEqual({});
  });

  it('тело создания: невалидное имя отклоняется', () => {
    expect(worktreeCreateSchema.safeParse({ name: 'Feature' }).success).toBe(false);
    expect(worktreeCreateSchema.safeParse({ name: '../escape' }).success).toBe(false);
    expect(worktreeCreateSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('тело создания: невалидная ветка отклоняется', () => {
    for (const branch of ['', 'with space', 'a..b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b']) {
      expect(worktreeCreateSchema.safeParse({ branch }).success, branch).toBe(false);
    }
    expect(worktreeCreateSchema.safeParse({ branch: 'feature/x' }).success).toBe(true);
    expect(worktreeCreateSchema.safeParse({ branch: 'HEAD' }).success).toBe(true);
    expect(isValidWorktreeBranch('feature/x')).toBe(true);
    expect(isValidWorktreeBranch('a..b')).toBe(false);
  });

  it('тело создания: repoPath — относительный путь без «..»', () => {
    expect(worktreeCreateSchema.safeParse({ repoPath: '/abs/path' }).success).toBe(false);
    expect(worktreeCreateSchema.safeParse({ repoPath: '../outside' }).success).toBe(false);
    expect(worktreeCreateSchema.safeParse({ repoPath: 'repos/../..' }).success).toBe(false);
    expect(worktreeCreateSchema.safeParse({ repoPath: 'C:\\abs' }).success).toBe(false);
    expect(worktreeCreateSchema.safeParse({ repoPath: 'repos/app' }).success).toBe(true);
    expect(isValidWorktreeRepoPath('repos/app')).toBe(true);
    expect(isValidWorktreeRepoPath('repos/app')).toBe(true);
  });

  it('тело prune: параметров нет, лишние поля — ошибка', () => {
    expect(worktreePruneSchema.safeParse({}).success).toBe(true);
    expect(worktreePruneSchema.safeParse({ force: true }).success).toBe(false);
  });
});
