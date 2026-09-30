import type { SkillLevel, SkillScope, SkillSummary } from '@itphx/synth-shared';
import type { DiscoveredSkill, SkillCatalogOptions } from './types.js';
import {
  isDisabledBySession,
  isDisabledBySystem,
  isModelInvocable,
  matchesBinding,
  missingCapabilities,
} from './scope.js';

/** Максимальная длина описания строки каталога (AD-046 §5: ~60–100). */
export const CATALOG_DESCRIPTION_MAX = 100;

/**
 * Запись каталога скиллов для системного промпта (AD-046 §5). Тело не входит —
 * progressive disclosure.
 */
export interface ComposerSkillEntry {
  name: string;
  description: string;
  scope: SkillScope;
  level: SkillLevel;
  category?: string;
  /** `false` — не хватает capabilities; виден, но `unavailable` (§6.3). */
  available: boolean;
  unavailableReason?: 'capabilities';
  /** volatile-маркер: явно включён в сессии (§4.5). */
  enabled?: boolean;
  /** volatile-маркер: отключён в сессии (§4.5). */
  disabled?: boolean;
  disabledReason?: 'session';
}

/** Каталог скиллов в промпт: stable (system/project) + volatile (session). */
export interface ComposerSkillsCatalog {
  stable: ComposerSkillEntry[];
  session: ComposerSkillEntry[];
}

export interface BuildSkillCatalogOptions extends SkillCatalogOptions {
  /** AD-046 §8.1: `deny` скрывает скилл из каталога. */
  isDenied?: (name: string) => boolean;
}

/** Сводка найденного скилла (capability-aware, AD-046 §6.3). */
export function toSkillSummary(
  skill: DiscoveredSkill,
  opts?: { capabilities?: readonly string[]; toolsets?: Record<string, readonly string[]> },
): SkillSummary {
  const meta = skill.meta;
  const missing = missingCapabilities(meta, opts?.capabilities, opts?.toolsets);
  return {
    name: skill.name,
    description: meta.description,
    scope: skill.source.scope,
    level: skill.source.level,
    dir: skill.dir,
    invocation: meta.invocation,
    userInvocable: meta.userInvocable,
    modelInvocable: isModelInvocable(meta.invocation),
    ...(meta.category ? { category: meta.category } : {}),
    tags: meta.tags ?? [],
    agents: meta.agents ?? [],
    groups: meta.groups ?? [],
    requiresCapabilities: meta.requiresCapabilities ?? [],
    trusted: skill.trusted,
    available: missing.length === 0,
    ...(missing.length > 0 ? { unavailableReason: 'capabilities' as const } : {}),
  };
}

/**
 * AD-046 §5/§6: каталог скиллов для промпта. Гейты (per-item, opt-in):
 * системный (`systemDisabled`) → проектный (`projectEnabled`) → сессионный
 * opt-out (`sessionDisabled`) → сид/явное включение. `deny` и не-model-invocable
 * — исключаются; не привязанные к агенту (binding) — исключаются.
 *
 * Тиры: снапшот (`defaultOn`) → `stable`; явное `sessionEnabled` → session-tier
 * `{enabled:true}`; opt-out → session-tier `{disabled:true}`; отключённые
 * системой/проектом — исключаются (причина видна через API скоупа).
 */
export function buildSkillCatalog(
  skills: readonly DiscoveredSkill[],
  opts: BuildSkillCatalogOptions,
): ComposerSkillsCatalog {
  const stable: ComposerSkillEntry[] = [];
  const session: ComposerSkillEntry[] = [];
  // Проект без настроек — гейт не задан (legacy, доступно всё).
  const projectGate = opts.projectEnabled ? new Set(opts.projectEnabled) : null;
  // `defaultOn` не передан — legacy-режим (без снапшота): доступны все.
  const seeded = (name: string): boolean =>
    opts.defaultOn === undefined ? true : opts.defaultOn.includes(name);

  for (const skill of skills) {
    // AD-046 §4.4: недоверенные проектные скиллы не грузятся.
    if (!skill.trusted) continue;
    const meta = skill.meta;
    if (!isModelInvocable(meta.invocation)) continue;
    if (!matchesBinding(meta, opts.agent)) continue;
    if (opts.isDenied?.(skill.name)) continue;
    // Системный/проектный hard-gate — скилл исключается из каталога.
    if (isDisabledBySystem(meta, opts.systemDisabled)) continue;
    if (projectGate && !projectGate.has(skill.name)) continue;

    const disabled = isDisabledBySession(meta, opts.sessionDisabled);
    const missing = missingCapabilities(meta, opts.capabilities, opts.toolsets);
    const base: ComposerSkillEntry = {
      name: skill.name,
      description: meta.description,
      scope: skill.source.scope,
      level: skill.source.level,
      ...(meta.category ? { category: meta.category } : {}),
      available: missing.length === 0 && !disabled,
    };

    if (disabled) {
      session.push({ ...base, disabled: true, disabledReason: 'session' });
      continue;
    }
    if (opts.sessionEnabled?.includes(skill.name)) {
      session.push({ ...base, enabled: true });
      continue;
    }
    if (missing.length > 0) {
      session.push({ ...base, available: false, unavailableReason: 'capabilities' });
      continue;
    }
    // Opt-in: без снапшота и без явного включения скилл недоступен.
    if (seeded(skill.name)) stable.push(base);
  }

  return { stable, session };
}

function truncateDescription(description: string): string {
  const oneLine = description.replace(/\s+/g, ' ').trim();
  return oneLine.length > CATALOG_DESCRIPTION_MAX
    ? `${oneLine.slice(0, CATALOG_DESCRIPTION_MAX - 1)}…`
    : oneLine;
}

/**
 * AD-046 §5: текстовый блок каталога. Формат строки: `name` + обрезанный
 * `description` + маркеры (`unavailable`/`disabled`/`enabled`).
 */
export function formatSkillsCatalogBlock(
  entries: readonly ComposerSkillEntry[],
  lang: string,
  kind: 'stable' | 'session' = 'stable',
): string {
  if (entries.length === 0) return '';
  const en = lang === 'en';
  const header = kind === 'session'
    ? (en ? '[SKILLS: SESSION]' : '[СКИЛЛЫ: СЕССИЯ]')
    : (en ? '[SKILLS]' : '[СКИЛЛЫ]');
  const intro = en
    ? 'Available skills — call the `skill` tool with the name to load full instructions:'
    : 'Доступные скиллы — вызови тул `skill` с именем, чтобы загрузить полные инструкции:';

  const lines: string[] = [header, '', intro];
  for (const entry of entries) {
    const markers: string[] = [];
    if (entry.unavailableReason === 'capabilities') {
      markers.push(en
        ? 'unavailable: requires capabilities — delegate via `task`'
        : 'недоступен: нужны capabilities — делегируй через `task`');
    }
    if (entry.disabled) {
      markers.push(en ? 'disabled in session' : 'отключён в сессии');
    }
    if (entry.enabled) {
      markers.push(en ? 'enabled in session' : 'включён в сессии');
    }
    const suffix = markers.length > 0 ? ` (${markers.join('; ')})` : '';
    lines.push(`- ${entry.name}: ${truncateDescription(entry.description)}${suffix}`);
  }
  return lines.join('\n');
}
