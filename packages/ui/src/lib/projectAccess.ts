// Права доступа к проекту в UI (ADR-089 §5.5/§5.8, инвариант 21, PROP-133 §1).
//
// Правда чтения — на сервере (guard на границе, инвариант 16). UI лишь
// **прячет недоступные действия**, чтобы не предлагать пользователю
// заведомо отказную операцию.
//
// Правило сервера (`canEditProjectContent` в backend/core):
//   owner проекта, участник с ролью OWNER или EDITOR, глобальные LEAD/ADMIN.
//   VIEWER читает, но не мутирует (инвариант 21).
//
// PROP-133: предикаты считаются **единым резолвером** из shared
// (`resolveProjectAccess`) — он же источник истины на сервере. UI — зеркало:
// те же приоритеты (владелец → ADMIN/LEAD → участник → группа → «всем»),
// тот же fail-closed для неизвестной роли (битая запись → `viewer`).

import { ProjectRole } from '@itphx/synth-shared/types'
import {
  canManageWithProjectRole,
  canWriteWithProjectRole,
  resolveProjectAccess,
  type ProjectAccess,
} from '@itphx/synth-shared/types'

import type { ProjectData } from '@/lib/api/synthApi'
import type { ProjectAccessBody, ProjectAccessRole } from '@/lib/api/synthApi'
import type { User } from '@/lib/api/client'

/** Роли участника проекта (ADR-014, `ProjectRole` в shared). */
export type ProjectMemberRole = 'owner' | 'editor' | 'viewer'

/** Контекст развёртывания, в котором UI показывает права. */
export interface ProjectAccessOptions {
  /** UI работает с локальным core (standalone/гибрид) — `deployment === 'standalone'`. */
  standalone?: boolean
}

/**
 * Минимальный набор полей проекта, нужный для решения о доступе.
 *
 * `group_members`/`everyone_role` — состояние списка доступа (PROP-133 §3.2);
 * без них (старый сервер) резолвер считает проект «только автору».
 */
export type ProjectAccessSubject = Pick<
  ProjectData,
  'owner_id' | 'members' | 'origin'
> & {
  group_members?: Record<string, string> | null
  everyone_role?: string | null
}

/**
 * Локальный мир однопользовательский: единственная личность инстанса и есть
 * владелец локальных проектов.
 *
 * Локальные проекты создаёт сам core с `owner_id: 'local'` (у
 * `mountStandaloneRoutes` нет `getCurrentUserId`), а серверный `canManage` в
 * core по умолчанию разрешает (RBAC-хук не передан). Сравнение id здесь
 * только скрывало бы доступное действие: в гибриде UI авторизуется серверной
 * личностью (`user.id` = id пользователя backend), и `'local' !== 'u-…'`
 * навсегда закрывал бы блоки MCP/скиллов/доступа. `remote:`-проекты живут на
 * backend с той же личностью — для них правило прежнее.
 */
function isLocalStandaloneProject(
  project: Pick<ProjectData, 'origin'>,
  options?: ProjectAccessOptions,
): boolean {
  return options?.standalone === true && project.origin !== 'remote'
}

/** Строка роли из DTO → enum `ProjectRole` (неизвестное — fail-closed в `viewer`). */
function toProjectRole(value: unknown): ProjectRole {
  if (value === 'owner') return ProjectRole.OWNER
  if (value === 'editor') return ProjectRole.EDITOR
  if (value === 'viewer') return ProjectRole.VIEWER
  return ProjectRole.VIEWER
}

/** Карта грантов из DTO (`Record<string, string>`) → `Record<string, ProjectRole>`. */
function toRoleMap(value: Record<string, string> | null | undefined): Record<string, ProjectRole> {
  const out: Record<string, ProjectRole> = {}
  if (!value) return out
  for (const [key, role] of Object.entries(value)) {
    if (!key) continue
    out[key] = toProjectRole(role)
  }
  return out
}

/**
 * Роль доступа пользователя к проекту — **зеркало** серверного
 * `resolveProjectAccess` (PROP-133 §1).
 *
 * Порядок: владелец → ADMIN/LEAD → участник (`members`) → группа
 * (`group_members`) → «всем пользователям» (`everyone_role`). Первое
 * совпадение выигрывает. Неизвестная роль в данных — fail-closed в
 * `viewer` (только чтение).
 */
export function resolveProjectRole(
  project: ProjectAccessSubject | undefined | null,
  user: User | null | undefined,
  options?: ProjectAccessOptions,
): ProjectAccess['role'] {
  if (!project || !user) return null
  if (isLocalStandaloneProject(project, options)) return 'owner'
  const access: ProjectAccess = resolveProjectAccess(
    {
      ownerId: project.owner_id,
      members: toRoleMap(project.members),
      groupMembers: toRoleMap(project.group_members),
      everyoneRole:
        project.everyone_role === null || project.everyone_role === undefined
          ? undefined
          : toProjectRole(project.everyone_role),
    },
    { userId: user.id, roles: user.roles ?? [] },
  )
  return access.role
}

/**
 * Есть ли право **читать** проект (ADR-089 §5.8, PROP-133 §1).
 *
 * Зеркалит серверное правило чтения: владелец, ADMIN/LEAD, участник
 * (любая роль), «всем пользователям» (`everyone_role`). `viewer` читает, но
 * не получает права на изменение (инвариант 21).
 */
export function canReadProject(
  project: ProjectAccessSubject | undefined | null,
  user: User | null | undefined,
  options?: ProjectAccessOptions,
): boolean {
  if (!project || !user) return false
  if (isLocalStandaloneProject(project, options)) return true
  return resolveProjectRole(project, user, options) !== null
}

