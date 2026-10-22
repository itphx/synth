/**
 * Поведение при переводе точек исполнения на порт (ADR-077, шаг 1).
 *
 * Тесты фиксируют то, что порт НЕ должен менять:
 *   - параметры вызова (бинарь/аргументы, форма команды, `cwd`, таймаут,
 *     лимит вывода, окружение, сигнал отмены);
 *   - тексты результатов и ошибок тулов (`tool.binary_missing`,
 *     `tool.output_truncated`, `search.rg_not_installed`, ошибки git);
 *   - семантику таймаута (обычная ошибка, а не маркер отмены) и наследование
 *     `process.env`/`HOME`.
 *
 * «Запись» запросов делает подставной порт; реальные запуски (inline-реализация)
 * проверяют окружение и обрезку вывода.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstructionsConfig, ToolContext } from '@itphx/synth-shared';
import { executeShellTool } from '../engine/tools/shell.js';
import { grepFilesTool } from '../engine/tools/search.js';
import { gitShowTool, gitStatusTool } from '../engine/tools/git.js';
import { getProjectInfoTool, listReposTool } from '../engine/tools/project-context.js';
import { runInlineShell } from '../engine/commands/inline-shell.js';
import { probeBinary } from '../engine/tools/runtime-deps.js';
import { ProjectInstructionsResolver } from '../engine/context/instructions.js';
import { t as sm } from '../engine/system-messages.js';
import { ExecutionError, DEFAULT_MAX_OUTPUT_BYTES, type ExecRequest, type ExecResult, type ExecutionPort } from './ports/index.js';

/** Порт-заглушка: пишет запросы и отдаёт заданный результат/ошибку. */
class RecordingPort implements ExecutionPort {
  readonly requests: ExecRequest[] = [];

  constructor(
    private readonly behavior: {
      result?: Partial<ExecResult>;
      error?: ExecutionError;
    } = {},
  ) {}

  async execute(req: ExecRequest): Promise<ExecResult> {
    this.requests.push(req);
    if (this.behavior.error) throw this.behavior.error;
    return {
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
      durationMs: 1,
      ...this.behavior.result,
    };
  }
}

/** Минимальный конфиг резолвера проектных инструкций (ADR-069). */
function makeInstructionsConfig(): InstructionsConfig {
  return {
    enabled: true,
    claudeCompat: false,
    contextCompat: false,
    headRatio: 0.7,
    tailRatio: 0.2,
    windowRatio: 0.06,
    minChars: 20_000,
    maxCharsCeiling: 500_000,
    lazy: { enabled: true, maxAncestors: 5, maxChars: 8_000, excludeDirs: [] },
    fetch: { timeoutMs: 5_000, cacheTtlSec: 3_600, maxBytes: 262_144 },
    sources: [],
    excludeProjects: [],
    allowInstallTreeFallback: false,
  };
}

