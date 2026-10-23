/**
 * ADR-106 Ф4: принципал хода.
 *
 * Принципал фиксируется **при приёме ввода** (постановка сообщения в очередь),
 * а не при исполнении: автор хода не меняется оттого, что ход исполнился позже
 * (ADR-106 §«Инварианты модели», п. 4). Steering (ADR-104) **не создаёт новый
 * ход** — поэтому принципал инъекции не влияет на принципал текущего хода.
 *
 * Модуль — единственное место, где принципал хода выводится из данных
 * (сообщение/сессия). Проверки прав — в резолвере (`resolve.ts`) и guard'е
 * (`guard.ts`); здесь только идентификация.
 */
import type { AuthorityPrincipal, Message, Session } from '@itphx/synth-shared';

import { LOCAL_USER_ID } from '../../server/local-owner.js';

export { LOCAL_USER_ID };

/**
 * Ссылка на принципала (`<вид>:<id>`) — компактная форма для хранения
 * (ADR-106 §«Модель»). Используется в журнале решений и в сравнении
 * принципалов.
 */
export function principalRef(principal: AuthorityPrincipal): string {
  return `${principal.kind}:${principal.id}`;
}

/** Разбор ссылки `<вид>:<id>` обратно в принципала (`undefined` — не наша форма). */
export function parsePrincipalRef(ref: string): AuthorityPrincipal | undefined {
  const idx = ref.indexOf(':');
  if (idx <= 0) return undefined;
  const kind = ref.slice(0, idx);
  const id = ref.slice(idx + 1);
  if (!id) return undefined;
  if (kind !== 'user' && kind !== 'agent' && kind !== 'service' && kind !== 'scheduler' && kind !== 'event') {
    return undefined;
  }
  return { kind, id, roles: [] };
}

/** Один и тот же ли принципал (вид + id; роли не сравниваются). */
export function samePrincipal(
  a: AuthorityPrincipal | undefined | null,
  b: AuthorityPrincipal | undefined | null,
): boolean {
  if (!a || !b) return false;
  return a.kind === b.kind && a.id === b.id;
}

/**
 * Принципал владельца сессии — **совместимый fallback** для старых сообщений и
 * сессий, созданных до Ф4 (принципала на сообщении нет). Вид — `user` (как в
 * прежнем коде permission-слоя), даже если владелец — машинный (`service:*`).
 */
export function sessionOwnerPrincipal(session: Session): AuthorityPrincipal {
  return { kind: 'user', id: session.ownerId ?? session.userId ?? LOCAL_USER_ID, roles: [] };
}

/**
 * Принципал хода: из сообщения (зафиксирован при приёме ввода) → иначе владелец
 * сессии (совместимость). **Не пересчитывается** по текущему владельцу сессии,
 * если принципал уже зафиксирован.
 */
export function resolveTurnPrincipal(
  session: Session,
  message?: Message | null,
): AuthorityPrincipal {
  return message?.principal ?? sessionOwnerPrincipal(session);
}

/**
 * Принципал пользователя по его id. Машинный доступ (service-key, ADR-052) —
 * отдельный вид `service`; id — ключ без префикса `service:`.
 */
export function userPrincipal(userId: string, roles: readonly string[] = []): AuthorityPrincipal {
  if (userId.startsWith('service:')) {
    return { kind: 'service', id: userId.slice('service:'.length), roles: [...roles] };
  }
  return { kind: 'user', id: userId, roles: [...roles] };
}

/**
 * Принципал пользователя по его id. Пустой id (не аутентифицирован) →
 * `undefined` — вызывающий оставляет принципал незаданным (fallback — владелец
 * сессии), чтобы не записать «принципал без носителя».
 */
export function resolveUserPrincipal(
  userId: string | undefined | null,
  roles: readonly string[] = [],
): AuthorityPrincipal | undefined {
  if (!userId) return undefined;
  return userPrincipal(userId, roles);
}

/** Принципал агента (`agent:<id>`) — исполнитель хода от имени агента. */
export function agentPrincipal(agentId: string, roles: readonly string[] = []): AuthorityPrincipal {
  return { kind: 'agent', id: agentId, roles: [...roles] };
}

/** Принципал внешнего источника события (`event:<source>`). */
export function eventPrincipal(source: string, roles: readonly string[] = []): AuthorityPrincipal {
  return { kind: 'event', id: source, roles: [...roles] };
}

/** Принципал шедулера (`scheduler`). */
export function schedulerPrincipal(id = 'cron', roles: readonly string[] = []): AuthorityPrincipal {
  return { kind: 'scheduler', id, roles: [...roles] };
}
