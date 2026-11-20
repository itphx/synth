import type { PermissionConfig, PermissionRule } from '@itphx/synth-shared';

/** ADR-029: срок ожидания подтверждения `ask` по умолчанию — 5 минут. */
export const DEFAULT_ASK_TIMEOUT_MS = 300_000;

export function emptyPermissionConfig(): PermissionConfig {
  return { rules: {}, askTimeoutMs: DEFAULT_ASK_TIMEOUT_MS };
}

/**
 * ADR-029 (chain-no-copy): `deny`-дополнения **роли** саб-агента.
 *
 * Наследование прав родителя теперь **живое**: правила читаются по цепочке
 * `parentId` в момент проверки (`engine/permission/effective.ts`,
 * `resolveEffectivePermission`), поэтому копии правил родителя здесь больше нет
 * — иначе ребёнок фиксировал бы политику родителя на момент создания и не
 * видел бы ни выданных позже грантов, ни отзывов.
 *
 * Здесь остаются только ограничения роли: `question`/`plan_enter`/`plan_exit`/
 * `task` саб-агенту запрещены (ADR-026/ADR-039 — саб-агент не спрашивает
 * человека и не запускает вложенных детей). Это не родительская политика, а
 * свойство роли, поэтому `deny` живёт в конфиге ребёнка.
 *
 * Правила по конкретным именам тулов имеют приоритет над групповыми и `'*'`,
 * поэтому эти `deny` переопределяют любые `allow`, пришедшие по цепочке.
 *
 * ADR-126 §10: правила `skill` (per-skill allow/deny/ask + glob) приходят
 * саб-агенту по цепочке `parentId` вместе с остальными правилами родителя —
 * собственный `skill`-deny саб-агенту не добавляется (скиллы делегируются
 * через `task`).
 */
export function deriveSubagentPermission(parentConfig?: PermissionConfig): PermissionConfig {
  const rules: Record<string, PermissionRule> = {};
  rules.question = 'deny';
  rules.plan_enter = 'deny';
  rules.plan_exit = 'deny';
  rules.task = 'deny';

  return {
    rules,
    askTimeoutMs: parentConfig?.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
  };
}

/**
 * ADR-029 (chain-no-copy): правила прогона саб-агента — правила, собранные по
 * цепочке `parentId` (`resolveEffectivePermission`), плюс `deny`-дополнения
 * роли. Порядок важен: `deriveSubagentPermission` применяется **после** резолва
 * и добавляет только ограничения роли, не теряя унаследованные правила.
 */
export function applySubagentRoleDenies(base: PermissionConfig): PermissionConfig {
  const role = deriveSubagentPermission(base);
  return {
    rules: { ...base.rules, ...role.rules },
    askTimeoutMs: role.askTimeoutMs,
  };
}
