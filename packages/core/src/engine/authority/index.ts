/**
 * PROP-108 Ф1: движок Authority-слоя (резолвер решений + отображение тулов на
 * действия/цели).
 *
 * Слой собран из трёх частей:
 * - `actions.ts` — отображение оси тулов на ось действий и целей (мост
 *   миграции Ф1; доменные действия приезжают контентом);
 * - `target.ts` — вывод цели из вызова тула (относительные пути, без
 *   секретов);
 * - `resolve.ts` — резолвер: пересечение осей, решение по паре
 *   «действие × цель», одноразовое подтверждение.
 */
export {
  AUTHORITY_CORE_ACTIONS,
  authorityActionForTool,
  authorityTargetKindForTool,
  isCoreAuthorityAction,
} from './actions.js';
export type { AuthorityCoreAction } from './actions.js';

export { deriveAuthorityTarget } from './target.js';
export type { AuthorityTargetInput, DerivedAuthorityTarget } from './target.js';

export { AuthorityResolver, computeAuthorityApprovalDigest } from './resolve.js';
export type {
  AuthorityApprovalOutcome,
  AuthorityApprovalReason,
  AuthorityAxis,
  AuthorityAxisSource,
  AuthorityDecision,
  AuthorityDecisionEffect,
  AuthorityDecisionReason,
  AuthorityEffective,
  AuthorityResolverOptions,
} from './resolve.js';
