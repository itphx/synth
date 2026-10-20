import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition, ToolContext, ToolResult } from '@itphx/synth-shared';
import { resolvePath, validateInputPath, isSymlinkEscape, isInsideReal, pathEscapesWorkspaceResult } from './path-utils.js';
import { deobfuscateArgs } from './obfuscation.js';
import { isAborted, abortedResult } from './abort.js';
import { resolveRepoGitEnv, resolveProjectRepoEntry } from './git-ssh.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import type { SystemMessageKey } from '../system-messages.js';

const execFileAsync = promisify(execFile);

const MAX_GIT_OUTPUT = 20_000;

/**
 * Обёртка git-команд: signal (если передан) убивает процесс SIGTERM по «Стоп».
 * `env` (ADR-076 §T6) — дополнительные переменные окружения (например
 * `GIT_SSH_COMMAND`): объединяются с `process.env`, а не заменяют его.
 */
export async function runGit(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  const mergedEnv = env ? { ...process.env, ...env } : process.env;
  return execFileAsync('git', args, { cwd, timeout: 30_000, signal, maxBuffer: 10 * 1024 * 1024, env: mergedEnv });
}

/** ADR-076 §T6: `repo_path` выходит за пределы workspace проекта. */
export class RepoPathError extends Error {
  readonly code = 'git.repo_path_invalid';
  constructor(readonly repoPath: string) {
    super(`Invalid repository path: ${repoPath}`);
    this.name = 'RepoPathError';
  }
}

/**
 * Резолвит `repo_path` ОТНОСИТЕЛЬНО корня project.workspace. Путь не может
 * выходить за пределы workspace (containment): абсолютный либо `..`-выход →
 * `RepoPathError`. `.`/пустая строка — сам workspace.
 *
 * Containment учитывает симлинки: каталог репозитория не может быть (или
 * проходить через) симлинк, ведущий за пределы workspace — иначе git-операции
 * выполнялись бы во внешнем каталоге. Неразрешимый путь (битый симлинк/цикл) —
 * fail-closed (`RepoPathError`).
 */
export function resolveRepoCwd(repoPath: string, workingDir: string): string {
  if (isAbsolute(repoPath)) throw new RepoPathError(repoPath);
  const base = resolve(workingDir);
  const abs = resolve(base, repoPath);
  const rel = relative(base, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new RepoPathError(repoPath);
  }
  if (!isInsideReal(base, abs)) throw new RepoPathError(repoPath);
  return abs;
}

/**
 * Рабочий каталог git-тула: приоритетно `repo_path` (относительно workspace,
 * containment), иначе legacy `path` (прежнее поведение `resolvePath`).
 */
function resolveGitCwd(
  params: { path?: string; repo_path?: string },
  ctx: ToolContext,
): string | ToolResult {
  if (params.repo_path !== undefined) {
    try {
      return resolveRepoCwd(params.repo_path, ctx.workingDir);
    } catch {
      return {
        content: sm('git.repo_path_invalid', { path: params.repo_path }),
        isError: true,
        metadata: { i18n: i18nMeta('git.repo_path_invalid', { path: params.repo_path }) },
      };
    }
  }
  if (params.path !== undefined) validateInputPath(params.path, 'path');
  const resolved = resolvePath(params.path, ctx.workingDir);
  if (isSymlinkEscape(ctx.workingDir, resolved)) return pathEscapesWorkspaceResult(resolved);
  return resolved;
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_GIT_OUTPUT) return output;
  return output.slice(0, MAX_GIT_OUTPUT) + '\n... (вывод обрезан)';
}

