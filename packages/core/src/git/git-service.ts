import { readdir, mkdir, rm } from 'node:fs/promises';
import { resolve as pathResolve, relative, join, isAbsolute, sep } from 'node:path';
import type { RepoStatus, CommitInfo, CommitDetail, CommitFileInfo } from '@itphx/synth-shared';
import type { ExecutionPort } from '../execution/ports/index.js';
import { gitExec, sanitizeGitEnv } from './exec.js';

/**
 * ADR-076 §T3: git-сервис ядра (перенос из backend `lib/git-service.ts`).
 * Единая реализация git — в core; backend (T4) переходит на core-фабрику роутов.
 *
 * ADR-077: исполнение — через `ExecutionPort` (`git/exec.ts`), без сторонней
 * git-библиотеки.
 * Публичный API класса не меняется; в remote-режиме те же команды уходят
 * исполнителю (control plane больше не требует git в своём образе).
 */

/** Санитайз окружения git — историческое место экспорта (реализация — `exec.ts`). */
export { sanitizeGitEnv };

/** Опции git-вызова: дополнительные переменные окружения (например SSH). */
export interface GitEnvOptions {
  env?: Record<string, string>;
}

/** Опции fetch: окружение + конкретный remote (по умолчанию — все). */
export interface GitFetchOptions extends GitEnvOptions {
  remote?: string;
}

/**
 * Опции сервиса. `execution` — порт исполнения команд (ADR-077); не задан —
 * inline (`InlineExecutionPort`), то есть прежнее локальное поведение.
 */
export interface GitServiceOptions {
  execution?: ExecutionPort;
}

function relativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'только что';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} дн назад`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} мес назад`;
  const years = Math.floor(months / 12);
  return `${years} г назад`;
}

/**
 * ADR-076: резолвит относительный путь репозитория ВНУТРИ абсолютного workspace.
 * Абсолютный `repoRelPath` либо выход за workspace (`..`) → ошибка
 * `PATH_TRAVERSAL` (защита от traversal). Пустой `repoRelPath` — сам workspace.
 */
export function resolveRepoPath(workspaceAbsPath: string, repoRelPath: string): string {
  const base = pathResolve(workspaceAbsPath);
  const repoPath = repoRelPath ? pathResolve(base, repoRelPath) : base;
  const rel = relative(base, repoPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw { error: 'Путь репозитория выходит за пределы workspace', code: 'PATH_TRAVERSAL' };
  }
  return repoPath;
}

/** Имя репозитория из URL (последний сегмент без `.git`). */
export function deriveRepoName(url: string): string {
  let name = url.replace(/\/$/, '').split('/').pop() || 'repo';
  name = name.replace(/\.git$/, '');
  return name;
}

/** Поля заголовка `git status --porcelain=v2 --branch`. */
const STATUS_BRANCH_HEAD = '# branch.head ';

/**
 * Ветка из `git status --porcelain=v2 --branch -z`.
 *
 * Записи (`1`/`2`/`u`/`?`/`!`) пропускаются: у записи типа `2` (rename/copy)
 * исходный путь идёт отдельным NUL-полем — его тоже пропускаем, иначе путь,
 * начинающийся с `# `, был бы прочитан как заголовок.
 */
function parseStatusBranch(raw: string): string | undefined {
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token.startsWith(STATUS_BRANCH_HEAD)) {
      const head = token.slice(STATUS_BRANCH_HEAD.length).trim();
      if (!head) return undefined;
      // `rev-parse --abbrev-ref HEAD` (прежняя реализация) на detached HEAD
      // возвращает `HEAD` — сохраняем это представление.
      return head === '(detached)' ? 'HEAD' : head;
    }
    if (token.startsWith('2 ')) i += 1;
  }
  return undefined;
}

/** Разбор `--numstat -z`: `add\tdel\tpath`, у rename путь — два NUL-поля. */
function parseNumstatZ(raw: string): CommitFileInfo[] {
  const files: CommitFileInfo[] = [];
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (!token) continue;
    const parts = token.split('\t');
    if (parts.length < 2) continue;
    const additions = parseInt(parts[0] ?? '', 10) || 0;
    const deletions = parseInt(parts[1] ?? '', 10) || 0;
    const path = parts.slice(2).join('\t');
    if (!path) {
      // Rename/copy: `add\tdel\t` + исходный путь + новый путь.
      const newPath = tokens[i + 2] ?? '';
      i += 2;
      if (newPath) {
        files.push({ path: newPath, status: 'renamed', additions, deletions });
      }
      continue;
    }
    files.push({ path, status: 'modified', additions, deletions });
  }
  return files;
}

