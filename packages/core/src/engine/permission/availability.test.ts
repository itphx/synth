import { describe, it, expect } from 'vitest';
import { computeToolAvailability, isWorkspaceDependentTool } from './availability.js';

describe('computeToolAvailability (AD-070 §2.9.1)', () => {
  it('доступен по умолчанию', () => {
    expect(computeToolAvailability('read_file', ['file_read'], {})).toEqual({ available: true });
  });

  it('role: у агента нет ни одной capability тула → unavailable(role)', () => {
    expect(
      computeToolAvailability('write_file', ['file_write'], { agentCapabilities: ['file_read'] }),
    ).toEqual({ available: false, reason: 'role' });
  });

  it('role: пересечение capabilities → доступен', () => {
    expect(
      computeToolAvailability('write_file', ['file_write'], { agentCapabilities: ['file_read', 'file_write'] }),
    ).toEqual({ available: true });
  });

  it('role: тул без capabilities считается доступным', () => {
    expect(
      computeToolAvailability('custom_tool', [], { agentCapabilities: ['file_read'] }),
    ).toEqual({ available: true });
    expect(
      computeToolAvailability('custom_tool', undefined, { agentCapabilities: ['file_read'] }),
    ).toEqual({ available: true });
  });

  it('mode: plan-рестрикция write/edit → unavailable(mode)', () => {
    expect(
      computeToolAvailability('write_file', ['file_write'], {
        sessionMode: 'plan',
        planMode: 'auto',
        planApproved: false,
      }),
    ).toEqual({ available: false, reason: 'mode' });
  });

  it('mode: strict без утверждённого плана блокирует write', () => {
    expect(
      computeToolAvailability('edit_file', ['file_write'], {
        sessionMode: 'act',
        planMode: 'strict',
        planApproved: false,
      }),
    ).toEqual({ available: false, reason: 'mode' });
  });

  it('mode: act + auto → write доступен', () => {
    expect(
      computeToolAvailability('write_file', ['file_write'], {
        sessionMode: 'act',
        planMode: 'auto',
        planApproved: false,
      }),
    ).toEqual({ available: true });
  });

  it('mode: MCP-тул, выключенный в текущем режиме → unavailable(mode)', () => {
    expect(
      computeToolAvailability('github_create_issue', ['mcp'], {
        sessionMode: 'plan',
        mcpToolSettings: { github: { default: { plan: false, act: true } } },
      }),
    ).toEqual({ available: false, reason: 'mode' });
  });

  it('mode: MCP-тул, включённый в текущем режиме → доступен', () => {
    expect(
      computeToolAvailability('github_create_issue', ['mcp'], {
        sessionMode: 'act',
        mcpToolSettings: { github: { default: { plan: true, act: true } } },
      }),
    ).toEqual({ available: true });
  });

  it('role приоритетнее mode (сначала ролевая проверка)', () => {
    expect(
      computeToolAvailability('write_file', ['file_write'], {
        sessionMode: 'plan',
        planMode: 'auto',
        agentCapabilities: ['file_read'],
      }),
    ).toEqual({ available: false, reason: 'role' });
  });

  it('dependency: git-тул при отсутствии git → unavailable(dependency)', () => {
    expect(
      computeToolAvailability('git_status', ['git_read'], {
        runtimeDeps: { git: false, rg: true, sh: true },
      }),
    ).toEqual({ available: false, reason: 'dependency' });
  });

  it('dependency: grep_files при отсутствии rg, execute_shell при отсутствии sh', () => {
    expect(
      computeToolAvailability('grep_files', ['file_read'], {
        runtimeDeps: { git: true, rg: false, sh: true },
      }),
    ).toEqual({ available: false, reason: 'dependency' });
    expect(
      computeToolAvailability('execute_shell', ['shell'], {
        runtimeDeps: { git: true, rg: true, sh: false },
      }),
    ).toEqual({ available: false, reason: 'dependency' });
  });

  it('dependency не влияет на тулы без внешней программы', () => {
    expect(
      computeToolAvailability('read_file', ['file_read'], {
        runtimeDeps: { git: false, rg: false, sh: false },
      }),
    ).toEqual({ available: true });
  });

  it('runtimeDeps не задан → доступно (fail-open)', () => {
    expect(computeToolAvailability('git_status', ['git_read'], {})).toEqual({ available: true });
  });

  it('mode приоритетнее dependency (plan-рестрикция git_write)', () => {
    expect(
      computeToolAvailability('git_commit', ['git_write'], {
        sessionMode: 'plan',
        planMode: 'auto',
        planApproved: false,
        runtimeDeps: { git: false, rg: true, sh: true },
      }),
    ).toEqual({ available: false, reason: 'mode' });
  });

  it('role приоритетнее dependency (ролевая проверка первой)', () => {
    expect(
      computeToolAvailability('git_status', ['git_read'], {
        agentCapabilities: ['file_read'],
        runtimeDeps: { git: false, rg: true, sh: true },
      }),
    ).toEqual({ available: false, reason: 'role' });
  });
});

describe('computeToolAvailability — workspace (AD-075)', () => {
  it('workspaceReady:false блокирует file/shell/git/search причиной workspace', () => {
    const cases: Array<[string, string]> = [
      ['read_file', 'file_read'],
      ['write_file', 'file_write'],
      ['execute_shell', 'shell'],
      ['grep_files', 'search'],
      ['git_status', 'git_read'],
      ['git_commit', 'git_write'],
    ];
    for (const [tool, cap] of cases) {
      expect(computeToolAvailability(tool, [cap], { workspaceReady: false })).toEqual({
        available: false,
        reason: 'workspace',
      });
    }
  });

  it('workspaceReady:false не блокирует web/task/runtime', () => {
    expect(computeToolAvailability('web_fetch', ['web'], { workspaceReady: false })).toEqual({ available: true });
    expect(computeToolAvailability('task', ['task'], { workspaceReady: false })).toEqual({ available: true });
    expect(computeToolAvailability('classify_conversation', ['runtime'], { workspaceReady: false })).toEqual({ available: true });
  });

  it('workspaceReady undefined/true → fail-open', () => {
    expect(computeToolAvailability('read_file', ['file_read'], {})).toEqual({ available: true });
    expect(computeToolAvailability('read_file', ['file_read'], { workspaceReady: true })).toEqual({ available: true });
  });

  it('isWorkspaceDependentTool: file/shell/git/search — да, web/task/runtime — нет', () => {
    expect(isWorkspaceDependentTool(['file_read'])).toBe(true);
    expect(isWorkspaceDependentTool(['file_write'])).toBe(true);
    expect(isWorkspaceDependentTool(['shell'])).toBe(true);
    expect(isWorkspaceDependentTool(['search'])).toBe(true);
    expect(isWorkspaceDependentTool(['git_read'])).toBe(true);
    expect(isWorkspaceDependentTool(['git_write'])).toBe(true);
    expect(isWorkspaceDependentTool(['web'])).toBe(false);
    expect(isWorkspaceDependentTool(['task'])).toBe(false);
    expect(isWorkspaceDependentTool(['runtime'])).toBe(false);
    expect(isWorkspaceDependentTool(undefined)).toBe(false);
    expect(isWorkspaceDependentTool([])).toBe(false);
  });

  it('mode приоритетнее workspace (plan-рестрикция write)', () => {
    expect(
      computeToolAvailability('write_file', ['file_write'], {
        sessionMode: 'plan',
        planMode: 'auto',
        workspaceReady: false,
      }),
    ).toEqual({ available: false, reason: 'mode' });
  });
});
