/**
 * ADR-051: встроенные тулы расписаний планировщика — чтение, авторство,
 * принудительный запуск и история срабатываний.
 *
 * Шесть тулов: `schedule_list`, `schedule_get`, `schedule_save`,
 * `schedule_delete`, `schedule_run`, `schedule_jobs`. Они дают агенту
 * возможность вести расписания (cron/интервал → цель) и смотреть историю
 * срабатываний без обращения к HTTP API.
 *
 * ## Границы
 *
 * - **Область доступа — «свои + проект».** Расписание доступно агенту, если
 *   оно **своё** (`ownerId === userId` сессии) **или** его цель относится к
 *   проекту сессии (`pipeline`/`ephemeral`/`bound`/`queue` — правила в
 *   `automation-helpers.ts`, `isScheduleInScope`). Расписание вне области
 *   выглядит как отсутствующее (`schedule.tool.not_found`) — существование
 *   чужого ресурса не раскрывается.
 * - **Мутации — по правам.** `save`/`delete`/`run` требуют либо владения
 *   расписанием, либо права изменения содержимого проекта (`canEditProject`);
 *   read-уровень (`VIEWER`) только читает (инвариант 21).
 * - **Цель не подсунуть.** Аргумент `project_id` не принимается: цель
 *   `pipeline` обязана указывать на проект сессии, цель `bound`/`queue` — на
 *   сессию своей (или своей же проекта).
 * - **Прогон пайплайна — только по опубликованной версии** (ADR-101): цель
 *   `pipeline` без `publishedVersion` отвергается.
 * - Тексты — только через ключи `shared/i18n` (ADR-041).
 */
