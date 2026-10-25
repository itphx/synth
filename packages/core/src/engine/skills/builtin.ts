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
 * ADR-098 (W5): имя встроенного скилла-руководства по восстановлению
 * недоступного хранилища (деградированный режим). Read-only по природе — доступен
 * и в обычном режиме (профилактика/диагностика), и в аварийном.
 */
export const SYNTH_STORAGE_RECOVERY_NAME = 'synth-storage-recovery';

/** Slash-команда скилла `synth-storage-recovery`. */
export const SYNTH_STORAGE_RECOVERY_COMMAND = 'storage-recovery';

/**
 * ADR-101: имя встроенного скилла-руководства по пайплайнам проекта
 * (спецификация → публикация версии → прогон → журнал). Команда `pipelines`
 * не занята ни встроенной командой (`/help`, `/skills`, `/commands`,
 * `/summary`, `/init`), ни другим скиллом — иначе `resolveCatalog` эмитил бы
 * диагностику `shadowed` и скилл был бы недостижим.
 */
export const SYNTH_PIPELINES_NAME = 'synth-pipelines';

/** Slash-команда скилла `synth-pipelines`. */
export const SYNTH_PIPELINES_COMMAND = 'pipelines';

/**
 * ADR-051: имя встроенного скилла-руководства по расписаниям планировщика
 * (cron/интервал → цель). Команда `schedules` свободна — коллизий с
 * встроенными командами и другими скиллами нет.
 */
export const SYNTH_SCHEDULES_NAME = 'synth-schedules';

/** Slash-команда скилла `synth-schedules`. */
export const SYNTH_SCHEDULES_COMMAND = 'schedules';

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

/** Тело встроенного `synth-storage-recovery` (модель-facing runbook, ADR-098 W5). */
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

/** `SkillMeta` встроенного `synth-storage-recovery` (ADR-098 W5). */
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
 * Тело встроенного `synth-pipelines` (модель-facing англоязычная инструкция,
 * ADR-101).
 */
