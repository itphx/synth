/**
 * ADR-106 Ф5: активация контента полномочий пакета в политику инстанса.
 *
 * Контент (`provides.authority` пакета) — **декларация**: роли, действия, виды
 * целей и привязки агентов. Он попадает в инстанс **только** после одобрения
 * ADMIN и **не выдаёт права сам себе** (ADR-106 §«Правила безопасности
 * контента»):
 *
 * 1. **Пересечение, а не дарование.** Эффективные гранты роли = гранты пакета
 *    ∩ гранты, разрешённые политикой инстанса. Явный запрет инстанца
 *    (`deny`) — сильнее; область, которую инстанс не разрешает, — не
 *    разрешается и пакетом. Если у инстанса потолок не задан (ось инстанса не
 *    применима) — ограничений нет, и гранты пакета сохраняются.
 * 2. **Trust-floor.** Мутирующие гранты (`write`/`execute`/`commit`/`publish`/
 *    `approve`/`sign`/`delegate` — всё, кроме `read`) активируются только при
 *    доверии ≥ `trusted` (PROP-068 §4.1). Пакет уровня `community` **объявляет**
 *    роли, но **не получает** их мутирующую часть.
 * 3. **Валидация, а не каст.** Неизвестное действие/цель/роль — отказ на
 *    разборе манифеста (`validateAuthorityContent`), до активации дело не
 *    доходит.
 *
 * Модуль — **чистые функции** (без I/O): запись в порт делает вызывающий
 * (`server/routes/packs.ts`), поэтому правила активации тестируются без
 * хранилища.
 */

import {
  isAuthorityMutatingAction,
  matchAuthorityTargetPattern,
  trustLevelRank,
  type AuthorityAction,
  type AuthorityGrant,
  type AuthorityPolicy,
  type AuthorityRole,
  type AuthorityTargetDeclaration,
  type CatalogTrustLevel,
} from '@itphx/synth-shared';

/**
 * Контент пакета, который активируется в инстансе (ADR-106 Ф5).
 *
 * Та же форма, что `provides.authority` в манифесте (`PackAuthorityProvides`),
 * но без привязки к формату манифеста — модуль не знает про `synth.pack`.
 */
export interface PackAuthorityContent {
  /** Объявленные доменные действия. */
  actions: readonly AuthorityAction[];
  /** Роли (именованные наборы грантов). */
  roles: readonly AuthorityRole[];
  /** Виды целей, которые пакет вводит. */
  targets: readonly AuthorityTargetDeclaration[];
  /** Агенты с ролями и потолком. */
  agents: readonly { id: string; roles: readonly string[]; ceiling: readonly string[] }[];
}

/** Причина, по которой элемент контента не активирован. */
export type AuthorityActivationSkipReason =
  /** Мутирующий грант при доверии ниже `trusted` (trust-floor). */
  | 'trust_floor'
  /** Политика инстанса запрещает область гранта (`deny`). */
  | 'instance_deny'
  /** Политика инстанса не разрешает область гранта. */
  | 'instance_not_allowed'
  /** Роль уже объявлена в политике инстанса (политика — источник истины). */
  | 'role_exists'
  /** Агент ссылается на роль, которая не активирована. */
  | 'unknown_role';

/** Что не активировано и почему. */
export interface AuthorityActivationSkip {
  /** Вид элемента контента. */
  kind: 'role' | 'action' | 'target' | 'agent' | 'grant';
  /** id элемента (для гранта — действие). */
  id: string;
  /** Причина (машиночитаемый код). */
  reason: AuthorityActivationSkipReason;
  /** Пояснение (без секретов и сырых путей). */
  detail?: string;
}

/** Что активировано в политике инстанса. */
export interface AuthorityActivatedContent {
  actions: string[];
  roles: string[];
  targets: string[];
  agents: string[];
}

/** Результат активации контента пакета. */
export interface AuthorityActivationResult {
  /** Новая политика инстанса (полная — политика пишется целиком). */
  policy: AuthorityPolicy;
  /** Что активировано. */
  activated: AuthorityActivatedContent;
  /** Что не активировано и почему. */
  skipped: AuthorityActivationSkip[];
}

/** Результат снятия контента пакета. */
export interface AuthorityDeactivationResult {
  /** Новая политика инстанса. */
  policy: AuthorityPolicy;
  /** Снятые роли. */
  removedRoles: string[];
  /** Снятые привязки агентов. */
  removedAgents: string[];
}

