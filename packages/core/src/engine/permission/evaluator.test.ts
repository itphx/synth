import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { PermissionEvaluator, extractPaths, isInsideWorkingDir } from './evaluator.js';
import { deriveSubagentPermission } from './derive.js';
import type { PermissionConfig } from '@synth/shared';
import { globMatch } from '@synth/shared';
const CWD = '/workspace/project';

function evalCheck(
  config: PermissionConfig,
  toolName: string,
  params: Record<string, unknown>,
  capabilities?: readonly string[],
) {
  return new PermissionEvaluator(config).check({ toolName, params, workingDir: CWD, capabilities });
}

describe('globMatch', () => {
  it('базовые паттерны', () => {
    expect(globMatch('*.env', '.env')).toBe(true);
    expect(globMatch('*.env', 'config/.env')).toBe(false);
    expect(globMatch('**/*.env', 'config/.env')).toBe(true);
    expect(globMatch('**/credentials.*', 'src/credentials.json')).toBe(true);
    expect(globMatch('/tmp/*', '/tmp/foo.txt')).toBe(true);
    expect(globMatch('/tmp/*', '/tmp/a/b.txt')).toBe(false);
    expect(globMatch('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(globMatch('src/*.ts', 'src/a.ts')).toBe(true);
    expect(globMatch('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(globMatch('*.{ts,js}', 'a.ts')).toBe(true);
    expect(globMatch('*.{ts,js}', 'a.md')).toBe(false);
  });
});

describe('PermissionEvaluator — приоритет правил', () => {
  it('правило по имени тула приоритетнее группового и "*"', () => {
    const cfg: PermissionConfig = {
      rules: { '*': 'allow', read: { '*': 'allow' }, read_file: 'deny' },
      askTimeoutMs: 30_000,
    };
    expect(evalCheck(cfg, 'read_file', { file_path: 'a.txt' }).action).toBe('deny');
  });

  it('групповое правило приоритетнее "*"', () => {
    const cfg: PermissionConfig = {
      rules: { '*': 'allow', read: 'deny' },
      askTimeoutMs: 30_000,
    };
    expect(evalCheck(cfg, 'read_file', { file_path: 'a.txt' }).action).toBe('deny');
    // не входящий в группу тул — только '*'
    expect(evalCheck(cfg, 'web_fetch', { url: 'http://x' }).action).toBe('allow');
  });

  it('дефолт allow при пустом конфиге', () => {
    const cfg: PermissionConfig = { rules: {}, askTimeoutMs: 30_000 };
    expect(evalCheck(cfg, 'write_file', { file_path: 'a.txt' }).action).toBe('allow');
  });

  it('специфичный файловый паттерн побеждает "*" внутри группы', () => {
    const cfg: PermissionConfig = {
      rules: { read: { '*': 'allow', '*.env': 'ask' } },
      askTimeoutMs: 30_000,
    };
    expect(evalCheck(cfg, 'read_file', { file_path: '.env' }).action).toBe('ask');
    expect(evalCheck(cfg, 'read_file', { file_path: 'src/main.ts' }).action).toBe('allow');
  });
});

describe('PermissionEvaluator — группы', () => {
  it('read применяется к read_file/list_directory/glob', () => {
    const cfg: PermissionConfig = { rules: { read: 'deny' }, askTimeoutMs: 30_000 };
    expect(evalCheck(cfg, 'read_file', { file_path: 'a.txt' }).action).toBe('deny');
    expect(evalCheck(cfg, 'list_directory', { path: 'src' }).action).toBe('deny');
    expect(evalCheck(cfg, 'glob', { pattern: '**/*.ts', path: 'src' }).action).toBe('deny');
  });

  it('edit применяется к write_file/edit_file/delete_file/create_directory', () => {
    const cfg: PermissionConfig = { rules: { edit: 'deny' }, askTimeoutMs: 30_000 };
    expect(evalCheck(cfg, 'write_file', { file_path: 'a.txt', content: 'x' }).action).toBe('deny');
    expect(evalCheck(cfg, 'edit_file', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }).action).toBe('deny');
    expect(evalCheck(cfg, 'delete_file', { file_path: 'a.txt' }).action).toBe('deny');
    expect(evalCheck(cfg, 'create_directory', { path: 'new' }).action).toBe('deny');
  });

  it('shell применяется к execute_shell', () => {
    const cfg: PermissionConfig = { rules: { shell: 'ask' }, askTimeoutMs: 30_000 };
    expect(evalCheck(cfg, 'execute_shell', { command: 'ls' }).action).toBe('ask');
  });

  it('capability-имя группы работает (file_write)', () => {
    const cfg: PermissionConfig = { rules: { file_write: 'deny' }, askTimeoutMs: 30_000 };
    expect(evalCheck(cfg, 'write_file', { file_path: 'a.txt', content: 'x' }, ['file_write']).action).toBe('deny');
  });

  it('mcp-группа матчит динамические тулы по capability', () => {
    const cfg: PermissionConfig = { rules: { mcp: 'deny' }, askTimeoutMs: 30_000 };
    expect(evalCheck(cfg, 'some_mcp_tool', {}, ['mcp']).action).toBe('deny');
  });
});

describe('PermissionEvaluator — файловые паттерны', () => {
  it('паттерн матчится по относительному и абсолютному пути', () => {
    const cfg: PermissionConfig = {
      rules: { read: { '*': 'allow', '**/credentials.*': 'deny', '*.env': 'ask' } },
      askTimeoutMs: 30_000,
    };
    const absCred = join(CWD, 'src', 'credentials.json');
    expect(evalCheck(cfg, 'read_file', { file_path: absCred }).action).toBe('deny');
    expect(evalCheck(cfg, 'read_file', { file_path: 'src/credentials.json' }).action).toBe('deny');
    // *.env — только файлы в корне workingDir (вложенные требуют **)
    expect(evalCheck(cfg, 'read_file', { file_path: 'config/.env' }).action).toBe('allow');
    expect(evalCheck(cfg, 'read_file', { file_path: 'config/.env' }).matchedRule).toBe('read.*');
  });

  it('паттерн "*.env" матчит файл в корне workingDir', () => {
    const cfg: PermissionConfig = {
      rules: { read: { '*': 'allow', '*.env': 'ask' } },
      askTimeoutMs: 30_000,
    };
    expect(evalCheck(cfg, 'read_file', { file_path: join(CWD, '.env') }).action).toBe('ask');
    expect(evalCheck(cfg, 'read_file', { file_path: '.env' }).matchedRule).toBe('read.*.env');
  });
});

describe('PermissionEvaluator — external_directory', () => {
  it('путь вне workingDir проверяется по секции external_directory', () => {
    const cfg: PermissionConfig = {
      rules: { external_directory: { '*': 'ask', '/tmp/*': 'allow' } },
      askTimeoutMs: 30_000,
    };
    expect(evalCheck(cfg, 'read_file', { file_path: '/tmp/x.txt' }).action).toBe('allow');
    expect(evalCheck(cfg, 'read_file', { file_path: '/etc/passwd' }).action).toBe('ask');
    // внутри workingDir external_directory не применяется
    expect(evalCheck(cfg, 'read_file', { file_path: 'a.txt' }).action).toBe('allow');
  });

  it('external_directory работает для execute_shell cwd', () => {
    const cfg: PermissionConfig = {
      rules: { external_directory: { '*': 'deny' }, '*': 'allow' },
      askTimeoutMs: 30_000,
    };
    expect(evalCheck(cfg, 'execute_shell', { command: 'ls', cwd: '/elsewhere' }).action).toBe('deny');
  });
});

describe('PermissionEvaluator — plan_enter/plan_exit (имена тулов)', () => {
  it('слой готов к ещё не реализованным тулам', () => {
    const cfg: PermissionConfig = {
      rules: { '*': 'allow', plan_enter: 'deny', plan_exit: 'deny', doom_loop: 'ask', question: 'deny' },
      askTimeoutMs: 30_000,
    };
    expect(evalCheck(cfg, 'plan_enter', {}).action).toBe('deny');
    expect(evalCheck(cfg, 'plan_exit', {}).action).toBe('deny');
    expect(evalCheck(cfg, 'doom_loop', {}).action).toBe('ask');
    expect(evalCheck(cfg, 'question', {}).action).toBe('deny');
    expect(evalCheck(cfg, 'read_file', { file_path: 'a.txt' }).action).toBe('allow');
  });
});

describe('PermissionEvaluator — plan mode (AD-025)', () => {
  function planCheck(
    toolName: string,
    params: Record<string, unknown>,
    opts: { sessionMode?: 'plan' | 'act'; planMode?: 'auto' | 'strict' | 'off'; planApproved?: boolean } = {},
  ) {
    return new PermissionEvaluator({ rules: {}, askTimeoutMs: 30_000 }).check({
      toolName,
      params,
      workingDir: CWD,
      sessionMode: opts.sessionMode ?? 'act',
      planMode: opts.planMode ?? 'auto',
      planApproved: opts.planApproved ?? false,
    });
  }

  it('mode=plan блокирует write/edit/delete тулы', () => {
    expect(planCheck('write_file', { file_path: 'a.txt', content: 'x' }, { sessionMode: 'plan' }).action).toBe('deny');
    expect(planCheck('edit_file', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }, { sessionMode: 'plan' }).action).toBe('deny');
    expect(planCheck('delete_file', { file_path: 'a.txt' }, { sessionMode: 'plan' }).action).toBe('deny');
    expect(planCheck('create_directory', { path: 'new' }, { sessionMode: 'plan' }).action).toBe('deny');
  });

  it('mode=plan разрешает запись в .synth/plans/*.md', () => {
    const d = planCheck('write_file', { file_path: '.synth/plans/2026-01-01-100000-plan.md', content: 'x' }, { sessionMode: 'plan' });
    expect(d.action).toBe('allow');
    expect(d.matchedRule).toBe('plan.plans');
  });

  it('mode=plan не блокирует read-тулы', () => {
    expect(planCheck('read_file', { file_path: 'a.txt' }, { sessionMode: 'plan' }).action).toBe('allow');
    expect(planCheck('grep_files', { path: 'src', pattern: 'x' }, { sessionMode: 'plan' }).action).toBe('allow');
  });

  it('mode=plan не блокирует plan_enter/plan_exit (сами управляют режимом)', () => {
    expect(planCheck('plan_enter', {}, { sessionMode: 'plan' }).action).toBe('allow');
    expect(planCheck('plan_exit', { plan: 'x' }, { sessionMode: 'plan' }).action).toBe('allow');
  });

  it('strict без утверждённого плана блокирует write', () => {
    expect(planCheck('write_file', { file_path: 'a.txt', content: 'x' }, { planMode: 'strict', planApproved: false }).action).toBe('deny');
  });

  it('strict с утверждённым планом разрешает write', () => {
    expect(planCheck('write_file', { file_path: 'a.txt', content: 'x' }, { planMode: 'strict', planApproved: true }).action).toBe('allow');
  });

  it('strict без плана разрешает чтение', () => {
    expect(planCheck('read_file', { file_path: 'a.txt' }, { planMode: 'strict', planApproved: false }).action).toBe('allow');
  });

  it('mode=plan блокирует git-запись', () => {
    expect(planCheck('git_commit', { path: '.' }, { sessionMode: 'plan' }).action).toBe('deny');
    expect(planCheck('git_push', {}, { sessionMode: 'plan' }).action).toBe('deny');
    expect(planCheck('git_pull', {}, { sessionMode: 'plan' }).action).toBe('deny');
    expect(planCheck('git_checkout', { branch: 'main' }, { sessionMode: 'plan' }).action).toBe('deny');
    expect(planCheck('git_stash', { action: 'push' }, { sessionMode: 'plan' }).action).toBe('deny');
  });

  it('strict без плана блокирует git-запись', () => {
    expect(planCheck('git_commit', { path: '.' }, { planMode: 'strict', planApproved: false }).action).toBe('deny');
  });

  it('mode=plan оставляет git-чтение доступным', () => {
    expect(planCheck('git_status', { path: '.' }, { sessionMode: 'plan' }).action).toBe('allow');
    expect(planCheck('git_diff', {}, { sessionMode: 'plan' }).action).toBe('allow');
    expect(planCheck('git_log', {}, { sessionMode: 'plan' }).action).toBe('allow');
    expect(planCheck('git_branch_list', {}, { sessionMode: 'plan' }).action).toBe('allow');
    expect(planCheck('git_show', {}, { sessionMode: 'plan' }).action).toBe('allow');
    expect(planCheck('git_blame', {}, { sessionMode: 'plan' }).action).toBe('allow');
  });

  it('strict без плана оставляет git-чтение доступным', () => {
    expect(planCheck('git_status', { path: '.' }, { planMode: 'strict', planApproved: false }).action).toBe('allow');
  });

  it('mode=plan в act-режиме не блокирует git-запись', () => {
    expect(planCheck('git_commit', { path: '.' }, { sessionMode: 'act', planMode: 'auto' }).action).toBe('allow');
  });

  it('off никогда не блокирует write', () => {
    expect(planCheck('write_file', { file_path: 'a.txt', content: 'x' }, { planMode: 'off', sessionMode: 'plan', planApproved: false }).action).toBe('allow');
  });

  it('auto в act-режиме не блокирует write', () => {
    expect(planCheck('write_file', { file_path: 'a.txt', content: 'x' }, { planMode: 'auto', sessionMode: 'act' }).action).toBe('allow');
  });
});