const SYNTH_PIPELINES_BODY = `# Pipelines

Work with the pipelines of the current project: author the specification, publish a
version, run it and read the execution journal.

## When to use
- The user asks to create, change, publish, run or debug a pipeline of this project.
- The user asks which pipelines exist or why a run failed.
- A repeatable multi-step procedure should become a pipeline.

## Tools
- \`pipeline_list\` — pipelines of the current project (draft and published versions).
- \`pipeline_get\` — one pipeline: draft specification, published version, draft problems.
- \`pipeline_save\` — create or replace the **draft** specification.
- \`pipeline_publish\` — publish the draft as an immutable version.
- \`pipeline_delete\` — delete a pipeline (its runs stay readable).
- \`pipeline_run\` — start a run of a **published** version.
- \`pipeline_run_status\` — one run: status, current node, error, journal.
- \`pipeline_run_list\` — runs of the project (filter by pipeline id or status).
- \`pipeline_run_resume\` — approve or reject a step that waits for a human.
- \`pipeline_run_cancel\` — cancel a run that executes or waits.
- \`pipeline_templates\` — pipeline templates of the instance (no project needed).
- \`pipeline_instantiate\` — copy an instance template into the project as a draft.

## Steps
1. Look around first: \`pipeline_list\` for the pipelines of the project and
   \`pipeline_templates\` for the ready-made ones. Never invent a pipeline id — read it
   with \`pipeline_get\`.
2. Edit the draft: \`pipeline_save\` with the full \`spec\` (the format is \`PipelineSpec\` —
   see \`docs/PIPELINES.md\` §2.2–§2.5). Saving **does not** change the version: it
   replaces the draft only.
3. Check the draft with \`pipeline_get\` — it reports the problems it found.
4. Publish: \`pipeline_publish\`. That freezes the current draft as a published version
   and opens the next draft. Publishing again without changes is idempotent — no extra
   version appears.
5. Run: \`pipeline_run\`. Only a **published** version can run. The run continues in the
   background — the answer carries the run id, not the result.
6. Follow it: \`pipeline_run_status\` for one run (status, current node, journal) and
   \`pipeline_run_list\` for the history of the project.
7. A run in status \`awaiting_human\` waits for a decision: \`pipeline_run_resume\` with
   \`approved\` (plus optional \`output\` and \`comment\`). A run that must stop:
   \`pipeline_run_cancel\`.
8. Remove: \`pipeline_delete\` — the pipeline is gone, its runs remain readable.

## Rules
- The project comes from the session; there is no \`project_id\` argument. A pipeline of
  another project is reported as not found.
- Mutating tools (\`pipeline_save\`, \`pipeline_publish\`, \`pipeline_delete\`,
  \`pipeline_run\`, \`pipeline_run_resume\`, \`pipeline_run_cancel\`,
  \`pipeline_instantiate\`) need write access to the project: a \`VIEWER\` member may only
  read. In \`plan\` mode mutations are blocked.
- Only a published version can run — a pipeline without one is refused.
- A pipeline has at most one active run: a second \`pipeline_run\` while the first one is
  still running is refused (\`already_running\`). Wait for it or cancel it first.
- \`pipeline_run_resume\` and \`pipeline_run_cancel\` need write access to the project too.
- \`pipeline_instantiate\` copies a template as a **draft** — it still has to be published
  before it can run. With \`ensure: true\` the call is idempotent: an existing copy of the
  same template is returned instead of a second one. A legacy template that cannot be
  converted is refused with the list of problems — report them, do not work around them
  silently.
- \`pipeline_templates\` is an instance-level resource: it works without a project.

## Typical scenario — create a pipeline from a template, fix a step, publish, run, show the journal
1. \`pipeline_templates\` — pick the template id.
2. \`pipeline_instantiate\` with \`{template_id, ensure: true}\` — take the pipeline id of
   the copy.
3. \`pipeline_get\` — read the draft specification.
4. \`pipeline_save\` with \`{pipeline_id, spec: …}\` — apply the change to the draft.
5. \`pipeline_publish\` — the change becomes a published version.
6. \`pipeline_run\` with \`{pipeline_id}\` — the run starts in the background; keep the run id.
7. \`pipeline_run_status\` with \`{run_id}\` — read the status and the journal, then report
   the outcome to the user.

## Verify
- \`pipeline_get\` shows the published version you expect and no problems in the draft.
- \`pipeline_run_status\` shows a final status (\`done\` / \`failed\` / \`cancelled\`) and the
  journal of the steps that ran.`;

/** `SkillMeta` встроенного `synth-pipelines` (ADR-101). */
export function buildSynthPipelinesMeta(): SkillMeta {
  return {
    name: SYNTH_PIPELINES_NAME,
    description:
      'Пайплайны проекта: авторство спецификации, публикация версий, запуск прогонов, HITL-решения и шаблоны инстанца',
    userInvocable: true,
    disableModelInvocation: false,
    invocation: 'both',
    trigger: 'manual',
    command: SYNTH_PIPELINES_COMMAND,
    category: 'automation',
    tags: [SYNTH_PIPELINES_NAME, 'pipelines', 'automation', 'adr-101'],
    relatedSkills: [SYNTH_SCHEDULES_NAME],
    requiresCapabilities: [ToolCapability.PIPELINE],
    scope: 'instance',
    mode: 'any',
  };
}

/**
 * Тело встроенного `synth-schedules` (модель-facing англоязычная инструкция,
 * ADR-051).
 */
