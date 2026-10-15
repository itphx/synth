import { normalize, resolve, isAbsolute, sep } from 'node:path';
import type { SkillInvocation, SkillMeta } from '@itphx/synth-shared';

/**
 * ADR-046 §6.1: `invocation` из двух совместимых флагов.
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
 * ADR-046 §6.2: binding — `agents`/`groups` пусты = все. Непустой binding
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
 * ADR-046 §3.2/§12: полный набор требуемых capabilities — `requires_capabilities`
 * ∪ expand(`requires_toolsets` через `config.skills.toolsets`).
 */
export function expandRequiredCapabilities(
  meta: Pick<SkillMeta, 'requiresCapabilities' | 'requiresToolsets'>,
  toolsets?: Record<string, readonly string[]>,
): string[] {
  const set = new Set<string>(meta.requiresCapabilities ?? []);
  for (const name of meta.requiresToolsets ?? []) {
    for (const cap of toolsets?.[name] ?? []) set.add(cap);
  }
  return [...set];
}

/**
 * ADR-046 §6.3: не хватает ли агенту требуемых capabilities. Возвращает список
 * отсутствующих (пусто — доступен). `requires_toolsets` экспандится через
 * `config.skills.toolsets` в capabilities перед проверкой.
 */
export function missingCapabilities(
  meta: Pick<SkillMeta, 'requiresCapabilities' | 'requiresToolsets'>,
  capabilities: readonly string[] | undefined,
  toolsets?: Record<string, readonly string[]>,
): string[] {
  const required = expandRequiredCapabilities(meta, toolsets);
  if (required.length === 0) return [];
  const have = new Set(capabilities ?? []);
  return required.filter((cap) => !have.has(cap));
}

/**
 * ADR-046 §4.5: opt-out по имени, категории или группе — общий помощник для
 * сессионного и системного гейтов.
 */
export function isDisabledInList(
  meta: Pick<SkillMeta, 'name' | 'category' | 'groups'>,
  disabled: readonly string[] | undefined,
): boolean {
  if (!disabled || disabled.length === 0) return false;
  if (disabled.includes(meta.name)) return true;
  if (meta.category && disabled.includes(meta.category)) return true;
  for (const group of meta.groups ?? []) {
    if (disabled.includes(group)) return true;
  }
  return false;
}

/** ADR-046 §4.5: per-session opt-out по имени, категории или группе. */
export function isDisabledBySession(
  meta: Pick<SkillMeta, 'name' | 'category' | 'groups'>,
  sessionDisabled: readonly string[] | undefined,
): boolean {
  return isDisabledInList(meta, sessionDisabled);
}

/**
 * ADR-046 §4.5: системный hard-gate — скилл отключён, если совпал по имени,
 * категории или группе в любой из трёх осей конфигурации.
 */
export function isDisabledBySystem(
  meta: Pick<SkillMeta, 'name' | 'category' | 'groups'>,
  disabled:
    | { categories?: readonly string[]; groups?: readonly string[]; skills?: readonly string[] }
    | undefined,
): boolean {
  if (!disabled) return false;
  return isDisabledInList(meta, disabled.skills)
    || isDisabledInList(meta, disabled.categories)
    || isDisabledInList(meta, disabled.groups);
}

/** Причина, по которой скилл недоступен (уровень гейта). */
export type SkillDisabledReason = 'system' | 'project' | 'session';

/**
 * ADR-046 §4.5: эффективная доступность скилла по scope (без I/O). Единая
 * семантика для каталога, API скоупа и тула `skill`:
 * `systemOn && projectOn && !sessionOff && (seed || sessionOn)`.
 * Причина (приоритет): `system` → `project` → `session`.
 */
export function resolveSkillAvailability(
  meta: Pick<SkillMeta, 'name' | 'category' | 'groups'>,
  scope: import('./types.js').SkillScopeOptions | undefined,
): { enabled: boolean; reason?: SkillDisabledReason } {
  if (!scope) return { enabled: true };
  if (isDisabledBySystem(meta, scope.systemDisabled)) return { enabled: false, reason: 'system' };
  if (scope.projectEnabled && !scope.projectEnabled.includes(meta.name)) {
    return { enabled: false, reason: 'project' };
  }
  if (isDisabledInList(meta, scope.sessionDisabled)) return { enabled: false, reason: 'session' };
  const seeded = scope.defaultOn === undefined ? true : scope.defaultOn.includes(meta.name);
  const sessionOn = scope.sessionEnabled?.includes(meta.name) ?? false;
  if (!seeded && !sessionOn) return { enabled: false, reason: 'session' };
  return { enabled: true };
}

/** ADR-046 §4.4: каталог проекта доверен, если он явно перечислен. */
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
