import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Project, ToolContext } from '@itphx/synth-shared';
import { normalizeGitRepoConfig } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { ProjectStore } from '../../storage/project-store.js';
import type { SSHKeyStore } from '../../storage/ssh-key-store.js';
import { SSHKeyStoreError } from '../../storage/ssh-key-store.js';
import { createSshEnv, SshEnvError } from '../../git/ssh-env.js';

/**
 * AD-076 §T6: SSH-окружение для сетевых git-тулов (`git_push`/`git_pull`).
 *
 * По `cwd` находим запись реестра `project.repos` (по относительному пути к
 * корню workspace) и, если у неё задан `sshKeyId`, готовим `GIT_SSH_COMMAND`
 * через `createSshEnv`. Ключ не найден/не расшифрован или не удалось
 * подготовить SSH-окружение → типизированная ошибка (i18n-ключ), а не
 * молчаливый фейл аутентификации.
 */

interface GitSshExtra {
  sessionManager?: SessionManager;
  projectStore?: ProjectStore;
  sessionId?: string;
  sshKeyStore?: SSHKeyStore;
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

/** Результат подготовки SSH-окружения по явному `sshKeyId` (AD-076). */
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
 * AD-076: SSH-окружение по явному `sshKeyId` (без привязки к реестру проекта).
 * Общий хелпер HTTP-роутов (`/api/v2/git`) и тулов управления репозиториями:
 * нет ключа/не расшифрован → `sshkey.not_found`; сбой подготовки → `sshkey.env_failed`.
 */
export async function resolveSshEnvById(
  sshKeyStore: SSHKeyStore | undefined,
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

  const projectDir = resolveProjectDir(project, extra.workspacesRoot);
  if (!projectDir) return { cleanup: noopCleanup };

  const rel = relative(projectDir, resolve(cwd));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { cleanup: noopCleanup };
  }
  const relPath = normalizeRelPath(rel);

  let entry: { path: string; sshKeyId?: string } | null = null;
  for (const raw of project.repos ?? []) {
    const normalized = normalizeGitRepoConfig(raw);
    if (normalized && normalizeRelPath(normalized.path) === relPath) {
      entry = normalized;
      break;
    }
  }
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