/** Порог доверия для мутирующих грантов (PROP-068 §4.1). */
const TRUST_FLOOR: CatalogTrustLevel = 'trusted';

/** true — доверие не ниже порога (`trusted`). */
function trustAllowsMutating(level: CatalogTrustLevel): boolean {
  return trustLevelRank(level) <= trustLevelRank(TRUST_FLOOR);
}

/** Разбирает шаблон цели на вид и ссылку (`path:src/**` → `path` + `src/**`). */
function splitTargetPattern(pattern: string): { kind: string; ref: string } | undefined {
  const idx = pattern.indexOf(':');
  if (idx <= 0) return undefined;
  return { kind: pattern.slice(0, idx), ref: pattern.slice(idx + 1) };
}

/**
 * Покрывает ли шаблон потолка инстанца шаблон гранта пакета.
 *
 * Шаблон потолка — glob по ссылке цели; шаблон гранта — тоже glob. Покрытие
 * оценивается матчером целей (`matchAuthorityTargetPattern`): ссылка гранта
 * проверяется **как есть** (буквальный ref) против glob'а потолка. Поэтому
 * `path:**` покрывает `path:src/**`, а `path:src/**` — **не** покрывает
 * `path:**` (содержание не может расширять потолок инстанца).
 */
function instanceCovers(instancePattern: string, packPattern: string): boolean {
  const instance = splitTargetPattern(instancePattern);
  const pack = splitTargetPattern(packPattern);
  if (!instance || !pack) return false;
  if (instance.kind !== pack.kind) return false;
  return matchAuthorityTargetPattern(instancePattern, { kind: pack.kind, ref: pack.ref });
}

/** Гранты потолка инстанса (все потолки политики — как в резолвере). */
function instanceGrants(policy: AuthorityPolicy): AuthorityGrant[] {
  return policy.ceilings.flatMap((ceiling) => ceiling.grants);
}

/**
 * Пересечение гранта пакета с политикой инстанса.
 *
 * `null` — грант остаётся; иначе — причина, по которой грант отброшен.
 */
function intersectGrantWithInstance(
  grant: AuthorityGrant,
  grants: readonly AuthorityGrant[],
): AuthorityActivationSkipReason | undefined {
  // Потолок инстанса не задан → ось инстанса не применима, ограничений нет.
  if (grants.length === 0) return undefined;
  const matching = grants.filter(
    (instanceGrant) =>
      instanceGrant.action === grant.action &&
      instanceCovers(instanceGrant.targetPattern, grant.targetPattern),
  );
  if (matching.length === 0) return 'instance_not_allowed';
  if (matching.some((instanceGrant) => instanceGrant.effect === 'deny')) return 'instance_deny';
  return undefined;
}

/**
 * Активировать контент пакета в политике инстанса.
 *
 * Политика — **источник истины** для ролей: роль, уже объявленная в
 * инстансе, **не перезаписывается** контентом пакета (`role_exists`).
 * Объявления действий и видов целей добавляются (их нет в потолке — они
 * объявляют, что инстанс знает эти глаголы/виды целей).
 */
