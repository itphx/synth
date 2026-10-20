import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { GitRepoConfig, Project, ToolContext } from '@itphx/synth-shared';
import { normalizeGitRepoConfig } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { ProjectStoreLike } from '../../storage/project-store.js';
import type { SSHKeyRepository } from '../../storage/ports/ssh-key-repository.js';
import { SSHKeyStoreError } from '../../storage/ssh-key-store.js';
import { createSshEnv, SshEnvError } from '../../git/ssh-env.js';

/**
 * ADR-076 §T6: SSH-окружение для сетевых git-тулов (`git_push`/`git_pull`).
 *
 * По `cwd` находим запись реестра `project.repos` (по относительному пути к
 * корню workspace) и, если у неё задан `sshKeyId`, готовим `GIT_SSH_COMMAND`
 * через `createSshEnv`. Ключ не найден/не расшифрован или не удалось
 * подготовить SSH-окружение → типизированная ошибка (i18n-ключ), а не
 * молчаливый фейл аутентификации.
 */

interface GitSshExtra {
  sessionManager?: SessionManager;
  projectStore?: ProjectStoreLike;
  sessionId?: string;
  sshKeyStore?: SSHKeyRepository;
  workspacesRoot?: string;
}

export interface RepoGitEnvResult {
  /** Дополнительные переменные окружения git (GIT_SSH_COMMAND); пусто — ambient ssh. */
  env?: Record<string, string>;
  /** Идемпотентная очистка временного ключа; no-op, если окружение не создавалось. */
  cleanup: () => Promise<void>;
  /** i18n-ключ ошибки (`sshkey.not_found` / `sshkey.decrypt_failed` / `sshkey.env_failed`). */
  error?: string;
  /** Параметры подстановки для `error`. */
  errorParams?: Record<string, string>;
}

const noopCleanup = async (): Promise<void> => {};

/** Результат подготовки SSH-окружения по явному `sshKeyId` (ADR-076). */
export interface SshEnvByIdResult {
  /** Дополнительные переменные окружения git (GIT_SSH_COMMAND); пусто — ambient ssh. */
  env?: Record<string, string>;
  /** Идемпотентная очистка временного ключа; no-op, если окружение не создавалось. */
  cleanup: () => Promise<void>;
  /** i18n-ключ ошибки (`sshkey.not_found` / `sshkey.env_failed`). */
  error?: string;
  /** Параметры подстановки для `error`. */
  errorParams?: Record<string, string>;
}

/**
 * ADR-076: SSH-окружение по явному `sshKeyId` (без привязки к реестру проекта).
 * Общий хелпер HTTP-роутов (`/api/v2/git`) и тулов управления репозиториями:
 * нет ключа/не расшифрован → `sshkey.not_found`; сбой подготовки → `sshkey.env_failed`.
 */
export async function resolveSshEnvById(
  sshKeyStore: SSHKeyRepository | undefined,
  sshKeyId?: string,
): Promise<SshEnvByIdResult> {
  if (!sshKeyId) return { cleanup: noopCleanup };

  let revealed: { privateKey: string; passphrase?: string } | null = null;
  try {
    revealed = sshKeyStore ? await sshKeyStore.reveal(sshKeyId) : null;
  } catch {
    return { cleanup: noopCleanup, error: 'sshkey.not_found', errorParams: { id: sshKeyId } };
  }
  if (!revealed) {
    return { cleanup: noopCleanup, error: 'sshkey.not_found', errorParams: { id: sshKeyId } };
  }

  try {
    const ssh = await createSshEnv(revealed);
    return { env: ssh.env, cleanup: ssh.cleanup };
  } catch (err) {
    if (err instanceof SshEnvError) {
      return { cleanup: noopCleanup, error: 'sshkey.env_failed' };
    }
    throw err;
  }
}

/** POSIX-нормализация относительного пути (`''`/`.` → `.`, убираем `./` и хвостовые `/`). */
function normalizeRelPath(value: string): string {
  const posix = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return posix === '' ? '.' : posix;
}

/** Резолвит корень workspace проекта: абсолютный — как есть, относительный — от workspacesRoot. */
function resolveProjectDir(project: Project, workspacesRoot?: string): string | undefined {
  if (!project.workspace) return undefined;
  if (isAbsolute(project.workspace)) return resolve(project.workspace);
  return workspacesRoot ? resolve(workspacesRoot, project.workspace) : undefined;
}