const SYNTH_SCHEDULES_BODY = `# Schedules

Work with the scheduler of the instance: create, change, trigger and inspect
schedules.

## When to use
- The user asks to run something later, every hour, every night…
- The user asks to list, inspect or delete schedules.
- The user wants a published pipeline to be started automatically.

## Tools
- \`schedule_list\` — schedules available to the session (own ones and project ones).
- \`schedule_get\` — one schedule: trigger, target, prompt, owner, next run.
- \`schedule_save\` — create a schedule or patch an existing one.
- \`schedule_delete\` — delete a schedule (the history of its runs is kept).
- \`schedule_run\` — trigger a schedule right now, even if it is disabled.
- \`schedule_jobs\` — history of the runs of the schedules.

## Steps
1. Start with \`schedule_list\` — it shows the trigger, the target, the next run and the
   status of the last run.
2. Create or change with \`schedule_save\`:
   - **exactly one trigger**: \`cron\` (5 fields, **UTC**) **or** \`every\`
     (\`30s\`, \`15m\`, \`1h\`, \`24h\`) — setting one replaces the other;
   - the **target** — what the schedule does:
     - \`bound\` / \`queue\` — a session: the current one or another session of the same
       project;
     - \`ephemeral\` — a new temporary session (\`agentTemplate?\`, \`ttl?\`, \`project?\`);
     - \`pipeline\` — a run of a **published** pipeline of the project of the session
       (\`projectId\` = project of the session, \`pipelineId\` = pipeline of that project,
       \`version\` — by default the latest published one).
   - optional \`prompt\`, \`payload\`, \`enabled\`, \`catch_up\` (\`skip\` | \`once\`).
   After the save the next run is recalculated and returned as \`nextRunAt\`.
3. Check with \`schedule_get\` — the whole record, including the owner.
4. Test it now with \`schedule_run\` — a manual trigger works regardless of \`enabled\`.
5. Look at the history with \`schedule_jobs\` — when the schedule ran, what triggered it,
   the status, the routing decision, the duration and the error.
6. Remove with \`schedule_delete\`.

## Rules
- The scope is **"own + project"**: a schedule is visible when it is your own (\`ownerId\` =
   user of the session) or when its target belongs to the project of the session. Own
   schedules are available even when the session has no project. Schedules of other users
   and projects are reported as not found.
- Mutating tools (\`schedule_save\`, \`schedule_delete\`, \`schedule_run\`) need either
   ownership of the schedule or write access to its project: a \`VIEWER\` member may only
   read. In \`plan\` mode mutations are blocked.
- There is no \`project_id\` argument — the target cannot be pointed at another project.
- The target \`pipeline\` requires a **published** pipeline: without a published version the
   schedule is refused.
- Warn the user that cron is interpreted in **UTC** — a schedule meant for local time has
   to be shifted by the offset of that time zone.
- The target \`pipeline\` does **not** create a session: the run happens in the background
   and its progress is read with \`pipeline_run_status\` (see the \`synth-pipelines\` skill).

## Typical scenario — "run this pipeline every night at 3"
1. \`schedule_list\` — check whether such a schedule already exists.
2. \`pipeline_get\` (the \`synth-pipelines\` skill) — take the pipeline id and confirm that
   it has a published version.
3. \`schedule_save\` with
   \`{name, cron: "0 3 * * *", target: {mode: "pipeline", projectId: <project of the session>, pipelineId: <id>}}\`.
4. Report \`nextRunAt\` to the user and remind them that the time is UTC.

## Verify
- \`schedule_get\` shows the expected trigger, target and \`nextRunAt\`.
- \`schedule_jobs\` shows the runs that appeared after \`schedule_run\`.`;

/** `SkillMeta` встроенного `synth-schedules` (ADR-051). */
export function buildSynthSchedulesMeta(): SkillMeta {
  return {
    name: SYNTH_SCHEDULES_NAME,
    description:
      'Расписания планировщика: cron/интервал → цель (сессия, временная сессия, пайплайн), запуск и история срабатываний',
    userInvocable: true,
    disableModelInvocation: false,
    invocation: 'both',
    trigger: 'manual',
    command: SYNTH_SCHEDULES_COMMAND,
    category: 'automation',
    tags: [SYNTH_SCHEDULES_NAME, 'schedules', 'automation', 'cron', 'scheduler', 'adr-051'],
    relatedSkills: [SYNTH_PIPELINES_NAME],
    requiresCapabilities: [ToolCapability.SCHEDULE],
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
    build(SYNTH_PIPELINES_NAME, buildSynthPipelinesMeta(), SYNTH_PIPELINES_BODY),
    build(SYNTH_SCHEDULES_NAME, buildSynthSchedulesMeta(), SYNTH_SCHEDULES_BODY),
  ];
}
