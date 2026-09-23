import { normalize, resolve, isAbsolute, sep } from 'node:path';
import type { SkillInvocation, SkillMeta } from '@itphx/synth-shared';

/**
 * AD-046 §6.1: `invocation` из двух совместимых флагов.
 */
export function computeInvocation(
  userInvocable: boolean,
  disableModelInvocation: boolean,
): SkillInvocation {
  if (userInvocable && !disableModelInvocation) return 'both';
  if (userInvocable && disableModelInvocation) return 'user';
  if (!userInvocable && !disableModelInvocation) return 'model';
  return 'none';
}

/** Модель может вызвать скилл через core-тул `skill`. */
export function isModelInvocable(invocation: SkillInvocation): boolean {
  return invocation === 'both' || invocation === 'model';
}

/**
 * AD-046 §6.2: binding — `agents`/`groups` пусты = все. Непустой binding
 * матчится по id агента и его группам.
 */
export function matchesBinding(
  meta: Pick<SkillMeta, 'agents' | 'groups'>,
  agent?: { id?: string; groups?: string[] },
): boolean {
  // Нет binding-контекста (agent не передан) — не фильтруем.
  if (!agent) return true;
  const agents = meta.agents ?? [];
  if (agents.length > 0) {
    if (!agent?.id || !agents.includes(agent.id)) return false;
  }
  const groups = meta.groups ?? [];
  if (groups.length > 0) {
    const agentGroups = agent?.groups ?? [];
    if (!groups.some((g) => agentGroups.includes(g))) return false;
  }
  return true;
}

/**
 * AD-046 §6.3: не хватает ли агенту требуемых capabilities. Возвращает список
 * отсутствующих (пусто — доступен).
 */
export function missingCapabilities(
  meta: Pick<SkillMeta, 'requiresCapabilities'>,
  capabilities: readonly string[] | undefined,
): string[] {
  const required = meta.requiresCapabilities ?? [];
  if (required.length === 0) return [];
  const have = new Set(capabilities ?? []);
  return required.filter((cap) => !have.has(cap));
}

/**
 * AD-046 §4.5: per-session opt-out по имени, категории или группе.
 */
export function isDisabledBySession(
  meta: Pick<SkillMeta, 'name' | 'category' | 'groups'>,
  sessionDisabled: readonly string[] | undefined,
): boolean {
  if (!sessionDisabled || sessionDisabled.length === 0) return false;
  if (sessionDisabled.includes(meta.name)) return true;
  if (meta.category && sessionDisabled.includes(meta.category)) return true;
  for (const group of meta.groups ?? []) {
    if (sessionDisabled.includes(group)) return true;
  }
  return false;
}

/** AD-046 §4.4: каталог проекта доверен, если он явно перечислен. */
export function isProjectWorkspaceTrusted(
  projectWorkspace: string,
  trustedProjectDirs: readonly string[],
): boolean {
  const target = normalizeAbs(projectWorkspace);
  return trustedProjectDirs.some((dir) => normalizeAbs(dir) === target);
}

/** Нормализация абсолютного пути без `~` (раскрытие — в discovery). */
function normalizeAbs(p: string): string {
  const abs = isAbsolute(p) ? p : resolve(p);
  const n = normalize(abs);
  return n.length > 1 && n.endsWith(sep) ? n.slice(0, -1) : n;
}
