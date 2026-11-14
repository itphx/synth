/**
 * ADR-106 Ф4: участники сессии и потолок хода по роли.
 *
 * Участники сессии — **выводятся**, а не хранятся вручную:
 *
 * - **проектная сессия** — владелец сессии + владелец проекта + участники
 *   проекта (роли проекта: `OWNER`/`EDITOR`/`VIEWER` → `owner`/`editor`/`viewer`);
 * - **личная сессия** — только владелец;
 * - сессия без владельца (legacy) — участников нет (пустой список).
 *
 * Пустой список участников = «потолок по роли не применяется» (прежнее
 * поведение). Непустой список — потолок применяется: `viewer` получает
 * read-only потолок, `editor`/`owner` — обычный. Неизвестная роль или
 * неучастник — **fail-closed** (только чтение).
 *
 * PROP-133 §1: роль **действующего пользователя** в проекте считает единый
 * резолвер доступа (`resolveProjectAccess`) — гранты по группе и режим «всем
 * пользователям» учтены, а перечислять участников по группам не нужно.
 * Список участников (`deriveSessionParticipants`) остаётся прежним — он про
 * отображение.
 *
 * Модуль — единственное место, где участники выводятся и где роль
 * принципала сопоставляется с ролью участника. Проверка прав — в guard'е
 * (`engine/authority/guard.ts`).
 */
import type {
  AuthorityPrincipal,
  Project,
  Session,
  SessionParticipant,
  SessionParticipantRole,
} from '@itphx/synth-shared';

import { normalizeSessionParticipantRole, resolveProjectAccess } from '@itphx/synth-shared';

/** Глобальные роли инстанса со сквозным доступом (как в `approval.ts`). */
const ELEVATED_INSTANCE_ROLES = ['ADMIN', 'LEAD'] as const;

/**
 * Проект, по которому считается роль принципала (PROP-133 §1).
 *
 * Отдельный тип от `Project`: нужны только поля состояния доступа.
 */
export type ProjectAccessSubject = Pick<
  Project,
  'ownerId' | 'members' | 'groupMembers' | 'everyoneRole'
>;

/**
 * Нормализация роли участника: неизвестное значение — **fail-closed**
 * (`viewer`, только чтение).
 */
export function normalizeParticipantRole(role: unknown): SessionParticipantRole {
  return normalizeSessionParticipantRole(role);
}

/**
 * Участники сессии (ADR-106 Ф4).
 *
 * Порядок: явный список сессии → владелец сессии → владелец проекта →
 * участники проекта. Явная роль участника не может понизить владельца
 * сессии/проекта.
 */
export function deriveSessionParticipants(
  session: Pick<Session, 'ownerId' | 'userId' | 'participants'>,
  project?: Pick<Project, 'ownerId' | 'members'> | null,
): SessionParticipant[] {
  const roles = new Map<string, SessionParticipantRole>();

  for (const participant of session.participants ?? []) {
    if (!participant?.userId) continue;
    roles.set(participant.userId, normalizeParticipantRole(participant.role));
  }

  const sessionOwner = session.ownerId ?? session.userId;
  if (sessionOwner) roles.set(sessionOwner, 'owner');

  if (project) {
    if (project.ownerId) roles.set(project.ownerId, 'owner');
    for (const [userId, role] of Object.entries(project.members ?? {})) {
      if (!userId || roles.has(userId)) continue;
      roles.set(userId, normalizeParticipantRole(role));
    }
  }

  return [...roles.entries()].map(([userId, role]) => ({ userId, role }));
}

/**
 * Роль принципала среди участников сессии.
 *
 * - `undefined` — роль не определяется: принципал не участник, участники
 *   неизвестны (пустой список) или принципал не человек (service/event/
 *   scheduler/agent — их права идут от других осей);
 * - `owner`/`editor`/`viewer` — роль участника.
 *
 * PROP-133 §1: если задан проект сессии, роль принципала считает **единый
 * резолвер доступа** (`resolveProjectAccess`) — гранты по группе и режим
 * «всем пользователям» учитываются здесь, а не перечислением участников.
 * Если по проекту доступа нет (пользователь не участник проекта) — прежнее
 * поведение по списку участников сессии.
 */
export function resolveParticipantRole(
  participants: readonly SessionParticipant[] | undefined,
  principal: AuthorityPrincipal | undefined,
  project?: ProjectAccessSubject | null,
  groups?: readonly string[],
): SessionParticipantRole | undefined {
  if (!principal) return undefined;
  // Принципал-человек с глобальной ролью инстанса — сквозной доступ.
  if (principal.roles.some((role) => (ELEVATED_INSTANCE_ROLES as readonly string[]).includes(role))) {
    return 'owner';
  }
  // Машинные принципалы (service/event/scheduler/agent) — не участники:
  // их права определяются scope'ами/ролями политики, а не ролью в сессии.
  if (principal.kind !== 'user') return undefined;
  if (!participants || participants.length === 0) return undefined;
  // PROP-133 §1: роль действующего пользователя в проекте — из резолвера.
  const projectRole = project
    ? resolveProjectAccess(project, {
      userId: principal.id,
      roles: principal.roles,
      ...(groups ? { groups } : {}),
    }).role
    : null;
  if (projectRole) return projectRole;
  const found = participants.find((participant) => participant.userId === principal.id);
  if (!found) {
    // Fail-closed: участник есть, принципал — нет → только чтение.
    return 'viewer';
  }
  return normalizeParticipantRole(found.role);
}
