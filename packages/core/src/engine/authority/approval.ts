/**
 * ADR-106 Ф3: покрытие подтверждения — «носитель покрывающего гранта».
 *
 * Ответ на запрос подтверждения принимает **не тот, кто видит сессию**, а тот,
 * чьи полномочия покрывают пару «действие × цель» запроса (ADR-106
 * §«Резолвинг и решение», `approve`; §«Многопользовательская сессия»).
 *
 * Источники полномочий носителя (все — **серверные**, клиенту не доверяем):
 * - **роли инстанса** (`ADMIN`/`LEAD`/`AUDITOR`) — глобальные роли;
 * - **роль в проекте** (`owner`/`editor`/`viewer`) — участник проекта сессии;
 * - **владелец сессии** — подтверждает всё в своей сессии;
 * - **гранты политики инстанса** (роли → гранты, `AuthorityPolicy.roles`) —
 *   доменные роли из контента (ADR-106 §«Доменная нейтральность»).
 *
 * Направление правил — как в ADR-025/ADR-089: чтение доступно участнику,
 * мутация — только тем, кто может её выполнить (`VIEWER` читает, но не
 * мутирует — инвариант 21).
 */
import {
  AUTHORITY_CORE_TARGET_KINDS,
  matchAuthorityTargetPattern,
  type AuthorityGrant,
  type AuthorityPolicy,
  type AuthorityPrincipal,
} from '@itphx/synth-shared';

import { AUTHORITY_CORE_ACTIONS } from './actions.js';
import type { ApprovalBinding, ApprovalCoverageResolver } from '../permission/approval.js';

/** Роль носителя в проекте сессии (значения `ProjectRole`). */
export type ApprovalProjectRole = 'owner' | 'editor' | 'viewer';

/**
 * Профиль носителя подтверждения — **серверные** вычисленные полномочия
 * отвечающего (не данные клиента).
 */
export interface ApprovalResponderProfile {
  /** Аутентифицированный принципал-отвечающий. */
  principal: AuthorityPrincipal;
  /** Роль в проекте сессии (если сессия в проекте). */
  projectRole?: ApprovalProjectRole;
  /** Владелец сессии — подтверждает действия в своей сессии. */
  sessionOwner?: boolean;
  /** Явные гранты принципала (политика/контент). */
  grants?: readonly AuthorityGrant[];
}

/** Резолвер профиля носителя по сессии и принципалу. */
export type ApprovalProfileResolver = (
  sessionId: string,
  responder: AuthorityPrincipal,
) => ApprovalResponderProfile | Promise<ApprovalResponderProfile>;

/** Глобальные роли инстанса, которым доступно подтверждение мутаций. */
const ELEVATED_INSTANCE_ROLES = ['ADMIN', 'LEAD'] as const;

/**
 * Гранты носителя по профилю.
 *
 * - владелец сессии / `owner` / `editor` проекта — все действия ядра на всех
 *   видах целей ядра (может подтвердить то, что способен выполнить);
 * - `viewer` проекта и `AUDITOR` — только чтение;
 * - `ADMIN`/`LEAD` — все действия (сквозной доступ);
 * - роли политики инстанса — их гранты (доменные роли из контента).
 */
export function approvalGrantsForProfile(
  profile: ApprovalResponderProfile,
  policy?: AuthorityPolicy | null,
): AuthorityGrant[] {
  const grants: AuthorityGrant[] = [];
  const roles = profile.principal.roles ?? [];

  // Явные гранты принципала.
  grants.push(...(profile.grants ?? []));

  // Гранты ролей политики инстанса (доменные роли контента).
  for (const role of policy?.roles ?? []) {
    if (!roles.includes(role.id)) continue;
    grants.push(...role.grants);
  }

  const actions = [...AUTHORITY_CORE_ACTIONS, ...(policy?.actions ?? []).map((a) => a.id)];
  const kinds = [...AUTHORITY_CORE_TARGET_KINDS, ...(policy?.targets ?? []).map((t) => t.kind)];

  const full = (): void => {
    for (const action of actions) {
      for (const kind of kinds) {
        grants.push({ action, targetPattern: `${kind}:**`, effect: 'allow' });
      }
    }
  };

  if (profile.sessionOwner === true) full();
  if (profile.projectRole === 'owner' || profile.projectRole === 'editor') full();
  if (roles.some((role) => (ELEVATED_INSTANCE_ROLES as readonly string[]).includes(role))) full();

  // Читатель — только чтение (VIEWER проекта, AUDITOR инстанса).
  const readOnly =
    profile.projectRole === 'viewer' ||
    (roles.includes('AUDITOR') && !roles.some((r) => (ELEVATED_INSTANCE_ROLES as readonly string[]).includes(r)));
  if (readOnly) {
    for (const kind of kinds) {
      grants.push({ action: 'read', targetPattern: `${kind}:**`, effect: 'allow' });
    }
  }

  return grants;
}

