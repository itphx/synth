import type { Project, Session } from '@itphx/synth-shared';
import type { ProjectStoreLike } from '../storage/project-store.js';
import type { LocalOwnerResolver } from './local-owner.js';

/**
 * ADR-089: контекст проверки видимости сессии. `elevated` — сквозной обзор
 * (managed: ADMIN/LEAD; standalone не задаётся).
 */
export interface SessionOwnerCtx {
  /** id пользователя запроса. */
  userId: string;
  /** Сквозной обзор (ADMIN/LEAD) — видно всё. */
  elevated: boolean;
  /**
   * ADR-089 (standalone): нормализация legacy-владельца локального профиля к
   * `local` (UUID профиля до фикса резолвера внешней идентичности). Managed не
   * задаёт — id пользователей реальные, поведение не меняется.
   */
  localOwnerResolver?: LocalOwnerResolver;
}

/**
 * ADR-089: загрузка проекта с опциональным кэшем на время одного вызова списка.
 * Кэш передаётся вызывающей стороной (`Map`) и НЕ живёт на уровне модуля —
 * проекты меняются. Для одиночных проверок кэш не нужен.
 */
async function loadProject(
  store: ProjectStoreLike,
  projectId: string,
  cache?: Map<string, Project | null>,
): Promise<Project | null> {
  if (cache?.has(projectId)) return cache.get(projectId) ?? null;
  const project = await store.load(projectId).catch(() => null);
  cache?.set(projectId, project);
  return project;
}

/**
 * ADR-089: видимость сессии в списке.
 *
 * Правила (в порядке проверки):
 * 1. `elevated` (ADMIN/LEAD) — видно всё;
 * 2. владелец (`ownerId ?? userId === ctx.userId`) — видно;
 * 2a. `ctx.localOwnerResolver` (standalone) подтверждает, что владелец — локальный
 *     профиль под legacy-UUID (`ProfileData.id`) — видно (нормализация при чтении);
 * 3. нет владельца — видно (паритет с `canAccessSession`, чтобы legacy-сессии
 *    без владельца не пропадали);
 * 4. иначе — если у сессии есть `projectId` и проект (`projectStore.load`)
 *    принадлежит пользователю (`ownerId`) или пользователь числится в `members`
 *    (любая роль) — видно (командная/проектная сессия);
 * 5. иначе — не видно.
 */
export async function isSessionVisible(
  session: Session,
  projectStore: ProjectStoreLike | undefined,
  ctx: SessionOwnerCtx,
  projectCache?: Map<string, Project | null>,
): Promise<boolean> {
  if (ctx.elevated) return true;

  const owner = session.ownerId ?? session.userId;
  if (!owner) return true;
  if (owner === ctx.userId) return true;
  // ADR-089 (standalone): legacy-владелец (UUID профиля `local`) трактуется как
  // локальный → видно локальному пользователю. Managed не задаёт резолвер.
  if (ctx.localOwnerResolver && (await ctx.localOwnerResolver.isLocalOwner(owner))) return true;

  if (!session.projectId || !projectStore) return false;
  const project = await loadProject(projectStore, session.projectId, projectCache);
  if (!project) return false;
  return project.ownerId === ctx.userId || ctx.userId in (project.members ?? {});
}