export function activatePackAuthority(input: {
  /** Контент пакета (`provides.authority`). */
  content: PackAuthorityContent;
  /** Текущая политика инстанса (`null` — политики нет). */
  policy: AuthorityPolicy | null;
  /** Фактическое доверие пакета (PROP-068 §4.1). */
  trustLevel: CatalogTrustLevel;
}): AuthorityActivationResult {
  const base: AuthorityPolicy = input.policy ?? {
    actions: [],
    roles: [],
    targets: [],
    ceilings: [],
    agents: [],
  };
  const instanceGrantList = instanceGrants(base);
  const mutatingAllowed = trustAllowsMutating(input.trustLevel);

  const skipped: AuthorityActivationSkip[] = [];
  const roles: AuthorityRole[] = [...base.roles];
  const activatedRoles: string[] = [];

  for (const role of input.content.roles) {
    if (base.roles.some((existing) => existing.id === role.id)) {
      skipped.push({
        kind: 'role',
        id: role.id,
        reason: 'role_exists',
        detail: 'роль уже объявлена в политике инстанса — политика не перезаписывается контентом',
      });
      continue;
    }
    const grants: AuthorityGrant[] = [];
    for (const grant of role.grants) {
      if (isAuthorityMutatingAction(grant.action) && !mutatingAllowed) {
        skipped.push({
          kind: 'grant',
          id: grant.action,
          reason: 'trust_floor',
          detail: `мутирующий грант не активирован: доверие «${input.trustLevel}» ниже «${TRUST_FLOOR}»`,
        });
        continue;
      }
      const reason = intersectGrantWithInstance(grant, instanceGrantList);
      if (reason) {
        skipped.push({
          kind: 'grant',
          id: grant.action,
          reason,
          detail:
            reason === 'instance_deny'
              ? 'политика инстанса запрещает эту область'
              : 'политика инстанса не разрешает эту область',
        });
        continue;
      }
      grants.push(grant);
    }
    roles.push({ ...role, grants });
    activatedRoles.push(role.id);
  }

  const actions: AuthorityAction[] = [...base.actions];
  const activatedActions: string[] = [];
  for (const action of input.content.actions) {
    if (actions.some((existing) => existing.id === action.id)) continue;
    actions.push(action);
    activatedActions.push(action.id);
  }

  const targets: AuthorityTargetDeclaration[] = [...base.targets];
  const activatedTargets: string[] = [];
  for (const target of input.content.targets) {
    if (targets.some((existing) => existing.kind === target.kind)) continue;
    targets.push(target);
    activatedTargets.push(target.kind);
  }

  const agents = [...base.agents];
  const activatedAgents: string[] = [];
  for (const agent of input.content.agents) {
    const missing = agent.roles.filter((roleId) => !roles.some((role) => role.id === roleId));
    if (missing.length > 0) {
      skipped.push({
        kind: 'agent',
        id: agent.id,
        reason: 'unknown_role',
        detail: `неизвестная роль: ${missing.join(', ')}`,
      });
      continue;
    }
    const binding = { id: agent.id, roles: [...agent.roles], ceiling: [...agent.ceiling] };
    const index = agents.findIndex((existing) => existing.id === agent.id);
    if (index >= 0) agents[index] = binding;
    else agents.push(binding);
    activatedAgents.push(agent.id);
  }

  return {
    policy: {
      actions,
      roles,
      targets,
      ceilings: base.ceilings,
      agents,
    },
    activated: {
      actions: activatedActions,
      roles: activatedRoles,
      targets: activatedTargets,
      agents: activatedAgents,
    },
    skipped,
  };
}

/**
 * Снять контент пакета из политики инстанса (снятие установки пакета).
 *
 * Убираются **роли** и **привязки агентов**, принесённые пакетом. Объявления
 * действий и видов целей остаются: они не дают прав, а их удаление сломало бы
 * ссылки из других пакетов (и уже активированных ролей).
 *
 * Идемпотентно: снятие отсутствующего пакета/роли — пустая операция. Роли и
 * агенты, которые приносит **другой** установленный пакет, остаются
 * (`keepRoleIds`/`keepAgentIds`).
 */
export function deactivatePackAuthority(input: {
  /** Контент снимаемого пакета. */
  content: PackAuthorityContent;
  /** Текущая политика инстанса. */
  policy: AuthorityPolicy | null;
  /** id ролей, которые остаются (их приносит другой пакет). */
  keepRoleIds?: readonly string[];
  /** id агентов, которые остаются (их приносит другой пакет). */
  keepAgentIds?: readonly string[];
}): AuthorityDeactivationResult {
  const base: AuthorityPolicy = input.policy ?? {
    actions: [],
    roles: [],
    targets: [],
    ceilings: [],
    agents: [],
  };
  const keepRoles = new Set(input.keepRoleIds ?? []);
  const keepAgents = new Set(input.keepAgentIds ?? []);

  const removedRoles: string[] = [];
  const roles = base.roles.filter((role) => {
    const broughtByPack = input.content.roles.some((packRole) => packRole.id === role.id);
    if (!broughtByPack || keepRoles.has(role.id)) return true;
    removedRoles.push(role.id);
    return false;
  });

  const removedAgents: string[] = [];
  const agents = base.agents.filter((agent) => {
    const broughtByPack = input.content.agents.some((packAgent) => packAgent.id === agent.id);
    if (!broughtByPack || keepAgents.has(agent.id)) return true;
    removedAgents.push(agent.id);
    return false;
  });

  return {
    policy: {
      actions: base.actions,
      roles,
      targets: base.targets,
      ceilings: base.ceilings,
      agents,
    },
    removedRoles,
    removedAgents,
  };
}
