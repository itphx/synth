import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolvePath, validateInputPath } from './path-utils.js';

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
