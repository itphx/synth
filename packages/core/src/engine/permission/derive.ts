import type { PermissionConfig, PermissionRule } from '@itphx/synth-shared';

export const DEFAULT_ASK_TIMEOUT_MS = 30_000;

export function emptyPermissionConfig(): PermissionConfig {
  return { rules: {}, askTimeoutMs: DEFAULT_ASK_TIMEOUT_MS };
}

/**
 * ADR-029: наследование permissions саб-агентами (аналог deriveSubagentSessionPermission
 * из OpenCode). Саб-агент получает правила родительской сессии + блокировку
 * question/plan_enter/plan_exit/task. Правила по конкретным именам тулов имеют
 * приоритет над групповыми и '*', поэтому deny здесь переопределяет любые allow
 * из родительского конфига.
 *
 * ADR-046 §8.1: правила `skill` (per-skill allow/deny/ask + glob) наследуются
 * саб-агентом автоматически вместе с остальными правилами родителя — собственный
 * `skill`-deny саб-агенту не добавляется (скиллы делегируются через `task`).
 */
export function deriveSubagentPermission(parentConfig?: PermissionConfig): PermissionConfig {
  const rules: Record<string, PermissionRule> = {
    ...(parentConfig?.rules ?? {}),
  };
  rules.question = 'deny';
  rules.plan_enter = 'deny';
  rules.plan_exit = 'deny';
  rules.task = 'deny';

  return {
    rules,
    askTimeoutMs: parentConfig?.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
  };
}
