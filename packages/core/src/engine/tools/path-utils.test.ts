import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  resolvePath,
  validateInputPath,
  resolveRealPath,
  isLexicallyInside,
  isInsideReal,
  isSymlinkEscape,
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
