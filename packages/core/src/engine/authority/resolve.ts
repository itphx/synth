/**
 * PROP-108 Ф1: резолвер решений Authority-слоя.
 *
 * Резолвер — единственное место, где право вычисляется по модели
 * «действие × цель» (PROP-108 §«Точки принуждения»). Правила решения —
 * ровно из документа (PROP-108 §«Резолвинг и решение»):
 *
 * ```ts
 * effective(turn) = grants(principal) ∩ grants(agent)
 *                   ∩ ceiling(session) ∩ ceiling(pack) ∩ policy(instance)
 *
 * decide(turn, action, target):
 *   if !known(action) || !resolved(target)  -> deny('unknown')    // fail-closed
 *   if any(deny matches)                    -> deny('explicit')
 *   if none(allow matches)                  -> deny('no_grant')   // нет гранта — нет права
 *   if any(ask matches) || requireConfirm   -> ask(Approval{...})
 *   return allow
 * ```
 *
 * «Пересечение» реализовано как **согласованная решётка по осям**: каждая
 * применимая ось выносит свой вердикт, а итог — конъюнкция прав:
 *
 * - ось без подходящего гранта → запрет (нет гранта — нет права);
 * - ось с явным `deny` → запрет (запрет сильнее разрешения);
 * - ось с `ask` (или `allow` c `requireConfirm`) → требуется подтверждение;
 * - иначе — все оси разрешили → `allow`.
 *
 * Ни одна ось не может **добавить** право: оси только сужают
 * (PROP-108 §«Инварианты модели», п. 3).
 */
import { createHash } from 'node:crypto';

import {
  AUTHORITY_CORE_TARGET_KINDS,
  matchAuthorityTargetPattern,
  type AuthorityApproval,
  type AuthorityCeiling,
  type AuthorityGrant,
  type AuthorityPolicy,
  type AuthorityPrincipal,
  type AuthorityTarget,
  type AuthorityTurn,
} from '@itphx/synth-shared';

import { isCoreAuthorityAction } from './actions.js';

/** Ось права (источник грантов). */
export type AuthorityAxisSource = 'user' | 'agent' | 'session' | 'pack' | 'instance';

/** Применимая ось с её грантами. */
export interface AuthorityAxis {
  source: AuthorityAxisSource;
  grants: readonly AuthorityGrant[];
}

/** Результат `effective(turn)` — набор применимых осей. */
export interface AuthorityEffective {
  axes: readonly AuthorityAxis[];
}

/** Эффект решения. */
export type AuthorityDecisionEffect = 'allow' | 'ask' | 'deny';

/**
 * Причина решения:
 * - `unknown` — действие или цель неизвестны (fail-closed);
 * - `explicit` — совпал явный запрет (`deny`-грант);
 * - `no_grant` — ни одна ось не дала разрешающего гранта;
 * - `null` — решение «allow»/«ask» (причина не нужна).
 */
export type AuthorityDecisionReason = 'unknown' | 'explicit' | 'no_grant' | null;

/** Решение резолвера. */
export interface AuthorityDecision {
  effect: AuthorityDecisionEffect;
  reason: AuthorityDecisionReason;
  /** Ось, давшая решение (для `deny` — ось с запретом/без гранта). */
  source: AuthorityAxisSource;
  /** Грант, породивший решение (если есть). */
  grant?: AuthorityGrant;
}

/** Причины отказа в подтверждении. */
export type AuthorityApprovalReason =
  | 'ok'
  | 'turn_mismatch'
  | 'already_consumed'
  | 'expired'
  | 'digest_mismatch'
  | 'no_grant';

/** Итог подтверждения. */
export interface AuthorityApprovalOutcome {
  effect: 'allow' | 'deny';
  reason: AuthorityApprovalReason;
  /** Подтверждение, к которому относится решение. */
  approval: AuthorityApproval;
}

/** Опции резолвера. */
export interface AuthorityResolverOptions {
  /**
   * Политика инстанса (ADR-096, порт `AuthorityPolicyRepository`): объявленные
   * роли (из них берутся гранты носителей ролей) и потолок инстанса.
   */
  policy?: AuthorityPolicy | null;
  /**
   * Гранты принципала (ось `user`) — компиляция правил сессии
   * (ADR-029) или явные гранты вызывающего.
   */
  principalGrants?: readonly AuthorityGrant[];
  /**
   * Гранты агента (ось `agent`) — из определения агента/контента пакета.
   */
  agentGrants?: readonly AuthorityGrant[];
  /**
   * Роли агента хода (ось `agent`) — id ролей из `policy.roles`.
   */
  agentRoles?: readonly string[];
  /**
   * Явные гранты по id принципала — используются при проверке права
   * подтверждать (`approve`): «носитель покрывающего гранта».
   */
  principalGrantsById?: Readonly<Record<string, readonly AuthorityGrant[]>>;
  /** Дополнительные известные действия (контент/конфиг). */
  knownActions?: readonly string[];
  /** Дополнительные известные виды целей (контент). */
  knownTargetKinds?: readonly string[];
}