export class GitService {
  private readonly _execution: ExecutionPort | undefined;

  constructor(
    private workspacesRoot: string,
    options: GitServiceOptions = {},
  ) {
    this._execution = options.execution;
  }

  /** Публичный доступ к проверке containment (для роутов/тестов). */
  resolveRepoPath(workspaceAbsPath: string, repoRelPath: string): string {
    return resolveRepoPath(workspaceAbsPath, repoRelPath);
  }

  /** Git-команда через порт исполнения (ADR-077) с общим окружением. */
  private run(
    args: string[],
    cwd?: string,
    env?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string }> {
    return gitExec(args, { execution: this._execution, cwd, env });
  }

  async isRepo(repoPath: string, opts?: GitEnvOptions): Promise<boolean> {
    try {
      const { stdout } = await this.run(['rev-parse', '--is-inside-work-tree'], repoPath, opts?.env);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async getRepoStatus(repoAbsPath: string, opts?: GitEnvOptions): Promise<RepoStatus | null> {
    if (!(await this.isRepo(repoAbsPath, opts))) return null;
    try {
      const { stdout } = await this.run(
        ['status', '--porcelain=v2', '-z', '--branch'],
        repoAbsPath,
        opts?.env,
      );
      const { stdout: logOut } = await this.run(
        ['log', '-1', '--format=%aI%x00%s'],
        repoAbsPath,
        opts?.env,
      );
      const [lastCommitAt, lastCommitSubject] = logOut.split('\0');
      return {
        path: '',
        isRepo: true,
        currentBranch: parseStatusBranch(stdout),
        lastCommitAt: lastCommitAt || undefined,
        // `git log` добавляет завершающий перевод строки — оставляем только subject.
        lastCommitSubject: lastCommitSubject?.split('\n')[0] || undefined,
      };
    } catch {
      return null;
    }
  }

  async scanWorkspace(wsAbsPath: string): Promise<RepoStatus[]> {
    const results: RepoStatus[] = [];

    const rootStatus = await this.getRepoStatus(wsAbsPath);
    if (rootStatus) {
      rootStatus.path = '';
      results.push(rootStatus);
    }

    const subdirs = await this.listSubdirs(wsAbsPath, 3);
    for (const subdir of subdirs) {
      const fullPath = join(wsAbsPath, subdir);
      const status = await this.getRepoStatus(fullPath);
      if (status) {
        status.path = subdir;
        results.push(status);
      }
    }

    return results;
  }

  private async listSubdirs(root: string, maxDepth: number): Promise<string[]> {
    const result: string[] = [];

    async function walk(dir: string, depth: number, relPrefix: string) {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        result.push(relPath);
        await walk(join(dir, entry.name), depth + 1, relPath);
      }
    }

    await walk(root, 1, '');
    return result;
  }

  async initRepo(
    wsAbsPath: string,
    repoRelPath: string,
    defaultBranch?: string,
    opts?: GitEnvOptions,
  ): Promise<RepoStatus> {
    const repoPath = resolveRepoPath(wsAbsPath, repoRelPath);
    try {
      await mkdir(repoPath, { recursive: true });
    } catch {
      // directory might already exist
    }
    const args = defaultBranch ? ['init', '--initial-branch', defaultBranch] : ['init'];
    await this.run(args, repoPath, opts?.env);
    return {
      path: repoRelPath,
      isRepo: true,
    };
  }

  async cloneRepo(
    wsAbsPath: string,
    repoRelPath: string,
    url: string,
    branch?: string,
    opts?: GitEnvOptions,
  ): Promise<RepoStatus> {
    const effectivePath = repoRelPath || deriveRepoName(url);
    const repoPath = resolveRepoPath(wsAbsPath, effectivePath);
    const parentDir = pathResolve(repoPath, '..');
    try {
      await mkdir(parentDir, { recursive: true });
    } catch {
      // директория может уже существовать
    }
    const args = ['clone'];
    if (branch) args.push('--branch', branch);
    args.push(url, repoPath);
    // `cwd` — родительский каталог внутри workspace: в remote-режиме
    // containment проверяет исполнитель, и абсолютный путь назначения обязан
    // лежать в его workspace (том общий, ADR-077).
    await this.run(args, parentDir, opts?.env);
    return {
      path: effectivePath,
      isRepo: true,
    };
  }

  /** ADR-076: fetch репозитория (при необходимости с SSH-окружением). */
  async fetchRepo(wsAbsPath: string, repoRelPath: string, opts?: GitFetchOptions): Promise<void> {
    const repoPath = resolveRepoPath(wsAbsPath, repoRelPath);
    await this.ensureRepo(repoPath, opts);
    const args = opts?.remote ? ['fetch', opts.remote] : ['fetch'];
    await this.run(args, repoPath, opts?.env);
  }

  /**
   * ADR-076: удаляет локальный каталог репозитория. `rm -rf` выполняется ТОЛЬКО
   * после проверки containment через `resolveRepoPath` (защита от traversal);
   * корень workspace удалять запрещено. Это файловая операция, не git-команда.
   */
  async removeLocal(wsAbsPath: string, repoRelPath: string): Promise<void> {
    const repoPath = resolveRepoPath(wsAbsPath, repoRelPath);
    if (repoPath === pathResolve(wsAbsPath)) {
      throw { error: 'Нельзя удалить корень workspace', code: 'PATH_TRAVERSAL' };
    }
    await rm(repoPath, { recursive: true, force: true });
  }

  async getLog(
    wsAbsPath: string,
    repoRelPath: string,
    maxCount = 30,
    opts?: GitEnvOptions,
  ): Promise<CommitInfo[]> {
    const repoPath = resolveRepoPath(wsAbsPath, repoRelPath);
    await this.ensureRepo(repoPath, opts);
    const branch = (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath, opts?.env)).stdout.trim();
    const { stdout } = await this.run(
      [
        'log',
        '-n',
        String(maxCount),
        '-z',
        '--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s',
      ],
      repoPath,
      opts?.env,
    );
    const tokens = stdout.split('\0');
    // `-z` завершает каждый коммит NUL — последний токен пустой.
    if (tokens.at(-1) === '') tokens.pop();
    const commits: CommitInfo[] = [];
    for (let i = 0; i + 5 < tokens.length; i += 6) {
      const hash = tokens[i] ?? '';
      const shortHash = tokens[i + 1] || hash.slice(0, 7);
      const author = tokens[i + 2] ?? '';
      const authorEmail = tokens[i + 3] ?? '';
      const date = tokens[i + 4] ?? '';
      const subject = tokens[i + 5] ?? '';
      commits.push({
        hash,
        shortHash,
        subject,
        message: subject,
        author,
        authorEmail,
        date,
        relativeDate: relativeTime(date),
        branch,
      });
    }
    return commits;
  }

