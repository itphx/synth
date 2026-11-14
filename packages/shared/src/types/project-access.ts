/**
 * PROP-133 §1: единая точка истины по доступу к проекту.
 *
 * Модуль **browser-safe**: только типы и чистые функции, без `node:*` и без
 * `zod` (читают и ядро, и UI, и драйвер PostgreSQL).
 *
 * Порядок резолва (первое совпадение выигрывает, дальше не идём) — PROP-133 §1:
 *
 * 1. владелец проекта (`ownerId === userId`) → `owner`;
 * 2. глобальная роль инстанса `ADMIN`/`LEAD` → `owner` (сквозной обзор);
 * 3. пользовательский грант (`members[userId]`) → эта роль;
 * 4. максимальная роль по группам (`groupMembers` среди `groups`) — `owner` >
 *    `editor` > `viewer`;
 * 5. `everyoneRole` (если задан) → эта роль;
 * 6. иначе — доступа нет (`read: false`, `role: null`).
 *
 * `read` = `role !== null`. Неизвестное значение роли в данных (битая запись,
 * легаси) — **fail-closed** в `viewer` (как `normalizeParticipantRole`,
 * ADR-106 Ф4).
 */

import { ProjectRole, type Project } from './project.js';

/** Каноническая роль доступа к проекту (строковое значение). */
export type ProjectAccessRoleValue = 'owner' | 'editor' | 'viewer';

/**
 * PROP-133: роль доступа к проекту; `null` — доступа нет.
 */
export type ProjectAccessRole = ProjectAccessRoleValue | null;

/**
 * PROP-133: кто запрашивает доступ (роль инстанса + группы пользователя).
 */
export interface ProjectPrincipal {
  /** Идентификатор пользователя (владелец сессии/проекта). */
  userId: string;
  /** Глобальные роли инстанса (`ADMIN`/`LEAD` — сквозной обзор). */
  roles?: readonly string[];
  /** Группы пользователя (субъект грантов по группам). */
  groups?: readonly string[];
}

/**
 * PROP-133: читатель списка проектов — пользователь и его группы.
 *
 * Отдельный тип от `ProjectPrincipal`: у «просто читателя списка» нет ролей
 * инстанса (`ADMIN`/`LEAD` получают весь список без аргумента — см. порт
 * `ProjectRepository.list`).
 */
export interface ProjectViewer {
  userId: string;
  groups?: readonly string[];
}

/** PROP-133: решение по доступу к проекту. */
export interface ProjectAccess {
  /** Есть ли право чтения (`role !== null`). */
  read: boolean;
  /** Роль доступа (`null` — доступа нет). */
  role: ProjectAccessRole;
}

/** Глобальные роли инстанса со сквозным обзором (PROP-133 §1, п. 2). */
const ELEVATED_INSTANCE_ROLES = ['ADMIN', 'LEAD'] as const;

/** Вес роли для выбора максимума по группам (`owner` > `editor` > `viewer`). */
const ROLE_RANK: Record<ProjectAccessRoleValue, number> = {
  owner: 3,
  editor: 2,
  viewer: 1,
};

/** Канонические значения ролей → enum `ProjectRole` (для полей `Project`). */
const ROLE_BY_VALUE: Record<ProjectAccessRoleValue, ProjectRole> = {
  owner: ProjectRole.OWNER,
  editor: ProjectRole.EDITOR,
  viewer: ProjectRole.VIEWER,
};

/**
 * PROP-133: нормализация роли доступа — неизвестное значение **fail-closed**
 * (`viewer`, только чтение).
 */
export function normalizeProjectAccessRole(value: unknown): ProjectAccessRoleValue {
  if (value === 'owner' || value === 'editor' || value === 'viewer') return value;
  return 'viewer';
}

/**
 * PROP-133: нормализация карты грантов (пользователь → роль) при чтении.
 *
 * Не-объект → пустая карта; неизвестная роль → `viewer`; пустой ключ
 * отбрасывается.
 */
export function normalizeProjectMemberRoles(value: unknown): Record<string, ProjectRole> {
  const out: Record<string, ProjectRole> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, role] of Object.entries(value as Record<string, unknown>)) {
    if (!key) continue;
    out[key] = ROLE_BY_VALUE[normalizeProjectAccessRole(role)];
  }
  return out;
}

/**
 * PROP-133: нормализация роли «всем пользователям» при чтении.
 *
 * - `undefined` — поле отсутствует (проект не опубликован);
 * - `null` — явное «не опубликован»;
 * - `owner`/`editor`/`viewer` — как есть;
 * - нечто иное (битая запись) — `undefined` (fail-closed: проект **не**
 *   опубликован, доступ для всех не выдаётся).
 */
export function normalizeProjectEveryoneRole(
  value: unknown,
): ProjectRole | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value === 'owner' || value === 'editor' || value === 'viewer') {
    return ROLE_BY_VALUE[value];
  }
  return undefined;
}

/**
 * PROP-133 §1: единый резолвер доступа к проекту.
 *
 * Первое совпадение выигрывает (дальше не идём) — порядок см. в шапке модуля.
 */
export function resolveProjectAccess(
  project: Pick<Project, 'ownerId' | 'members' | 'groupMembers' | 'everyoneRole'>,
  principal: ProjectPrincipal,
): ProjectAccess {
  // 1. Владелец проекта.
  if (project.ownerId && project.ownerId === principal.userId) {
    return { read: true, role: 'owner' };
  }

  // 2. Сквозной обзор (`ADMIN`/`LEAD`) — сравнение без учёта регистра.
  const roles = principal.roles ?? [];
  for (const role of roles) {
    if (typeof role !== 'string') continue;
    const upper = role.trim().toUpperCase();
    if ((ELEVATED_INSTANCE_ROLES as readonly string[]).includes(upper)) {
      return { read: true, role: 'owner' };
    }
  }

  // 3. Пользовательский грант.
  const memberRole = project.members?.[principal.userId];
  if (memberRole !== undefined) {
    return { read: true, role: normalizeProjectAccessRole(memberRole) };
  }

  // 4. Гранты по группам — максимальная роль среди групп пользователя.
  const groups = principal.groups ?? [];
  let groupRole: ProjectAccessRoleValue | null = null;
  for (const group of groups) {
    const granted = project.groupMembers?.[group];
    if (granted === undefined) continue;
    const role = normalizeProjectAccessRole(granted);
    if (groupRole === null || ROLE_RANK[role] > ROLE_RANK[groupRole]) groupRole = role;
  }
  if (groupRole !== null) return { read: true, role: groupRole };

  // 5. Режим «всем пользователям».
  const everyone = project.everyoneRole;
  if (everyone !== undefined && everyone !== null) {
    return { read: true, role: normalizeProjectAccessRole(everyone) };
  }

  // 6. Доступа нет.
  return { read: false, role: null };
}

/**
 * PROP-133: право изменения содержимого проекта — `owner`/`editor`.
 * Грант `viewer` записи не даёт (инвариант 21).
 */
export function canWriteWithProjectRole(role: ProjectAccessRole): boolean {
  return role === 'owner' || role === 'editor';
}

/**
 * PROP-133: право управления доступом к проекту — только `owner`
 * (гранты `viewer`/`editor` записи не дают).
 */
export function canManageWithProjectRole(role: ProjectAccessRole): boolean {
  return role === 'owner';
}
