/**
 * PROP-133 §1: принципал доступа к проекту — пользователь, его роли инстанса
 * и группы.
 *
 * Единая точка сборки принципала для backend-контуров (`routes/projects.ts`,
 * `routes/sessions.ts`, `events/hub.ts`): иначе «кто запрашивает» собирался бы
 * в трёх местах по-разному, а правила доступа разошлись бы (PROP-133 §1).
 *
 * Группы: в Ф1 поля `User.groups` в контракте нет (claim `groups` из IdP —
 * Ф2), поэтому группы читаются **defensively**: поле отсутствует → групп нет
 * (fail-closed). Поле в `User` не добавляется — это задел Ф2.
 */
import type { ProjectPrincipal, User } from '@itphx/synth-shared';

/**
 * Пользователь с группами.
 *
 * Отдельный интерфейс (не изменение `User`): группа — аддитивное поле Ф2,
 * которого в контракте Ф1 ещё нет.
 */
export interface UserWithGroups extends User {
  /** Группы пользователя (Ф2): субъект грантов по группам. */
  groups?: readonly string[];
}

/**
 * PROP-133: группы пользователя.
 *
 * Нет поля / не массив / пусто → `undefined` (групп нет — fail-closed).
 */
export function groupsOf(user: User | null | undefined): readonly string[] | undefined {
  const groups = (user as UserWithGroups | null | undefined)?.groups;
  if (!Array.isArray(groups)) return undefined;
  const named = groups.filter(
    (group): group is string => typeof group === 'string' && group.length > 0,
  );
  return named.length > 0 ? named : undefined;
}

/**
 * PROP-133 §1: принципал доступа к проекту.
 *
 * `userId` — идентификатор пользователя запроса (владелец сессии/проекта);
 * `roles` — глобальные роли инстанса (`ADMIN`/`LEAD` — сквозной обзор);
 * `groups` — группы пользователя (Ф2; нет — `undefined`).
 */
export function projectPrincipalOf(
  user: User | null | undefined,
  userId: string,
  roles?: readonly string[],
): ProjectPrincipal {
  const groups = groupsOf(user);
  return {
    userId,
    roles: roles ?? user?.roles ?? [],
    ...(groups ? { groups } : {}),
  };
}
