import { join } from 'node:path';
import { ToolCapability } from '@itphx/synth-shared';
import type { SkillMeta } from '@itphx/synth-shared';
import type { DiscoveredSkill, SkillSource } from './types.js';

/**
 * ADR-046 §9.5: встроенные (builtin) скиллы — объявлены в коде (TS-константа),
 * без нового asset-каталога (ADR-038). Не сидятся на ФС: `dir` — синтетический
 * маркер, читать его не нужно (supporting-файлов нет).
 */
export const BUILTIN_SKILLS_DIRNAME = '.builtin';

/** Имя встроенного мета-скилла-скаффолдера. */
export const SKILL_CREATOR_NAME = 'skill-creator';

/**
 * ADR-069 §8.2: имя встроенного скилла генерации/аудита проектных инструкций.
 * Slash-команда — `agents-md`, а не `init`: имя `init` занято встроенной
 * командой `/init` (ADR-069 §8.1), а `resolveCatalog` при коллизии эмитит
 * диагностику `shadowed` и скилл был бы недостижим.
 */
export const SYNTH_AGENTS_MD_NAME = 'synth-agents-md';

/** Slash-команда скилла `synth-agents-md` (без конфликта с builtin `/init`). */
export const SYNTH_AGENTS_MD_COMMAND = 'agents-md';

/**
 * PROP-032 (W5): имя встроенного скилла-руководства по восстановлению
 * недоступного хранилища (деградированный режим). Read-only по природе — доступен
 * и в обычном режиме (профилактика/диагностика), и в аварийном.
 */
export const SYNTH_STORAGE_RECOVERY_NAME = 'synth-storage-recovery';

/** Slash-команда скилла `synth-storage-recovery`. */
export const SYNTH_STORAGE_RECOVERY_COMMAND = 'storage-recovery';

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

/** Тело встроенного `synth-agents-md` (модель-facing англоязычная инструкция). */
const SYNTH_AGENTS_MD_BODY = `# AGENTS.md

Create, update and audit \`AGENTS.md\` — repository project instructions that
Synth loads automatically (ADR-069).

## When to use
- The user runs \`/init\` or \`/${SYNTH_AGENTS_MD_COMMAND}\`.
- Project instructions need to be created, refreshed or reviewed.

## Steps
1. Investigate the repository: \`README*\`, manifests, workspace config,
   build/test/lint/typecheck configuration, CI workflows, existing instruction
   files (\`AGENTS.md\`, \`CLAUDE.md\`, \`.cursor/rules/\`) and real entrypoints.
2. Extract only high-signal, repository-specific facts. If docs conflict with
   config or scripts, trust the executable source.
3. Ask questions in plain text (one short batch) only when the repository cannot
   answer something important.
4. Generate or update \`AGENTS.md\` in the workspace root: short sections and
   bullets, exact commands, non-obvious architecture, local conventions. If the
   file already exists, improve it in place and keep proven useful guidance.
5. Audit: flag stale commands/paths, duplicates and unverified claims; state
   what could not be verified.

## Principles
- Every line must answer: "Would the agent get this wrong without it?" If not,
  remove it.
- Executable sources of truth beat prose.
- Compactness beats completeness — reference other files instead of copying.

## Verify
- Confirm the file exists at \`AGENTS.md\` and is valid Markdown.
- Confirm commands mentioned in it actually exist in package/CI config.
- Note that project instructions load only from a trusted workspace.`;

/** `SkillMeta` встроенного `synth-agents-md` (ADR-069 §8.2). */
export function buildSynthAgentsMdMeta(): SkillMeta {
  return {
    name: SYNTH_AGENTS_MD_NAME,
    description: 'Создаёт, обновляет и аудирует AGENTS.md — проектные инструкции для агентов',
    userInvocable: true,
    disableModelInvocation: false,
    invocation: 'both',
    trigger: 'manual',
    command: SYNTH_AGENTS_MD_COMMAND,
    category: 'meta',
    tags: [SYNTH_AGENTS_MD_NAME, 'onboarding', 'instructions', 'docs'],
    relatedSkills: [SKILL_CREATOR_NAME],
    requiresCapabilities: [
      ToolCapability.FILE_READ,
      ToolCapability.SEARCH,
      ToolCapability.FILE_WRITE,
    ],
    scope: 'instance',
    mode: 'any',
  };
}

