import { readdir, mkdir, rm } from 'node:fs/promises';
import { resolve as pathResolve, relative, join, isAbsolute, sep } from 'node:path';
import { simpleGit, type SimpleGit, type SimpleGitOptions, type LogResult } from 'simple-git';
import type { RepoStatus, CommitInfo, CommitDetail, CommitFileInfo } from '@itphx/synth-shared';
// ADR-099: доверие TLS/CA для git — пер-вызовом через `-c <key>=<value>`;
// прокси (D2b) — child-env (`http_proxy`/`https_proxy`/`all_proxy`/`no_proxy`).
import { gitCaConfig } from '../security/tls.js';
import { gitProxyEnv } from '../security/proxy-state.js';

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
 * ADR-076: не-git ключи, которые simple-git блокирует по blocklist
 * (`@simple-git/argv-parser`: `isGitEnvKey` — `EDITOR`, `VISUAL`, `PAGER`,
 * `PREFIX`, `SSH_ASKPASS`, …). Остальные блокируемые ключи — `GIT_*`
 * (`GIT_EDITOR`, `GIT_PAGER`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, …) —
 * вырезаются по префиксу в `sanitizeGitEnv`. `SSH_ASKPASS_REQUIRE` сам не в
 * blocklist, но вырезается вместе с `SSH_ASKPASS`: сервис ставит его только сам
 * (см. `createSshEnv`) — ambient-значение не должно протекать в git.
 * `allowUnsafeEditor`/`allowUnsafePager` сознательно НЕ включаем.
 */
const BLOCKED_ENV_KEYS = new Set(['editor', 'visual', 'pager', 'prefix', 'ssh_askpass', 'ssh_askpass_require']);

/**
 * Санитизирует окружение перед передачей в `simpleGit.env()`: вырезает
 * `git*`-ключи (без учёта регистра) и не-git blocklist (`EDITOR`, `VISUAL`,
 * `PAGER`, `PREFIX`, `SSH_ASKPASS`, …). Иначе `process.env` хоста (например
 * `EDITOR` из dev-шелла) роняет вызов на environment-guard / blockUnsafeOperationsPlugin.
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
 *
 * `allowEnvironment` (simple-git 4.x) — двойной opt-in: environment-guard
 * отклоняет задачу, если через `.env()` явно передан `GIT_*`/blocklist-ключ,
 * не названный здесь. Список — ровно те переменные, которые сервис ставит сам:
 * `GIT_TERMINAL_PROMPT` (неинтерактивность) и SSH-набор из `createSshEnv`.
 * Ambient-значения этих ключей не протекают: `.env()` получает санитайзенный
 * `process.env` (см. `withEnv`).
 */
const GIT_UNSAFE_OPTIONS = {
  unsafe: { allowUnsafeSshCommand: true, allowUnsafeAskPass: true },
  allowEnvironment: ['GIT_TERMINAL_PROMPT', 'GIT_SSH_COMMAND', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'],
} as const;

/**
 * ADR-099: опции инстанса `simple-git` = разрешённые SSH/askpass-категории +
 * args git-конфига доверия CA (`git -c <arg>`).
 *
 * Доверие уже инициализировано при старте (`initTlsTrust`) — путь CA берём
 * геттером `gitCaConfig()`, конфиг в git-модуль не тянем. `GIT_SSL_CAINFO` как
 * env-канал недоступен: `sanitizeGitEnv` вырезает `git*`-env, а
 * `allowEnvironment`-guard отклоняет задачу, поэтому CA передаётся только
 * пер-вызовом. Без `security.tls.caFile` — пусто (системное доверие, прежнее
 * поведение, поле `config` не появляется).
 */
function gitInstanceOptions(): Partial<SimpleGitOptions> {
  // Прокси в argv/`-c` НЕ передаём (пароль не должен попадать в аргументы):
  // D2b использует child-env в `withEnv` (`gitProxyEnv`), libcurl применяет
  // `no_proxy` и Basic-креды из userinfo.
  const config = gitCaConfig();
  return config.length > 0 ? { ...GIT_UNSAFE_OPTIONS, config } : GIT_UNSAFE_OPTIONS;
}

/** Создаёт simple-git с разрешёнными SSH/askpass-операциями и CA доверия. */
function createGit(baseDir?: string): SimpleGit {
  const options = gitInstanceOptions();
  return baseDir === undefined ? simpleGit(options) : simpleGit(baseDir, options);
}

/**
 * Применяет env к simple-git. `simpleGit.env(obj)` ЗАМЕНЯЕТ окружение процесса,
 * поэтому базовый `process.env` обязательно объединяем — но только после
 * санитайза: с simple-git 4.x environment-guard отклоняет задачу, если в `.env()`
 * явно передан `GIT_*`/blocklist-ключ без `allowEnvironment`, а ambient-`GIT_*`
 * без этого не протекает. Поэтому `.env()` ставится ВСЕГДА (даже без `env`):
 * дочерний git получает предсказуемое санитайзенное окружение и не наследует
 * `GIT_*`/`EDITOR`/… из окружения хоста.
 * `GIT_TERMINAL_PROMPT=0` — неинтерактивность: git не ждёт ввода без askpass.
 */
function withEnv(git: SimpleGit, env?: Record<string, string>): SimpleGit {
  return git.env({
    ...sanitizeGitEnv(process.env),
    GIT_TERMINAL_PROMPT: '0',
    // D2b: прокси/креды/no_proxy — только env (libcurl), не argv.
    ...gitProxyEnv(),
    ...env,
  });
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
