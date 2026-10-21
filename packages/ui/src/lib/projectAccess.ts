// Права доступа к проекту в UI (ADR-089 §5.5/§5.8, инвариант 21).
//
// Правда чтения — на сервере (guard на границе, инвариант 16). UI лишь
// **прячет недоступные действия**, чтобы не предлагать пользователю
// заведомо отказную операцию.
//
// Правило сервера (`canEditProjectContent` в backend/core):
//   owner проекта, участник с ролью OWNER или EDITOR, глобальные LEAD/ADMIN.
//   VIEWER читает, но не мутирует (инвариант 21).

import type { ProjectData } from '@/lib/api/synthApi'
import type { User } from '@/lib/api/client'

/** Роли участника проекта (ADR-014, `ProjectRole` в shared). */
export type ProjectMemberRole = 'owner' | 'editor' | 'viewer'

/**
 * Есть ли право **изменять содержимое** проекта (пайплайны, прогоны, HITL).
 *
 * Зеркалит серверный `canEditProjectContent`: owner / OWNER / EDITOR / LEAD / ADMIN.
 */
export function canEditProjectContent(
  project: Pick<ProjectData, 'owner_id' | 'members'> | undefined | null,
  user: User | null | undefined,
): boolean {
  if (!project || !user) return false
  const roles = user.roles ?? []
  if (roles.includes('ADMIN') || roles.includes('LEAD')) return true
  if (project.owner_id === user.id) return true
  const memberRole = project.members?.[user.id] as ProjectMemberRole | undefined
  return memberRole === 'owner' || memberRole === 'editor'
}
