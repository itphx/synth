/**
 * PROP-133 §6: «видимые» сессии пользователя — свои **+** сессии всех проектов,
 * где у пользователя есть роль (владелец, участник, грант по группе, режим
 * «всем пользователям»).
 *
 * Единый шов для двух мест, которым нужен один и тот же список:
 * - список сессий (`routes/sessions.ts` → `resolveMemberProjectIds`);
 * - подписки хаба (`events/hub.ts` → `registerClient`).
 *
 * Своей копии предиката здесь нет: список проектов считает резолвер доступа
 * слоя 1 (`ProjectRepository.list(viewer)`).
 */
import type { ProjectRepository, SessionManager } from '@itphx/synth-core';
import type { Session } from '@itphx/synth-shared';

/** Кто запрашивает видимые сессии. */
export interface VisibleSessionScope {
  /** Идентификатор пользователя (владелец сессии/проекта). */
  userId: string;
  /** Группы пользователя (PROP-133 Ф2): нет — групп нет (fail-closed). */
  groups?: readonly string[];
}

/**
 * Идентификаторы проектов, видимых пользователю (владелец/участник/грант по
 * группе/«всем пользователям»). Список без аргумента (все проекты) здесь не
 * используется — он нужен elevated-ролям (`ADMIN`/`LEAD`), они идут отдельным
 * путём (`resolveElevated`).
 */
export async function resolveVisibleProjectIds(
  projectStore: ProjectRepository | undefined,
  scope: VisibleSessionScope,
): Promise<string[]> {
  if (!projectStore) return [];
  const projects = await projectStore.list({
    userId: scope.userId,
    ...(scope.groups ? { groups: scope.groups } : {}),
  });
  return projects.map((project) => project.id);
}

/**
 * Сессии, видимые пользователю: свои + сессии видимых проектов.
 *
 * Пустой `userId` → пустой список (fail-closed: без идентификатора запроса
 * выборка «все сессии» недопустима).
 */
export async function listVisibleSessions(
  sessionManager: Pick<SessionManager, 'listSessions'>,
  projectStore: ProjectRepository | undefined,
  scope: VisibleSessionScope,
): Promise<Session[]> {
  if (!scope.userId) return [];
  const projectIds = await resolveVisibleProjectIds(projectStore, scope);
  return sessionManager.listSessions(
    projectIds.length > 0
      ? { userId: scope.userId, projectIds }
      : { userId: scope.userId },
  );
}
