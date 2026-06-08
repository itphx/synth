import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ToolCapability } from '@synth/shared';
import type { ToolDefinition } from '@synth/shared';

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
}

export const gitStatusTool: ToolDefinition = {
  name: 'git_status',
  description: 'Show the working tree status — current branch, staged/unstaged changes, untracked files.',
  parameters: z.object({
    path: z.string().optional().describe('Path to the git repository (defaults to working directory)'),
  }),
  capabilities: [ToolCapability.GIT_READ],
  async execute(args, ctx) {
    const params = args as { path?: string };
    const cwd = params.path || ctx.workingDir;

    try {
      const { stdout } = await runGit(['status', '--porcelain', '--branch'], cwd);
      return {
        content: stdout || '(чистая рабочая директория)',
        metadata: { cwd, hasChanges: stdout.length > 0 },
      };
    } catch (err: unknown) {
      return {
        content: `Ошибка git status: ${(err as Error).message}`,
        isError: true,
        metadata: { cwd },
      };
    }
  },
};

export const gitDiffTool: ToolDefinition = {
  name: 'git_diff',
  description: 'Show changes between commits, commit and working tree, etc. Shows unstaged diff by default.',
  parameters: z.object({
    path: z.string().optional().describe('Path to the git repository (defaults to working directory)'),
    staged: z.boolean().optional().describe('Show staged changes (default: false)'),
    commit: z.string().optional().describe('Compare with specific commit hash'),
  }),
  capabilities: [ToolCapability.GIT_READ],
  async execute(args, ctx) {
    const params = args as { path?: string; staged?: boolean; commit?: string };
    const cwd = params.path || ctx.workingDir;

    try {
      const diffArgs = ['diff', '--no-color'];
      if (params.staged) diffArgs.push('--staged');
      if (params.commit) diffArgs.push(params.commit);

      const { stdout } = await runGit(diffArgs, cwd);
      const output = stdout || '(нет изменений)';

      return {
        content: output.length > 20_000 ? output.slice(0, 20_000) + '\n... (diff обрезан)' : output,
        metadata: { cwd, hasChanges: stdout.length > 0 },
      };
    } catch (err: unknown) {
      return {
        content: `Ошибка git diff: ${(err as Error).message}`,
        isError: true,
        metadata: { cwd },
      };
    }
  },
};

export const gitLogTool: ToolDefinition = {
  name: 'git_log',
  description: 'Show commit logs. Returns hash, author, date, and subject for each commit.',
  parameters: z.object({
    path: z.string().optional().describe('Path to the git repository (defaults to working directory)'),
    max_count: z.number().int().min(1).max(100).optional().default(10)
      .describe('Maximum number of commits to show (default: 10)'),
  }),
  capabilities: [ToolCapability.GIT_READ],
  async execute(args, ctx) {
    const params = args as { path?: string; max_count?: number };
    const cwd = params.path || ctx.workingDir;

    try {
      const { stdout } = await runGit(
        ['log', `-${params.max_count ?? 10}`, '--oneline', '--decorate'],
        cwd,
      );
      return {
        content: stdout || '(нет коммитов)',
        metadata: { cwd, count: stdout.split('\n').filter(Boolean).length },
      };
    } catch (err: unknown) {
      return {
        content: `Ошибка git log: ${(err as Error).message}`,
        isError: true,
        metadata: { cwd },
      };
    }
  },
};

export const gitCommitTool: ToolDefinition = {
  name: 'git_commit',
  description: 'Create a new commit with all staged changes. Uses git commit -m.',
  parameters: z.object({
    path: z.string().optional().describe('Path to the git repository (defaults to working directory)'),
    message: z.string().describe('Commit message'),
    allow_empty: z.boolean().optional().default(false).describe('Allow empty commit (default: false)'),
  }),
  capabilities: [ToolCapability.GIT_WRITE],
  async execute(args, ctx) {
    const params = args as { path?: string; message: string; allow_empty?: boolean };
    const cwd = params.path || ctx.workingDir;

    try {
      const commitArgs = ['commit', '-m', params.message];
      if (params.allow_empty) commitArgs.push('--allow-empty');

      const { stdout, stderr } = await runGit(commitArgs, cwd);
      return {
        content: stdout || stderr || 'Коммит создан',
        metadata: { cwd, message: params.message },
      };
    } catch (err: unknown) {
      return {
        content: `Ошибка git commit: ${(err as Error).message}`,
        isError: true,
        metadata: { cwd },
      };
    }
  },
};