import { z } from 'zod';
import { ToolCapability, scheduleInputSchema, scheduleTargetSchema } from '@itphx/synth-shared';
import type {
  Schedule,
  ScheduleInput,
  ScheduleTarget,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@itphx/synth-shared';
import type { JobRepository } from '../../storage/ports/job-repository.js';
import type { ScheduleRepository } from '../../storage/ports/schedule-repository.js';
import { isValidCron } from '../scheduler/cron.js';
import { parseDurationMs } from '../scheduler/duration.js';
import { canEditProject, resolveSessionUserId } from './project-access.js';
import { getSessionExtra } from './project-manage.js';
import {
  ensureScheduleMutable,
  isScheduleInScope,
  loadScheduleScope,
  scheduleDepsUnavailable,
  scheduleForbidden,
  type ScheduleScope,
} from './automation-helpers.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

/** Дефолтный размер выборки истории срабатываний. */
const DEFAULT_LIMIT = 20;

/** Абсолютный потолок выборки истории срабатываний. */
const MAX_LIMIT = 100;

/** Единый текст ошибки разбора аргументов (как у соседних тулов). */
function argError(toolName: string, issues: z.ZodIssue[]): ToolResult {
  return {
    content: sm('tool.args_error', {
      tool: toolName,
      issues: issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
    }),
    isError: true,
  };
}

/** Единый отказ «расписание не найдено» (нет такого или оно вне области). */
function scheduleNotFound(scheduleId: string): ToolResult {
  return {
    content: sm('schedule.tool.not_found', { id: scheduleId }),
    isError: true,
    metadata: { i18n: i18nMeta('schedule.tool.not_found', { id: scheduleId }) },
  };
}

/** Единый отказ «некорректное расписание» (список проблем). */
function invalidSchedule(problems: string[]): ToolResult {
  const text = problems.join('; ');
  return {
    content: sm('schedule.tool.invalid', { problems: text }),
    isError: true,
    metadata: { i18n: i18nMeta('schedule.tool.invalid', { problems: text }) },
  };
}

/** Единый отказ «цель расписания недоступна» (с причиной). */
function targetForbidden(reason: string): ToolResult {
  return {
    content: sm('schedule.tool.target_forbidden', { reason }),
    isError: true,
    metadata: { i18n: i18nMeta('schedule.tool.target_forbidden', { reason }) },
  };
}

/** Единый отказ «у пайплайна нет опубликованной версии». */
function notPublished(pipelineId: string): ToolResult {
  return {
    content: sm('schedule.tool.not_published', { id: pipelineId }),
    isError: true,
    metadata: { i18n: i18nMeta('schedule.tool.not_published', { id: pipelineId }) },
  };
}

/** Порт расписаний (или отказ «рантайм недоступен»). */
function schedulesPort(
  automation: { schedules?: ScheduleRepository },
  toolName: string,
): { ok: true; schedules: ScheduleRepository } | { ok: false; result: ToolResult } {
  const schedules = automation.schedules;
  if (!schedules) return { ok: false, result: scheduleDepsUnavailable(toolName) };
  return { ok: true, schedules };
}

/** Порт истории срабатываний (или отказ «рантайм недоступен»). */
function jobsPort(
  automation: { jobs?: JobRepository },
  toolName: string,
): { ok: true; jobs: JobRepository } | { ok: false; result: ToolResult } {
  const jobs = automation.jobs;
  if (!jobs) return { ok: false, result: scheduleDepsUnavailable(toolName) };
  return { ok: true, jobs };
}

/** Краткое представление цели расписания (для списка). */
function describeTarget(target: ScheduleTarget): string {
  switch (target.mode) {
    case 'bound':
      return `session ${target.sessionId}`;
    case 'queue':
      return `queue ${target.sessionId}`;
    case 'ephemeral':
      return target.project ? `ephemeral project ${target.project}` : 'ephemeral';
    case 'pipeline':
      return `pipeline ${target.pipelineId}`;
  }
}

/** Привести `limit` к допустимому виду: дефолт 20, потолок 100. */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/** Семантическая проверка триггера (cron/интервал) вне Zod-схемы. */
function validateTrigger(input: { cron?: string; every?: string }): string | null {
  if (input.cron && input.cron.trim() && !isValidCron(input.cron)) {
    return `invalid cron expression: "${input.cron}"`;
  }
  if (input.every && input.every.trim()) {
    try {
      parseDurationMs(input.every);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return null;
}

/**
 * Проверка цели расписания (ADR-051/ADR-101).
 *
 * - `bound`/`queue` — текущая сессия **или** сессия своего проекта с тем же
 *   пользователем;
 * - `ephemeral` — проект цели не задан **или** равен проекту сессии (запись в
 *   проектную цель — по праву изменения содержимого проекта);
 * - `pipeline` — проект цели равен проекту сессии, пайплайн существует в этом
 *   проекте и **опубликован** (прогон идёт только по опубликованной версии).
 *
 * `null` — цель допустима; иначе — готовый отказ.
 */
async function validateTarget(
  target: ScheduleTarget,
  scope: ScheduleScope,
  ctx: ToolContext,
  toolName: string,
): Promise<ToolResult | null> {
  const project = scope.project;

  if (target.mode === 'bound' || target.mode === 'queue') {
    if (target.sessionId === scope.session.id) return null;
    const sessionManager = getSessionExtra(ctx).sessionManager;
    const targetSession = sessionManager
      ? await sessionManager.getSession(target.sessionId)
      : null;
    if (!targetSession) return targetForbidden('the target session does not exist');
    if (!project) return targetForbidden('the session has no project');
    if (targetSession.projectId !== project.id) {
      return targetForbidden('the target session belongs to another project');
    }
    const targetUser = resolveSessionUserId(targetSession);
    if (targetUser && scope.userId && targetUser !== scope.userId) {
      return targetForbidden('the target session belongs to another user');
    }
    return null;
  }

  if (target.mode === 'ephemeral') {
    if (!target.project) return null;
    if (!project) return targetForbidden('the session has no project');
    if (target.project !== project.id) {
      return targetForbidden('the target project is another project');
    }
    if (!canEditProject(scope.session, project)) return scheduleForbidden();
    return null;
  }

  // `pipeline` (ADR-101) — цель проекта сессии, пайплайн опубликован.
  if (!project) return targetForbidden('the session has no project');
  if (target.projectId !== project.id) {
    return targetForbidden('the target project is another project');
  }
  const pipelines = scope.automation.pipelines;
  if (!pipelines) return scheduleDepsUnavailable(toolName);
  const record = await pipelines.getPipeline(target.pipelineId);
  if (!record || record.scope !== 'project' || record.projectId !== project.id) {
    return notPublished(target.pipelineId);
  }
  if (record.publishedVersion === undefined) return notPublished(target.pipelineId);
  if (!canEditProject(scope.session, project)) return scheduleForbidden();
  return null;
}

// ─────────────────────────────── schedule_list ───────────────────────────────

const scheduleListSchema = z.object({
  include_disabled: z
    .boolean()
    .optional()
    .describe('Show disabled schedules as well (default: true; false — only enabled)'),
});

export const scheduleListTool: ToolDefinition = {
  name: 'schedule_list',
  description:
    'List the schedules available to the session: the ones owned by the user and the ones '
    + 'targeting the project of the session. Shows the trigger, the target, the next run and '
    + 'the status of the last run. Schedules of other users and projects are not shown.',
  parameters: scheduleListSchema,
  capabilities: [ToolCapability.SCHEDULE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argError(this.name, parsed.error.issues);
    }
    const params = parsed.data as { include_disabled?: boolean };

    const loaded = await loadScheduleScope(ctx, this.name);
    if (!loaded.ok) return loaded.result;
    const scope = loaded.scope;
    const port = schedulesPort(scope.automation, this.name);
    if (!port.ok) return port.result;

    // По умолчанию показываем и выключенные расписания.
    const includeDisabled = params.include_disabled !== false;
    const all = await port.schedules.list();
    const visible: Schedule[] = [];
    for (const schedule of all) {
      if (!includeDisabled && !schedule.enabled) continue;
      if (!(await isScheduleInScope(schedule, scope, ctx))) continue;
      visible.push(schedule);
    }

    if (visible.length === 0) {
      return {
        content: sm('schedule.tool.list_empty'),
        metadata: { count: 0, i18n: i18nMeta('schedule.tool.list_empty') },
      };
    }

    const lines = visible.map(
      (schedule) =>
        `- ${schedule.id} «${schedule.name}» [${schedule.enabled ? 'on' : 'off'}] `
        + `${schedule.cron ?? schedule.every ?? '—'} → ${describeTarget(schedule.target)} `
        + `(next: ${schedule.nextRunAt ?? '—'}, last: ${schedule.lastStatus ?? '—'})`,
    );
    return {
      content: lines.join('\n'),
      metadata: { count: visible.length },
    };
  },
};

// ─────────────────────────────── schedule_get ────────────────────────────────

const scheduleGetSchema = z.object({
  schedule_id: z.string().min(1).describe('Id of the schedule'),
});

export const scheduleGetTool: ToolDefinition = {
  name: 'schedule_get',
  description:
    'Show one schedule: its trigger, target, prompt, owner, next run and the status of the last '
    + 'run. A schedule of another user or project is reported as not found.',
  parameters: scheduleGetSchema,
  capabilities: [ToolCapability.SCHEDULE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argError(this.name, parsed.error.issues);
    }
    const params = parsed.data as { schedule_id: string };

    const loaded = await loadScheduleScope(ctx, this.name);
    if (!loaded.ok) return loaded.result;
    const scope = loaded.scope;
    const port = schedulesPort(scope.automation, this.name);
    if (!port.ok) return port.result;

    const schedule = await port.schedules.get(params.schedule_id);
    if (!schedule) return scheduleNotFound(params.schedule_id);
    if (!(await isScheduleInScope(schedule, scope, ctx))) {
      return scheduleNotFound(params.schedule_id);
    }

    const lines = [
      `Schedule «${schedule.name}» (${schedule.id}) — ${schedule.enabled ? 'enabled' : 'disabled'}, `
      + `${schedule.cron ?? schedule.every ?? '—'} → ${describeTarget(schedule.target)}`,
      JSON.stringify({ schedule }, null, 2),
    ];
    return {
      content: lines.join('\n'),
      metadata: { scheduleId: schedule.id, enabled: schedule.enabled },
    };
  },
};

// ─────────────────────────────── schedule_save ───────────────────────────────

const scheduleSaveSchema = z.object({
  schedule_id: z
    .string()
    .min(1)
    .optional()
    .describe('Id of the schedule to update (omit to create a new one)'),
  name: z.string().min(1).optional().describe('Name of the schedule'),
  enabled: z.boolean().optional().describe('Enable or disable the schedule'),
  cron: z.string().optional().describe('Cron trigger (5 fields, UTC)'),
  every: z.string().optional().describe('Interval trigger (30s | 15m | 1h | 24h)'),
  target: scheduleTargetSchema.optional().describe('Target of the schedule'),
  prompt: z.string().optional().describe('Prompt text sent on trigger'),
  payload: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Additional fields of the event payload'),
  catch_up: z
    .enum(['skip', 'once'])
    .optional()
    .describe('Behaviour on a missed trigger: skip it or run once'),
});

export const scheduleSaveTool: ToolDefinition = {
  name: 'schedule_save',
  description:
    'Create or update a schedule. Without schedule_id a new schedule owned by the user of the '
    + 'session is created; with it the existing schedule is patched (the given fields replace '
    + 'the current ones, the rest are kept). Exactly one trigger (cron or every) must be set. '
    + 'The target must be the current session, a session of the same project or a published '
    + 'pipeline of the project of the session. Requires write access to the project for '
    + 'project-scoped targets.',
  parameters: scheduleSaveSchema,
  capabilities: [ToolCapability.SCHEDULE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argError(this.name, parsed.error.issues);
    }
    const params = parsed.data as {
      schedule_id?: string;
      name?: string;
      enabled?: boolean;
      cron?: string;
      every?: string;
      target?: z.infer<typeof scheduleTargetSchema>;
      prompt?: string;
      payload?: Record<string, unknown>;
      catch_up?: 'skip' | 'once';
    };

    const loaded = await loadScheduleScope(ctx, this.name);
    if (!loaded.ok) return loaded.result;
    const scope = loaded.scope;
    const port = schedulesPort(scope.automation, this.name);
    if (!port.ok) return port.result;
    // Планировщик нужен для пересчёта `nextRunAt` после записи.
    const scheduler = scope.automation.scheduler;
    if (!scheduler) return scheduleDepsUnavailable(this.name);

    // Обновляемое расписание должно быть в области доступа.
    let current: Schedule | null = null;
    if (params.schedule_id !== undefined) {
      current = await port.schedules.get(params.schedule_id);
      if (!current) return scheduleNotFound(params.schedule_id);
      if (!(await isScheduleInScope(current, scope, ctx))) {
        return scheduleNotFound(params.schedule_id);
      }
      const denied = await ensureScheduleMutable(current, scope, ctx);
      if (denied) return denied;
    }

    // Триггер: новая задача **заменяет** прежнюю (cron ↔ every), иначе
    // частичный патч оставил бы оба поля и вход стал бы невалидным.
    const hasCron = params.cron !== undefined && params.cron.trim().length > 0;
    const hasEvery = params.every !== undefined && params.every.trim().length > 0;
    if (hasCron && hasEvery) {
      return invalidSchedule(['only one of cron/every can be set']);
    }
    const cron = hasCron ? params.cron : hasEvery ? undefined : current?.cron;
    const every = hasEvery ? params.every : hasCron ? undefined : current?.every;

    // Слияние с текущим расписанием (частичный патч).
    const catchUp = params.catch_up ?? current?.catchUp;
    const merged = {
      name: params.name ?? current?.name,
      enabled: params.enabled ?? current?.enabled ?? true,
      ...(cron !== undefined ? { cron } : {}),
      ...(every !== undefined ? { every } : {}),
      target: params.target ?? current?.target,
      ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
      ...(params.payload !== undefined ? { payload: params.payload } : {}),
      ...(current?.ownerId !== undefined ? { ownerId: current.ownerId } : {}),
      ...(catchUp !== undefined ? { catchUp } : {}),
    };

    const validated = scheduleInputSchema.safeParse(merged);
    if (!validated.success) {
      return invalidSchedule(
        validated.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`),
      );
    }
    const triggerProblem = validateTrigger(validated.data);
    if (triggerProblem) return invalidSchedule([triggerProblem]);

    const targetProblem = await validateTarget(
      validated.data.target,
      scope,
      ctx,
      this.name,
    );
    if (targetProblem) return targetProblem;

    // Создание — владелец всегда пользователь сессии; обновление — владелец
    // прежний (чужим расписанием не владеют).
    const ownerId = current?.ownerId ?? (scope.userId || undefined);
    const input: ScheduleInput = {
      ...validated.data,
      ...(ownerId !== undefined ? { ownerId } : {}),
    };

    const saved = current
      ? await port.schedules.update(current.id, input)
      : await port.schedules.create(input);
    // `update` возвращает `null`, если запись исчезла между чтением и записью.
    if (!saved) return scheduleNotFound(current?.id ?? params.schedule_id ?? '');

    const refreshed = await scheduler.refreshNextRun(saved.id);
    const nextRunAt = refreshed?.nextRunAt ?? saved.nextRunAt;

    return {
      content: sm('schedule.tool.saved', { id: saved.id }),
      metadata: {
        scheduleId: saved.id,
        enabled: saved.enabled,
        nextRunAt,
        i18n: i18nMeta('schedule.tool.saved', { id: saved.id }),
      },
    };
  },
};

// ────────────────────────────── schedule_delete ──────────────────────────────

const scheduleDeleteSchema = z.object({
  schedule_id: z.string().min(1).describe('Id of the schedule'),
});

export const scheduleDeleteTool: ToolDefinition = {
  name: 'schedule_delete',
  description:
    'Delete a schedule. The history of its runs is kept. '
    + 'Requires ownership of the schedule or write access to its project.',
  parameters: scheduleDeleteSchema,
  capabilities: [ToolCapability.SCHEDULE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argError(this.name, parsed.error.issues);
    }
    const params = parsed.data as { schedule_id: string };

    const loaded = await loadScheduleScope(ctx, this.name);
    if (!loaded.ok) return loaded.result;
    const scope = loaded.scope;
    const port = schedulesPort(scope.automation, this.name);
    if (!port.ok) return port.result;

    const schedule = await port.schedules.get(params.schedule_id);
    if (!schedule) return scheduleNotFound(params.schedule_id);
    if (!(await isScheduleInScope(schedule, scope, ctx))) {
      return scheduleNotFound(params.schedule_id);
    }
    const denied = await ensureScheduleMutable(schedule, scope, ctx);
    if (denied) return denied;

    const removed = await port.schedules.remove(schedule.id);
    if (!removed) return scheduleNotFound(params.schedule_id);

    return {
      content: sm('schedule.tool.deleted', { id: schedule.id }),
      metadata: {
        scheduleId: schedule.id,
        i18n: i18nMeta('schedule.tool.deleted', { id: schedule.id }),
      },
    };
  },
};

// ─────────────────────────────── schedule_run ───────────────────────────────

const scheduleRunSchema = z.object({
  schedule_id: z.string().min(1).describe('Id of the schedule'),
});

export const scheduleRunTool: ToolDefinition = {
  name: 'schedule_run',
  description:
    'Trigger a schedule right now (even if it is disabled) and report the status of the run. '
    + 'Requires ownership of the schedule or write access to its project.',
  parameters: scheduleRunSchema,
  capabilities: [ToolCapability.SCHEDULE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argError(this.name, parsed.error.issues);
    }
    const params = parsed.data as { schedule_id: string };

    const loaded = await loadScheduleScope(ctx, this.name);
    if (!loaded.ok) return loaded.result;
    const scope = loaded.scope;
    const port = schedulesPort(scope.automation, this.name);
    if (!port.ok) return port.result;
    const scheduler = scope.automation.scheduler;
    if (!scheduler) return scheduleDepsUnavailable(this.name);

    const schedule = await port.schedules.get(params.schedule_id);
    if (!schedule) return scheduleNotFound(params.schedule_id);
    if (!(await isScheduleInScope(schedule, scope, ctx))) {
      return scheduleNotFound(params.schedule_id);
    }
    const denied = await ensureScheduleMutable(schedule, scope, ctx);
    if (denied) return denied;

    const updated = await scheduler.runNow(schedule.id);
    if (!updated) return scheduleNotFound(params.schedule_id);

    const status = updated.lastStatus ?? '—';
    return {
      content: sm('schedule.tool.ran', { id: updated.id, status }),
      metadata: {
        scheduleId: updated.id,
        status,
        i18n: i18nMeta('schedule.tool.ran', { id: updated.id, status }),
      },
    };
  },
};

// ────────────────────────────── schedule_jobs ──────────────────────────────

const scheduleJobsSchema = z.object({
  schedule_id: z
    .string()
    .min(1)
    .optional()
    .describe('Only the runs of this schedule (a schedule of the session)'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('How many runs to show (default 20, max 100)'),
});

export const scheduleJobsTool: ToolDefinition = {
  name: 'schedule_jobs',
  description:
    'Show the history of schedule runs: when it started, what triggered it, its status, the '
    + 'routing decision, the duration and the error. Only runs of the schedules available to '
    + 'the session are shown.',
  parameters: scheduleJobsSchema,
  capabilities: [ToolCapability.SCHEDULE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argError(this.name, parsed.error.issues);
    }
    const params = parsed.data as { schedule_id?: string; limit?: number };

    const loaded = await loadScheduleScope(ctx, this.name);
    if (!loaded.ok) return loaded.result;
    const scope = loaded.scope;
    const port = schedulesPort(scope.automation, this.name);
    if (!port.ok) return port.result;
    const jobPort = jobsPort(scope.automation, this.name);
    if (!jobPort.ok) return jobPort.result;

    // Фильтр по расписанию: чужое расписание выглядит как отсутствующее.
    if (params.schedule_id !== undefined) {
      const schedule = await port.schedules.get(params.schedule_id);
      if (!schedule) return scheduleNotFound(params.schedule_id);
      if (!(await isScheduleInScope(schedule, scope, ctx))) {
        return scheduleNotFound(params.schedule_id);
      }
    }

    const limit = resolveLimit(params.limit);
    // Журнал общий для инстанса: сначала отсекаем по области доступа
    // (чужие проекты/пользователи не раскрываются), и только затем применяем
    // `limit` — иначе последние N записей могли бы оказаться чужими.
    const all = await jobPort.jobs.list(
      params.schedule_id !== undefined ? { scheduleId: params.schedule_id } : {},
    );

    const schedules = await port.schedules.list();
    const inScope = new Set<string>();
    for (const schedule of schedules) {
      if (await isScheduleInScope(schedule, scope, ctx)) inScope.add(schedule.id);
    }
    const visible = all.filter((job) => inScope.has(job.scheduleId)).slice(-limit);

    if (visible.length === 0) {
      return {
        content: sm('schedule.tool.jobs_empty'),
        metadata: { count: 0, i18n: i18nMeta('schedule.tool.jobs_empty') },
      };
    }

    const lines = visible.map(
      (job) =>
        `- ${job.startedAt} ${job.trigger} ${job.status} ${job.decision ?? '—'} `
        + `${job.durationMs}ms ${job.error ?? '—'}`,
    );
    return {
      content: lines.join('\n'),
      metadata: { count: visible.length },
    };
  },
};
