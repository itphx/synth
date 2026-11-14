/**
 * PROP-133 §1: принципал доступа к проекту — пользователь, его роли инстанса
 * и группы.
 *
 * Единая точка сборки принципала для backend-контуров (`routes/projects.ts`,
 * `routes/sessions.ts`, `events/hub.ts`): иначе «кто запрашивает» собирался бы
 * в трёх местах по-разному, а правила доступа разошлись бы (PROP-133 §1).
 *
 * Группы (ADR-140 Ф2): источник — claim `groups` из IdP, доставленный в
 * `User.groups` (снимок на момент логина). Поле читается напрямую; нет поля /
 * не массив / пусто → групп нет (fail-closed).
 */
import type { ProjectPrincipal, User } from '@itphx/synth-shared';

/**
 * ADR-140: группы пользователя.
 *
 * Нет поля / не массив / пусто → `undefined` (групп нет — fail-closed).
 */
export function groupsOf(user: User | null | undefined): readonly string[] | undefined {
  const groups = user?.groups;
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
 * `groups` — группы пользователя (ADR-140; нет — `undefined`).
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
