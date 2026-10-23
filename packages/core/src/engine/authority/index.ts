/**
 * ADR-106 Ф1: движок Authority-слоя (резолвер решений + отображение тулов на
 * действия/цели).
 *
 * Слой собран из трёх частей:
 * - `actions.ts` — отображение оси тулов на ось действий и целей (мост
 *   миграции Ф1; доменные действия приезжают контентом);
 * - `target.ts` — вывод цели из вызова тула (относительные пути, без
 *   секретов);
 * - `resolve.ts` — резолвер: пересечение осей, решение по паре
 *   «действие × цель», одноразовое подтверждение;
 * - `compile.ts` — компиляция правил permission-слоя в гранты «действие ×
 *   цель» (таблица совместимости ADR-106: «`PermissionConfig.rules` — …;
 *   компилируется в гранты при чтении»);
 * - `hook.ts` — шов shadow-интеграции (только типы, без побочных эффектов);
 * - `shadow.ts` — shadow-интеграция: решение считается и пишется в журнал,
 *   но **не применяется** (решение прав не меняется).
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

export { compileAuthorityGrantsForTool } from './compile.js';
export type { AuthorityRuleCompilationInput } from './compile.js';

export type {
  AuthorityShadowContext,
  AuthorityShadowHook,
  AuthorityShadowInput,
  AuthorityGateHook,
  AuthorityGateResult,
} from './hook.js';

export { AuthorityGuard } from './guard.js';
export type { AuthorityGuardOptions } from './guard.js';

export { AuthorityShadowRecorder } from './shadow.js';
export type { AuthorityShadowRecorderOptions } from './shadow.js';