describe('PermissionEvaluator — MCP доступность по режимам (plan/act)', () => {
  function mcpCheck(
    mcpToolSettings: Record<string, import('@synth/shared').McpServerToolSettings>,
    opts: { sessionMode?: 'plan' | 'act' } = {},
  ) {
    return new PermissionEvaluator({ rules: {}, askTimeoutMs: 30_000 }).check({
      toolName: 'github_create_issue',
      params: {},
      workingDir: CWD,
      capabilities: ['mcp'],
      sessionMode: opts.sessionMode ?? 'act',
      mcpToolSettings,
    });
  }

  it('plan=false в plan-режиме — deny', () => {
    const d = mcpCheck({ github: { default: { plan: false, act: true } } }, { sessionMode: 'plan' });
    expect(d.action).toBe('deny');
    expect(d.matchedRule).toBe('mcp.mode');
  });

  it('plan=true в plan-режиме — allow', () => {
    const d = mcpCheck({ github: { default: { plan: true, act: true } } }, { sessionMode: 'plan' });
    expect(d.action).toBe('allow');
  });

  it('act=false в act-режиме — deny', () => {
    const d = mcpCheck({ github: { default: { plan: true, act: false } } }, { sessionMode: 'act' });
    expect(d.action).toBe('deny');
  });

  it('act=true в act-режиме — allow', () => {
    const d = mcpCheck({ github: { default: { plan: true, act: true } } }, { sessionMode: 'act' });
    expect(d.action).toBe('allow');
  });

  it('точечная настройка tools приоритетнее default', () => {
    const d = mcpCheck({
      github: { default: { plan: true, act: true }, tools: { create_issue: { plan: false, act: true } } },
    }, { sessionMode: 'plan' });
    expect(d.action).toBe('deny');
  });

  it('без настроек для сервера — доступен (обратная совместимость)', () => {
    const d = mcpCheck({ other_server: { default: { plan: false, act: false } } }, { sessionMode: 'plan' });
    expect(d.action).toBe('allow');
  });

  it('без mcpToolSettings — доступен (обратная совместимость)', () => {
    const d = new PermissionEvaluator({ rules: {}, askTimeoutMs: 30_000 }).check({
      toolName: 'github_create_issue',
      params: {},
      workingDir: CWD,
      capabilities: ['mcp'],
      sessionMode: 'plan',
    });
    expect(d.action).toBe('allow');
  });

  it('не-MCP тулы не затрагиваются настройками', () => {
    const d = new PermissionEvaluator({ rules: {}, askTimeoutMs: 30_000 }).check({
      toolName: 'read_file',
      params: { file_path: 'a.txt' },
      workingDir: CWD,
      sessionMode: 'plan',
      mcpToolSettings: { github: { default: { plan: false, act: false } } },
    });
    expect(d.action).toBe('allow');
  });
});