/**
 * Есть ли право **управлять** проектом (скоупы MCP и скиллов, workspace и т.п.).
 *
 * Зеркалит серверный `canManage`: LEAD / ADMIN, owner проекта, участник с
 * ролью OWNER. В **локальном мире** (standalone/гибрид) правило шире — см.
 * комментарий `isLocalStandaloneProject`.
 */
export function canManageProject(
  project: ProjectAccessSubject | undefined | null,
  user: User | null | undefined,
  options?: ProjectAccessOptions,
): boolean {
  if (!project || !user) return false
  if (isLocalStandaloneProject(project, options)) return true
  return canManageWithProjectRole(resolveProjectRole(project, user, options))
}

/**
 * Есть ли право **изменять содержимое** проекта (пайплайны, прогоны, HITL).
 *
 * Зеркалит серверный `canEditProjectContent`: owner / OWNER / EDITOR / LEAD / ADMIN.
 */
export function canEditProjectContent(
  project: ProjectAccessSubject | undefined | null,
  user: User | null | undefined,
  options?: ProjectAccessOptions,
): boolean {
  if (!project || !user) return false
  if (isLocalStandaloneProject(project, options)) return true
  return canWriteWithProjectRole(resolveProjectRole(project, user, options))
}

// --- Слой 3 (UI): проекции доступа (PROP-133 §4) -----------------------------

/**
 * Три проекции доступа — **состояния одного и того же** списка доступа
 * (PROP-133 §4): не хранимый флаг, а проекция состояния.
 */
export const PROJECT_ACCESS_PROJECTIONS = ['author', 'selected', 'all'] as const

/** Проекция доступа к проекту (значения — как у DTO `visibility`). */
export type ProjectAccessProjection = (typeof PROJECT_ACCESS_PROJECTIONS)[number]

/** Роль, которую UI может выдать участнику (владелец — `owner`, его не выбирают). */
export type ProjectGrantRole = 'viewer' | 'editor'

/**
 * Текущая проекция доступа проекта — из DTO (`visibility`, производное сервером).
 *
 * Старый сервер поля не отдаёт — проект считается «только автору».
 */
export function accessProjectionOf(
  project: Pick<ProjectData, 'visibility'> | undefined | null,
): ProjectAccessProjection {
  const visibility = project?.visibility
  if (visibility === 'selected' || visibility === 'all') return visibility
  return 'author'
}

/**
 * Черновик участников из DTO: `userId → 'viewer'|'editor'`.
 *
 * Владелец проекта в список не входит: сервер держит его `owner` сам и не
 * даёт понизить (передача владения — отдельная операция, Ф3).
 */
export function draftMembersOf(
  project: Pick<ProjectData, 'owner_id' | 'members'> | undefined | null,
): Record<string, ProjectGrantRole> {
  const out: Record<string, ProjectGrantRole> = {}
  if (!project) return out
  for (const [id, role] of Object.entries(project.members ?? {})) {
    if (!id || id === project.owner_id) continue
    if (role === 'editor') out[id] = 'editor'
    else if (role === 'viewer') out[id] = 'viewer'
  }
  return out
}

/**
 * Роль режима «всем пользователям» из DTO (`everyone_role`).
 *
 * `editor` — только явное значение сервера; всё прочее (в т.ч. `owner` и
 * битое значение) — `viewer`: повышение прав по умолчанию не включается.
 */
export function everyoneRoleOf(
  project: Pick<ProjectData, 'everyone_role'> | undefined | null,
): ProjectGrantRole {
  return project?.everyone_role === 'editor' ? 'editor' : 'viewer'
}

/**
 * Состояние списка доступа после смены проекции (PROP-133 §4).
 *
 * Проекции — **состояния одного списка**, поэтому переход между ними имеет
 * правило: «Только автору» снимает список участников, «Всем пользователям»
 * возвращает роль `viewer` (повышение до `editor` — только явный выбор
 * автора). Правило живёт здесь, а не в компонентах — иначе у каждого
 * экрана своя копия правды.
 */
export function projectAccessDraftAfterProjection(
  next: ProjectAccessProjection,
  current: ProjectAccessProjection,
  members: Record<string, ProjectGrantRole>,
  everyoneRole: ProjectGrantRole,
): {
  projection: ProjectAccessProjection
  members: Record<string, ProjectGrantRole>
  everyoneRole: ProjectGrantRole
} {
  return {
    projection: next,
    members: next === 'author' ? {} : members,
    everyoneRole: next === 'all' && current !== 'all' ? 'viewer' : everyoneRole,
  }
}

/**
 * Тело состояния доступа для сохранения — **полная замена** (PROP-133 §3.1).
 *
 * - «Только автору» — список участников пуст, публикация снята;
 * - «Только выбранным» — публикация снята, список участников целиком;
 * - «Всем пользователям» — одна роль для всех; индивидуальные гранты не
 *   уходят (иначе они бы «сужали» роль для отдельных людей).
 *
 * `everyone_role` для режима «всем» по умолчанию `viewer`; `editor` — только
 * явным выбором автора (никогда не включается автоматически).
 */
export function buildProjectAccessBody(
  projection: ProjectAccessProjection,
  members: Record<string, ProjectGrantRole>,
  everyoneRole: ProjectGrantRole = 'viewer',
): ProjectAccessBody {
  if (projection === 'selected') {
    const list: Record<string, ProjectAccessRole> = {}
    for (const [id, role] of Object.entries(members)) {
      if (!id) continue
      list[id] = role
    }
    return { members: list, everyone_role: null }
  }
  if (projection === 'all') {
    return { members: {}, everyone_role: everyoneRole }
  }
  return { members: {}, everyone_role: null }
}