  async getCommitDetail(
    wsAbsPath: string,
    repoRelPath: string,
    hash: string,
    opts?: GitEnvOptions,
  ): Promise<CommitDetail> {
    const repoPath = resolveRepoPath(wsAbsPath, repoRelPath);
    await this.ensureRepo(repoPath, opts);
    const branch = (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath, opts?.env)).stdout.trim();

    const { stdout: showRaw } = await this.run(
      ['show', '-s', '--no-patch', '--format=%H%x00%an%x00%ae%x00%aI%x00%s%x00%B', hash],
      repoPath,
      opts?.env,
    );
    const meta = showRaw.split('\0');
    const commitHash = (meta[0] ?? '').trim() || hash;
    const author = meta[1] ?? '';
    const authorEmail = meta[2] ?? '';
    const date = meta[3] ?? '';
    const subject = meta[4] ?? '';
    // `%B` — полное сообщение; git добавляет завершающий перевод строки.
    const message = (meta[5] ?? '').replace(/\n+$/, '') || subject;

    const { stdout: statRaw } = await this.run(
      ['show', '--numstat', '-z', '--format=', hash],
      repoPath,
      opts?.env,
    );
    const files = parseNumstatZ(statRaw);

    const diff = (
      await this.run(['show', hash, '--patch', '--format='], repoPath, opts?.env)
    ).stdout;

    return {
      hash: commitHash,
      shortHash: commitHash.slice(0, 7),
      subject,
      message,
      author,
      authorEmail,
      date,
      relativeDate: relativeTime(date),
      branch,
      files,
      diff: diff || '',
    };
  }

  private async ensureRepo(repoPath: string, opts?: GitEnvOptions): Promise<void> {
    if (!(await this.isRepo(repoPath, opts))) {
      throw { error: 'Директория не является git-репозиторием', code: 'NOT_FOUND' };
    }
  }
}
