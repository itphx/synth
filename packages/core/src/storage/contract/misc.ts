import { describe, expect, it } from 'vitest';
import type { BlobStore, DefaultsRepository } from '../ports/index.js';

/** Паспорт порта `BlobStore`: round-trip, рекурсивный list, containment. */
export function describeBlobStore(
  name: string,
  make: () => Promise<{ repo: BlobStore; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('write/read/exists/delete; отсутствующий — null/false', async () => {
      const { repo } = await make();
      expect(await repo.read('missing.bin')).toBeNull();
      expect(await repo.exists('missing.bin')).toBe(false);

      await repo.write('a/b.txt', 'hello');
      expect(await repo.exists('a/b.txt')).toBe(true);
      expect((await repo.read('a/b.txt'))?.toString('utf-8')).toBe('hello');

      await repo.delete('a/b.txt');
      expect(await repo.exists('a/b.txt')).toBe(false);
      await expect(repo.delete('a/b.txt')).resolves.toBeUndefined();
    });

    it('list рекурсивен и детерминирован; пустой — []', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      await repo.write('dir/b.txt', 'bb');
      await repo.write('dir/a.txt', 'a');
      await repo.write('root.txt', 'r');

      const all = await repo.list();
      expect(all.map((e) => e.path)).toEqual(['dir/a.txt', 'dir/b.txt', 'root.txt']);
      expect(all.find((e) => e.path === 'dir/a.txt')?.size).toBe(1);

      const scoped = await repo.list('dir');
      expect(scoped.map((e) => e.path)).toEqual(['dir/a.txt', 'dir/b.txt']);
    });

    it('containment: `..` отклоняется', async () => {
      const { repo } = await make();
      await expect(repo.write('../escape.txt', 'x')).rejects.toThrow();
    });
  });
}

/** Паспорт порта `DefaultsRepository`. */
export function describeDefaultsRepository(
  name: string,
  make: () => Promise<{ repo: DefaultsRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('пустые умолчания — {}; saveDefaults сливает патч поверх', async () => {
      const { repo } = await make();
      expect(await repo.loadDefaults()).toEqual({});

      const saved = await repo.saveDefaults({ locale: 'ru', themeMode: 'dark' });
      expect(saved.locale).toBe('ru');
      expect(saved.themeMode).toBe('dark');

      const merged = await repo.saveDefaults({ theme: 'synth' });
      expect(merged.locale).toBe('ru');
      expect(merged.theme).toBe('synth');
    });
  });
}