/** Ошибка запуска процесса из-за отсутствия бинарника в окружении (ENOENT). */
function isBinaryMissing(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Fallback, если детекция окружения не сработала, а `git` не установлен:
 * локализованное `tool.binary_missing` вместо сырой ошибки запуска.
 */
function gitBinaryMissingResult(name: string, cwd: string): ToolResult {
  return {
    content: sm('tool.binary_missing', { tool: name, binary: 'git' }),
    isError: true,
    metadata: { cwd, i18n: i18nMeta('tool.binary_missing', { tool: name, binary: 'git' }) },
  };
}

/**
 * Значения параметров git-тулов, попадающие в argv, проверяются ДО запуска git.
 *
 * Git запускается без shell (`execFile` + массив argv), поэтому классическая
 * shell-инъекция невозможна — но значение, попавшее в argv отдельным элементом,
 * может оказаться НЕ аргументом, а git-флагом: `commit: "--output=/tmp/x"`
 * превращает `git diff` в писателя произвольного файла, `--ext-diff`/`--textconv`
 * запускают внешнюю команду, а `remote: "https://attacker.example/x"` уводит
 * push на произвольный хост. Значение приходит от модели, а модель может быть
 * направлена недоверенным содержимым (файл, документ, веб-страница) — значит
 * это расширение полномочий агента.
 *
 * Две линии защиты:
 *  1) allowlist формы значения (не может выразить флаг);
 *  2) явный запрет опасных опций (остаётся в силе, если allowlist ослабят).
 */
const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/;

/** Имя remote: буквы/цифры и `._-` — без `/`, `:`, `@` (URL невозможен). */
const GIT_REMOTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Явно запрещённые опции git: произвольная запись файла (`--output`), запуск
 * внешних команд (`--ext-diff`, `--textconv`, `--exec`), принудительные
 * refspec-операции (`--mirror`, `--force`, `--delete`) и прочие.
 */
const FORBIDDEN_GIT_OPTIONS = new Set([
  '--output',
  '--ext-diff',
  '--textconv',
  '--no-index',
  '--exec',
  '--upload-pack',
  '--receive-pack',
  '--force',
  '--force-with-lease',
  '--mirror',
  '--all',
  '--prune',
  '--delete',
  '--orphan',
  '--detach',
  '--set-upstream',
  '--push-option',
]);

/** Тип значения параметра git-тула (определяет allowlist). */
export type GitValueKind = 'ref' | 'branch' | 'remote';

/**
 * Проверяет значение параметра git-тула. `null` — значение допустимо, иначе
 * причина отказа (без префикса с именем параметра).
 */
export function validateGitValue(value: string, kind: GitValueKind): string | null {
  if (!value) return 'must not be empty';

  // Значение, начинающееся с `-`, git прочитает как опцию — запрещаем явно.
  if (value.startsWith('-')) {
    const option = value.split('=', 1)[0] ?? value;
    if (FORBIDDEN_GIT_OPTIONS.has(option)) {
      return `the git option "${option}" is not allowed here`;
    }
    return 'must not start with "-" (git would read it as an option)';
  }

  // Refspec (`src:dst`) — не имя ветки: mirror-push, удаление ветки на remote.
  if (kind !== 'remote' && value.includes(':')) {
    return 'must be a plain name, not a refspec (":" is not allowed)';
  }

  const pattern = kind === 'remote' ? GIT_REMOTE_PATTERN : GIT_REF_PATTERN;
  if (!pattern.test(value)) {
    return kind === 'remote'
      ? 'must be a remote name (letters, digits, ".", "_", "-") — a URL is not allowed'
      : 'must be a commit/branch name (letters, digits, ".", "_", "/", "@", "+", "-")';
  }
  return null;
}

/** Отказ по значению параметра — через существующий механизм ошибок тула. */
function gitArgError(tool: string, issues: string): ToolResult {
  return {
    content: sm('tool.args_error', { tool, issues }),
    isError: true,
    metadata: { i18n: i18nMeta('tool.args_error', { tool, issues }) },
  };
}

/** Сравнение URL репозитория: хвостовой `/` и `.git` несущественны. */
function sameGitUrl(a: string, b: string): boolean {
  const normalize = (url: string): string => url.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  return normalize(a) === normalize(b);
}

/**
 * ADR-076: проверка remote для сетевых git-тулов (`git_push`/`git_pull`).
 *
 * Remote обязан существовать в репозитории И указывать на репозиторий,
 * зарегистрированный в проекте (`project.repos`) — иначе содержимое репозитория
 * можно выгрузить на произвольный хост в обход egress-адресной политики
 * (ADR-099): git-дочерние процессы через неё не идут. `null` — remote корректен.
 */
async function resolveRegistryRemote(
  ctx: ToolContext,
  cwd: string,
  remote: string,
  mode: 'push' | 'pull',
): Promise<string | null> {
  const lookup = await resolveProjectRepoEntry(ctx, cwd);
  if (lookup.kind === 'no_project') {
    return 'the session has no project — the remote cannot be verified against the project registry (ADR-076)';
  }
  if (lookup.kind === 'not_registered') {
    return 'the repository is not registered in the project — register it first (ADR-076)';
  }
  const registeredUrl = lookup.url;
  if (!registeredUrl) {
    return 'the repository is registered in the project without a URL — there is no configured remote';
  }

  let url = '';
  try {
    const { stdout } = await runGit(
      mode === 'push' ? ['remote', 'get-url', '--push', remote] : ['remote', 'get-url', remote],
      cwd,
      ctx.abortSignal,
    );
    url = stdout.trim().split('\n')[0]?.trim() ?? '';
  } catch (err: unknown) {
    if (isBinaryMissing(err)) return 'the git binary is not available in the environment';
    url = '';
  }
  if (!url) return `remote "${remote}" is not configured in the repository`;
  if (!sameGitUrl(url, registeredUrl)) {
    return `remote "${remote}" does not point to the repository registered for the project`;
  }
  return null;
}

export const gitStatusTool: ToolDefinition = {
  name: 'git_status',
  description: 'Show the working tree status — current branch, staged/unstaged changes, untracked files.',
  parameters: z.object({
    path: z.string().optional().describe('Path to the git repository (absolute or relative to the working directory; defaults to working directory)'),
    repo_path: z.string().optional().describe('Repository path relative to the project workspace (must stay inside it; "." — workspace root)'),
  }),
  capabilities: [ToolCapability.GIT_READ],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — git-команда не стартует (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { path?: string; repo_path?: string };
    const cwd = resolveGitCwd(params, ctx);
    if (typeof cwd !== 'string') return cwd;

    try {
      const { stdout } = await runGit(['status', '--porcelain', '--branch'], cwd, ctx.abortSignal);
      return {
        content: stdout || '(чистая рабочая директория)',
        metadata: { cwd, hasChanges: stdout.length > 0 },
      };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены, не «ошибка git»
      if (isAborted(ctx)) return abortedResult(this.name);
      if (isBinaryMissing(err)) return gitBinaryMissingResult(this.name, cwd);
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
    path: z.string().optional().describe('Path to the git repository (absolute or relative to the working directory; defaults to working directory)'),
    repo_path: z.string().optional().describe('Repository path relative to the project workspace (must stay inside it; "." — workspace root)'),
    staged: z.boolean().optional().describe('Show staged changes (default: false)'),
    commit: z.string().optional().describe('Compare with specific commit hash (a commit/branch name — not a git option)'),
  }),
  capabilities: [ToolCapability.GIT_READ],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — git-команда не стартует (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { path?: string; repo_path?: string; staged?: boolean; commit?: string };
    const cwd = resolveGitCwd(params, ctx);
    if (typeof cwd !== 'string') return cwd;

    // Значение от модели не должно стать флагом git (`--output=…`, `--ext-diff`).
    // Пустая строка — как и раньше, просто не попадает в argv.
    if (params.commit) {
      const commitError = validateGitValue(params.commit, 'ref');
      if (commitError) return gitArgError(this.name, `commit: ${commitError}`);
    }

    try {
      // `--` перед commit НЕ ставим: в `git diff` он переключает разбор на
      // pathspec (`git diff -- <rev>` — уже не ревизия, а путь). Защита — allowlist.
      // `--no-ext-diff`/`--no-textconv` — внешние diff-драйверы и textconv
      // (в т.ч. из `.gitattributes` недоверенного репозитория) не запускаются.
      const diffArgs = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
      if (params.staged) diffArgs.push('--staged');
      if (params.commit) diffArgs.push(params.commit);

      const { stdout } = await runGit(diffArgs, cwd, ctx.abortSignal);
      const output = stdout || '(нет изменений)';

      return {
        content: output.length > 20_000 ? output.slice(0, 20_000) + '\n... (diff обрезан)' : output,
        metadata: { cwd, hasChanges: stdout.length > 0 },
      };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены, не «ошибка git»
      if (isAborted(ctx)) return abortedResult(this.name);
      if (isBinaryMissing(err)) return gitBinaryMissingResult(this.name, cwd);
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
    path: z.string().optional().describe('Path to the git repository (absolute or relative to the working directory; defaults to working directory)'),
    repo_path: z.string().optional().describe('Repository path relative to the project workspace (must stay inside it; "." — workspace root)'),
    max_count: z.number().int().min(1).max(100).optional().default(10)
      .describe('Maximum number of commits to show (default: 10)'),
  }),
  capabilities: [ToolCapability.GIT_READ],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — git-команда не стартует (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { path?: string; repo_path?: string; max_count?: number };
    const cwd = resolveGitCwd(params, ctx);
    if (typeof cwd !== 'string') return cwd;

    try {
      const { stdout } = await runGit(
        ['log', `-${params.max_count ?? 10}`, '--oneline', '--decorate'],
        cwd,
        ctx.abortSignal,
      );
      return {
        content: stdout || '(нет коммитов)',
        metadata: { cwd, count: stdout.split('\n').filter(Boolean).length },
      };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены, не «ошибка git»
      if (isAborted(ctx)) return abortedResult(this.name);
      if (isBinaryMissing(err)) return gitBinaryMissingResult(this.name, cwd);
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
    path: z.string().optional().describe('Path to the git repository (absolute or relative to the working directory; defaults to working directory)'),
    repo_path: z.string().optional().describe('Repository path relative to the project workspace (must stay inside it; "." — workspace root)'),
    message: z.string().describe('Commit message'),
    allow_empty: z.boolean().optional().default(false).describe('Allow empty commit (default: false)'),
  }),
  capabilities: [ToolCapability.GIT_WRITE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — git-команда не стартует (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { path?: string; repo_path?: string; message: string; allow_empty?: boolean };
    const cwd = resolveGitCwd(params, ctx);
    if (typeof cwd !== 'string') return cwd;

    // ADR-036: деобфускация в точке потребления — message может содержать ⟦SYNTH_SECRET_N⟧
    const restored = (await deobfuscateArgs(ctx, params)) as { path?: string; repo_path?: string; message: string; allow_empty?: boolean };

    try {
      const commitArgs = ['commit', '-m', restored.message];
      if (restored.allow_empty) commitArgs.push('--allow-empty');

      const { stdout, stderr } = await runGit(commitArgs, cwd, ctx.abortSignal);
      return {
        content: stdout || stderr || 'Коммит создан',
        metadata: { cwd, message: params.message },
      };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены, не «ошибка git»
      if (isAborted(ctx)) return abortedResult(this.name);
      if (isBinaryMissing(err)) return gitBinaryMissingResult(this.name, cwd);
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
    path: z.string().optional().describe('Path to the git repository (absolute or relative to the working directory; defaults to working directory)'),
    repo_path: z.string().optional().describe('Repository path relative to the project workspace (must stay inside it; "." — workspace root)'),
    remote: z.string().optional().default('origin')
      .describe('Remote name (default: origin). Must be a remote configured in the repository and registered in the project (ADR-076) — a URL is not allowed'),
    branch: z.string().optional().describe('Branch name to push (default: current branch). A plain branch name — a refspec is not allowed'),
  }),
  capabilities: [ToolCapability.GIT_WRITE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — git-команда не стартует (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { path?: string; repo_path?: string; remote?: string; branch?: string };
    const cwd = resolveGitCwd(params, ctx);
    if (typeof cwd !== 'string') return cwd;

    // ADR-036: деобфускация в точке потребления — remote/branch могут содержать ⟦SYNTH_SECRET_N⟧
    const restored = (await deobfuscateArgs(ctx, params)) as { path?: string; repo_path?: string; remote?: string; branch?: string };

    const remote = restored.remote ?? 'origin';
    const branch = restored.branch;

    // Значения от модели не должны стать флагом git (`--force`) или refspec
    // (`+refs/heads/*:refs/heads/*` — mirror-push, `:refs/heads/x` — удаление ветки).
    const remoteError = validateGitValue(remote, 'remote');
    if (remoteError) return gitArgError(this.name, `remote: ${remoteError}`);
    if (branch) {
      const branchError = validateGitValue(branch, 'branch');
      if (branchError) return gitArgError(this.name, `branch: ${branchError}`);
    }

    // ADR-076: remote обязан быть зарегистрирован в проекте — иначе push ушёл бы
    // на произвольный хост (обход egress-адресной политики, ADR-099).
    const registryError = await resolveRegistryRemote(ctx, cwd, remote, 'push');
    if (registryError) return gitArgError(this.name, `remote: ${registryError}`);

    // ADR-076 §T6: SSH-окружение по реестру проекта (сетевой тул).
    const ssh = await resolveRepoGitEnv(ctx, cwd);
    if (ssh.error) {
      return {
        content: sm(ssh.error as SystemMessageKey, ssh.errorParams),
        isError: true,
        metadata: { cwd, i18n: i18nMeta(ssh.error, ssh.errorParams) },
      };
    }

    try {
      // `--` перед remote: git push/pull принимают его как конец опций, поэтому
      // remote/branch не могут быть прочитаны как флаги; смысл команды тот же.
      const pushArgs = ['push', '--', remote];
      if (branch) pushArgs.push(branch);

      const { stdout, stderr } = await runGit(pushArgs, cwd, ctx.abortSignal, ssh.env);
      return {
        content: stdout || stderr || 'git push выполнен',
        metadata: { cwd, remote: params.remote, branch: params.branch },
      };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены, не «ошибка git»
      if (isAborted(ctx)) return abortedResult(this.name);
      if (isBinaryMissing(err)) return gitBinaryMissingResult(this.name, cwd);
      return {
        content: `Ошибка git push: ${(err as Error).message}`,
        isError: true,
        metadata: { cwd },
      };
    } finally {
      await ssh.cleanup();
    }
  },
};

export const gitPullTool: ToolDefinition = {
  name: 'git_pull',
  description: 'Pull changes from the remote repository. Uses git pull.',
  parameters: z.object({
    path: z.string().optional().describe('Path to the git repository (absolute or relative to the working directory; defaults to working directory)'),
    repo_path: z.string().optional().describe('Repository path relative to the project workspace (must stay inside it; "." — workspace root)'),
    remote: z.string().optional().default('origin')
      .describe('Remote name (default: origin). Must be a remote configured in the repository and registered in the project (ADR-076) — a URL is not allowed'),
    branch: z.string().optional().describe('Branch name to pull (default: current tracking branch). A plain branch name — a refspec is not allowed'),
  }),
  capabilities: [ToolCapability.GIT_WRITE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — git-команда не стартует (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { path?: string; repo_path?: string; remote?: string; branch?: string };
    const cwd = resolveGitCwd(params, ctx);
    if (typeof cwd !== 'string') return cwd;

    // ADR-036: деобфускация в точке потребления — remote/branch могут содержать ⟦SYNTH_SECRET_N⟧
    const restored = (await deobfuscateArgs(ctx, params)) as { path?: string; repo_path?: string; remote?: string; branch?: string };

    const remote = restored.remote ?? 'origin';
    const branch = restored.branch;

    // Значения от модели не должны стать флагом git или refspec'ом.
    const remoteError = validateGitValue(remote, 'remote');
    if (remoteError) return gitArgError(this.name, `remote: ${remoteError}`);
    if (branch) {
      const branchError = validateGitValue(branch, 'branch');
      if (branchError) return gitArgError(this.name, `branch: ${branchError}`);
    }

    // ADR-076: remote обязан быть зарегистрирован в проекте — иначе pull ушёл бы
    // на произвольный хост (обход egress-адресной политики, ADR-099).
    const registryError = await resolveRegistryRemote(ctx, cwd, remote, 'pull');
    if (registryError) return gitArgError(this.name, `remote: ${registryError}`);

    // ADR-076 §T6: SSH-окружение по реестру проекта (сетевой тул).
    const ssh = await resolveRepoGitEnv(ctx, cwd);
    if (ssh.error) {
      return {
        content: sm(ssh.error as SystemMessageKey, ssh.errorParams),
        isError: true,
        metadata: { cwd, i18n: i18nMeta(ssh.error, ssh.errorParams) },
      };
    }

    try {
      // `--` перед remote: конец опций — remote/branch не читаются как флаги.
      const pullArgs = ['pull', '--', remote];
      if (branch) pullArgs.push(branch);

      const { stdout, stderr } = await runGit(pullArgs, cwd, ctx.abortSignal, ssh.env);
      return {
        content: stdout || stderr || 'git pull выполнен',
        metadata: { cwd, remote: params.remote, branch: params.branch },
      };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены, не «ошибка git»
      if (isAborted(ctx)) return abortedResult(this.name);
      if (isBinaryMissing(err)) return gitBinaryMissingResult(this.name, cwd);
      return {
        content: `Ошибка git pull: ${(err as Error).message}`,
        isError: true,
        metadata: { cwd },
      };
    } finally {
      await ssh.cleanup();
    }
  },
};

export const gitCheckoutTool: ToolDefinition = {
  name: 'git_checkout',
  description: 'Switch branches or restore files. Uses git checkout.',
  parameters: z.object({
    path: z.string().optional().describe('Path to the git repository (absolute or relative to the working directory; defaults to working directory)'),
    repo_path: z.string().optional().describe('Repository path relative to the project workspace (must stay inside it; "." — workspace root)'),
    target: z.string().describe('Branch name or commit hash to checkout (not a git option)'),
    create_branch: z.boolean().optional().default(false).describe('Create a new branch before checkout (-b flag)'),
  }),
  capabilities: [ToolCapability.GIT_WRITE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — git-команда не стартует (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { path?: string; repo_path?: string; target: string; create_branch?: boolean };
    const cwd = resolveGitCwd(params, ctx);
    if (typeof cwd !== 'string') return cwd;

    // ADR-036: деобфускация в точке потребления — target может содержать ⟦SYNTH_SECRET_N⟧
    const restored = (await deobfuscateArgs(ctx, params)) as { path?: string; repo_path?: string; target: string; create_branch?: boolean };

    // Значение от модели не должно стать флагом git (`-f`, `-B`, `--orphan`).
    const targetError = validateGitValue(restored.target, 'ref');
    if (targetError) return gitArgError(this.name, `target: ${targetError}`);

    try {
      // `--` перед target НЕ ставим: в `git checkout` он означает «восстановить
      // пути», а не «вот ветка» (`git checkout -- <branch>` — pathspec, не ветка).
      const checkoutArgs = ['checkout'];
      if (restored.create_branch) checkoutArgs.push('-b');
      checkoutArgs.push(restored.target);

      const { stdout, stderr } = await runGit(checkoutArgs, cwd, ctx.abortSignal);
      return {
        content: stdout || stderr || `Переключён на ${params.target}`,
        metadata: { cwd, target: params.target, createdBranch: params.create_branch },
      };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены, не «ошибка git»
      if (isAborted(ctx)) return abortedResult(this.name);
      if (isBinaryMissing(err)) return gitBinaryMissingResult(this.name, cwd);
      return {
        content: `Ошибка git checkout: ${(err as Error).message}`,
        isError: true,
        metadata: { cwd },
      };
    }
  },
};

export const gitBranchListTool: ToolDefinition = {
  name: 'git_branch_list',
  description: 'List all branches in the repository. Marks the current branch with an asterisk.',
  parameters: z.object({
    path: z.string().optional().describe('Path to the git repository (absolute or relative to the working directory; defaults to working directory)'),
    repo_path: z.string().optional().describe('Repository path relative to the project workspace (must stay inside it; "." — workspace root)'),
    all: z.boolean().optional().default(false).describe('Include remote branches (default: false)'),
    verbose: z.boolean().optional().default(false).describe('Show last commit and tracking info (default: false)'),
  }),
  capabilities: [ToolCapability.GIT_READ],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — git-команда не стартует (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { path?: string; repo_path?: string; all?: boolean; verbose?: boolean };
    const cwd = resolveGitCwd(params, ctx);
    if (typeof cwd !== 'string') return cwd;

    try {
      const branchArgs = ['branch'];
      if (params.verbose) {
        branchArgs.push(params.all ? '-vv' : '-v');
      } else if (params.all) {
        branchArgs.push('--all');
      } else {
        branchArgs.push('--format=%(refname:short)');
      }

      const { stdout, stderr } = await runGit(branchArgs, cwd, ctx.abortSignal);
      if (stderr) {
        return { content: `Ошибка git branch: ${stderr.trim()}`, isError: true, metadata: { cwd } };
      }

      if (!stdout.trim()) {
        return { content: '(веток не найдено)', metadata: { cwd } };
      }

      let output = stdout.trimEnd();
      if (!params.verbose && !params.all) {
        const current = (await runGit(['branch', '--show-current'], cwd, ctx.abortSignal)).stdout.trim();
        if (current) {
          output = stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => (line === current ? `* ${line}` : `  ${line}`))
            .join('\n');
        }
      }

      return { content: truncateOutput(output), metadata: { cwd, count: stdout.split('\n').filter(Boolean).length } };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены, не «ошибка git»
      if (isAborted(ctx)) return abortedResult(this.name);
      if (isBinaryMissing(err)) return gitBinaryMissingResult(this.name, cwd);
      return {
        content: `Ошибка git branch: ${(err as Error).message}`,
        isError: true,
        metadata: { cwd },
      };
    }
  },
};

export const gitShowTool: ToolDefinition = {
  name: 'git_show',
  description: 'Show various types of git objects (commits, tags, trees, blobs).',
  parameters: z.object({
    path: z.string().optional().describe('Path to the git repository (absolute or relative to the working directory; defaults to working directory)'),
    repo_path: z.string().optional().describe('Repository path relative to the project workspace (must stay inside it; "." — workspace root)'),
    object: z.string().optional().default('HEAD').describe('Object name — commit hash, tag or branch (default: HEAD). Not a git option'),
    stat: z.boolean().optional().default(true).describe('Show diffstat summary (default: true)'),
  }),
  capabilities: [ToolCapability.GIT_READ],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — git-команда не стартует (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { path?: string; repo_path?: string; object?: string; stat?: boolean };
    const cwd = resolveGitCwd(params, ctx);
    if (typeof cwd !== 'string') return cwd;

    // Значение от модели не должно стать флагом git (`--output=…`, `--ext-diff`).
    const object = params.object ?? 'HEAD';
    const objectError = validateGitValue(object, 'ref');
    if (objectError) return gitArgError(this.name, `object: ${objectError}`);

    try {
      // `--` перед object НЕ ставим: в `git show` он переключает разбор на
      // pathspec (`git show -- <obj>` — уже не объект, а путь). Защита — allowlist.
      // `--no-ext-diff`/`--no-textconv` — внешние diff-драйверы и textconv не запускаются.
      const showArgs = ['show', '--no-ext-diff', '--no-textconv'];
      if (params.stat) showArgs.push('--stat');
      showArgs.push(object);

      const { stdout, stderr } = await runGit(showArgs, cwd, ctx.abortSignal);
      if (stderr) {
        return { content: `Ошибка git show: ${stderr.trim()}`, isError: true, metadata: { cwd } };
      }

      return {
        content: truncateOutput(stdout || '(объект пуст)'),
        metadata: { cwd, object: params.object },
      };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены, не «ошибка git»
      if (isAborted(ctx)) return abortedResult(this.name);
      if (isBinaryMissing(err)) return gitBinaryMissingResult(this.name, cwd);
      return {
        content: `Ошибка git show: ${(err as Error).message}`,
        isError: true,
        metadata: { cwd },
      };
    }
  },
};

export const gitBlameTool: ToolDefinition = {
  name: 'git_blame',
  description: 'Show what revision and author last modified each line of a file.',
  parameters: z.object({
    path: z.string().optional().describe('Path to the git repository (absolute or relative to the working directory; defaults to working directory)'),
    repo_path: z.string().optional().describe('Repository path relative to the project workspace (must stay inside it; "." — workspace root)'),
    file: z.string().describe('Path to the file to blame (relative to the repository root)'),
    max_count: z.number().int().min(1).optional().describe('Limit the number of lines to show'),
    line_range: z.string().optional().describe('Line range to blame, e.g. "1,10"'),
  }),
  capabilities: [ToolCapability.GIT_READ],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — git-команда не стартует (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { path?: string; repo_path?: string; file: string; max_count?: number; line_range?: string };
    const cwd = resolveGitCwd(params, ctx);
    if (typeof cwd !== 'string') return cwd;

    try {
      const blameArgs = ['blame'];
      if (params.max_count) blameArgs.push('--max-count', String(params.max_count));
      if (params.line_range) blameArgs.push('-L', params.line_range);
      blameArgs.push('--', params.file);

      const { stdout, stderr } = await runGit(blameArgs, cwd, ctx.abortSignal);
      if (stderr) {
        return { content: `Ошибка git blame: ${stderr.trim()}`, isError: true, metadata: { cwd, file: params.file } };
      }

      return {
        content: truncateOutput(stdout || '(нет данных blame)'),
        metadata: { cwd, file: params.file, count: stdout.split('\n').filter(Boolean).length },
      };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены, не «ошибка git»
      if (isAborted(ctx)) return abortedResult(this.name);
      if (isBinaryMissing(err)) return gitBinaryMissingResult(this.name, cwd);
      return {
        content: `Ошибка git blame: ${(err as Error).message}`,
        isError: true,
        metadata: { cwd, file: params.file },
      };
    }
  },
};

export const gitStashTool: ToolDefinition = {
  name: 'git_stash',
  description: 'Stash changes in the working directory for later use. Actions: push, pop, list, show, drop, apply.',
  parameters: z.object({
    path: z.string().optional().describe('Path to the git repository (absolute or relative to the working directory; defaults to working directory)'),
    repo_path: z.string().optional().describe('Repository path relative to the project workspace (must stay inside it; "." — workspace root)'),
    action: z.enum(['push', 'pop', 'list', 'show', 'drop', 'apply']).optional().default('push')
      .describe('Stash action (default: push)'),
    message: z.string().optional().describe('Stash message (for push)'),
    stash_index: z.number().int().min(0).optional().describe('Stash index (for pop, show, drop, apply)'),
    include_untracked: z.boolean().optional().default(false).describe('Include untracked files in stash (default: false)'),
  }),
  capabilities: [ToolCapability.GIT_WRITE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — git-команда не стартует (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as {
      path?: string;
      repo_path?: string;
      action?: 'push' | 'pop' | 'list' | 'show' | 'drop' | 'apply';
      message?: string;
      stash_index?: number;
      include_untracked?: boolean;
    };
    const cwd = resolveGitCwd(params, ctx);
    if (typeof cwd !== 'string') return cwd;
    const action = params.action ?? 'push';

    // ADR-036: деобфускация в точке потребления — message может содержать ⟦SYNTH_SECRET_N⟧
    const restored = (await deobfuscateArgs(ctx, params)) as typeof params;

    try {
      const stashArgs = ['stash'];
      let result: { stdout: string; stderr: string };

      if (action === 'list') {
        stashArgs.push('list');
        result = await runGit(stashArgs, cwd, ctx.abortSignal);
        if (result.stderr) {
          return { content: `Ошибка git stash: ${result.stderr.trim()}`, isError: true, metadata: { cwd } };
        }
        return { content: truncateOutput(result.stdout.trim() || '(нет stash-записей)'), metadata: { cwd } };
      }

      if (action === 'show') {
        stashArgs.push('show');
        if (restored.stash_index !== undefined) stashArgs.push(`stash@{${restored.stash_index}}`);
        result = await runGit(stashArgs, cwd, ctx.abortSignal);
        if (result.stderr) {
          return { content: `Ошибка git stash: ${result.stderr.trim()}`, isError: true, metadata: { cwd } };
        }
        return { content: truncateOutput(result.stdout.trim() || '(пусто)'), metadata: { cwd } };
      }

      if (action === 'drop' || action === 'pop' || action === 'apply') {
        stashArgs.push(action);
        if (restored.stash_index !== undefined) stashArgs.push(`stash@{${restored.stash_index}}`);
        result = await runGit(stashArgs, cwd, ctx.abortSignal);
        if (result.stderr) {
          return { content: `Ошибка git stash: ${result.stderr.trim()}`, isError: true, metadata: { cwd } };
        }
        return { content: truncateOutput(result.stdout.trim() || `${action} выполнен`), metadata: { cwd } };
      }

      if (restored.include_untracked) stashArgs.push('--include-untracked');
      if (restored.message) {
        stashArgs.push('push', '-m', restored.message);
      } else {
        stashArgs.push('push');
      }
      result = await runGit(stashArgs, cwd, ctx.abortSignal);
      if (result.stderr) {
        return { content: `Ошибка git stash: ${result.stderr.trim()}`, isError: true, metadata: { cwd } };
      }
      return { content: truncateOutput(result.stdout.trim() || 'Изменения сохранены в stash'), metadata: { cwd } };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены, не «ошибка git»
      if (isAborted(ctx)) return abortedResult(this.name);
      if (isBinaryMissing(err)) return gitBinaryMissingResult(this.name, cwd);
      return {
        content: `Ошибка git stash: ${(err as Error).message}`,
        isError: true,
        metadata: { cwd },
      };
    }
  },
};
