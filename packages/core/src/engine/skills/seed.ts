import type { ProjectMcpSettings, ProjectSkillSettings, SkillsDisabledRequest } from '@itphx/synth-shared';
import type { SkillService } from './service.js';
import { isDisabledBySystem } from './scope.js';

/**
 * AD-046 §4.5 / AD-071 §2.4: сид скоупа НОВОГО проекта.
 *
 * Скиллы — все обнаруженные, кроме системного hard-gate (`skillsDisabled`) и
 * `disabledForNewProjects` (админский сид). `defaultOn` = `enabled`.
 * MCP — серверы с `enabledByDefault` (instance-сид).
 */

/** Системный сид скиллов нового проекта (снимок). */
export async function resolveProjectSkillSeed(
  skillService: SkillService,
  disabledForNewProjects: SkillsDisabledRequest | undefined,
  projectWorkspace?: string,
): Promise<ProjectSkillSettings> {
  const { skills } = await skillService.listSummaries({ projectWorkspace });
  const enabled = skills
    .filter((s) => !isDisabledBySystem(
      { name: s.name, category: s.category, groups: s.groups },
      disabledForNewProjects,
    ))
    .map((s) => s.name);
  return { enabled, defaultOn: [...enabled] };
}

/** Системный сид MCP нового проекта: серверы `enabledByDefault`. */
export function resolveProjectMcpSeed(defaultServers: readonly string[]): ProjectMcpSettings {
  const enabled = [...defaultServers];
  return { enabled, defaultOn: [...enabled] };
}
