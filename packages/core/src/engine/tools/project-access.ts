import type { Project, Session } from '@itphx/synth-shared';
import { canWriteWithProjectRole, resolveProjectAccess } from '@itphx/synth-shared';

/**
 * ADR-075/D5: id пользователя сессии для проверки прав на проектные данные.
 *
 * Глобальных ролей в core нет (LEAD/ADMIN — концерн backend), поэтому опираемся
 * только на атрибуцию сессии: `userId`, затем `ownerId` (standalone/hybrid
 * выставляют `'local'`, managed — id пользователя).
 */
export function resolveSessionUserId(session: Session | null | undefined): string | undefined {
  return session?.userId || session?.ownerId || undefined;
}

/**
 * ADR-075/D5: может ли пользователь сессии писать проектные данные
 * (`invariants`, `log`, `plan`).
 *
 * PROP-133 §1: право — из **единого резолвера доступа** (`resolveProjectAccess`
 * + `canWriteWithProjectRole`), а не из собственной копии правила: владелец
 * проекта, участник с ролью `owner`/`editor`, грант по группе и режим
 * «всем пользователям» с ролью `editor`. Своей копии предиката здесь больше
 * нет — иначе правила разошлись бы (PROP-133 §1: предикат продублирован).
 *
 * Back-compat: если пользователь не идентифицируем (нет `userId` сессии) —
 * прежнее поведение: доверяем синтетическому контексту без владельца
 * проекта; владелец есть — писать ему нельзя.
 *
 * Ограничение core: глобальные роли LEAD/ADMIN здесь недоступны — их носители
 * не проходят гейт в чате, но могут менять проект через UI/API (backend RBAC).
 * Группы пользователя core тоже не знает (Ф2: claim `groups` из IdP) — список
 * групп пустой, гранты по группам в core не применяются (fail-closed); в
 * managed их применяет backend-резолвер (`projectPrincipalOf`).
 */
export function canEditProject(session: Session | null, project: Project): boolean {
  const userId = resolveSessionUserId(session);
  if (!userId) {
    // Нет атрибуции пользователя — доверяем только синтетическому контексту
    // без владельца проекта. Если владелец есть, писать ему нельзя.
    return !project.ownerId;
  }
  const role = resolveProjectAccess(project, { userId, roles: [], groups: [] }).role;
  return canWriteWithProjectRole(role);
}
