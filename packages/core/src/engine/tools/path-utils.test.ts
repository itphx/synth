import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  resolvePath,
  validateInputPath,
  resolveRealPath,
  isLexicallyInside,
  isInsideReal,
  isSymlinkEscape,
  isInsideAnyRoot,
  isSymlinkEscapeInRoots,
  toolRoots,
} from './path-utils.js';

const HOME = homedir();

describe('resolvePath', () => {
  const wd = '/work/project';

  it('undefined → рабочий каталог', () => {
    expect(resolvePath(undefined, wd)).toBe(wd);
  });

  it('пустая строка → рабочий каталог', () => {
    expect(resolvePath('', wd)).toBe(wd);
    expect(resolvePath('   ', wd)).toBe(wd);
  });

  it('абсолютный путь → как есть', () => {
    expect(resolvePath('/tmp/x', wd)).toBe('/tmp/x');
  });

  it('относительный путь → относительно рабочего каталога', () => {
    expect(resolvePath('src/a.ts', wd)).toBe(join(wd, 'src/a.ts'));
    expect(resolvePath('./src', wd)).toBe(join(wd, 'src'));
    expect(resolvePath('../other', wd)).toBe('/work/other');
  });

  it('нормализует абсолютный путь с ".."', () => {
    expect(resolvePath('/tmp/../tmp/x', wd)).toBe('/tmp/x');
  });

  it('тильда ~ → домашний каталог', () => {
    expect(resolvePath('~/.ssh/config', wd)).toBe(join(HOME, '.ssh/config'));
    expect(resolvePath('~/', wd)).toBe(HOME);
    expect(resolvePath('~', wd)).toBe(HOME);
  });

  it('$HOME / ${HOME} → домашний каталог', () => {
    expect(resolvePath('$HOME/.ssh/config', wd)).toBe(join(HOME, '.ssh/config'));
    expect(resolvePath('${HOME}/x', wd)).toBe(join(HOME, 'x'));
  });

  it('$PWD / ${PWD} → рабочий каталог', () => {
    expect(resolvePath('$PWD/.git', wd)).toBe(join(wd, '.git'));
    expect(resolvePath('${PWD}/src', wd)).toBe(join(wd, 'src'));
  });
});

describe('validateInputPath', () => {
  it('отклоняет пустую строку', () => {
    expect(() => validateInputPath('', 'p')).toThrow();
    expect(() => validateInputPath('   ', 'p')).toThrow();
  });

  it('отклоняет NUL-символ', () => {
    expect(() => validateInputPath('a\0b', 'p')).toThrow();
  });

  it('принимает корректный путь', () => {
    expect(() => validateInputPath('src/a.ts', 'p')).not.toThrow();
    expect(() => validateInputPath('/abs/path', 'p')).not.toThrow();
  });
});

