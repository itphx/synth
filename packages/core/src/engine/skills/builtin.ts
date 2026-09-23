import { join } from 'node:path';
import { ToolCapability } from '@itphx/synth-shared';
import type { SkillMeta } from '@itphx/synth-shared';
import type { DiscoveredSkill, SkillSource } from './types.js';

/**
 * AD-046 §9.5: встроенные (builtin) скиллы — объявлены в коде (TS-константа),
 * без нового asset-каталога (AD-038). Не сидятся на ФС: `dir` — синтетический
 * маркер, читать его не нужно (supporting-файлов нет).
 */
export const BUILTIN_SKILLS_DIRNAME = '.builtin';

/** Имя встроенного мета-скилла-скаффолдера. */
export const SKILL_CREATOR_NAME = 'skill-creator';

/**
 * Синтетический каталог-источник builtin-скиллов: system-уровень, `trusted: true`.
 * Идёт **первым** в discovery, поэтому не перекрывается project/instance.
 */
export const BUILTIN_SOURCE: SkillSource = {
  scope: 'instance',
  level: 'system',
  origin: 'instance',
  dir: BUILTIN_SKILLS_DIRNAME,
  trusted: true,
};

/** Тело встроенного `skill-creator` (модель-facing англоязычная инструкция). */
const SKILL_CREATOR_BODY = `# Skill Creator

Create or update a project skill: a directory with a \`SKILL.md\` and optional
supporting files, loaded on demand via the \`skill\` tool or a \`/name\` command.

## When to use
- The user asks to create, scaffold, or update a skill.
- A repeatable procedure should be captured so the agent can load it later.

## Location and naming
- Project skills live in \`{project.workspace}/.synth/skills/<name>/SKILL.md\`.
- \`<name>\`: lowercase kebab-case, 1-64 chars, matching \`^[a-z0-9]+(-[a-z0-9]+)*$\`,
  and it MUST equal the directory name.
- Project skills load only from a trusted workspace (\`skills.trustedProjectDirs\`);
  otherwise they stay visible but untrusted.
- Instance skills are managed only through the admin API/UI
  (\`POST /api/v2/skills\`) — never write \`{dataDir}/skills\` directly.

## Required frontmatter
---
name: <name>
description: <one-line summary, <= 1024 chars>
---
\`name\` and \`description\` are mandatory. Optional Claude Code keys:
\`license\`, \`compatibility\`, \`allowed-tools\`, \`when_to_use\`, \`model\`,
\`agent\`, \`argument-hint\`, \`user-invocable\`, \`disable-model-invocation\`.

## Optional \`metadata.synth.*\`
- \`tags\`, \`category\`, \`related_skills\`
- \`requires_capabilities\`: e.g. \`[file_read, file_write]\`
- \`requires_toolsets\`: named sets from config (\`git\`, \`web\`, ...)
- \`agents\` / \`groups\`: binding; empty = all
- \`trigger\`: \`manual\` | \`auto\`
- \`command\`: \`/\`-command name, if different from \`name\`
- \`mode\`: \`plan\` | \`act\` | \`any\`

## Body structure
1. \`## When to use\` — trigger conditions.
2. \`## Steps\` — numbered, imperative instructions.
3. \`## Supporting files\` — relative paths (\`references/\`, \`scripts/\`, \`assets/\`).

## Supporting files
Put extra content next to \`SKILL.md\` and reference it from the body by relative
path; relative paths resolve from the skill base directory.

## Verify
- Confirm the skill appears in \`/skills\` and \`GET /api/v2/skills\`.
- Ensure \`name\` matches the directory and the frontmatter parses.

## Safety
- Do NOT overwrite an existing \`SKILL.md\` without explicit user confirmation.
- Ask which capabilities/tools the skill needs before writing.`;

/** `SkillMeta` встроенного `skill-creator`. */
export function buildSkillCreatorMeta(): SkillMeta {
  return {
    name: SKILL_CREATOR_NAME,
    description: 'Scaffold a new project skill (SKILL.md) with correct frontmatter and structure',
    userInvocable: true,
    disableModelInvocation: false,
    invocation: 'both',
    trigger: 'auto',
    command: SKILL_CREATOR_NAME,
    category: 'meta',
    tags: ['skills', 'meta', 'scaffold'],
    requiresCapabilities: [ToolCapability.FILE_READ, ToolCapability.FILE_WRITE],
  };
}

/**
 * Собирает встроенные скиллы. `dir`/`file` — синтетические пути (на ФС нет);
 * `mtimeMs: 0` — builtin вне mtime-инвалидации watcher'а.
 */
export function buildBuiltinSkills(opts: { dataDir?: string } = {}): DiscoveredSkill[] {
  const root = opts.dataDir ?? '.';
  const dir = join(root, BUILTIN_SKILLS_DIRNAME, SKILL_CREATOR_NAME);
  return [{
    name: SKILL_CREATOR_NAME,
    meta: buildSkillCreatorMeta(),
    body: SKILL_CREATOR_BODY,
    dir,
    file: join(dir, 'SKILL.md'),
    source: BUILTIN_SOURCE,
    trusted: true,
    mtimeMs: 0,
  }];
}
