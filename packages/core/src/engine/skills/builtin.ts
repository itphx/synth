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
 * Workstream A1/A2: имя встроенного скилла-руководства по инстансу и MCP
 * (вход/ключи, реестр MCP, проекты/сессии, сетевая политика, перезапуск).
 * Команда `instance` не занята.
 */
export const SYNTH_INSTANCE_NAME = 'synth-instance';

/** Slash-команда скилла `synth-instance`. */
export const SYNTH_INSTANCE_COMMAND = 'instance';

/**
 * ADR-134: имя встроенного скилла регистрации userspace-сервиса systemd
 * (`synth service install`). Команда `service` не занята ни встроенными
 * командами, ни другими скиллами.
 */
export const SYNTH_SERVICE_NAME = 'synth-service';

/** Slash-команда скилла `synth-service`. */
export const SYNTH_SERVICE_COMMAND = 'service';

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
 * Тело встроенного `synth-instance` (модель-facing англоязычный runbook).
 *
 * Самодостаточно: в npm-пакете нет `docs/`, поэтому только команды, HTTP
 * эндпоинты и инструменты. Секреты не читаются и не печатаются.
 */
const SYNTH_INSTANCE_BODY = `# Synth instance — setup and diagnostics

Self-help runbook for configuring and diagnosing a Synth instance from chat:
auth/keys, MCP registry, projects and sessions, network policy, restart.
If the \`synth_*\` tools are unavailable for your agent, delegate to @admin or
use the UI/API instead of inventing shell/curl workarounds.

## When to use
- First run or reconfiguration of Synth (ports, data dir, API key, storage).
- MCP does not work: a server is missing, listed but has no tools, or tools fail.
- The user asks to add/update/enable/remove an MCP server.
- A session must be moved into a project (the user only knows the project name).
- Diagnostics: 401, policy denies, "Session not found", after an MCP restart.

## Know the instance
- \`synth_info\` — version, mode, dataDir, workingDir, workspacesRoot, auth flags
  (never values), storage backend/degraded, feature flags, counts.
- \`synth doctor --json\` — instance health (data dir, schema, storage probe).
- \`GET /health\` and \`GET /api/v2/meta\` — liveness/capabilities (message model,
  remote MCP, users feature). \`/health\` is outside \`/api/v2\`.
- Standalone core listens on **4300** by default: \`--port\`, \`SYNTH_CORE_PORT\`,
  or \`core.port\`. It is NOT \`server.port\` (that is the managed backend).
- dataDir comes from \`SYNTH_DATA_DIR\` / \`--data-dir\` / \`storage.dataDir\`;
  local home — \`--home\` / \`SYNTH_HOME\`.
- NEVER read \`{dataDir}/secrets/*\` with file/shell tools, and never print key
  values. \`synth_info\` only reports \`localKeyPresent\`/\`apiKeyConfigured\` flags.

## Auth in standalone
Priority for the instance API key:
1. \`--api-key\`
2. \`SYNTH_API_KEY\`
3. \`core.apiKey\` (config)
4. generated \`{dataDir}/secrets/api-key\` (printed once at first start)

The local key is ADMIN and is a secret: do not echo it, do not put it into chat,
commands visible to others, or files. The UI login session cookie is separate
from the API key — do not forge or copy cookies. Managed instances use OIDC
and/or scoped service keys; a service key differs from an event binding key
and carries \`scopes\`/\`allowedProjects\`.

## MCP model
- The **registry** is the source of truth (\`{dataDir}\` storage via the MCP
  repository). \`config.mcp.servers\` is only a seed at startup; editing it does
  not change a running instance.
- Levels: \`system\` (registry \`enabled\` master flag) → \`project.mcp.enabled\`
  (hard gate) → session (\`settings.mcpServers\`, \`mcpDisabledServers\`,
  \`mcpDefaultOn\`). Default is opt-in: a newly added server is **off** for the
  session until enabled.
- Transports: \`stdio\`, \`http\` (Streamable HTTP; the URL usually ends with
  \`/mcp\`), \`sse\`. Tool names are \`<server>_<tool>\`.
- Network policy: \`origin:"user"\` HTTP/SSE are checked (loopback/private ranges
  denied unless an exception exists); \`origin:"instance"\` and stdio are trusted
  (ADMIN only). \`synth_mcp_list\` shows the policy decision per server.

## MCP tools
| Tool | Purpose |
|---|---|
| \`synth_mcp_list\` | registry, status, effective scope, policy; no secrets |
| \`synth_mcp_test\` | temporary connect to an already configured (existing) server + tool list; does not register |
| \`synth_mcp_add\` | add a server (opt-in for sessions) |
| \`synth_mcp_update\` | change config/master flags (user record: author or ADMIN/LEAD; instance record: ADMIN) |
| \`synth_mcp_remove\` | disconnect + remove from registry |
| \`synth_mcp_enable\` | enable/disable at \`session\`/\`project\`/\`instance\` |
| \`synth_mcp_reconnect\` | reconnect without restarting Synth |

Mutate only as: user records — author or ADMIN/LEAD; stdio and \`origin:"instance"\`
require **ADMIN**. Plaintext secret headers are rejected (use the credential
layer / UI). Never put tokens into \`config.headers\` or \`config.env\`.

## Add and enable a server
1. \`synth_mcp_list\` — see what exists and its effective state.
2. \`synth_mcp_add\` an HTTP server (local service, ADMIN):
\`\`\`json
{"name":"playwright","config":{"type":"http","url":"http://127.0.0.1:8931/mcp"},"origin":"instance"}
\`\`\`
   A local service is added as \`origin:"instance"\` (ADMIN) to bypass the
   loopback policy; otherwise use \`origin:"user"\` **and** add an egress/network
   exception in settings.
3. \`synth_mcp_add\` a stdio server (ADMIN only):
\`\`\`json
{"name":"filesystem","config":{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem@latest","/workspace"]}}
\`\`\`
4. \`synth_mcp_test {"name":"<name>"}\` — check the **already added** server
   (temporary connect + tool list, does not register; the config comes from the
   registry, so the server must be added first).
5. Enable it: \`synth_mcp_enable {"name":"playwright","enabled":true,"level":"session"}\`
   (\`project\` for the current project, \`instance\` for the master flag).
6. Verify with \`synth_mcp_list\` and call a server tool (for Playwright —
   \`browser_navigate\`, \`browser_snapshot\`).
7. If a server's tools fail after the MCP process restarted ("Session not
   found"), run \`synth_mcp_reconnect {"name":"..."}\` — no Synth restart.

\`enabledByDefault\` only affects **new projects**; project \`defaultOn\` is a
snapshot and does not change existing sessions.

## Projects and sessions
- \`list_projects {"query":"..."}\` — compact list of visible projects.
- \`get_project {"project":"id-or-exact-name"}\` — details, role, can_edit.
- **Never guess a project id.** Use \`list_projects\`/\`get_project\`.
- \`project_attach {"project":"Exact Name"}\` — id or exact name (case-insensitive);
  ambiguous names return candidates, no silent pick. Moving detaches a git
  worktree, resets plan approval and publishes \`session.moved\`. If the target
  has no workspace, file/shell/git tools stay blocked until
  \`project_workspace_set\`.
- \`list_sessions\`, \`get_session_info\`, \`session_rename {title}\` — discovery and
  renaming of the current session (no message history in responses).

## Hybrid: local core + backend
Hybrid mode has **two independent worlds**. Tools execute in the world of the
session (local session → local core; remote session → backend).

- Discovery tools are **read-only** and show both worlds: \`list_projects\` /
  \`list_sessions\` add \`origin: "local" | "remote"\`; remote ids are
  \`remote:<uuid>\`; remote items have \`can_attach:false\`, \`cross_instance:true\`.
- \`get_project\` with \`remote:<id>\` reads the remote project; by name it first
  resolves locally, then searches the remote world.
- \`list_sessions\`: no project filter merges both worlds; a local project shows
  local sessions only; a \`remote:\` project shows remote sessions only.
- \`remote_offline\` / \`remote_truncated\` mean the backend is unreachable / the
  list is page-capped; the local world still works.
- \`project_attach\` works **inside the current world only**:
  - \`remote:\` or a name that exists only remotely → \`project.cross_instance\`
    (no attach);
  - the same name locally and remotely → \`project.hybrid_ambiguous\` (candidates,
    never a silent pick);
  - a local \`projectId\` attaches without a remote check.
- Cross-world move is **not supported** (not critical): use
  \`synth project export/import\`, publish/fork, or create the session in the
  target world. Remote MCP merge/management is also not critical: \`synth_mcp_*\`
  manages the local registry; server-side MCP (PROP-125) is a separate layer.

## Troubleshooting
| Symptom | Cause / action |
|---|---|
| 401 / "no key" | API key missing/invalid; check \`synth_info\` auth flags; use \`--api-key\`/\`SYNTH_API_KEY\` (do not read the key file) |
| \`MCP_CONNECT_ERROR\` | server down or wrong URL/transport; for an already added server run \`synth_mcp_test\`, otherwise \`synth_mcp_add\` and then \`synth_mcp_test\`/\`synth_mcp_reconnect\` |
| policy deny for loopback | user HTTP/SSE to private address; add as \`origin:"instance"\` (ADMIN) or add a network-policy exception |
| server listed but no tools | not enabled in the session (opt-in), project gate, or stale snapshot; \`synth_mcp_enable\` at session/project |
| "Session not found" after MCP restart | stale MCP session; \`synth_mcp_reconnect\` (no Synth restart) |
| project is on the other instance | \`project.cross_instance\`; do not try to attach — use \`synth project export/import\` or fork/publish/create the session there |
| stdio rejected | stdio/instance mutations require ADMIN |
| plaintext auth header rejected | use the credential layer (ADR-105) / UI; never put secrets in headers |
| \`npm\` \`SELF_SIGNED_CERT_IN_CHAIN\` | run \`npm\` with \`NODE_OPTIONS=--use-system-ca\` (outside Synth) |
| Chrome "unsupported flag" infobar in Playwright | launch Chrome with \`--test-type\` |

## Recipe: Playwright MCP with one shared headed Chrome
- Package: \`@playwright/mcp@0.0.84\`; system Chrome; X display \`DISPLAY=:1\`.
- \`~/.config/playwright-mcp/config.json\`:
\`\`\`json
{
  "browser": {
    "launchOptions": {"channel": "chrome", "headless": false, "args": ["--test-type"]},
    "userDataDir": "/home/<user>/.cache/playwright-mcp-profile",
    "isolated": false
  },
  "server": {"port": 8931, "host": "127.0.0.1", "sharedBrowserContext": true}
}
\`\`\`
- systemd user unit (\`~/.config/systemd/user/playwright-mcp.service\`):
\`\`\`ini
[Unit]
Description=Playwright MCP (shared headed Chrome)
[Service]
Environment=DISPLAY=:1
Environment=NODE_OPTIONS=--use-system-ca
ExecStart=/usr/bin/node /path/to/@playwright/mcp/cli.js --config %h/.config/playwright-mcp/config.json
Restart=on-failure
[Install]
WantedBy=default.target
\`\`\`
  Then \`systemctl --user enable --now playwright-mcp\` and
  \`loginctl enable-linger $USER\`.
- Add to Synth as \`origin:"instance"\`, URL \`http://127.0.0.1:8931/mcp\`; enable
  at session or project level; verify with \`browser_navigate\`/\`browser_snapshot\`.
- Security: bind loopback only; use \`--allowed-hosts\`; \`browser_run_code_unsafe\`
  is RCE — keep it off; never store secrets in the Chrome profile or reports.

## Verify
- \`synth_info\` shows the expected mode/dataDir/storage and no secret values.
- \`synth_mcp_list\` shows the server, status and effective scope.
- A server tool call succeeds (e.g. \`browser_snapshot\`).
- Session/project changes are visible in \`list_sessions\`/\`get_project\`.
- Hybrid: remote items carry \`remote:\` ids, \`origin:"remote"\`, \`can_attach:false\`;
  \`project.cross_instance\`/\`project.hybrid_ambiguous\` mean no cross-world attach.
- No secrets were printed or written by your commands.

## Safety
- Never read or print \`{dataDir}/secrets/*\`; never put tokens in
  \`config.headers\`/\`config.env\` (use credentials).
- Do not restart Synth to apply MCP changes: the registry is live; use
  \`synth_mcp_reconnect\` for a restarted MCP server.
- Do not treat \`config.yaml mcp.servers\` as the source of truth — it is a seed.
- Hybrid: \`synth_mcp_*\` manages the local registry only; do not assume remote MCP servers are merged.
- Do not forge UI cookies or reuse another user's session/key.
`;