/** Тело встроенного `synth-storage-recovery` (модель-facing runbook, PROP-032 W5). */
const SYNTH_STORAGE_RECOVERY_BODY = `# Storage recovery (degraded mode)

Runbook for restoring Synth storage: the configured backend (\`storage.backend=postgres\`)
is unreachable, so the service started on a **file fallback** in strict **read-only**
(degraded mode). No auto-recovery exists — recovery requires a **restart** after the
underlying problem is fixed.

## 1. Diagnose
- \`GET /api/v2/health\` — \`status: "degraded"\` plus \`storage.{backend, fallbackDir, reason, since}\`.
- \`GET /api/v2/storage/status\` — probes the original backend and reports
  \`recovery.connection.ok\` + \`recovery.restartRequired: true\`. Use it to tell
  "DB is back" (needs restart) from "DB is still down".
- \`synth doctor\` — instance health (data dir, schema, storage backend probe).
- Server log — the loud \`[storage] PostgreSQL недоступен … \` block entered at startup
  contains the concrete failure reason (network/credentials/schema).

## 2. Classify the cause
- **Network / DNS / port** — the DB host/port is unreachable (firewall, container down,
  wrong \`SYNTH_POSTGRES_HOST\`/\`SYNTH_POSTGRES_PORT\`).
- **Credentials** — authentication failed (\`SYNTH_POSTGRES_PASSWORD\` / \`{dataDir}/secrets/postgres-password\`).
- **Schema** — driver failed to apply/assert migrations (\`storage.backend=postgres\`, DBA mode \`assert\`).
- **Capacity / locked** — DB out of connections or schema locked by another process.

## 3. Recover (pick per cause)
- Network/credentials: fix the config/secret/network, then verify with
  \`GET /api/v2/storage/status\` (probe \`ok: true\`) — **a restart is still required**
  (the storage context is bound at startup).
- Schema: apply migrations against the DB (\`synth migrate\`) and restart.
- Data loss: restore from a \`synth backup\` dump, then restart.
- Never copy data out of the file fallback back into the DB by hand — the fallback is
  diagnostic-only and its contents are not migrated.

## 4. What stays available in degraded mode
- READ requests and diagnostics (\`GET /health\`, \`GET /api/v2/storage/status\`, maintenance
  doctor/backup/export). Mutating requests (\`POST/PUT/PATCH/DELETE\`) are rejected with
  \`503 STORAGE_DEGRADED_READONLY\`; non-administrators get \`503 STORAGE_DEGRADED\`.
- The tool registry exposes only safe tools (\`skill\`, \`web_fetch\`, \`web_search\`).

## 5. Return to normal
1. Confirm the probe: \`GET /api/v2/storage/status\` → \`recovery.connection.ok: true\`.
2. Restart the service (auto-recovery is intentionally disabled — live backend swap is
   risky). On startup the driver reconnects to PostgreSQL with the configured schema mode.

## Verify
- \`GET /api/v2/health\` → \`status: "healthy"\` (no \`storage\` block).
- \`GET /api/v2/storage/status\` → \`status: "healthy"\`.`;

/** `SkillMeta` встроенного `synth-storage-recovery` (PROP-032 W5). */
export function buildSynthStorageRecoveryMeta(): SkillMeta {
  return {
    name: SYNTH_STORAGE_RECOVERY_NAME,
    description:
      'Восстановление хранилища: диагностика и лечение деградированного режима (backend недоступен, read-only фоллбек)',
    userInvocable: true,
    disableModelInvocation: false,
    invocation: 'both',
    trigger: 'manual',
    command: SYNTH_STORAGE_RECOVERY_COMMAND,
    category: 'ops',
    tags: [SYNTH_STORAGE_RECOVERY_NAME, 'storage', 'postgres', 'recovery', 'degraded', 'runbook'],
    relatedSkills: [SYNTH_AGENTS_MD_NAME],
    // Read-only по природе (диагностика через HTTP/CLI) — не требует файловых capabilities.
    requiresCapabilities: [],
    scope: 'instance',
    mode: 'any',
  };
}

/**
 * Собирает встроенные скиллы. `dir`/`file` — синтетические пути (на ФС нет);
 * `mtimeMs: 0` — builtin вне mtime-инвалидации watcher'а.
 */
export function buildBuiltinSkills(opts: { dataDir?: string } = {}): DiscoveredSkill[] {
  const root = opts.dataDir ?? '.';
  const build = (
    name: string,
    meta: SkillMeta,
    body: string,
  ): DiscoveredSkill => {
    const dir = join(root, BUILTIN_SKILLS_DIRNAME, name);
    return {
      name,
      meta,
      body,
      dir,
      file: join(dir, 'SKILL.md'),
      source: BUILTIN_SOURCE,
      trusted: true,
      mtimeMs: 0,
    };
  };
  return [
    build(SKILL_CREATOR_NAME, buildSkillCreatorMeta(), SKILL_CREATOR_BODY),
    build(SYNTH_AGENTS_MD_NAME, buildSynthAgentsMdMeta(), SYNTH_AGENTS_MD_BODY),
    build(SYNTH_STORAGE_RECOVERY_NAME, buildSynthStorageRecoveryMeta(), SYNTH_STORAGE_RECOVERY_BODY),
  ];
}
