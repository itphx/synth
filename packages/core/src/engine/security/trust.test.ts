import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { ToolCapability } from '@itphx/synth-shared';
import { getToolTrust } from './trust.js';

const WS = '/tmp/synth-ws';
const PROJECT = '/tmp/synth-project';

describe('getToolTrust — матрица доверия', () => {
  it('web_fetch → untrusted, источник web, URL', () => {
    const t = getToolTrust('web_fetch', { url: 'https://evil.example' }, WS);
    expect(t).toEqual({
      trust: 'untrusted',
      source: 'web',
      attrs: { URL: 'https://evil.example' },
    });
  });

  it('web_fetch c urls[] → берёт первый URL', () => {
    const t = getToolTrust('web_fetch', { urls: ['https://a.example', 'https://b.example'] }, WS);
    expect(t?.attrs.URL).toBe('https://a.example');
  });

  it('web_search → untrusted, QUERY', () => {
    const t = getToolTrust('web_search', { query: 'как устроен react' }, WS);
    expect(t?.trust).toBe('untrusted');
    expect(t?.attrs.QUERY).toBe('как устроен react');
  });

  it('execute_shell → untrusted, источник shell', () => {
    const t = getToolTrust('execute_shell', { command: 'ls' }, WS);
    expect(t?.trust).toBe('untrusted');
    expect(t?.source).toBe('shell');
  });

  it('MCP-инструмент → untrusted', () => {
    const t = getToolTrust('my-server_tool', {}, WS, [ToolCapability.MCP]);
    expect(t?.trust).toBe('untrusted');
    expect(t?.source).toBe('mcp');
  });

  it('task → untrusted', () => {
    const t = getToolTrust('task', { prompt: 'x' }, WS);
    expect(t?.trust).toBe('untrusted');
    expect(t?.source).toBe('task');
  });

  it('read_session_reference → untrusted, SESSION_ID', () => {
    const t = getToolTrust('read_session_reference', { session_id: 'ses_1' }, WS);
    expect(t?.trust).toBe('untrusted');
    expect(t?.attrs.SESSION_ID).toBe('ses_1');
  });

  it('read_file внутри workingDir → trusted', () => {
    const t = getToolTrust('read_file', { file_path: join(WS, 'src', 'a.ts') }, WS);
    expect(t?.trust).toBe('trusted');
    expect(t?.attrs.PATH).toBe(join(WS, 'src', 'a.ts'));
  });

  it('read_file с относительным путём внутри → trusted', () => {
    const t = getToolTrust('read_file', { file_path: 'src/a.ts' }, WS);
    expect(t?.trust).toBe('trusted');
  });

  it('read_file вне workingDir → untrusted', () => {
    const t = getToolTrust('read_file', { file_path: '/etc/passwd' }, WS);
    expect(t?.trust).toBe('untrusted');
  });

  it('list_directory вне workingDir → untrusted', () => {
    const t = getToolTrust('list_directory', { path: '/tmp/other' }, WS);
    expect(t?.trust).toBe('untrusted');
  });

  it('glob с path внутри → trusted', () => {
    const t = getToolTrust('glob', { pattern: '**/*.ts', path: WS }, WS);
    expect(t?.trust).toBe('trusted');
  });

  it('grep_files с path вне → untrusted', () => {
    const t = getToolTrust('grep_files', { pattern: 'x', path: '/var/log' }, WS);
    expect(t?.trust).toBe('untrusted');
  });

  it('write_file вне → untrusted, внутри → trusted', () => {
    expect(getToolTrust('write_file', { file_path: '/tmp/x.txt' }, WS)?.trust).toBe('untrusted');
    expect(getToolTrust('write_file', { file_path: 'a.txt' }, WS)?.trust).toBe('trusted');
  });

  it('git_* → trusted', () => {
    for (const name of ['git_status', 'git_diff', 'git_log', 'git_commit', 'git_branch_list', 'git_blame', 'git_stash']) {
      expect(getToolTrust(name, {}, WS)?.trust).toBe('trusted');
      expect(getToolTrust(name, {}, WS)?.source).toBe('git');
    }
  });

  it('project-тулы → trusted', () => {
    expect(getToolTrust('get_project_info', {}, WS)?.trust).toBe('trusted');
    expect(getToolTrust('list_repos', {}, WS)?.source).toBe('project');
  });

  it('ssh_keys_list → trusted, источник project (ADR-076)', () => {
    // Реестр ключей — структура инстанса, недоверенного содержимого в нём нет.
    expect(getToolTrust('ssh_keys_list', {}, WS, [ToolCapability.GIT_READ])).toEqual({
      trust: 'trusted',
      source: 'project',
      attrs: {},
    });
  });

  it('системные тулы → null', () => {
    for (const name of ['plan_enter', 'plan_exit', 'todo_write', 'classify_conversation']) {
      expect(getToolTrust(name, {}, WS)).toBeNull();
    }
  });

  it('неизвестный тул → null', () => {
    expect(getToolTrust('unknown_tool', {}, WS)).toBeNull();
  });
});

describe('getToolTrust — периметр allowedRoots (ADR-114)', () => {
  it('read_file в корне проекта: без roots untrusted, с roots trusted', () => {
    const file = join(PROJECT, 'src', 'a.ts');
    expect(getToolTrust('read_file', { file_path: file }, WS)?.trust).toBe('untrusted');
    expect(getToolTrust('read_file', { file_path: file }, WS, undefined, [PROJECT])?.trust)
      .toBe('trusted');
  });

  it('write_file в корне проекта с roots → trusted', () => {
    const t = getToolTrust('write_file', { file_path: 'src/a.ts' }, WS, undefined, [PROJECT]);
    // Относительный путь резолвится от рабочего каталога — остаётся внутри.
    expect(t?.trust).toBe('trusted');
    const inProject = getToolTrust(
      'write_file',
      { file_path: join(PROJECT, 'src', 'a.ts') },
      WS,
      undefined,
      [PROJECT],
    );
    expect(inProject?.trust).toBe('trusted');
  });

  it('patch: все пути внутри roots → trusted', () => {
    const t = getToolTrust(
      'patch',
      {
        edits: [
          { file_path: join(PROJECT, 'src', 'a.ts'), old_string: 'a', new_string: 'b' },
          { file_path: 'src/b.ts', old_string: 'c', new_string: 'd' },
        ],
      },
      WS,
      undefined,
      [PROJECT],
    );
    expect(t?.trust).toBe('trusted');
    expect(t?.source).toBe('file');
  });

  it('patch: один путь снаружи → untrusted', () => {
    const t = getToolTrust(
      'patch',
      {
        edits: [
          { file_path: join(PROJECT, 'src', 'a.ts'), old_string: 'a', new_string: 'b' },
          { file_path: '/etc/passwd', old_string: 'c', new_string: 'd' },
        ],
      },
      WS,
      undefined,
      [PROJECT],
    );
    expect(t?.trust).toBe('untrusted');
  });

  it('patch без roots: путь в корне проекта → untrusted', () => {
    const t = getToolTrust(
      'patch',
      { edits: [{ file_path: join(PROJECT, 'src', 'a.ts'), old_string: 'a', new_string: 'b' }] },
      WS,
    );
    expect(t?.trust).toBe('untrusted');
  });

  it('patch: пустой/битый список edits → trusted (нечего оборачивать)', () => {
    expect(getToolTrust('patch', { edits: [] }, WS)?.trust).toBe('trusted');
    expect(getToolTrust('patch', { edits: 'nope' }, WS)?.trust).toBe('trusted');
    expect(getToolTrust('patch', {}, WS)?.trust).toBe('trusted');
  });
});
