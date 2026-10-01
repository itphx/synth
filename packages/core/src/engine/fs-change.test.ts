import { describe, it, expect } from 'vitest';
import { resolveFsChange } from './fs-change.js';

const WS = '/tmp/project-ws';

describe('resolveFsChange', () => {
  it('write_file внутри workspace → file + относительный POSIX-путь', () => {
    expect(resolveFsChange('write_file', { path: '/tmp/project-ws/src/a.ts' }, WS))
      .toEqual({ scope: 'file', paths: ['src/a.ts'] });
  });

  it('create_directory внутри workspace → file', () => {
    expect(resolveFsChange('create_directory', { path: '/tmp/project-ws/dir' }, WS))
      .toEqual({ scope: 'file', paths: ['dir'] });
  });

  it('нет metadata.path → all', () => {
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