describe('PermissionEvaluator — yolo mode (AD-025)', () => {
  function yoloCheck(
    config: PermissionConfig,
    toolName: string,
    params: Record<string, unknown>,
    opts: { sessionMode?: 'plan' | 'act' | 'yolo'; planMode?: 'auto' | 'strict' | 'off'; planApproved?: boolean; capabilities?: readonly string[] } = {},
  ) {
    return new PermissionEvaluator(config).check({
      toolName,
      params,
      workingDir: CWD,
      capabilities: opts.capabilities,
      sessionMode: opts.sessionMode ?? 'yolo',
      planMode: opts.planMode ?? 'auto',
      planApproved: opts.planApproved ?? false,
    });
  }

  it('ask трансформируется в allow (автоподтверждение)', () => {
    const cfg: PermissionConfig = { rules: { write_file: 'ask' }, askTimeoutMs: 30_000 };
    const d = yoloCheck(cfg, 'write_file', { file_path: 'a.txt', content: 'x' });
    expect(d.action).toBe('allow');
    expect(d.reason).toContain('yolo');
  });

  it('ask на групповом правиле и "*" тоже трансформируется в allow', () => {
    const cfg: PermissionConfig = { rules: { shell: 'ask' }, askTimeoutMs: 30_000 };
    expect(yoloCheck(cfg, 'execute_shell', { command: 'ls' }).action).toBe('allow');

    const starCfg: PermissionConfig = { rules: { '*': 'ask' }, askTimeoutMs: 30_000 };
    expect(yoloCheck(starCfg, 'read_file', { file_path: 'a.txt' }).action).toBe('allow');
  });

  it('deny остаётся deny (не трансформируется)', () => {
    const cfg: PermissionConfig = { rules: { write_file: 'deny', '*.env': 'deny' }, askTimeoutMs: 30_000 };
    expect(yoloCheck(cfg, 'write_file', { file_path: 'a.txt', content: 'x' }).action).toBe('deny');
  });

  it('allow остаётся allow', () => {
    const cfg: PermissionConfig = { rules: { read_file: 'allow' }, askTimeoutMs: 30_000 };
    expect(yoloCheck(cfg, 'read_file', { file_path: 'a.txt' }).action).toBe('allow');
  });

  it('plan-рестрикция не активируется самим режимом yolo', () => {
    // write не блокируется из-за yolo (режим plan блокирует — но yolo не plan)
    const cfg: PermissionConfig = { rules: {}, askTimeoutMs: 30_000 };
    expect(yoloCheck(cfg, 'write_file', { file_path: 'a.txt', content: 'x' }).action).toBe('allow');
  });

  it('в yolo deny от MCP-доступности остаётся deny', () => {
    const cfg: PermissionConfig = { rules: {}, askTimeoutMs: 30_000 };
    const d = new PermissionEvaluator(cfg).check({
      toolName: 'github_create_issue',
      params: {},
      workingDir: CWD,
      capabilities: ['mcp'],
      sessionMode: 'yolo',
      mcpToolSettings: { github: { default: { plan: true, act: false } } },
    });
    expect(d.action).toBe('deny');
  });

  it('strict без утверждённого плана блокирует write даже в yolo', () => {
    const cfg: PermissionConfig = { rules: {}, askTimeoutMs: 30_000 };
    const d = yoloCheck(cfg, 'write_file', { file_path: 'a.txt', content: 'x' }, { planMode: 'strict', planApproved: false });
    expect(d.action).toBe('deny');
  });
});

