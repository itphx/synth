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
    {
      userId: user.id,
      roles: user.roles ?? [],
      // ADR-140 Ф2: группы пользователя — субъект грантов по группам
      // (`group_members`). Без снимка групп резолвер не находит грант (fail-closed).
      groups: user.groups ?? [],
    },
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
 * Сырая карта грантов из DTO (`субъект → строка роли`).
 *
 * Роль приходит строкой: битое значение (`'WRONG'`) отбрасывается, а не
 * приводится молча к `viewer` (fail-closed, как в `toProjectRole`).
 */
type RawGrantMap = Record<string, string> | null | undefined

/**
 * Черновик грантов группам из DTO: `имя группы → 'viewer'|'editor'`
 * (ADR-140 Ф2).
 *
 * По образцу `draftMembersOf`: неизвестные роли отбрасываются, имена
 * trim-ятся, пустые отбрасываются (имя группы — свободная строка).
 */
export function draftGroupMembersOf(
  project: { group_members?: RawGrantMap } | undefined | null,
): Record<string, ProjectGrantRole> {
  const out: Record<string, ProjectGrantRole> = {}
  if (!project) return out
  for (const [rawName, role] of Object.entries(project.group_members ?? {})) {
    const name = rawName.trim()
    if (!name) continue
    if (role === 'editor') out[name] = 'editor'
    else if (role === 'viewer') out[name] = 'viewer'
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

/** Состав списка доступа — по каким осям выданы гранты (ADR-140 Ф2). */
export interface ProjectAccessComposition {
  /** Есть ли гранты отдельным пользователям (владелец в счёт не идёт). */
  hasUserGrants: boolean
  /** Есть ли гранты группам. */
  hasGroupGrants: boolean
}

/**
 * Состав списка доступа проекта: есть ли гранты пользователям и группам.
 *
 * Владелец (роль `owner` в `members`) — не грант: он и так имеет полный
 * доступ. Битые роли в данных не считаются грантом (fail-closed, как в
 * `draftMembersOf`).
 */
export function accessCompositionOf(
  project:
    | {
        owner_id?: string
        members?: RawGrantMap
        group_members?: RawGrantMap
      }
    | undefined
    | null,
): ProjectAccessComposition {
  if (!project) return { hasUserGrants: false, hasGroupGrants: false }
  let hasUserGrants = false
  for (const [id, role] of Object.entries(project.members ?? {})) {
    if (!id || id === project.owner_id) continue
    if (role === 'owner' || role === 'editor' || role === 'viewer') {
      hasUserGrants = true
      break
    }
  }
  let hasGroupGrants = false
  for (const name of Object.keys(project.group_members ?? {})) {
    if (name.trim()) {
      hasGroupGrants = true
      break
    }
  }
  return { hasUserGrants, hasGroupGrants }
}

/**
 * Состояние списка доступа после смены проекции (PROP-133 §4, ADR-140 Ф2).
 *
 * Проекции — **состояния одного списка**, поэтому переход между ними имеет
 * правило: «Только автору» снимает список участников и гранты группам,
 * «Всем пользователям» возвращает роль `viewer` (повышение до `editor` —
 * только явный выбор автора). Правило живёт здесь, а не в компонентах —
 * иначе у каждого экрана своя копия правды.
 *
 * `groupMembers` — необязательный последний параметр (обратная совместимость:
 * вызовы без групп работают как раньше).
 */
export function projectAccessDraftAfterProjection(
  next: ProjectAccessProjection,
  current: ProjectAccessProjection,
  members: Record<string, ProjectGrantRole>,
  everyoneRole: ProjectGrantRole,
  groupMembers?: Record<string, ProjectGrantRole>,
): {
  projection: ProjectAccessProjection
  members: Record<string, ProjectGrantRole>
  everyoneRole: ProjectGrantRole
  groupMembers: Record<string, ProjectGrantRole>
} {
  return {
    projection: next,
    members: next === 'author' ? {} : members,
    everyoneRole: next === 'all' && current !== 'all' ? 'viewer' : everyoneRole,
    // Группы — как пользователи: «только автору» снимает список, остальные
    // проекции держат черновик (в «всем» его очистит сборка тела).
    groupMembers: next === 'author' ? {} : { ...(groupMembers ?? {}) },
  }
}

/**
 * Тело состояния доступа для сохранения — **полная замена** (PROP-133 §3.1).
 *
 * - «Только автору» — список участников и гранты группам пусты, публикация
 *   снята;
 * - «Только выбранным» — публикация снята, списки участников и групп целиком;
 * - «Всем пользователям» — одна роль для всех; индивидуальные гранты не
 *   уходят (иначе они бы «сужали» роль для отдельных людей).
 *
 * `group_members` присутствует **во всех** ветках: сервер трактует набор
 * как полную замену, поэтому отсутствие поля означало бы «оставить как
 * есть», а пустой объект — «снять все гранты группам».
 *
 * `everyone_role` для режима «всем» по умолчанию `viewer`; `editor` — только
 * явным выбором автора (никогда не включается автоматически).
 */
export function buildProjectAccessBody(
  projection: ProjectAccessProjection,
  members: Record<string, ProjectGrantRole>,
  everyoneRole: ProjectGrantRole = 'viewer',
  groupMembers?: Record<string, ProjectGrantRole>,
): ProjectAccessBody {
  if (projection === 'selected') {
    const list: Record<string, ProjectAccessRole> = {}
    for (const [id, role] of Object.entries(members)) {
      if (!id) continue
      list[id] = role
    }
    const groups: Record<string, ProjectAccessRole> = {}
    for (const [rawName, role] of Object.entries(groupMembers ?? {})) {
      const name = rawName.trim()
      if (!name) continue
      groups[name] = role
    }
    return { members: list, group_members: groups, everyone_role: null }
  }
  if (projection === 'all') {
    return { members: {}, group_members: {}, everyone_role: everyoneRole }
  }
  return { members: {}, group_members: {}, everyone_role: null }
}
