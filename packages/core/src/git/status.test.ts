import { describe, it, expect } from 'vitest';
import { MAX_WORKTREE_STATUS_FILES, parseWorktreeStatus } from './status.js';

/**
 * ADR-076 (этап 1): разбор `git status --porcelain=v2 -z --branch`.
 *
 * Фикстуры записаны в точном формате git (записи NUL-терминированы, пути не
 * квотируются) — форма проверена на реальном репозитории: `1 .M N... 100644
 * 100644 100644 <hH> <hI> <path>`, у rename `2 R. … R100 <path>\0<origPath>`,
 * unmerged — `u UU N... <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`.
 */

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

/** Склейка записей в NUL-поток (как отдаёт git при `-z`). */
function stream(...tokens: string[]): string {
  return `${tokens.join('\0')}\0`;
}

describe('parseWorktreeStatus', () => {
  it('ветка + ahead/behind из заголовков', () => {
    const raw = stream('# branch.oid ' + H1, '# branch.head main', '# branch.ab +2 -1');
    expect(parseWorktreeStatus(raw)).toEqual({ branch: 'main', ahead: 2, behind: 1, files: [] });
  });

  it('detached HEAD — ветки нет', () => {
    const raw = stream('# branch.oid ' + H1, '# branch.head (detached)');
    const parsed = parseWorktreeStatus(raw);
    expect(parsed.branch).toBeUndefined();
    expect(parsed.files).toEqual([]);
  });

  it('modified в рабочем дереве (unstaged)', () => {
    const raw = stream('# branch.head main', `1 .M N... 100644 100644 100644 ${H1} ${H2} src/a.ts`);
    expect(parseWorktreeStatus(raw).files).toEqual([
      { path: 'src/a.ts', kind: 'modified', staged: false, unstaged: true },
    ]);
  });

  it('staged + unstaged одновременно (MM)', () => {
    const raw = stream(`1 MM N... 100644 100644 100644 ${H1} ${H2} b.txt`);
    const [file] = parseWorktreeStatus(raw).files;
    expect(file).toMatchObject({ path: 'b.txt', kind: 'modified', staged: true, unstaged: true });
  });

  it('staged added (A.)', () => {
    const raw = stream(`1 A. N... 000000 100644 100644 ${'0'.repeat(40)} ${H2} new.txt`);
    expect(parseWorktreeStatus(raw).files).toEqual([
      { path: 'new.txt', kind: 'added', staged: true, unstaged: false },
    ]);
  });

  it('rename: orig_path из отдельного NUL-токена', () => {
    const raw = stream(
      `2 R. N... 100644 100644 100644 ${H1} ${H2} R100 e ü.txt`,
      'c d ü.txt',
    );
    const parsed = parseWorktreeStatus(raw);
    // Исходный путь съеден парсером, а не разобран как отдельная запись.
    expect(parsed.files).toEqual([
      {
        path: 'e ü.txt',
        orig_path: 'c d ü.txt',
        kind: 'renamed',
        staged: true,
        unstaged: false,
      },
    ]);
  });

  it('delete в индексе и в рабочем дереве', () => {
    const raw = stream(
      `1 D. N... 100644 000000 000000 ${H1} ${'0'.repeat(40)} gone.txt`,
      `1 .D N... 100644 100644 000000 ${H1} ${H1} gone2.txt`,
    );
    const files = parseWorktreeStatus(raw).files;
    expect(files.map((f) => [f.path, f.kind, f.staged, f.unstaged])).toEqual([
      ['gone.txt', 'deleted', true, false],
      ['gone2.txt', 'deleted', false, true],
    ]);
  });

  it('typechange (T)', () => {
    const raw = stream(`1 .T N... 100644 100644 120000 ${H1} ${H1} d.txt`);
    expect(parseWorktreeStatus(raw).files[0]).toMatchObject({ path: 'd.txt', kind: 'typechange' });
  });

  it('conflict (unmerged `u`) — отдельный вид, приоритетнее XY', () => {
    const raw = stream(
      `u UU N... 100644 100644 100644 100644 ${H1} ${H2} ${H1} f.txt`,
    );
    expect(parseWorktreeStatus(raw).files).toEqual([
      { path: 'f.txt', kind: 'conflict', staged: true, unstaged: true },
    ]);
  });

  it('untracked и ignored — разные виды (ignored не считается изменённым)', () => {
    const raw = stream('? untracked.txt', '! x.log');
    expect(parseWorktreeStatus(raw).files).toEqual([
      { path: 'untracked.txt', kind: 'untracked', staged: false, unstaged: true },
      { path: 'x.log', kind: 'ignored', staged: false, unstaged: false },
    ]);
  });

  it('новые файлы перечислены поимённо, в т.ч. внутри каталога (`-uall`)', () => {
    // `--untracked-files=all`: git отдаёт каждый файл отдельной записью, а не
    // каталогом `Test/` — иначе панель не может отметить ни файл, ни каталог.
    const raw = stream('? Test/Test.txt', '? Test/inner/Second.txt', '? root.txt', '! node_modules/');
    expect(parseWorktreeStatus(raw).files).toEqual([
      { path: 'Test/Test.txt', kind: 'untracked', staged: false, unstaged: true },
      { path: 'Test/inner/Second.txt', kind: 'untracked', staged: false, unstaged: true },
      { path: 'root.txt', kind: 'untracked', staged: false, unstaged: true },
      // Игнорируемый каталог — по-прежнему одна запись (внутрь не заходим).
      { path: 'node_modules/', kind: 'ignored', staged: false, unstaged: false },
    ]);
  });

  it('путь с пробелом и юникодом', () => {
    const raw = stream(`1 .M N... 100644 100644 100644 ${H1} ${H2} c d ü.txt`);
    expect(parseWorktreeStatus(raw).files[0]?.path).toBe('c d ü.txt');
  });

  it('лимит записей: truncated + первые N по порядку git', () => {
    const raw = stream(
      `1 .M N... 100644 100644 100644 ${H1} ${H2} a.txt`,
      `1 .M N... 100644 100644 100644 ${H1} ${H2} b.txt`,
      `1 .M N... 100644 100644 100644 ${H1} ${H2} c.txt`,
    );
    const parsed = parseWorktreeStatus(raw, { maxFiles: 2 });
    expect(parsed.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt']);
    expect(parsed.truncated).toBe(true);
  });

  it('ровно по лимиту — не обрезано', () => {
    const raw = stream(
      `1 .M N... 100644 100644 100644 ${H1} ${H2} a.txt`,
      `1 .M N... 100644 100644 100644 ${H1} ${H2} b.txt`,
    );
    const parsed = parseWorktreeStatus(raw, { maxFiles: 2 });
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.files).toHaveLength(2);
  });

  it('дефолтный лимит — 2000 записей', () => {
    expect(MAX_WORKTREE_STATUS_FILES).toBe(2000);
    const many = Array.from(
      { length: MAX_WORKTREE_STATUS_FILES + 5 },
      (_, i) => `? f${i}.txt`,
    );
    const parsed = parseWorktreeStatus(stream(...many));
    expect(parsed.files).toHaveLength(MAX_WORKTREE_STATUS_FILES);
    expect(parsed.truncated).toBe(true);
  });

  it('пустой вывод — пустое состояние', () => {
    expect(parseWorktreeStatus('')).toEqual({ files: [] });
  });
});