describe('deriveSubagentPermission', () => {
  it('наследует правила родителя и добавляет deny на question/plan_enter/plan_exit/task', () => {
    const parent: PermissionConfig = {
      rules: { '*': 'allow', read: 'allow' },
      askTimeoutMs: 10_000,
    };
    const derived = deriveSubagentPermission(parent);
    expect(derived.askTimeoutMs).toBe(10_000);
    expect(derived.rules['*']).toBe('allow');
    expect(derived.rules.read).toBe('allow');
    expect(derived.rules.question).toBe('deny');
    expect(derived.rules.plan_enter).toBe('deny');
    expect(derived.rules.plan_exit).toBe('deny');
    expect(derived.rules.task).toBe('deny');
    // deny на конкретное имя переопределяет allow из '*'
    expect(evalCheck(derived, 'task', {}).action).toBe('deny');
    expect(evalCheck(derived, 'question', {}).action).toBe('deny');
  });

  it('без родителя — только deny-дополнения', () => {
    const derived = deriveSubagentPermission();
    expect(derived.rules).toEqual({
      question: 'deny',
      plan_enter: 'deny',
      plan_exit: 'deny',
      task: 'deny',
    });
  });

  it('не мутирует родительский конфиг', () => {
    const parent: PermissionConfig = { rules: { '*': 'allow' }, askTimeoutMs: 5000 };
    deriveSubagentPermission(parent);
    expect(parent.rules).toEqual({ '*': 'allow' });
  });
});

describe('extractPaths / isInsideWorkingDir', () => {
  it('extractPaths резолвит файловые параметры', () => {
    expect(extractPaths('read_file', { file_path: 'a.txt' }, CWD)).toEqual([join(CWD, 'a.txt')]);
    expect(extractPaths('read_file', { file_path: '/abs/a.txt' }, CWD)).toEqual(['/abs/a.txt']);
    expect(extractPaths('write_file', { file_path: '' }, CWD)).toEqual([]);
    expect(extractPaths('execute_shell', { command: 'ls', cwd: 'sub' }, CWD)).toEqual([join(CWD, 'sub')]);
    expect(extractPaths('web_fetch', { url: 'http://x' }, CWD)).toEqual([]);
  });

  it('isInsideWorkingDir', () => {
    expect(isInsideWorkingDir(join(CWD, 'a.txt'), CWD)).toBe(true);
    expect(isInsideWorkingDir(CWD, CWD)).toBe(true);
    expect(isInsideWorkingDir('/tmp/x', CWD)).toBe(false);
  });
});