describe('ADR-077: точки исполнения ходят в порт с прежними параметрами', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-exec-port-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(port: ExecutionPort, overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      extra: { executionPort: port },
      ...overrides,
    };
  }

  it('execute_shell: shell-форма, cwd, таймаут 30 с, лимит 10 МБ, HOME', async () => {
    const port = new RecordingPort({ result: { stdout: 'ok' } });
    const result = await executeShellTool.execute({ command: 'echo ok' }, makeCtx(port));

    expect(result.isError).toBeFalsy();
    expect(port.requests).toHaveLength(1);
    const req = port.requests[0]!;
    expect(req.command).toEqual({ kind: 'shell', command: 'echo ok', shell: 'sh' });
    expect(req.cwd).toBe(tmpDir);
    expect(req.timeoutMs).toBe(30_000);
    expect(req.maxOutputBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(req.env).toEqual({ HOME: process.env.HOME || '/root' });
    expect(req.signal).toBeUndefined();
  });

  it('execute_shell: явный таймаут уходит в порт; лимит 120 с не менялся', async () => {
    const port = new RecordingPort();
    await executeShellTool.execute({ command: 'echo ok', timeout: 5_000 }, makeCtx(port));
    expect(port.requests[0]!.timeoutMs).toBe(5_000);

    const tooBig = await executeShellTool.execute({ command: 'echo ok', timeout: 120_001 }, makeCtx(port));
    expect(tooBig.isError).toBe(true);
    expect((tooBig.metadata?.i18n as { key?: string })?.key).toBe('tool.args_error');
    expect(port.requests).toHaveLength(1);
  });

  it('execute_shell: сигнал отмены передаётся в порт', async () => {
    const port = new RecordingPort();
    const ac = new AbortController();
    await executeShellTool.execute({ command: 'echo ok' }, makeCtx(port, { abortSignal: ac.signal }));
    expect(port.requests[0]!.signal).toBe(ac.signal);
  });

  it('grep_files: argv без shell, таймаут 30 с, лимит 10 МБ, cwd не задан', async () => {
    const port = new RecordingPort({ result: { stdout: 'file.ts:1:hit\n' } });
    const result = await grepFilesTool.execute({ pattern: 'hit' }, makeCtx(port));

    expect(result.isError).toBeFalsy();
    const req = port.requests[0]!;
    expect(req.command.kind).toBe('argv');
    expect(req.command).toMatchObject({ kind: 'argv', file: 'rg' });
    const args = (req.command as { args?: string[] }).args ?? [];
    expect(args.slice(0, 5)).toEqual(['--line-number', '--no-heading', '--color', 'never', '-n']);
    expect(args[args.length - 2]).toBe('hit');
    expect(args[args.length - 1]).toBe(tmpDir);
    expect(req.timeoutMs).toBe(30_000);
    expect(req.maxOutputBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(req.cwd).toBeUndefined();
    expect(req.env).toBeUndefined();
  });

  it('git: argv без shell, cwd, таймаут 30 с, лимит 10 МБ', async () => {
    const port = new RecordingPort({ result: { stdout: '## main' } });
    const result = await gitStatusTool.execute({}, makeCtx(port));

    expect(result.isError).toBeFalsy();
    const req = port.requests[0]!;
    expect(req.command).toEqual({ kind: 'argv', file: 'git', args: ['status', '--porcelain', '--branch'] });
    expect(req.cwd).toBe(tmpDir);
    expect(req.timeoutMs).toBe(30_000);
    expect(req.maxOutputBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
  });

  it('inline-shell: shell-форма, cwd, таймаут 30 с, лимит 10 МБ, HOME', async () => {
    const port = new RecordingPort({ result: { stdout: 'out' } });
    const exec = await runInlineShell({ command: 'echo out', workingDir: tmpDir, execution: port });

    expect(exec.isError).toBe(false);
    const req = port.requests[0]!;
    expect(req.command).toEqual({ kind: 'shell', command: 'echo out', shell: 'sh' });
    expect(req.cwd).toBe(tmpDir);
    expect(req.timeoutMs).toBe(30_000);
    expect(req.maxOutputBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(req.env).toEqual({ HOME: process.env.HOME || '/root' });
  });

  it('детект зависимостей: проба `bin --version` через порт, таймаут 3 с', async () => {
    const port = new RecordingPort();
    expect(await probeBinary('git', ['--version'], port)).toBe(true);

    const req = port.requests[0]!;
    expect(req.command).toEqual({ kind: 'argv', file: 'git', args: ['--version'] });
    expect(req.timeoutMs).toBe(3_000);
  });
});

describe('ADR-077: тексты ошибок тулов не изменились', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-exec-err-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(port: ExecutionPort): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: tmpDir, extra: { executionPort: port } };
  }

  it('execute_shell: ENOENT → tool.binary_missing (бинарь sh)', async () => {
    const port = new RecordingPort({
      error: new ExecutionError({ message: 'spawn sh ENOENT', code: 'ENOENT', reason: 'spawn_failed' }),
    });
    const result = await executeShellTool.execute({ command: 'echo ok' }, makeCtx(port));

    expect(result.isError).toBe(true);
    expect(result.content).toBe(sm('tool.binary_missing', { tool: 'execute_shell', binary: 'sh' }));
    expect((result.metadata?.i18n as { key?: string })?.key).toBe('tool.binary_missing');
  });

  it('execute_shell: таймаут — обычная ошибка (не маркер отмены), exitCode -1', async () => {
    const port = new RecordingPort({
      error: new ExecutionError({
        message: 'Command failed: sh -c sleep 5\n',
        code: null,
        killed: true,
        signal: 'SIGTERM',
        reason: 'timeout',
      }),
    });
    const result = await executeShellTool.execute({ command: 'sleep 5' }, makeCtx(port));

    expect(result.isError).toBe(true);
    expect(result.metadata?.interrupted).toBeUndefined();
    expect(result.metadata?.stopped_by).toBeUndefined();
    expect(result.metadata?.exitCode).toBe(-1);
    expect(result.metadata?.killed).toBe(true);
    expect(result.content).toContain('Command failed: sh -c sleep 5');
  });

  it('git: ENOENT → tool.binary_missing (бинарь git)', async () => {
    const port = new RecordingPort({
      error: new ExecutionError({ message: 'spawn git ENOENT', code: 'ENOENT', reason: 'spawn_failed' }),
    });
    const result = await gitStatusTool.execute({}, makeCtx(port));

    expect(result.isError).toBe(true);
    expect(result.content).toBe(sm('tool.binary_missing', { tool: 'git_status', binary: 'git' }));
    expect((result.metadata?.i18n as { key?: string })?.key).toBe('tool.binary_missing');
  });

  it('git: таймаут — обычная ошибка git (не маркер отмены)', async () => {
    const port = new RecordingPort({
      error: new ExecutionError({
        message: 'Command failed: git status\n',
        code: null,
        killed: true,
        signal: 'SIGTERM',
        reason: 'timeout',
      }),
    });
    const result = await gitStatusTool.execute({}, makeCtx(port));

    expect(result.isError).toBe(true);
    expect(result.metadata?.interrupted).toBeUndefined();
    expect(result.content).toContain('Ошибка git status');
  });

  it('git: вывод обрезается на уровне тула (20 КБ)', async () => {
    const port = new RecordingPort({ result: { stdout: 'x'.repeat(30_000) } });
    const result = await gitShowTool.execute({ object: 'HEAD' }, makeCtx(port));

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(20_000 + '\n... (вывод обрезан)'.length);
    expect(result.content.endsWith('\n... (вывод обрезан)')).toBe(true);
  });

  it('grep_files: rg не установлен (code 127) → search.rg_not_installed', async () => {
    const port = new RecordingPort({
      error: new ExecutionError({ message: 'rg: not found', code: 127, reason: 'nonzero_exit' }),
    });
    const result = await grepFilesTool.execute({ pattern: 'hit' }, makeCtx(port));

    expect(result.isError).toBe(true);
    expect(result.content).toBe(sm('search.rg_not_installed'));
    expect((result.metadata?.i18n as { key?: string })?.key).toBe('search.rg_not_installed');
  });

  it('grep_files: rg завершился с кодом 1 → совпадений нет', async () => {
    const port = new RecordingPort({
      error: new ExecutionError({ message: 'Command failed', code: 1, reason: 'nonzero_exit' }),
    });
    const result = await grepFilesTool.execute({ pattern: 'hit' }, makeCtx(port));

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(sm('search.no_matches'));
    expect(result.metadata?.matches).toBe(0);
  });
});