/**
 * Резолвер решений Authority-слоя.
 *
 * Экземпляр **на инстанс/на ход** — состояние (использованные подтверждения)
 * живёт здесь, а не в глобальных синглтонах (ADR-099 п. 24 — без
 * process-глобальных singleton'ов).
 */
export class AuthorityResolver {
  private readonly _options: AuthorityResolverOptions;
  /** Одноразовость подтверждений: id уже использованных подтверждений. */
  private readonly _consumed = new Set<string>();

  constructor(options: AuthorityResolverOptions = {}) {
    this._options = options;
  }

  /** Применимые оси хода (пересечение прав). */
  effective(turn: AuthorityTurn): AuthorityEffective {
    const axes: AuthorityAxis[] = [];

    // Ось `user` — база прав: права принципала. Всегда применима: если у
    // принципала нет грантов — нет и права (нет гранта — нет права).
    axes.push({
      source: 'user',
      grants: [
        ...(this._options.principalGrants ?? []),
        ...this._grantsOfRoles(turn.principal.roles),
        ...this._ceilingGrants(turn, 'user'),
      ],
    });

    // Ось `agent` — права агента хода. Применима, только если агент объявлен
    // (роли/гранты): отсутствие потолка агента означает «ось не применима».
    if (turn.agentId) {
      const agentGrants = [
        ...(this._options.agentGrants ?? []),
        ...this._grantsOfRoles(this._options.agentRoles ?? []),
      ];
      if (agentGrants.length > 0) axes.push({ source: 'agent', grants: agentGrants });
    }

    // Ось `session` — потолок сессии (может быть пустым: пустой потолок
    // запрещает всё — «нет гранта — нет права»).
    const sessionCeiling = this._ceiling(turn, 'session');
    if (sessionCeiling) axes.push({ source: 'session', grants: sessionCeiling.grants });

    // Ось `pack` — потолок пакета (контента).
    const packCeiling = this._ceiling(turn, 'pack');
    if (packCeiling) axes.push({ source: 'pack', grants: packCeiling.grants });

    // Ось `instance` — политика инстанса.
    const instanceGrants = [
      ...this._ceilingGrants(turn, 'instance'),
      ...(this._options.policy?.ceilings ?? []).flatMap((ceiling) => ceiling.grants),
    ];
    const instanceCeiling = this._ceiling(turn, 'instance');
    if (instanceCeiling || (this._options.policy?.ceilings?.length ?? 0) > 0) {
      axes.push({ source: 'instance', grants: instanceGrants });
    }

    return { axes };
  }

  /**
   * Решение по паре «действие × цель».
   *
   * Неизвестное действие или неразрешённая цель → `deny('unknown')`
   * (fail-closed, PROP-108 §«Инварианты модели», п. 1).
   */
  decide(
    turn: AuthorityTurn,
    action: string,
    target: AuthorityTarget,
    altRefs?: readonly string[],
  ): AuthorityDecision {
    if (!this.isKnownAction(action)) {
      return { effect: 'deny', reason: 'unknown', source: 'instance' };
    }
    if (!this.isKnownTargetKind(target.kind)) {
      return { effect: 'deny', reason: 'unknown', source: 'instance' };
    }

    const effective = this.effective(turn);

    let explicitDeny: { axis: AuthorityAxis; grant: AuthorityGrant } | undefined;
    let askAxis: { axis: AuthorityAxis; grant: AuthorityGrant } | undefined;
    let missingAxis: AuthorityAxis | undefined;

    for (const axis of effective.axes) {
      const matching = axis.grants.filter(
        (grant) =>
          grant.action === action &&
          matchAuthorityTargetPattern(grant.targetPattern, target, altRefs),
      );

      const deny = matching.find((grant) => grant.effect === 'deny');
      if (deny) {
        explicitDeny = { axis, grant: deny };
        break;
      }

      const allow = matching.find((grant) => grant.effect === 'allow');
      const ask = matching.find((grant) => grant.effect === 'ask');
      if (!allow && !ask) {
        // Ось без гранта — право не выдаётся («нет гранта — нет права»).
        if (!missingAxis) missingAxis = axis;
        continue;
      }

      // `ask`-грант — условное разрешение: действие можно, но требует
      // подтверждения; `allow` с `requireConfirm` — то же самое.
      const needsAsk = ask !== undefined || allow?.constraints?.requireConfirm === true;
      if (needsAsk && !askAxis) askAxis = { axis, grant: ask ?? allow! };
    }

    if (explicitDeny) {
      return {
        effect: 'deny',
        reason: 'explicit',
        source: explicitDeny.axis.source,
        grant: explicitDeny.grant,
      };
    }
    if (missingAxis) {
      return { effect: 'deny', reason: 'no_grant', source: missingAxis.source };
    }
    if (askAxis) {
      return {
        effect: 'ask',
        reason: null,
        source: askAxis.axis.source,
        grant: askAxis.grant,
      };
    }
    return { effect: 'allow', reason: null, source: 'user' };
  }