export const gitPushTool: ToolDefinition = {
  name: 'git_push',
  description: 'Push commits to the remote repository. Uses git push.',
  parameters: z.object({
    path: z.string().optional().describe('Path to the git repository (defaults to working directory)'),
    remote: z.string().optional().default('origin').describe('Remote name (default: origin)'),
    branch: z.string().optional().describe('Branch name to push (default: current branch)'),
  }),
  capabilities: [ToolCapability.GIT_WRITE],
  async execute(args, ctx) {
    const params = args as { path?: string; remote?: string; branch?: string };
    const cwd = params.path || ctx.workingDir;

    try {
      const pushArgs = ['push', params.remote ?? 'origin'];
      if (params.branch) pushArgs.push(params.branch);

      const { stdout, stderr } = await runGit(pushArgs, cwd);
      return {
        content: stdout || stderr || 'git push выполнен',
        metadata: { cwd, remote: params.remote, branch: params.branch },
      };
    } catch (err: unknown) {
      return {
        content: `Ошибка git push: ${(err as Error).message}`,
        isError: true,
        metadata: { cwd },
      };
    }
  },
};

export const gitPullTool: ToolDefinition = {
  name: 'git_pull',
  description: 'Pull changes from the remote repository. Uses git pull.',
  parameters: z.object({
    path: z.string().optional().describe('Path to the git repository (defaults to working directory)'),
    remote: z.string().optional().default('origin').describe('Remote name (default: origin)'),
    branch: z.string().optional().describe('Branch name to pull (default: current tracking branch)'),
  }),
  capabilities: [ToolCapability.GIT_WRITE],
  async execute(args, ctx) {
    const params = args as { path?: string; remote?: string; branch?: string };
    const cwd = params.path || ctx.workingDir;

    try {
      const pullArgs = ['pull', params.remote ?? 'origin'];
      if (params.branch) pullArgs.push(params.branch);

      const { stdout, stderr } = await runGit(pullArgs, cwd);
      return {
        content: stdout || stderr || 'git pull выполнен',
        metadata: { cwd, remote: params.remote, branch: params.branch },
      };
    } catch (err: unknown) {
      return {
        content: `Ошибка git pull: ${(err as Error).message}`,
        isError: true,
        metadata: { cwd },
      };
    }
  },
};

export const gitCheckoutTool: ToolDefinition = {
  name: 'git_checkout',
  description: 'Switch branches or restore files. Uses git checkout.',
  parameters: z.object({
    path: z.string().optional().describe('Path to the git repository (defaults to working directory)'),
    target: z.string().describe('Branch name or commit hash to checkout'),
    create_branch: z.boolean().optional().default(false).describe('Create a new branch before checkout (-b flag)'),
  }),
  capabilities: [ToolCapability.GIT_WRITE],
  async execute(args, ctx) {
    const params = args as { path?: string; target: string; create_branch?: boolean };
    const cwd = params.path || ctx.workingDir;

    try {
      const checkoutArgs = ['checkout'];
      if (params.create_branch) checkoutArgs.push('-b');
      checkoutArgs.push(params.target);

      const { stdout, stderr } = await runGit(checkoutArgs, cwd);
      return {
        content: stdout || stderr || `Переключён на ${params.target}`,
        metadata: { cwd, target: params.target, createdBranch: params.create_branch },
      };
    } catch (err: unknown) {
      return {
        content: `Ошибка git checkout: ${(err as Error).message}`,
        isError: true,
        metadata: { cwd },
      };
    }
  },
};
