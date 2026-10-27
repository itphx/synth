import { describe, expect, it } from 'vitest';
import type { SkillRepository } from '../ports/index.js';

/**
 * Паспорт порта `SkillRepository` (ADR-046 §4, ADR-096, ADR-116).
 *
 * Проверяется **поведение**, а не файловая раскладка: порт не отдаёт путей,
 * поэтому ни `root()`, ни `skillDir()` в контракте нет. Общий для всех
 * backend'ов набор:
 * - `create`/`readMarkdown`/`listNames`/`remove`, дубль имени — ошибка;
 * - `listNames` — детерминированный порядок (по имени), пусто — `[]`;
 * - supporting-файлы: `writeFile`/`readFile`/`deleteFile` и `listFiles`
 *   (относительные пути, **без** `SKILL.md`, размеры в байтах, порядок по пути);
 * - `create` с `files` — supporting-файлы появляются сразу (установка пакета);
 * - `frontmatter` при создании сохраняется и не перетирает `name`/`description`;
 * - `updateMarkdown` сохраняет прочие ключи заголовка и supporting-файлы;
 * - `remove` удаляет и содержимое;
 * - небезопасные относительные пути не читаются и не пишутся.
 */
export function describeSkillRepository(
  name: string,
  make: () => Promise<{ repo: SkillRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('create/read/listNames/remove; пустой репозиторий — []', async () => {
      const { repo } = await make();
      expect(await repo.listNames()).toEqual([]);
      expect(await repo.readMarkdown('nope')).toBeNull();
      expect(await repo.exists('nope')).toBe(false);
      expect(await repo.remove('nope')).toBe(false);

      await repo.create({ name: 'alpha', description: 'первый' });
      expect(await repo.exists('alpha')).toBe(true);
      expect(await repo.listNames()).toEqual(['alpha']);
      expect(await repo.readMarkdown('alpha')).toContain('первый');

      await repo.updateMarkdown('alpha', { description: 'обновлён' });
      expect(await repo.readMarkdown('alpha')).toContain('обновлён');

      expect(await repo.remove('alpha')).toBe(true);
      expect(await repo.listNames()).toEqual([]);
      expect(await repo.exists('alpha')).toBe(false);
    });

    it('listNames детерминирован (по имени); дубль имени → ошибка', async () => {
      const { repo } = await make();
      await repo.create({ name: 'zeta', description: 'z' });
      await repo.create({ name: 'alpha', description: 'a' });
      await repo.create({ name: 'mid', description: 'm' });
      expect(await repo.listNames()).toEqual(['alpha', 'mid', 'zeta']);

      await expect(repo.create({ name: 'alpha', description: 'dup' })).rejects.toThrow();
    });

    it('supporting-файлы: write/read/listFiles/deleteFile, `SKILL.md` в списке нет', async () => {
      const { repo } = await make();
      await repo.create({ name: 'beta', description: 'd' });
      expect(await repo.listFiles('beta')).toEqual([]);

      await repo.writeFile('beta', 'notes/readme.md', 'hello');
      expect(await repo.readFile('beta', 'notes/readme.md')).toBe('hello');

      const files = await repo.listFiles('beta');
      expect(files).toEqual([{ path: 'notes/readme.md', size: 5 }]);
      expect(files.some((file) => file.path === 'SKILL.md')).toBe(false);

      expect(await repo.deleteFile('beta', 'notes/readme.md')).toBe(true);
      expect(await repo.readFile('beta', 'notes/readme.md')).toBeNull();
      expect(await repo.listFiles('beta')).toEqual([]);
      // Неизвестный скилл — пусто, а не ошибка.
      expect(await repo.listFiles('nope')).toEqual([]);
    });

    it('listFiles: вложенные пути отсортированы, размеры в байтах (utf-8)', async () => {
      const { repo } = await make();
      await repo.create({ name: 'gamma', description: 'd' });
      await repo.writeFile('gamma', 'b.txt', 'hello');
      await repo.writeFile('gamma', 'a/deep/c.txt', 'привет');
      await repo.writeFile('gamma', 'a/b.txt', '');

      expect(await repo.listFiles('gamma')).toEqual([
        { path: 'a/b.txt', size: 0 },
        { path: 'a/deep/c.txt', size: Buffer.byteLength('привет', 'utf-8') },
        { path: 'b.txt', size: 5 },
      ]);
    });

    it('create с files: supporting-файлы появляются сразу (установка пакета)', async () => {
      const { repo } = await make();
      await repo.create({
        name: 'delta',
        description: 'пакетный',
        body: 'тело',
        files: { 'scripts/run.sh': 'echo hi', 'reference/notes.md': 'n' },
      });
      expect((await repo.readMarkdown('delta'))?.includes('тело')).toBe(true);
      expect(await repo.readFile('delta', 'scripts/run.sh')).toBe('echo hi');
      expect((await repo.listFiles('delta')).map((file) => file.path)).toEqual([
        'reference/notes.md',
        'scripts/run.sh',
      ]);
    });

    it('frontmatter при создании сохраняется и не перетирает name/description', async () => {
      const { repo } = await make();
      await repo.create({
        name: 'epsilon',
        description: 'описание из входа',
        body: 'body',
        frontmatter: { license: 'MIT', 'allowed-tools': ['read_file'], name: 'чужое' },
      });
      const markdown = (await repo.readMarkdown('epsilon')) ?? '';
      expect(markdown).toContain('license: MIT');
      expect(markdown).toContain('allowed-tools');
      expect(markdown).toContain('name: epsilon');
      expect(markdown).toContain('описание из входа');
      expect(markdown).not.toContain('чужое');
    });

    it('updateMarkdown сохраняет прочие ключи frontmatter и supporting-файлы', async () => {
      const { repo } = await make();
      await repo.create({
        name: 'eta',
        description: 'd',
        body: 'old body',
        frontmatter: { license: 'Apache-2.0' },
        files: { 'keep.txt': 'k' },
      });

      await repo.updateMarkdown('eta', { description: 'new d', body: 'new body' });
      const markdown = (await repo.readMarkdown('eta')) ?? '';
      expect(markdown).toContain('license: Apache-2.0');
      expect(markdown).toContain('new d');
      expect(markdown).toContain('new body');
      expect(await repo.readFile('eta', 'keep.txt')).toBe('k');
    });

    it('remove удаляет supporting-файлы', async () => {
      const { repo } = await make();
      await repo.create({
        name: 'theta',
        description: 'd',
        files: { 'a.txt': 'a' },
      });
      expect(await repo.readFile('theta', 'a.txt')).toBe('a');

      expect(await repo.remove('theta')).toBe(true);
      expect(await repo.listFiles('theta')).toEqual([]);
      expect(await repo.readFile('theta', 'a.txt')).toBeNull();

      // Повторное создание того же имени — как новый скилл, без «хвостов».
      await repo.create({ name: 'theta', description: 'reborn' });
      expect(await repo.listFiles('theta')).toEqual([]);
    });

    it('небезопасные относительные пути не читаются и не пишутся', async () => {
      const { repo } = await make();
      await repo.create({ name: 'iota', description: 'd' });

      for (const bad of ['../escape.txt', '/abs.txt', 'a/../../b.txt']) {
        expect(await repo.readFile('iota', bad)).toBeNull();
        expect(await repo.deleteFile('iota', bad)).toBe(false);
        await expect(repo.writeFile('iota', bad, 'x')).rejects.toThrow();
      }
      expect(await repo.listFiles('iota')).toEqual([]);
    });
  });
}
