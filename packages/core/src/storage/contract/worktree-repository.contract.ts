import { describe, expect, it } from 'vitest';
import type { WorktreeRecord } from '@itphx/synth-shared';
import type { WorktreeRepository } from '../ports/index.js';

/**
 * Паспорт порта `WorktreeRepository` (этап 1 roadmap 0.13 — блок 1.4, ADR-114,
 * ADR-096).
 *
 * Проверяется общий для всех backend'ов контракт:
 * - upsert по `id` (`createdAt` не теряется, `updatedAt` — метка вызывающего),
 *   чтение, отсутствующая запись — `null`;
 * - список — «свежие первыми» (`createdAt` убыв., тайбрейкер `id`), фильтр по
 *   проекту;
 * - `delete` — идемпотентно (удаление отсутствующей записи — не ошибка);
 * - `deleteByProject` — число удалённых записей и фактическое удаление,
 *   записи чужих проектов не трогаются;
 * - «редкая» запись (без необязательных полей) читается без потерь.
 */
export function describeWorktreeRepository(
  name: string,
  make: () => Promise<{ repo: WorktreeRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('пустой репозиторий: список пуст, записи нет', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);
      expect(await repo.get('wkt-missing')).toBeNull();
    });

    it('upsert: создание и перезапись; createdAt иммутабельно, updatedAt — от вызывающего', async () => {
      const { repo } = await make();
      await repo.save(worktree('wkt-1', { createdAt: '2026-01-01T00:00:00.000Z' }));
      const created = await repo.get('wkt-1');
      expect(created?.projectId).toBe('prj-1');
      expect(created?.directory).toBe('/workspaces/.worktrees/prj-1/wkt-1');
      expect(created?.branch).toBe('feature/worktrees');
      expect(created?.name).toBe('worktrees');
      expect(created?.strategy).toBe('git');
      expect(created?.createdAt).toBe('2026-01-01T00:00:00.000Z');

      await repo.save(
        worktree('wkt-1', {
          branch: 'feature/worktrees-2',
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        }),
      );
      const updated = await repo.get('wkt-1');
      expect(updated?.branch).toBe('feature/worktrees-2');
      // `createdAt` иммутабельно, `updatedAt` — метка вызывающего.
      expect(updated?.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(updated?.updatedAt).toBe('2026-06-01T00:00:00.000Z');
      // Перезапись — полная: записи по-прежнему одна.
      expect((await repo.list()).filter((w) => w.id === 'wkt-1')).toHaveLength(1);
    });

    it('список: свежие первыми, фильтр по проекту', async () => {
      const { repo } = await make();
      await repo.save(worktree('wkt-1', { createdAt: '2026-01-01T00:00:00.000Z' }));
      await repo.save(
        worktree('wkt-2', {
          projectId: 'prj-2',
          createdAt: '2026-02-01T00:00:00.000Z',
        }),
      );
      await repo.save(worktree('wkt-3', { createdAt: '2026-03-01T00:00:00.000Z' }));

      expect((await repo.list()).map((w) => w.id)).toEqual(['wkt-3', 'wkt-2', 'wkt-1']);
      expect((await repo.list({ projectId: 'prj-1' })).map((w) => w.id)).toEqual([
        'wkt-3',
        'wkt-1',
      ]);
      expect((await repo.list({ projectId: 'prj-none' })).map((w) => w.id)).toEqual([]);
    });

    it('delete: запись удаляется, повторный вызов — не ошибка', async () => {
      const { repo } = await make();
      await repo.save(worktree('wkt-1'));

      await repo.delete('wkt-1');
      expect(await repo.get('wkt-1')).toBeNull();
      expect((await repo.list()).map((w) => w.id)).toEqual([]);

      // Идемпотентность: удаление отсутствующей записи — не ошибка.
      await expect(repo.delete('wkt-1')).resolves.toBeUndefined();
      await expect(repo.delete('wkt-never-existed')).resolves.toBeUndefined();
    });

    it('deleteByProject: удаляет записи проекта и считает их; чужие не трогает', async () => {
      const { repo } = await make();
      await repo.save(worktree('wkt-1'));
      await repo.save(worktree('wkt-2'));
      await repo.save(worktree('wkt-3', { projectId: 'prj-2' }));

      expect(await repo.deleteByProject('prj-1')).toBe(2);
      expect((await repo.list()).map((w) => w.id)).toEqual(['wkt-3']);
      expect(await repo.get('wkt-1')).toBeNull();

      // Повторный вызов — 0 (записей проекта уже нет).
      expect(await repo.deleteByProject('prj-1')).toBe(0);
      // Чужой проект не тронут.
      expect(await repo.deleteByProject('prj-none')).toBe(0);
      expect(await repo.get('wkt-3')).not.toBeNull();
    });

    it('запись без необязательных полей читается без потерь', async () => {
      const { repo } = await make();
      const sparse: WorktreeRecord = {
        id: 'wkt-sparse',
        projectId: 'prj-1',
        directory: '/workspaces/.worktrees/prj-1/sparse',
        branch: 'HEAD',
        name: 'sparse',
        strategy: 'git',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      await repo.save(sparse);
      const loaded = await repo.get('wkt-sparse');
      expect(loaded).toEqual(sparse);
      expect(loaded?.repoPath).toBeUndefined();
      expect(loaded?.createdBy).toBeUndefined();
    });
  });
}

/** Запись worktree для контрактного прогона. */
function worktree(id: string, overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id,
    projectId: 'prj-1',
    directory: `/workspaces/.worktrees/prj-1/${id}`,
    branch: 'feature/worktrees',
    name: 'worktrees',
    strategy: 'git',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
