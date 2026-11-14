/**
 * Общий резолвер проекта по id или точному имени (без учёта регистра).
 *
 * Нужен сразу нескольким тулам (`get_project`, `list_sessions`,
 * `project_attach`): агент получает от пользователя **имя** проекта, а не id,
 * поэтому «сначала id, затем точное имя среди видимых проектов» должно быть
 * одним правилом — иначе тулы разойдутся в трактовке неоднозначности.
 *
 * Видимость — та же, что у HTTP-списка проектов: elevated (ADMIN/LEAD) видит
 * всё, остальные — только те проекты, где у них есть роль (PROP-133 §1:
 * владелец, участник, грант по группе, режим «всем пользователям»). Невидимый
 * проект для не-elevated выглядит как отсутствующий: существование чужого
 * ресурса не раскрывается.
 */
import type { Project } from '@itphx/synth-shared';
import { resolveProjectAccess } from '@itphx/synth-shared';
import type { ToolContext } from '@itphx/synth-shared';
import type { ProjectStoreContract } from '../../storage/project-store.js';
import type { SessionManager } from '../../sessions/manager.js';

/** Принципал хода, собранный оркестратором в `ToolContext.extra`. */
export interface ToolPrincipal {
  userId: string;
  roles: string[];
  /**
   * PROP-133: группы пользователя (субъект грантов по группам). Поле появляется
   * в Ф2 (claim `groups` из IdP); нет — групп нет (fail-closed).
   */
  groups?: readonly string[];
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
  /** PROP-133: группы пользователя (гранты по группам). */
  groups?: readonly string[];
}

/**
 * Группы принципала хода из `ctx.extra` (ADR-140 Ф2).
 *
 * Источник — снимок в `extra.principal.groups` (оркестратор кладёт его из
 * принципала хода, зафиксированного при приёме ввода). Нет/пусто →
 * `undefined` (групп нет, fail-closed).
 */
export function principalGroups(ctx: ToolContext): readonly string[] | undefined {
  const extra = ctx.extra as PrincipalExtra | undefined;
  const groups = extra?.principal?.groups;
  return groups && groups.length > 0 ? groups : undefined;
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
  const groups = extra?.principal?.groups;
  return { userId, elevated, ...(groups && groups.length > 0 ? { groups } : {}) };
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

/**
 * Виден ли проект пользователю (PROP-133 §1: единый резолвер доступа).
 *
 * Elevated (ADMIN/LEAD) — всё; иначе — по роли доступа: владелец, участник,
 * грант по группе, режим «всем пользователям».
 */
export function isProjectVisible(
  project: Project,
  viewer: ProjectViewer,
): boolean {
  if (viewer.elevated) return true;
  return resolveProjectAccess(project, {
    userId: viewer.userId,
    ...(viewer.groups ? { groups: viewer.groups } : {}),
  }).read;
}

/** Метка роли доступа (`OWNER|EDITOR|VIEWER`) для DTO тулов. */
const ROLE_LABEL = {
  owner: 'OWNER',
  editor: 'EDITOR',
  viewer: 'VIEWER',
} as const;

/**
 * Роль пользователя в проекте в верхнем регистре (`OWNER|EDITOR|VIEWER`) или
 * `null`. PROP-133 §1: роль — из единого резолвера (владелец проекта — всегда
 * `OWNER`, даже если запись в `members` отсутствует; грант по группе и режим
 * «всем пользователям» — тоже учитываются).
 */
export function projectRoleLabel(
  project: Project,
  userId: string,
  groups?: readonly string[],
): 'OWNER' | 'EDITOR' | 'VIEWER' | null {
  const role = resolveProjectAccess(project, {
    userId,
    ...(groups ? { groups } : {}),
  }).role;
  return role ? ROLE_LABEL[role] : null;
}

/**
 * Проекты, видимые пользователю (PROP-133 §1: список фильтруется единым
 * резолвером — владелец, участник, грант по группе, режим «всем пользователям»).
 */
export async function listVisibleProjects(
  store: ProjectStoreContract,
  viewer: ProjectViewer,
): Promise<Project[]> {
  if (viewer.elevated) return store.list();
  return store.list({
    userId: viewer.userId,
    ...(viewer.groups ? { groups: viewer.groups } : {}),
  });
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
 *
 * PROP-133 §1: и по id, и по имени видимость считает **единый** резолвер
 * доступа (`resolveProjectAccess` через `isProjectVisible`/`listVisibleProjects`).
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
