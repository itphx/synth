import { readdir, mkdir, rm } from 'node:fs/promises';
import { resolve as pathResolve, relative, join, isAbsolute, sep } from 'node:path';
import { simpleGit, type SimpleGit, type LogResult } from 'simple-git';
import type { RepoStatus, CommitInfo, CommitDetail, CommitFileInfo } from '@itphx/synth-shared';

/**
 * ADR-076 §T3: git-сервис ядра (перенос из backend `lib/git-service.ts`).
 * Единая реализация git — в core; backend (T4) переходит на core-фабрику роутов.
 */

/** Опции git-вызова: дополнительные переменные окружения (например SSH). */
export interface GitEnvOptions {
  env?: Record<string, string>;
}

/** Опции fetch: окружение + конкретный remote (по умолчанию — все). */
export interface GitFetchOptions extends GitEnvOptions {
  remote?: string;
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

/**
 * ADR-076: не-git ключи, которые simple-git 3.36 блокирует по blocklist
 * (`@simple-git/argv-parser`, `parseEnv`). Остальные блокируемые ключи —
 * `GIT_*` (`GIT_EDITOR`, `GIT_PAGER`, `GIT_SSH`, `GIT_SSH_COMMAND`,
 * `GIT_ASKPASS`, …) — вырезаются по префиксу в `sanitizeGitEnv`.
 * `allowUnsafeEditor`/`allowUnsafePager` сознательно НЕ включаем.
 */
const BLOCKED_ENV_KEYS = new Set(['editor', 'pager', 'prefix', 'ssh_askpass']);

/**
 * Санитизирует окружение перед передачей в `simpleGit.env()`: вырезает
 * `git*`-ключи (без учёта регистра) и не-git blocklist (`EDITOR`, `PAGER`,
 * `PREFIX`, `SSH_ASKPASS`). Иначе `process.env` хоста (например `EDITOR`
 * из dev-шелла) роняет вызов на blockUnsafeOperationsPlugin.
 */
export function sanitizeGitEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower.startsWith('git') || BLOCKED_ENV_KEYS.has(lower)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Опции simple-git, разрешающие ровно те «unsafe»-категории, которые сервис
 * ставит сам (`GIT_SSH_COMMAND` из расшифрованного SSH-ключа, `SSH_ASKPASS`
 * для ключей с passphrase). `allowUnsafeEditor`/`allowUnsafePager` не включаем —
 * соответствующие переменные вырезаются санитайзером.
 */
const GIT_UNSAFE_OPTIONS = {
  unsafe: { allowUnsafeSshCommand: true, allowUnsafeAskPass: true },
} as const;

/** Создаёт simple-git с разрешёнными SSH/askpass-операциями. */
function createGit(baseDir?: string): SimpleGit {
  return baseDir === undefined ? simpleGit(GIT_UNSAFE_OPTIONS) : simpleGit(baseDir, GIT_UNSAFE_OPTIONS);
}

/**
 * Применяет дополнительные env к simple-git. `simpleGit.env(obj)` ЗАМЕНЯЕТ
 * окружение процесса, поэтому базовый `process.env` обязательно объединяем —
 * но только после санитайза (иначе blocklist simple-git роняет вызов).
 * `GIT_TERMINAL_PROMPT=0` — неинтерактивность: git не ждёт ввода без askpass.
 */
function withEnv(git: SimpleGit, env?: Record<string, string>): SimpleGit {
  if (!env) return git;
  return git.env({ ...sanitizeGitEnv(process.env), GIT_TERMINAL_PROMPT: '0', ...env });
}

export class GitService {
  constructor(private workspacesRoot: string) {}

  /** Публичный доступ к проверке containment (для роутов/тестов). */
  resolveRepoPath(workspaceAbsPath: string, repoRelPath: string): string {
    return resolveRepoPath(workspaceAbsPath, repoRelPath);
  }

  async isRepo(repoPath: string, opts?: GitEnvOptions): Promise<boolean> {
    try {
      return await withEnv(createGit(repoPath), opts?.env).checkIsRepo();
    } catch {
      return false;
    }
  }