/** `SkillMeta` встроенного `synth-instance` (Workstream A1/A2). */
export function buildSynthInstanceMeta(): SkillMeta {
  return {
    name: SYNTH_INSTANCE_NAME,
    description:
      'Настройка и диагностика инстанса Synth: вход, MCP-серверы, проекты и сессии, сетевая политика, перезапуск',
    userInvocable: true,
    disableModelInvocation: false,
    invocation: 'both',
    trigger: 'auto',
    command: SYNTH_INSTANCE_COMMAND,
    category: 'ops',
    tags: [
      'synth-instance',
      'setup',
      'admin',
      'mcp',
      'projects',
      'sessions',
      'troubleshooting',
      'self-help',
    ],
    relatedSkills: [SYNTH_STORAGE_RECOVERY_NAME],
    requiresCapabilities: [],
    scope: 'instance',
    mode: 'any',
  };
}

/** Тело встроенного `synth-service` (model-facing, ADR-134). */
const SYNTH_SERVICE_BODY = `# Synth service (systemd --user)

Register the local Synth instance as a **userspace** systemd service so it keeps
running and starts automatically. The unit is generated from a fixed template by
\`synth service install\` (ADR-134) — never write unit files yourself.

## When to use
- The user wants the instance to "always run", survive logout/reboot, or be
  managed with \`systemctl --user\`.
- The user asks how to see service logs, restart the instance, or enable
  autostart on a Linux machine.
- A restart from the UI answers 409 \`RESTART_UNSUPPORTED\` because no supervisor
  is running — the service unit fixes this (\`SYNTH_RESTART_MODE=process\`,
  \`RestartForceExitStatus=75\`).

## Ask the user first
Use the \`question\` tool (1–5 questions, with options) before installing:
1. **Mode** — standalone or hybrid. Hybrid needs a backend URL and the OIDC
   issuer/client ID used by the UI login.
2. **Data location** — a dedicated \`--home <dir>\` (config/data/profiles/
   credentials in one tree) or \`--data-dir <dir>\` (data only). Do not invent a
   path; ask.
3. **Port** — default 4300; ask if the user expects another one.
4. **Bind address** — \`127.0.0.1\` (default, loopback), \`0.0.0.0\` (all
   interfaces — warn: reachable from the network, check authentication) or a
   specific IP.
5. **Autostart / linger** — enable autostart and \`loginctl enable-linger\` so the
   service starts after reboot without an interactive login (best-effort).

For **hybrid**, remind the user to run \`synth connect --backend <url>\` **once by
hand** first: the unit stores no tokens, the service reuses the saved
credentials (device flow). \`--oidc-issuer\`/\`--oidc-client-id\` are **not** written
to the unit — they belong in \`config.yaml\` next to the home directory.

If the \`question\` tool is unavailable (not granted to the current agent), ask the
same questions as plain text and wait for the answers.

## Steps
1. Show the plan: \`synth service install --print-unit --port <n> --host <addr>
   (--home <dir>|--data-dir <dir>) [--connect <url>]\`. The unit template and
   paths are printed; nothing is written.
2. Get explicit confirmation from the user (paths, port, bind address, hybrid
   URL, autostart/linger).
3. Install **without sudo**:
   \`synth service install --port <n> --host <addr> (--home <dir>|--data-dir <dir>)
   [--connect <url>] [--no-autostart] [--no-start] [--no-linger]\`.
   Add \`--json\` when you need machine-readable output.
4. Verify: \`synth service status --json\` — \`installed:true\`, \`active\`, \`pid\`,
   \`linger\`, \`health.ok\`.
5. Verify the endpoint: \`GET http://127.0.0.1:<port>/health\` (or the configured
   host) returns \`{status, version, startedAt}\`.

## Verify
- \`synth service status --json\` shows \`installed:true\` and \`managed:true\`.
- \`health.ok\` is \`true\` and \`startedAt\` is fresh.
- \`systemctl --user is-enabled synth.service\` answers \`enabled\` (unless
  \`--no-autostart\` was requested).
- Logs are readable: \`synth service logs -n 100\` (or \`-f\` to follow).
- No secret value (API key, token) was printed anywhere.

## Safety
- Do NOT write \`~/.config/systemd/user/synth.service\` or the env file with file
  tools — the template lives in code; manual edits are overwritten on the next
  install.
- Do NOT use \`sudo\`, \`systemctl --system\` or a system-wide unit: \`--system\` is
  not supported. One user — their own instances (ADR-079).
- Do NOT print, copy or put secrets into the unit or \`service.env\`. The API key
  lives in \`{dataDir}/secrets/api-key\`; hybrid auth uses saved credentials.
- Do NOT delete or move instance data — \`synth service uninstall\` removes only
  the unit; data removal is \`synth uninstall\`.
- If systemd is unavailable (container, non-Linux), say so and do not emulate the
  service: use Docker/Helm (ADR-077) or ask the administrator.
`;

/** `SkillMeta` встроенного `synth-service` (ADR-134). */
export function buildSynthServiceMeta(): SkillMeta {
  return {
    name: SYNTH_SERVICE_NAME,
    description:
      'Регистрация инстанса Synth как userspace-сервиса systemd (synth service install): автозапуск, логи, рестарт',
    userInvocable: true,
    disableModelInvocation: false,
    invocation: 'both',
    trigger: 'manual',
    command: SYNTH_SERVICE_COMMAND,
    category: 'instance',
    tags: ['synth-service', 'systemd', 'service', 'autostart', 'install', 'ops'],
    relatedSkills: [SYNTH_INSTANCE_NAME],
    requiresCapabilities: [ToolCapability.SHELL, ToolCapability.QUESTION],
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
    build(SYNTH_INSTANCE_NAME, buildSynthInstanceMeta(), SYNTH_INSTANCE_BODY),
    build(SYNTH_SERVICE_NAME, buildSynthServiceMeta(), SYNTH_SERVICE_BODY),
  ];
}