  /**
   * Подтверждение решения.
   *
   * Правила (PROP-108 §«Резолвинг и решение», `approve`):
   * 1. подтверждение относится к текущему ходу (`turnId`);
   * 2. отвечает только **носитель покрывающего гранта** — не «любой, кто
   *    видит сессию»;
   * 3. подтверждение **одноразовое**: повторный ответ → отказ.
   */
  approve(
    approval: AuthorityApproval,
    principal: AuthorityPrincipal,
    opts: { turn?: AuthorityTurn; altRefs?: readonly string[] } = {},
  ): AuthorityApprovalOutcome {
    const deny = (reason: AuthorityApprovalReason): AuthorityApprovalOutcome => ({
      effect: 'deny',
      reason,
      approval,
    });

    if (opts.turn && opts.turn.id !== approval.turnId) return deny('turn_mismatch');
    if (this._consumed.has(approval.id)) return deny('already_consumed');
    if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) {
      return deny('expired');
    }
    const expectedDigest = computeAuthorityApprovalDigest({
      turnId: approval.turnId,
      action: approval.action,
      target: approval.target,
    });
    if (approval.digest !== expectedDigest) return deny('digest_mismatch');

    if (!this.coversPrincipal(principal, approval.action, approval.target, opts.altRefs)) {
      return deny('no_grant');
    }

    this._consumed.add(approval.id);
    return { effect: 'allow', reason: 'ok', approval };
  }

  /** Покрывает ли принципал пару «действие × цель» грантом. */
  coversPrincipal(
    principal: AuthorityPrincipal,
    action: string,
    target: AuthorityTarget,
    altRefs?: readonly string[],
  ): boolean {
    const grants = [
      ...this._grantsOfRoles(principal.roles),
      ...(this._options.principalGrantsById?.[principal.id] ?? []),
    ];
    return grants.some(
      (grant) =>
        (grant.effect === 'allow' || grant.effect === 'ask') &&
        grant.action === action &&
        matchAuthorityTargetPattern(grant.targetPattern, target, altRefs),
    );
  }

  /** Известно ли действие инстансу (ядро + контент). */
  isKnownAction(action: string): boolean {
    if (isCoreAuthorityAction(action)) return true;
    if (this._options.knownActions?.includes(action)) return true;
    return (this._options.policy?.actions ?? []).some((declared) => declared.id === action);
  }

  /** Известен ли вид цели инстансу (ядро + контент). */
  isKnownTargetKind(kind: string): boolean {
    if ((AUTHORITY_CORE_TARGET_KINDS as readonly string[]).includes(kind)) return true;
    if (this._options.knownTargetKinds?.includes(kind)) return true;
    return (this._options.policy?.targets ?? []).some((declared) => declared.kind === kind);
  }

  /** Гранты ролей из политики инстанса. */
  private _grantsOfRoles(roles: readonly string[]): AuthorityGrant[] {
    const policyRoles = this._options.policy?.roles ?? [];
    if (roles.length === 0 || policyRoles.length === 0) return [];
    const grants: AuthorityGrant[] = [];
    for (const role of policyRoles) {
      if (!roles.includes(role.id)) continue;
      grants.push(...role.grants);
    }
    return grants;
  }

  /** Потолок хода указанного источника (если задан). */
  private _ceiling(turn: AuthorityTurn, source: AuthorityCeiling['source']): AuthorityCeiling | undefined {
    return turn.ceiling.find((ceiling) => ceiling.source === source);
  }

  /** Гранты потолка хода указанного источника. */
  private _ceilingGrants(turn: AuthorityTurn, source: AuthorityCeiling['source']): AuthorityGrant[] {
    return this._ceiling(turn, source)?.grants ?? [];
  }
}

/**
 * Отпечаток подтверждения (PROP-108 §«Модель»): sha256 от
 * `(ход, действие, цель)`.
 *
 * Защищает от подмены запроса: подтверждение, выданное на одно действие, не
 * подходит для другого. Секретов в отпечатке нет — это необратимый хэш.
 */
export function computeAuthorityApprovalDigest(input: {
  turnId: string;
  action: string;
  target: AuthorityTarget;
}): string {
  const canonical = JSON.stringify({
    turnId: input.turnId,
    action: input.action,
    target: `${input.target.kind}:${input.target.ref}`,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