describe('resolveRealPath / isInsideReal / isSymlinkEscape (containment с симлинками)', () => {
  let tmpDir: string;
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-pathutil-'));
    workspace = join(tmpDir, 'ws');
    outside = join(tmpDir, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('resolveRealPath: существующий путь канонизируется', async () => {
    await writeFile(join(workspace, 'a.txt'), 'x');
    await mkdir(join(workspace, 'sub'));
    // через симлинк-родитель
    await symlink(workspace, join(tmpDir, 'link-to-ws'));
    const real = resolveRealPath(join(tmpDir, 'link-to-ws', 'sub', '..', 'a.txt'));
    expect(real).toBe(join(workspace, 'a.txt'));
  });

  it('resolveRealPath: несуществующая цель — разыменование ближайшего предка + остаток', async () => {
    const real = resolveRealPath(join(workspace, 'new', 'deep', 'file.txt'));
    expect(real).toBe(join(workspace, 'new', 'deep', 'file.txt'));
  });

  it('resolveRealPath: битый симлинк → null (fail-closed)', async () => {
    await symlink(join(workspace, 'no-such-target'), join(workspace, 'dangling'));
    expect(resolveRealPath(join(workspace, 'dangling'))).toBeNull();
    expect(resolveRealPath(join(workspace, 'dangling', 'child.txt'))).toBeNull();
  });

  it('resolveRealPath: цикл симлинков → null (fail-closed)', async () => {
    await symlink('cycle-b', join(workspace, 'cycle-a'));
    await symlink('cycle-a', join(workspace, 'cycle-b'));
    expect(resolveRealPath(join(workspace, 'cycle-a'))).toBeNull();
  });

  it('isLexicallyInside: только нормализация, без разыменования', async () => {
    expect(isLexicallyInside(workspace, join(workspace, 'a.txt'))).toBe(true);
    expect(isLexicallyInside(workspace, workspace)).toBe(true);
    expect(isLexicallyInside(workspace, outside)).toBe(false);
    // `..foo` — потомок, не выход
    expect(isLexicallyInside(workspace, join(workspace, '..foo'))).toBe(true);
  });

  it('isInsideReal: симлинк наружу → false, внутрь → true', async () => {
    await mkdir(join(workspace, 'sub'));
    await symlink(outside, join(workspace, 'escape'));
    await symlink(join(workspace, 'sub'), join(workspace, 'inlink'));

    expect(isInsideReal(workspace, join(workspace, 'sub'))).toBe(true);
    expect(isInsideReal(workspace, join(workspace, 'inlink'))).toBe(true);
    expect(isInsideReal(workspace, join(workspace, 'escape'))).toBe(false);
    expect(isInsideReal(workspace, join(workspace, 'escape', 'x.txt'))).toBe(false);
  });

  it('isSymlinkEscape: лексически внутри + реально снаружи → true', async () => {
    await symlink(outside, join(workspace, 'escape'));
    await symlink(join(workspace, 'sub-does-not-exist'), join(workspace, 'dangling'));

    expect(isSymlinkEscape(workspace, join(workspace, 'escape', 'x'))).toBe(true);
    expect(isSymlinkEscape(workspace, join(workspace, 'dangling'))).toBe(true);
    // внешний лексический путь — не «побег» (его гейтит permission-слой)
    expect(isSymlinkEscape(workspace, join(outside, 'x'))).toBe(false);
    // несуществующая цель внутри — не побег (write/mkdir в новое место)
    expect(isSymlinkEscape(workspace, join(workspace, 'new', 'file.txt'))).toBe(false);
  });
});

/**
 * Периметр сессии: рабочий каталог + дополнительные корни (`allowedRoots`).
 *
 * Сессия в git-worktree (ADR-114) считает «своими» и каталог worktree, и корень
 * проекта (основной checkout): путь в корне проекта не является побегом, а
 * симлинк из worktree наружу обоих корней — является.
 */
describe('toolRoots / isInsideAnyRoot / isSymlinkEscapeInRoots (периметр сессии)', () => {
  let tmpDir: string;
  let worktree: string;
  let projectRoot: string;
  let outside: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-roots-'));
    worktree = join(tmpDir, 'worktree');
    projectRoot = join(tmpDir, 'project');
    outside = join(tmpDir, 'outside');
    await mkdir(worktree, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(projectRoot, 'main-file.txt'), 'main');
    await writeFile(join(worktree, 'wt-file.txt'), 'wt');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('toolRoots: рабочий каталог первым, абсолютные, без пустых и дублей', () => {
    expect(toolRoots({ workingDir: worktree })).toEqual([worktree]);
    expect(toolRoots({ workingDir: worktree, allowedRoots: [] })).toEqual([worktree]);
    // пустые/пробельные игнорируются
    expect(toolRoots({ workingDir: worktree, allowedRoots: ['', '   '] })).toEqual([worktree]);
    // дубль рабочего каталога не повторяется
    expect(toolRoots({ workingDir: worktree, allowedRoots: [worktree] })).toEqual([worktree]);
    // порядок: рабочий каталог → дополнительные корни
    expect(toolRoots({ workingDir: worktree, allowedRoots: [projectRoot, worktree] }))
      .toEqual([worktree, projectRoot]);
  });

  it('toolRoots: относительный путь корня нормализуется в абсолютный', () => {
    const roots = toolRoots({ workingDir: 'ws', allowedRoots: ['proj/sub', 'proj/./sub'] });
    expect(roots).toEqual([resolve('ws'), resolve('proj/sub')]);
    for (const root of roots) expect(isAbsolute(root)).toBe(true);
  });

  it('isInsideAnyRoot: путь в любом из корней — внутренний', () => {
    const roots = [worktree, projectRoot];
    expect(isInsideAnyRoot(join(worktree, 'wt-file.txt'), roots)).toBe(true);
    expect(isInsideAnyRoot(join(projectRoot, 'main-file.txt'), roots)).toBe(true);
    expect(isInsideAnyRoot(projectRoot, roots)).toBe(true);
    expect(isInsideAnyRoot(join(outside, 'x.txt'), roots)).toBe(false);
  });

  it('isSymlinkEscapeInRoots: корень проекта — не побег, наружу обоих корней — побег', async () => {
    const roots = [worktree, projectRoot];
    // симлинк из worktree в основной checkout — часть периметра, не побег
    await symlink(projectRoot, join(worktree, 'to-main'));
    expect(isSymlinkEscapeInRoots(roots, join(worktree, 'to-main', 'main-file.txt'))).toBe(false);
    // симлинк наружу обоих корней — побег
    await symlink(outside, join(worktree, 'escape'));
    expect(isSymlinkEscapeInRoots(roots, join(worktree, 'escape', 'x.txt'))).toBe(true);
    // симлинк из worktree на самого себя — не побег
    await symlink(worktree, join(worktree, 'self'));
    expect(isSymlinkEscapeInRoots(roots, join(worktree, 'self', 'wt-file.txt'))).toBe(false);
    // битый симлинк внутри периметра — fail-closed (побег)
    await symlink(join(worktree, 'no-target'), join(worktree, 'dangling'));
    expect(isSymlinkEscapeInRoots(roots, join(worktree, 'dangling'))).toBe(true);
  });

  it('isSymlinkEscapeInRoots: лексически вне всех корней → не «побег»', () => {
    // обычный внешний доступ гейтит permission-слой, а не файловый тул
    expect(isSymlinkEscapeInRoots([worktree, projectRoot], join(outside, 'x.txt'))).toBe(false);
    // несуществующая цель внутри корня — не побег (write/mkdir в новое место)
    expect(isSymlinkEscapeInRoots([worktree, projectRoot], join(worktree, 'new', 'file.txt'))).toBe(false);
  });
});
