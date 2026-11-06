import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { GitRepoConfig, Project, ToolContext } from '@itphx/synth-shared';
import { normalizeGitRepoConfig } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { ProjectStoreLike } from '../../storage/project-store.js';
import type { SSHKeyRepository } from '../../storage/ports/ssh-key-repository.js';
import { SSHKeyStoreError } from '../../storage/ssh-key-store.js';
import { toSshSecret } from '../../git/ssh-env.js';
import type { ExecSecret } from '../../execution/ports/index.js';
import { resolveSshAccess, SshAccessError } from '../ssh/access.js';
import type { SystemMessageKey } from '../system-messages.js';

/**
 * ADR-076 §T6: SSH-доступ для сетевых git-тулов (`git_push`/`git_pull`).
 *
 * По `cwd` находим запись реестра `project.repos` (по относительному пути к
 * корню workspace) и, если у неё задан `sshKeyId`, готовим **секрет вызова**
 * (`ExecSecret`, ADR-077 протокол 4) — значение приватного ключа, а не путь
 * к файлу. Материализацию (временный ключ `0600` в каталоге `0700`) делает
 * **точка исполнения**: в remote-режиме это исполнитель, и путь control plane
 * в его контейнере не существует (ADR-077, «Обновлено 2026-10-26», (б)).
 * Ключ не найден/не расшифрован → типизированная ошибка (i18n-ключ), а не
 * молчаливый фейл аутентификации.
 *
 * PROP-124 §3: раскрытие ключа идёт **только** через единый гейт
 * (`engine/ssh/access.ts`) — здесь проверяется, что ключ пригоден для
 * git-операций (`usages`), а `reveal()` вызывается внутри гейта. Второго
 * места раскрытия секрета нет.
 */

interface GitSshExtra {
  sessionManager?: SessionManager;
  projectStore?: ProjectStoreLike;
  sessionId?: string;
  sshKeyStore?: SSHKeyRepository;
  workspacesRoot?: string;
}

export interface RepoGitEnvResult {
  /**
   * Секреты вызова (SSH-ключ) — доставляются точке исполнения на время
   * вызова; пусто — ambient ssh.
   */
  secrets?: ExecSecret[];
  /**
   * Идемпотентная очистка; no-op — материал готовит порт исполнения
   * (оставлено ради совместимости сигнатуры вызывающих).
   */
  cleanup: () => Promise<void>;
  /** i18n-ключ ошибки (`sshkey.not_found` / `sshkey.decrypt_failed` / `git.ssh_key_required`). */
  error?: SystemMessageKey;
  /** Параметры подстановки для `error`. */
  errorParams?: Record<string, string>;
}

const noopCleanup = async (): Promise<void> => {};

/** Результат подготовки SSH-доступа по явному `sshKeyId` (ADR-076). */
export interface SshEnvByIdResult {
  /**
   * Секреты вызова (SSH-ключ) — доставляются точке исполнения на время
   * вызова; пусто — ambient ssh.
   */
  secrets?: ExecSecret[];
  /**
   * Идемпотентная очистка; no-op — материал готовит порт исполнения
   * (оставлено ради совместимости сигнатуры вызывающих).
   */
  cleanup: () => Promise<void>;
  /** i18n-ключ ошибки (`sshkey.not_found` / `git.ssh_key_required`). */
  error?: SystemMessageKey;
  /** Параметры подстановки для `error`. */
  errorParams?: Record<string, string>;
}

/**
 * i18n-ключ движка для отказа гейта (ADR-041) — по образцу `git.ssh_*`.
 *
 * Новых ключей в `shared/i18n` на этом этапе не заводим, поэтому отказы
 * раскрываются существующими:
 *
 * - `key_not_found` → `sshkey.not_found` (ключа нет);
 * - `usage_denied` → `git.ssh_key_required` (для репозитория нужен ключ,
 *   пригодный для git: указанный ключ для этого не пригоден).
 *
 * Остальные коды (`agent_not_linked`/`host_denied`/`port_denied`/
 * `policy_required`/`ambiguous`) в git-пути не достижимы — они относятся к
 * `purpose:'ssh'` (адресные тулы/режим `agent`), где потребитель появится
 * на следующих этапах PROP-124.
 */
function sshAccessErrorKey(err: SshAccessError): SystemMessageKey {
  return err.code === 'key_not_found' ? 'sshkey.not_found' : 'git.ssh_key_required';
}

/**
 * Параметры подстановки для i18n-ключа отказа гейта.
 *
 * `sshkey.not_found` ждёт `{id}`, `git.ssh_key_required` — `{path}`.
 */
