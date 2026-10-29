/**
 * Реестр git-репозиториев (ADR-076): сравнение/канонизация пути.
 *
 * Один шов на тулы и HTTP-роуты — иначе `./app` находился бы только одним
 * контуром и `project_repo_add app` + `project_repo_add ./app` создавали бы две
 * записи (`repo-registry.ts`).
 */
import { describe, it, expect } from 'vitest';
import type { GitRepoConfig } from '@itphx/synth-shared';
import { comparableRepoPath, findRepoEntry, upsertRepoEntry } from './repo-registry.js';

function repo(path: string, id?: string): GitRepoConfig {
  return { id, path };
}

describe('comparableRepoPath — косметика относительного пути', () => {
  it.each([
    ['app', 'app'],
    ['./app', 'app'],
    ['.//app', 'app'],
    ['app/', 'app'],
    ['./app/', 'app'],
    ['app//sub', 'app/sub'],
    ['a/./b', 'a/b'],
    ['./a/./b/', 'a/b'],
    // Обратный слэш — разделитель (Windows-инсталляции и агенты).
    ['a\\b', 'a/b'],
    ['.\\app', 'app'],
    ['app\\', 'app'],
  ])('%s → %s', (input, expected) => {
    expect(comparableRepoPath(input)).toBe(expected);
  });

  it('корень workspace (`.`/`./`) канонизируется в `.`, не в пустую строку', () => {
    expect(comparableRepoPath('.')).toBe('.');
    expect(comparableRepoPath('./')).toBe('.');
    expect(comparableRepoPath('./.')).toBe('.');
  });

  it('пустой вход → пустая строка («запись не ищем»)', () => {
    expect(comparableRepoPath(undefined)).toBe('');
    expect(comparableRepoPath('')).toBe('');
  });

  it('`..` не резолвится и на обычные записи не матчится', () => {
    expect(comparableRepoPath('../app')).toBe('../app');
    expect(comparableRepoPath('./../app')).toBe('../app');
    expect(comparableRepoPath('a/../b')).toBe('a/../b');
    expect(comparableRepoPath('../app')).not.toBe(comparableRepoPath('app'));
    expect(comparableRepoPath('a/../b')).not.toBe(comparableRepoPath('b'));
  });

  it('абсолютные пути — отдельная ветка и не равны относительным', () => {
    // POSIX: только унификация разделителей/`//`.
    expect(comparableRepoPath('/workspace/app')).toBe('/workspace/app');
    expect(comparableRepoPath('//workspace//app')).toBe('/workspace/app');
    // Windows.
    expect(comparableRepoPath('C:\\work\\app')).toBe('C:/work/app');
    expect(comparableRepoPath('C:/work/app')).toBe('C:/work/app');
    // UNC.
    expect(comparableRepoPath('\\\\server\\share\\app')).toBe('/server/share/app');

    for (const absolute of ['/workspace/app', 'C:/work/app', '/server/share/app']) {
      expect(absolute).not.toBe(comparableRepoPath('app'));
    }
  });
});

describe('findRepoEntry', () => {
  const repos = [repo('app', 'id_app'), repo('vendor/lib', 'id_vendor'), repo('.', 'id_root')];

  it('id приоритетнее пути; заданный, но неизвестный id путь не подменяет', () => {
    expect(findRepoEntry(repos, 'id_vendor', 'app')?.path).toBe('vendor/lib');
    expect(findRepoEntry(repos, 'id_unknown', 'app')).toBeUndefined();
  });

  it('находит запись по косметике пути', () => {
    expect(findRepoEntry(repos, undefined, './app/')?.id).toBe('id_app');
    expect(findRepoEntry(repos, undefined, 'vendor\\lib')?.id).toBe('id_vendor');
  });

  it('пустой путь не ищет запись (в т.ч. запись корня)', () => {
    expect(findRepoEntry(repos, undefined, '')).toBeUndefined();
    expect(findRepoEntry(repos, undefined, undefined)).toBeUndefined();
  });

  it('запись `.` находится по `.`/`./`', () => {
    expect(findRepoEntry(repos, undefined, '.')?.id).toBe('id_root');
    expect(findRepoEntry(repos, undefined, './')?.id).toBe('id_root');
  });

  it('`..` и абсолютный путь записей не находят', () => {
    expect(findRepoEntry(repos, undefined, '../app')).toBeUndefined();
    expect(findRepoEntry(repos, undefined, '/workspace/app')).toBeUndefined();
  });
});

describe('upsertRepoEntry', () => {
  it('канонизирует путь и создаёт запись с id', () => {
    const { entry, next, existing } = upsertRepoEntry([], { path: './app/' });
    expect(entry.path).toBe('app');
    expect(entry.id).toBeTruthy();
    expect(next).toEqual([entry]);
    expect(existing).toBeUndefined();
  });

  it('дедуп: `app` и `./app` — одна запись с тем же id', () => {
    const first = upsertRepoEntry([], { path: 'app', url: 'https://example.com/app.git' });
    const second = upsertRepoEntry(first.next, { path: './app' });

    expect(second.existing?.id).toBe(first.entry.id);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.next).toHaveLength(1);
    expect(second.entry.path).toBe('app');
    // url второй регистрацией (без url) не затирается.
    expect(second.entry.url).toBe('https://example.com/app.git');
  });

  it('запись `.` сохраняет точку, а не пустую строку', () => {
    const root = upsertRepoEntry([], { path: '.' });
    expect(root.entry.path).toBe('.');
    const dotSlash = upsertRepoEntry(root.next, { path: './' });
    expect(dotSlash.entry.id).toBe(root.entry.id);
    expect(dotSlash.entry.path).toBe('.');
    expect(dotSlash.next).toHaveLength(1);
  });

  it('неизвестный id, но совпавший путь → merge в существующую запись', () => {
    const first = upsertRepoEntry([], { path: 'app', name: 'old' });
    const merged = upsertRepoEntry(first.next, { id: 'id_unknown', path: './app', name: 'new' });

    expect(merged.existing?.id).toBe(first.entry.id);
    expect(merged.entry.id).toBe(first.entry.id);
    expect(merged.entry.path).toBe('app');
    expect(merged.entry.name).toBe('new');
    expect(merged.next).toHaveLength(1);
  });
});
