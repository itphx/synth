import { describe, it, expect } from 'vitest';
import { resolveFsChange } from './fs-change.js';

const WS = '/tmp/project-ws';

describe('resolveFsChange', () => {
  it('write_file внутри workspace → file + относительный POSIX-путь + op write', () => {
    expect(resolveFsChange('write_file', { path: '/tmp/project-ws/src/a.ts' }, WS))
      .toEqual({ scope: 'file', paths: ['src/a.ts'], op: 'write' });
  });

  it('edit_file внутри workspace → op write', () => {
    expect(resolveFsChange('edit_file', { path: '/tmp/project-ws/src/a.ts' }, WS))
      .toEqual({ scope: 'file', paths: ['src/a.ts'], op: 'write' });
  });

  it('delete_file внутри workspace → op delete', () => {
    expect(resolveFsChange('delete_file', { path: '/tmp/project-ws/src/a.ts' }, WS))
      .toEqual({ scope: 'file', paths: ['src/a.ts'], op: 'delete' });
  });

  it('create_directory внутри workspace → file + op mkdir', () => {
    expect(resolveFsChange('create_directory', { path: '/tmp/project-ws/dir' }, WS))
      .toEqual({ scope: 'file', paths: ['dir'], op: 'mkdir' });
  });

  it('нет metadata.path → all (без op)', () => {
    expect(resolveFsChange('write_file', {}, WS)).toEqual({ scope: 'all' });
    expect(resolveFsChange('edit_file', undefined, WS)).toEqual({ scope: 'all' });
  });

  it('путь вне workspace (.. / абсолютный) → all', () => {
    expect(resolveFsChange('write_file', { path: '/etc/passwd' }, WS)).toEqual({ scope: 'all' });
    expect(resolveFsChange('write_file', { path: '/tmp/project-ws/../other/x' }, WS)).toEqual({ scope: 'all' });
  });

  it('корень workspace → all (не file)', () => {
    expect(resolveFsChange('delete_file', { path: WS }, WS)).toEqual({ scope: 'all' });
  });

  it('широкие мутирующие тулы → all', () => {
    for (const tool of [
      'execute_shell',
      'git_commit',
      'git_push',
      'git_pull',
      'git_checkout',
      'git_stash',
      'project_repo_clone',
      'project_repo_init',
      'project_repo_fetch',
      'project_repo_remove',
      'project_create',
      'project_attach',
      'task',
    ]) {
      expect(resolveFsChange(tool, { path: '/tmp/project-ws/x' }, WS), tool).toEqual({ scope: 'all' });
    }
  });

  it('broad-тулы не задают op (execute_shell / git_commit)', () => {
    const shell = resolveFsChange('execute_shell', { path: '/tmp/project-ws/x' }, WS);
    const git = resolveFsChange('git_commit', { path: '/tmp/project-ws/x' }, WS);
    expect(shell).not.toHaveProperty('op');
    expect(git).not.toHaveProperty('op');
  });

  describe('execute_shell → op move', () => {
    it('простая mv внутри workspace → move с from/to/paths', () => {
      expect(resolveFsChange('execute_shell', undefined, WS, { command: 'mv src/a.txt src/b.txt' }))
        .toEqual({
          scope: 'file',
          paths: ['src/a.txt', 'src/b.txt'],
          op: 'move',
          from: 'src/a.txt',
          to: 'src/b.txt',
        });
    });

    it('git mv внутри workspace → move', () => {
      expect(resolveFsChange('execute_shell', undefined, WS, { command: 'git mv a b' }))
        .toEqual({ scope: 'file', paths: ['a', 'b'], op: 'move', from: 'a', to: 'b' });
    });

    it('mv с флагами и кавычками → move, кавычки снимаются', () => {
      expect(resolveFsChange('execute_shell', undefined, WS, { command: 'mv -f a b' }))
        .toEqual({ scope: 'file', paths: ['a', 'b'], op: 'move', from: 'a', to: 'b' });
      expect(resolveFsChange('execute_shell', undefined, WS, { command: "mv 'a b' c" }))
        .toEqual({ scope: 'file', paths: ['a b', 'c'], op: 'move', from: 'a b', to: 'c' });
    });

    it('непростая команда/вне workspace → fallback all', () => {
      const fallback = { scope: 'all' } as const;
      for (const command of [
        'mv *.txt dir/',
        'mv a b && echo',
        'mv /abs/b c',
        'mv ../x y',
        'mv a',
        'rm x',
        'echo mv a b',
      ]) {
        expect(resolveFsChange('execute_shell', undefined, WS, { command }), command).toEqual(fallback);
      }
    });

    it('execute_shell без args/без command/с не-строкой → all', () => {
      expect(resolveFsChange('execute_shell', undefined, WS)).toEqual({ scope: 'all' });
      expect(resolveFsChange('execute_shell', undefined, WS, {})).toEqual({ scope: 'all' });
      expect(resolveFsChange('execute_shell', undefined, WS, { command: 42 })).toEqual({ scope: 'all' });
    });
  });

  it('project_workspace_set → all + workspaceChanged', () => {
    expect(resolveFsChange('project_workspace_set', undefined, WS))
      .toEqual({ scope: 'all', workspaceChanged: true });
  });

  it('read-only тулы → null', () => {
    expect(resolveFsChange('read_file', { path: `${WS}/a.ts` }, WS)).toBeNull();
    expect(resolveFsChange('git_status', undefined, WS)).toBeNull();
    expect(resolveFsChange('git_diff', undefined, WS)).toBeNull();
    expect(resolveFsChange('web_search', { query: 'x' }, WS)).toBeNull();
  });
});