/**
 * ADR-076: запись реестра `project.repos` для каталога `cwd` — по относительному
 * пути от корня workspace проекта. `cwd` вне workspace → записи нет.
 */
function findRepoEntry(project: Project, cwd: string, workspacesRoot?: string): GitRepoConfig | null {
  const projectDir = resolveProjectDir(project, workspacesRoot);
  if (!projectDir) return null;

  const rel = relative(projectDir, resolve(cwd));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const relPath = normalizeRelPath(rel);

  for (const raw of project.repos ?? []) {
    const normalized = normalizeGitRepoConfig(raw);
    if (normalized && normalizeRelPath(normalized.path) === relPath) return normalized;
  }
  return null;
}

/**
 * Результат поиска записи реестра git-репозиториев проекта для каталога `cwd`.
 * - `entry` — запись найдена (URL может отсутствовать — репозиторий заведён локально);
 * - `no_project` — у сессии нет проекта (реестра нет);
 * - `not_registered` — проект есть, но каталог в реестре не зарегистрирован.
 */
export type ProjectRepoLookup =
  | { kind: 'entry'; entry: GitRepoConfig; url?: string }
  | { kind: 'no_project' }
  | { kind: 'not_registered' };

/**
 * ADR-076: запись реестра `project.repos` для каталога `cwd`.
 * Нужен сетевым git-тулам (`git_push`/`git_pull`): remote обязан указывать на
 * репозиторий, зарегистрированный в проекте, — иначе содержимое репозитория
 * можно выгрузить на произвольный хост (git-дочерние процессы не идут через
 * egress-политику, ADR-099).
 */
export async function resolveProjectRepoEntry(ctx: ToolContext, cwd: string): Promise<ProjectRepoLookup> {
  const extra = ctx.extra as GitSshExtra | undefined;
  if (!extra?.sessionManager || !extra?.projectStore) return { kind: 'no_project' };

  const sessionId = ctx.sessionId || extra.sessionId;
  if (!sessionId) return { kind: 'no_project' };

  let project: Project | null = null;
  try {
    const session = await extra.sessionManager.getSession(sessionId);
    if (!session?.projectId) return { kind: 'no_project' };
    project = await extra.projectStore.load(session.projectId);
  } catch {
    return { kind: 'no_project' };
  }
  if (!project) return { kind: 'no_project' };

  const entry = findRepoEntry(project, cwd, extra.workspacesRoot);
  if (!entry) return { kind: 'not_registered' };
  return { kind: 'entry', entry, url: entry.url };
}

export async function resolveRepoGitEnv(ctx: ToolContext, cwd: string): Promise<RepoGitEnvResult> {
  const extra = ctx.extra as GitSshExtra | undefined;
  if (!extra?.sshKeyStore) return { cleanup: noopCleanup };

  const sessionId = ctx.sessionId || extra.sessionId;
  if (!sessionId || !extra.sessionManager || !extra.projectStore) return { cleanup: noopCleanup };

  let project: Project | null = null;
  try {
    const session = await extra.sessionManager.getSession(sessionId);
    if (!session?.projectId) return { cleanup: noopCleanup };
    project = await extra.projectStore.load(session.projectId);
  } catch {
    return { cleanup: noopCleanup };
  }
  if (!project) return { cleanup: noopCleanup };

  const entry = findRepoEntry(project, cwd, extra.workspacesRoot);
  if (!entry?.sshKeyId) return { cleanup: noopCleanup };

  let revealed: { privateKey: string; passphrase?: string } | null;
  try {
    revealed = await extra.sshKeyStore.reveal(entry.sshKeyId);
  } catch (err) {
    const code = err instanceof SSHKeyStoreError && err.code === 'not_found'
      ? 'sshkey.not_found'
      : 'sshkey.decrypt_failed';
    return { cleanup: noopCleanup, error: code, errorParams: { id: entry.sshKeyId } };
  }
  if (!revealed) {
    return { cleanup: noopCleanup, error: 'sshkey.not_found', errorParams: { id: entry.sshKeyId } };
  }

  try {
    const ssh = await createSshEnv(revealed);
    return { env: ssh.env, cleanup: ssh.cleanup };
  } catch (err) {
    if (err instanceof SshEnvError) {
      return { cleanup: noopCleanup, error: 'sshkey.env_failed' };
    }
    throw err;
  }
}