  async getRepoStatus(repoAbsPath: string, opts?: GitEnvOptions): Promise<RepoStatus | null> {
    if (!(await this.isRepo(repoAbsPath, opts))) return null;
    try {
      const g = withEnv(createGit(repoAbsPath), opts?.env);
      const branch = await g.revparse(['--abbrev-ref', 'HEAD']);
      const log = await g.log({ maxCount: 1 });
      const last = log.latest;
      return {
        path: '',
        isRepo: true,
        currentBranch: branch.trim() || undefined,
        lastCommitAt: last ? last.date : undefined,
        lastCommitSubject: last ? last.message.split('\n')[0] : undefined,
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
    const g = withEnv(createGit(repoPath), opts?.env);
    if (defaultBranch) {
      await g.init(['--initial-branch', defaultBranch]);
    } else {
      await g.init();
    }
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
    await withEnv(createGit(), opts?.env).clone(url, repoPath, branch ? { '--branch': branch } : undefined);
    return {
      path: effectivePath,
      isRepo: true,
    };
  }

  /** ADR-076: fetch репозитория (при необходимости с SSH-окружением). */
  async fetchRepo(wsAbsPath: string, repoRelPath: string, opts?: GitFetchOptions): Promise<void> {
    const repoPath = resolveRepoPath(wsAbsPath, repoRelPath);
    await this.ensureRepo(repoPath, opts);
    const g = withEnv(createGit(repoPath), opts?.env);
    await (opts?.remote ? g.fetch([opts.remote]) : g.fetch());
  }

  /**
   * ADR-076: удаляет локальный каталог репозитория. `rm -rf` выполняется ТОЛЬКО
   * после проверки containment через `resolveRepoPath` (защита от traversal);
   * корень workspace удалять запрещено.
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
    const g = withEnv(createGit(repoPath), opts?.env);
    const branch = (await g.revparse(['--abbrev-ref', 'HEAD'])).trim();
    const log: LogResult = await g.log({ maxCount });
    return log.all.map((entry) => ({
      hash: entry.hash,
      shortHash: entry.hash.slice(0, 7),
      subject: entry.message.split('\n')[0] || '',
      message: entry.message,
      author: entry.author_name,
      authorEmail: entry.author_email,
      date: entry.date,
      relativeDate: relativeTime(entry.date),
      branch,
    }));
  }

  async getCommitDetail(
    wsAbsPath: string,
    repoRelPath: string,
    hash: string,
    opts?: GitEnvOptions,
  ): Promise<CommitDetail> {
    const repoPath = resolveRepoPath(wsAbsPath, repoRelPath);
    await this.ensureRepo(repoPath, opts);
    const g = withEnv(createGit(repoPath), opts?.env);
    const branch = (await g.revparse(['--abbrev-ref', 'HEAD'])).trim();

    const showRaw = await g.raw(['show', '--format=%H%n%an%n%ae%n%aI%n%s%n%B%n==ENDOFCOMMIT==', '-s', '--no-patch', hash]);
    const metaEnd = showRaw.indexOf('\n==ENDOFCOMMIT==');
    const meta = metaEnd >= 0 ? showRaw.slice(0, metaEnd).split('\n') : showRaw.split('\n');
    const commitHash = meta[0] || hash;
    const author = meta[1] || '';
    const authorEmail = meta[2] || '';
    const date = meta[3] || '';
    const message = meta.slice(4).join('\n');
    const subject = message.split('\n')[0] || '';

    const statRaw = await g.raw(['diff-tree', '--no-commit-id', '--numstat', '-r', hash]);
    const files: CommitFileInfo[] = [];
    if (statRaw.trim()) {
      for (const line of statRaw.trim().split('\n')) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        files.push({
          path: parts[2]!,
          status: 'modified' as CommitFileInfo['status'],
          additions: parseInt(parts[0]!, 10) || 0,
          deletions: parseInt(parts[1]!, 10) || 0,
        });
      }
    }

    const diff = await g.show([hash, '--patch', '--format=']);

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