describe('ADR-077: inline-реализация сохраняет окружение и обрезку вывода', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-exec-real-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.SYNTH_EXEC_INHERIT_TEST;
  });

  function makeCtx(): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: tmpDir };
  }

  it('execute_shell: наследуется весь process.env и HOME', async () => {
    process.env.SYNTH_EXEC_INHERIT_TEST = 'inherited';
    const result = await executeShellTool.execute(
      { command: 'printf "%s|%s" "$SYNTH_EXEC_INHERIT_TEST" "$HOME"' },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(`inherited|${process.env.HOME || '/root'}`);
  });

  it('execute_shell: вывод > 100 КБ обрезается на уровне тула', async () => {
    const result = await executeShellTool.execute({ command: 'yes a | head -c 200000' }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(result.metadata?.truncated).toBe(true);
    expect(result.content.endsWith(sm('tool.output_truncated'))).toBe(true);
    expect(result.content.length).toBe(100_000 + sm('tool.output_truncated').length);
  });

  it('execute_shell: пустой вывод — маркер tool.empty_output', async () => {
    const result = await executeShellTool.execute({ command: 'true' }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(sm('tool.empty_output'));
  });
});

/**
 * ADR-077: точки исполнения, которые не являются тулами, тоже ходят во
 * внедрённый порт — иначе в split-режиме они остались бы в control plane.
 */
describe('ADR-077: не-туловые точки исполнения используют внедрённый порт', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-exec-seam-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(port: ExecutionPort): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: tmpDir, extra: { executionPort: port } };
  }

  it('get_project_info: git-детект идёт через порт (argv, cwd, таймаут 30 с)', async () => {
    // Каталог с `.git` — чтобы детект репозитория состоялся (иначе git не зовётся).
    await mkdir(join(tmpDir, '.git'), { recursive: true });
    const port = new RecordingPort({ result: { stdout: 'main\n' } });

    const result = await getProjectInfoTool.execute({}, makeCtx(port));

    expect(result.isError).toBeFalsy();
    expect(port.requests.length).toBeGreaterThan(0);
    for (const req of port.requests) {
      expect(req.command).toMatchObject({ kind: 'argv', file: 'git' });
      expect(req.cwd).toBe(tmpDir);
      expect(req.timeoutMs).toBe(30_000);
      expect(req.maxOutputBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    }
    expect(port.requests.map((r) => (r.command as { args?: string[] }).args?.[0])).toEqual([
      'branch',
      'remote',
      'status',
      'log',
    ]);
  });

  it('list_repos: git-детект идёт через порт', async () => {
    await mkdir(join(tmpDir, '.git'), { recursive: true });
    const port = new RecordingPort();

    const result = await listReposTool.execute({}, makeCtx(port));

    expect(result.isError).toBeFalsy();
    expect(port.requests.length).toBeGreaterThan(0);
    expect(port.requests[0]!.command).toMatchObject({ kind: 'argv', file: 'git' });
  });

  it('проектные инструкции: `git rev-parse` идёт через порт', async () => {
    const port = new RecordingPort({ result: { stdout: `${tmpDir}\n` } });
    const resolver = new ProjectInstructionsResolver({
      config: makeInstructionsConfig(),
      trustedProjectDirs: [tmpDir],
      dataDir: tmpDir,
      execution: port,
    });

    await resolver.resolve({ workspace: tmpDir });

    expect(port.requests).toHaveLength(1);
    const req = port.requests[0]!;
    expect(req.command).toEqual({ kind: 'argv', file: 'git', args: ['rev-parse', '--show-toplevel'] });
    expect(req.cwd).toBe(tmpDir);
    expect(req.timeoutMs).toBe(30_000);
  });
});
