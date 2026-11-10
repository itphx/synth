/**
 * Общий резолвер проекта по id или точному имени (без учёта регистра).
 *
 * Нужен сразу нескольким тулам (`get_project`, `list_sessions`,
 * `project_attach`): агент получает от пользователя **имя** проекта, а не id,
 * поэтому «сначала id, затем точное имя среди видимых проектов» должно быть
 * одним правилом — иначе тулы разойдутся в трактовке неоднозначности.
 *
 * Видимость — та же, что у HTTP-списка проектов: elevated (ADMIN/LEAD) видит
 * всё, остальные — только свои проекты и проекты участия (владелец или запись
 * в `members`). Невидимый проект для не-elevated выглядит как отсутствующий:
 * существование чужого ресурса не раскрывается.
 */
import type { Project } from '@itphx/synth-shared';
import { ProjectRole } from '@itphx/synth-shared';
import type { ToolContext } from '@itphx/synth-shared';
import type { ProjectStoreContract } from '../../storage/project-store.js';
import type { SessionManager } from '../../sessions/manager.js';

/** Принципал хода, собранный оркестратором в `ToolContext.extra`. */
export interface ToolPrincipal {
  userId: string;
  roles: string[];
}

/** Поля `extra`, общие для новых тулов проектов/сессий. */
export interface PrincipalExtra {
  principal?: ToolPrincipal;
  isElevatedPrincipal?: boolean;
}

/** Идентичность вызывающего для проверок видимости. */
export interface ProjectViewer {
  userId: string;
  elevated: boolean;
}

/**
 * Идентичность из `ctx.extra`. Если оркестратор не передал принципала
 * (старые тесты/встраивание), берётся `local` — тот же дефолт, что у владельца
 * сессии в standalone; elevated не выводится (fail-closed).
 */
export function viewerFromExtra(extra: PrincipalExtra | undefined): ProjectViewer {
  const userId = extra?.principal?.userId || 'local';
  const roles = extra?.principal?.roles ?? [];
  const elevated = extra?.isElevatedPrincipal
    ?? roles.some((role) => role.toUpperCase() === 'ADMIN' || role.toUpperCase() === 'LEAD');
  return { userId, elevated };
}

/**
 * Идентичность вызывающего с фоллбеком на владельца текущей сессии.
 *
 * Оркестратор всегда кладёт `principal`, но тулы вызываются и напрямую
 * (тесты, встраивание) — тогда владелец берётся из сессии (`ownerId`/`userId`),
 * иначе `local` (standalone-дефолт). Elevated без явного принципала не
 * выводится — fail-closed.
 */
export async function resolveViewer(
  ctx: ToolContext,
  extra: (PrincipalExtra & { sessionManager?: SessionManager; sessionId?: string }) | undefined,
): Promise<ProjectViewer> {
  const base = viewerFromExtra(extra);
  if (extra?.principal?.userId) return base;
  try {
    const sessionId = ctx.sessionId || extra?.sessionId;
    const session = sessionId && extra?.sessionManager
      ? await extra.sessionManager.getSession(sessionId)
      : null;
    const userId = session?.ownerId || session?.userId || base.userId;
    return { ...base, userId };
  } catch {
    return base;
  }
}

/** Виден ли проект пользователю (elevated — всё, иначе владелец/участник). */export function isProjectVisible(
  project: Project,
  viewer: ProjectViewer,
): boolean {
  if (viewer.elevated) return true;
  if (project.ownerId && project.ownerId === viewer.userId) return true;
  return Object.prototype.hasOwnProperty.call(project.members ?? {}, viewer.userId);
}

/**
 * Роль пользователя в проекте в верхнем регистре (`OWNER|EDITOR|VIEWER`) или
 * `null`. Владелец проекта — всегда `OWNER`, даже если запись в `members`
 * отсутствует (legacy/частичные записи).
 */
export function projectRoleLabel(
  project: Project,
  userId: string,
): 'OWNER' | 'EDITOR' | 'VIEWER' | null {
  if (project.ownerId && project.ownerId === userId) return 'OWNER';
  const role = project.members?.[userId];
  if (!role) return null;
  switch (role) {
    case ProjectRole.OWNER:
      return 'OWNER';
    case ProjectRole.EDITOR:
      return 'EDITOR';
    case ProjectRole.VIEWER:
      return 'VIEWER';
    default:
      return null;
  }
}

/** Проекты, видимые пользователю (для не-elevated — свои и проекты участия). */
export async function listVisibleProjects(
  store: ProjectStoreContract,
  viewer: ProjectViewer,
): Promise<Project[]> {
  if (viewer.elevated) return store.list();
  return store.list(viewer.userId);
}

/** Результат резолвинга: найден / не найден / неоднозначное имя. */
export type ProjectResolution =
  | { status: 'found'; project: Project }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: Project[] };

/**
 * Резолвит ссылку на проект: id (загрузка) → точное имя среди видимых.
 *
 * - id проверяется на видимость: невидимый проект = не найден;
 * - имя сравнивается без учёта регистра, пробелы по краям срезаются;
 * - два и более совпадений — `ambiguous` со списком кандидатов (первый **не**
 *   выбирается: молчаливый выбор чужого/не того проекта недопустим).
 */
export async function resolveProjectRef(
  store: ProjectStoreContract,
  ref: string,
  viewer: ProjectViewer,
): Promise<ProjectResolution> {
  const query = ref.trim();
  if (!query) return { status: 'not_found' };

  let byId: Project | null = null;
  try {
    byId = await store.load(query);
  } catch {
    byId = null;
  }
  if (byId) {
    return isProjectVisible(byId, viewer)
      ? { status: 'found', project: byId }
      : { status: 'not_found' };
  }

  const projects = await listVisibleProjects(store, viewer);
  const needle = query.toLowerCase();
  const matches = projects.filter((project) => project.name.trim().toLowerCase() === needle);
  if (matches.length === 0) return { status: 'not_found' };
  if (matches.length === 1) return { status: 'found', project: matches[0]! };
  return { status: 'ambiguous', candidates: matches };
}

/**
 * Компактный список кандидатов для текста ошибки: `- name (id, owner)`.
 * Без plan/log/invariants — только то, что помогает выбрать проект.
 */
export function formatProjectCandidates(candidates: Project[]): string {
  return candidates
    .map((project) => `- ${project.name} (${project.id}, owner: ${project.ownerId || '—'})`)
    .join('\n');
}

/** Краткая сводка кандидата для metadata (`ambiguous`). */
export function candidateSummary(project: Project) {
  return {
    id: project.id,
    name: project.name,
    owner_id: project.ownerId || null,
    workspace: project.workspace ?? null,
  };
}