function sshAccessErrorParams(
  err: SshAccessError,
  ctx: { id: string; path: string },
): Record<string, string> {
  return err.code === 'key_not_found' ? { id: ctx.id } : { path: ctx.path };
}

/**
 * ADR-076: SSH-доступ по явному `sshKeyId` (без привязки к реестру проекта).
 * Общий хелпер HTTP-роутов (`/api/v2/git`) и тулов управления репозиториями.
 *
 * Ключ раскрывается **только** через единый гейт (`engine/ssh/access.ts`,
 * PROP-124 §3): здесь проверяется `usages` (для git нужен `git`), а
 * `reveal()` вызывается внутри гейта — второго места раскрытия нет.
 *
 * `opts.path` — путь репозитория: нужен для i18n-ключа `git.ssh_key_required`
 * («нужен ключ, пригодный для этого репозитория»).
 */
export async function resolveSshEnvById(
  sshKeyStore: SSHKeyRepository | undefined,
  sshKeyId?: string,
  opts?: { path?: string },
): Promise<SshEnvByIdResult> {
  if (!sshKeyId) return { cleanup: noopCleanup };
  if (!sshKeyStore) {
    return { cleanup: noopCleanup, error: 'sshkey.not_found', errorParams: { id: sshKeyId } };
  }

  try {
    // Режим инстанса для git не применяется (PROP-124 §3) — в запросе гейта
    // поля `mode` нет вовсе (union по назначению).
    const access = await resolveSshAccess({
      store: sshKeyStore,
      purpose: 'git',
      keyId: sshKeyId,
    });
    return { secrets: [toSshSecret(access.key)], cleanup: noopCleanup };
  } catch (err) {
    if (err instanceof SshAccessError) {
      return {
        cleanup: noopCleanup,
        error: sshAccessErrorKey(err),
        errorParams: sshAccessErrorParams(err, { id: sshKeyId, path: opts?.path ?? '' }),
      };
    }
    // Ошибка хранилища (расшифровка/мастер-ключ) — прежнее поведение.
    return { cleanup: noopCleanup, error: 'sshkey.not_found', errorParams: { id: sshKeyId } };
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
 *
 * ADR-114 §4: в сессии, привязанной к worktree, каталог `cwd` лежит **вне**
 * `project.workspace` (worktree — вторичная копия), поэтому относительный
 * путь не вычислим. Тогда запись ищется по `repoPath` — пути репозитория
 * worktree **относительно `project.workspace`** (тот же контракт, что у
 * `repo_path` в ADR-076; `.` — репозиторий в корне workspace).
 */
function findRepoEntry(
  project: Project,
  cwd: string,
  workspacesRoot?: string,
  repoPath?: string,
): GitRepoConfig | null {
  let relPath: string;
  if (repoPath !== undefined) {
    // Привязка к worktree: сопоставляем по пути репозитория, а не по `cwd`
    // (каталог worktree лежит вне `project.workspace`).
    relPath = normalizeRelPath(repoPath);
  } else {
    const projectDir = resolveProjectDir(project, workspacesRoot);
    if (!projectDir) return null;
    const rel = relative(projectDir, resolve(cwd));
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    relPath = normalizeRelPath(rel);
  }

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

  const entry = findRepoEntry(project, cwd, extra.workspacesRoot, ctx.worktreeRepoPath);
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

  const entry = findRepoEntry(project, cwd, extra.workspacesRoot, ctx.worktreeRepoPath);
  if (!entry?.sshKeyId) return { cleanup: noopCleanup };

  try {
    // Единый гейт (PROP-124 §3): `usages` проверяется, `reveal()` — внутри.
    // Режим инстанса для git не применяется — поля `mode` в запросе нет.
    const access = await resolveSshAccess({
      store: extra.sshKeyStore,
      purpose: 'git',
      keyId: entry.sshKeyId,
    });
    return { secrets: [toSshSecret(access.key)], cleanup: noopCleanup };
  } catch (err) {
    if (err instanceof SshAccessError) {
      return {
        cleanup: noopCleanup,
        error: sshAccessErrorKey(err),
        errorParams: sshAccessErrorParams(err, { id: entry.sshKeyId, path: entry.path }),
      };
    }
    const code = err instanceof SSHKeyStoreError && err.code === 'not_found'
      ? 'sshkey.not_found'
      : 'sshkey.decrypt_failed';
    return { cleanup: noopCleanup, error: code, errorParams: { id: entry.sshKeyId } };
  }
}