/**
 * Покрывает ли профиль носителя пару «действие × цель» запроса.
 *
 * Грант покрывает, если действие совпадает, а шаблон цели совпадает с целью
 * (или с одной из её альтернативных ссылок — абсолютный путь и т. п.).
 */
export function coversApproval(
  profile: ApprovalResponderProfile,
  binding: ApprovalBinding,
  policy?: AuthorityPolicy | null,
  altRefs: readonly string[] = [],
): boolean {
  const grants = approvalGrantsForProfile(profile, policy);
  return grants.some(
    (grant) =>
      (grant.effect === 'allow' || grant.effect === 'ask') &&
      grant.action === binding.action &&
      matchAuthorityTargetPattern(grant.targetPattern, binding.target, altRefs),
  );
}

/**
 * Резолвер покрытия для реестра подтверждений (ADR-106 Ф3).
 *
 * Резолвер профиля обязателен: без него ответ не принимается (fail-closed).
 */
export function createApprovalCoverageResolver(opts: {
  policy?: AuthorityPolicy | null;
  profile: ApprovalProfileResolver;
}): ApprovalCoverageResolver {
  return (sessionId, responder, binding) => {
    const profile = opts.profile(sessionId, responder);
    return Promise.resolve(profile).then((resolved) =>
      coversApproval(resolved, binding, opts.policy ?? null),
    );
  };
}

/** Минимальный срез сессии/проекта для расчёта профиля носителя. */
export interface ApprovalProfileSources {
  /** Владелец сессии (`ownerId`/`userId`). */
  session?: { ownerId?: string; userId?: string } | null;
  /** Проект сессии (владелец + участники). */
  project?: { ownerId?: string; members?: Record<string, string> } | null;
  /** Явные гранты принципала. */
  grants?: readonly AuthorityGrant[];
}

/**
 * Профиль носителя по уже загруженным сессии и проекту (ADR-106 Ф3).
 *
 * Правила:
 * - владелец сессии → подтверждает всё в своей сессии;
 * - `owner`/`editor` проекта → подтверждают мутации в проекте;
 * - `viewer` проекта → только чтение (инвариант 21: read не расширяет права
 *   на изменение);
 * - `ADMIN`/`LEAD` (роли инстанса) → сквозной доступ; `AUDITOR` → чтение.
 */
export function buildApprovalResponderProfile(input: {
  principal: AuthorityPrincipal;
  sources?: ApprovalProfileSources;
}): ApprovalResponderProfile {
  const sources = input.sources ?? {};
  const session = sources.session ?? null;
  const project = sources.project ?? null;
  const userId = input.principal.id;

  const sessionOwner =
    session !== null && (session.ownerId === userId || (session.ownerId ?? session.userId) === userId);

  let projectRole: ApprovalProjectRole | undefined;
  if (project) {
    if (project.ownerId === userId) projectRole = 'owner';
    else {
      const member = project.members?.[userId];
      if (member === 'owner' || member === 'editor' || member === 'viewer') projectRole = member;
    }
  }

  return {
    principal: input.principal,
    ...(projectRole ? { projectRole } : {}),
    ...(sessionOwner ? { sessionOwner: true } : {}),
    ...(sources.grants ? { grants: sources.grants } : {}),
  };
}
