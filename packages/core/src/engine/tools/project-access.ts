import { ProjectRole } from '@itphx/synth-shared';
import type { Project, Session } from '@itphx/synth-shared';

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
 * (`invariants`, `log`, `plan`). Правило зеркалит HTTP-RBAC контентных полей
 * (`PUT /api/v2/projects/:id`, backend): owner проекта или участник
 * `{OWNER, EDITOR}`.
 *
 * Back-compat: если пользователь не идентифицируем (нет `userId` сессии и
 * `project.ownerId` пуст) — разрешаем (локальный/синтетический контекст).
 *
 * Ограничение core: глобальные роли LEAD/ADMIN здесь недоступны — их носители
 * не проходят гейт в чате, но могут менять проект через UI/API (backend RBAC).
 */
export function canEditProject(session: Session | null, project: Project): boolean {
  const userId = resolveSessionUserId(session);
  if (!userId) {
    // Нет атрибуции пользователя — доверяем только синтетическому контексту
    // без владельца проекта. Если владелец есть, писать ему нельзя.
    return !project.ownerId;
  }
  if (project.ownerId && project.ownerId === userId) return true;
  const role = project.members?.[userId];
  return role === ProjectRole.OWNER || role === ProjectRole.EDITOR;
}
