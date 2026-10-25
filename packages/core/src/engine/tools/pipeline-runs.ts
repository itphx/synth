/**
 * ADR-101: встроенные тулы прогонов пайплайна — запуск, статус, список,
 * HITL-решение и отмена.
 *
 * ## Границы
 *
 * - **Проект — только из сессии.** Аргумент `project_id` у тулов **не
 *   принимается**: подсунуть чужой проект нельзя (та же политика, что у
 *   `project_update`/`project_workspace_set`, ADR-075).
 * - **Прогон — только своего проекта.** Прогон чужого проекта выглядит как
 *   чужой (`pipeline.tool.run_foreign`): существование чужого ресурса не
 *   раскрывается.
 * - **Мутации — по правам проекта.** `pipeline_run`/`pipeline_run_resume`/
 *   `pipeline_run_cancel` требуют права изменения содержимого проекта
 *   (`canEditProject`: владелец/`EDITOR`); чтение (`pipeline_run_status`/
 *   `pipeline_run_list`) доступно и `VIEWER` (инвариант 21).
 * - **Запуск — общий реестр активных прогонов** (`engine/pipelines/
 *   run-control.ts`): soft-lock «не запустить второй прогон того же
 *   пайплайна» и отмена идущего прогона работают одинаково для HTTP и для
 *   агента.
 * - Тексты — только через ключи `shared/i18n` (ADR-041).
 */
import { z } from 'zod';
import { ToolCapability, nowISO, pipelineRunStatusSchema } from '@itphx/synth-shared';
import type { ToolDefinition, ToolResult } from '@itphx/synth-shared';
import type {
  PipelineRunRecord,
  PipelineRunRepository,
  PipelineRecord,
  ProjectPipelineRepository,
} from '../../storage/ports/index.js';
import { PipelineEngineError } from '../pipelines/types.js';
import type { AutomationRuntime } from './automation-runtime.js';
import {
  depsUnavailable,
  ensureCanEdit,
  loadAutomationScope,
} from './automation-helpers.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

/** Дефолтный размер выборки журнала/списка прогонов. */
const DEFAULT_LIMIT = 20;

/** Абсолютный потолок выборки журнала/списка прогонов. */
const MAX_LIMIT = 100;

/** Потолок длины payload'а события в тексте журнала. */
const MAX_PAYLOAD_CHARS = 200;

/**
 * Статусы, в которых прогон **завершён**: отменять или ждать решения в них
 * нечего.
 */
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

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

/** Единый отказ «пайплайн не найден» (нет такого или он чужой). */
function pipelineNotFound(pipelineId: string): ToolResult {
  return {
    content: sm('pipeline.tool.not_found', { id: pipelineId }),
    isError: true,
    metadata: { i18n: i18nMeta('pipeline.tool.not_found', { id: pipelineId }) },
  };
}

/** Единый отказ «у пайплайна нет опубликованной версии». */
function notPublished(pipelineId: string): ToolResult {
  return {
    content: sm('pipeline.tool.not_published', { id: pipelineId }),
    isError: true,
    metadata: { i18n: i18nMeta('pipeline.tool.not_published', { id: pipelineId }) },
  };
}

/** Единый отказ «прогон не найден». */
function runNotFound(runId: string): ToolResult {
  return {
    content: sm('pipeline.tool.run_not_found', { id: runId }),
    isError: true,
    metadata: { i18n: i18nMeta('pipeline.tool.run_not_found', { id: runId }) },
  };
}

/** Единый отказ «прогон чужого проекта» (существование не раскрывается). */
function runForeign(runId: string): ToolResult {
  return {
    content: sm('pipeline.tool.run_foreign', { id: runId }),
    isError: true,
    metadata: { i18n: i18nMeta('pipeline.tool.run_foreign', { id: runId }) },
  };
}

/**
 * Единый отказ «прогон не ждёт решения / уже завершён» — с текущим
 * статусом (по нему модель понимает, что делать дальше).
 */
function runNotWaiting(runId: string, status: string): ToolResult {
  return {
    content: sm('pipeline.tool.run_not_waiting', { id: runId, status }),
    isError: true,
    metadata: { i18n: i18nMeta('pipeline.tool.run_not_waiting', { id: runId, status }) },
  };
}

/** Единый отказ «по пайплайну уже идёт прогон» (soft-lock). */
function alreadyRunning(pipelineId: string): ToolResult {
  return {
    content: sm('pipeline.tool.already_running', { id: pipelineId }),
    isError: true,
    metadata: { i18n: i18nMeta('pipeline.tool.already_running', { id: pipelineId }) },
  };
}

/** Порт спецификаций пайплайнов (или отказ «рантайм недоступен»). */
function pipelinesPort(
  automation: AutomationRuntime,
  toolName: string,
): { ok: true; pipelines: ProjectPipelineRepository } | { ok: false; result: ToolResult } {
  const pipelines = automation.pipelines;
  if (!pipelines) return { ok: false, result: depsUnavailable(toolName) };
  return { ok: true, pipelines };
}

/** Порт прогонов и журнала (или отказ «рантайм недоступен»). */
function runsPort(
  automation: AutomationRuntime,
  toolName: string,
): { ok: true; runs: PipelineRunRepository } | { ok: false; result: ToolResult } {
  const runs = automation.runs;
  if (!runs) return { ok: false, result: depsUnavailable(toolName) };
  return { ok: true, runs };
}

/**
 * Пайплайн проекта по id.
 *
 * `null` — такого пайплайна нет **или** он принадлежит другому проекту
 * (существование чужого ресурса не раскрывается).
 */
async function loadProjectPipeline(
  pipelines: ProjectPipelineRepository,
  projectId: string,
  pipelineId: string,
): Promise<PipelineRecord | null> {
  const record = await pipelines.getPipeline(pipelineId);
  if (!record || record.scope !== 'project' || record.projectId !== projectId) return null;
  return record;
}

/** Привести `limit` к допустимому виду: дефолт 20, потолок 100. */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/** Payload события журнала — кратко (обрезан по длине). */
function summarizePayload(payload: Record<string, unknown> | undefined): string {
  if (!payload || Object.keys(payload).length === 0) return '';
  const text = JSON.stringify(payload);
  return text.length > MAX_PAYLOAD_CHARS ? `${text.slice(0, MAX_PAYLOAD_CHARS)}…` : text;
}

/** Ошибка движка → отказ тула (текст ошибки уже локализован движком). */
function engineFailure(err: PipelineEngineError, metadata: Record<string, unknown>): ToolResult {
  return {
    content: err.message,
    isError: true,
    metadata: { ...metadata, code: err.code },
  };
}

// ─────────────────────────────── pipeline_run ───────────────────────────────

const pipelineRunSchema = z.object({
  pipeline_id: z.string().min(1).describe('Id of the pipeline'),
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Published version to run (default: the latest published one)'),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Input data of the run (goes to the trigger payload)'),
});

export const pipelineRunTool: ToolDefinition = {
  name: 'pipeline_run',
  description:
    'Start a run of a published pipeline of the current project. The run goes in the background: '
    + 'the result contains the run id, its status and the id of the started pipeline. '
    + 'A pipeline without a published version cannot be started, and a second run of the same '
    + 'pipeline is rejected while the first one is still running. '
    + 'Requires write access to the project.',
  parameters: pipelineRunSchema,
  capabilities: [ToolCapability.PIPELINE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argError(this.name, parsed.error.issues);
    }
    const params = parsed.data as { pipeline_id: string; version?: number; input?: Record<string, unknown> };

    const scope = await loadAutomationScope(ctx, this.name);
    if (!scope.ok) return scope.result;
    const denied = ensureCanEdit(scope, this.name);
    if (denied) return denied;
    const port = pipelinesPort(scope.automation, this.name);
    if (!port.ok) return port.result;
    const runPort = runsPort(scope.automation, this.name);
    if (!runPort.ok) return runPort.result;
    const { engine, runControl } = scope.automation;
    if (!engine || !runControl) return depsUnavailable(this.name);

    const record = await loadProjectPipeline(port.pipelines, scope.project.id, params.pipeline_id);
    if (!record) return pipelineNotFound(params.pipeline_id);

    // Запускать можно только **опубликованную** версию (ADR-101 §2.8).
    const version = params.version ?? record.publishedVersion;
    if (version === undefined) return notPublished(record.id);
    if (!(await port.pipelines.getVersion(record.id, version))) return notPublished(record.id);

    try {
      const started = await runControl.startRun({
        engine,
        runs: runPort.runs,
        pipelineId: record.id,
        version,
        projectId: scope.project.id,
        trigger: { kind: 'manual' },
        ...(params.input ? { input: params.input } : {}),
      });
      return {
        content: sm('pipeline.tool.run_started', { run_id: started.run.id }),
        metadata: {
          runId: started.run.id,
          pipelineId: record.id,
          status: started.run.status,
          i18n: i18nMeta('pipeline.tool.run_started', { run_id: started.run.id }),
        },
      };
    } catch (err) {
      if (err instanceof PipelineEngineError) {
        if (err.code === 'pipeline.already_running') return alreadyRunning(record.id);
        return engineFailure(err, { pipelineId: record.id });
      }
      throw err;
    }
  },
};

// ──────────────────────────── pipeline_run_status ────────────────────────────

const pipelineRunStatusSchemaParams = z.object({
  run_id: z.string().min(1).describe('Id of the run'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('How many journal events to show (default 20, max 100)'),
});

export const pipelineRunStatusTool: ToolDefinition = {
  name: 'pipeline_run_status',
  description:
    'Show one pipeline run of the current project: its status, the current node, the error and '
    + 'the execution journal (the last events). A run of another project is reported as foreign.',
  parameters: pipelineRunStatusSchemaParams,
  capabilities: [ToolCapability.PIPELINE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argError(this.name, parsed.error.issues);
    }
    const params = parsed.data as { run_id: string; limit?: number };

    const scope = await loadAutomationScope(ctx, this.name);
    if (!scope.ok) return scope.result;
    const runPort = runsPort(scope.automation, this.name);
    if (!runPort.ok) return runPort.result;

    const run = await runPort.runs.getRun(params.run_id);
    if (!run) return runNotFound(params.run_id);
    if (run.projectId !== scope.project.id) return runForeign(params.run_id);

    const limit = resolveLimit(params.limit);
    const events = await runPort.runs.listEvents(run.id, { limit });

    const lines: string[] = [
      `Run ${run.id} — pipeline ${run.pipelineId} v${run.version}, status: ${run.status}, node: ${run.currentNode ?? '—'}`,
    ];
    if (run.error) lines.push(`Error: ${run.error}`);
    if (events.length === 0) {
      lines.push('Journal: empty');
    } else {
      lines.push('Journal:');
      for (const event of events) {
        const payload = summarizePayload(event.payload);
        lines.push(`- ${event.ts} ${event.type}${payload ? ` ${payload}` : ''}`);
      }
    }

    return {
      content: lines.join('\n'),
      metadata: { runId: run.id, status: run.status },
    };
  },
};

// ───────────────────────────── pipeline_run_list ─────────────────────────────

const pipelineRunListSchema = z.object({
  pipeline_id: z
    .string()
    .min(1)
    .optional()
    .describe('Only runs of this pipeline (a pipeline of the current project)'),
  status: pipelineRunStatusSchema
    .optional()
    .describe('Only runs in this status'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('How many runs to show (default 20, max 100)'),
});

export const pipelineRunListTool: ToolDefinition = {
  name: 'pipeline_run_list',
  description:
    'List the pipeline runs of the current project (freshest first), optionally filtered by '
    + 'pipeline id and status. A pipeline of another project is reported as not found.',
  parameters: pipelineRunListSchema,
  capabilities: [ToolCapability.PIPELINE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argError(this.name, parsed.error.issues);
    }
    const params = parsed.data as {
      pipeline_id?: string;
      status?: z.infer<typeof pipelineRunStatusSchema>;
      limit?: number;
    };

    const scope = await loadAutomationScope(ctx, this.name);
    if (!scope.ok) return scope.result;
    const runPort = runsPort(scope.automation, this.name);
    if (!runPort.ok) return runPort.result;

    // Фильтр по пайплайну: чужой пайплайн выглядит как отсутствующий.
    if (params.pipeline_id !== undefined) {
      const port = pipelinesPort(scope.automation, this.name);
      if (!port.ok) return port.result;
      const record = await loadProjectPipeline(port.pipelines, scope.project.id, params.pipeline_id);
      if (!record) return pipelineNotFound(params.pipeline_id);
    }

    const limit = resolveLimit(params.limit);
    const runs = await runPort.runs.listRuns({
      projectId: scope.project.id,
      ...(params.pipeline_id !== undefined ? { pipelineId: params.pipeline_id } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
      limit,
    });
    if (runs.length === 0) {
      return {
        content: sm('pipeline.tool.runs_empty'),
        metadata: { count: 0, i18n: i18nMeta('pipeline.tool.runs_empty') },
      };
    }

    const lines = runs.map(
      (run) =>
        `- ${run.id} — ${run.pipelineId} v${run.version}, status: ${run.status}, node: ${run.currentNode ?? '—'}`,
    );
    return {
      content: lines.join('\n'),
      metadata: { count: runs.length },
    };
  },
};

// ──────────────────────────── pipeline_run_resume ────────────────────────────

const pipelineRunResumeSchema = z.object({
  run_id: z.string().min(1).describe('Id of the run'),
  approved: z.boolean().describe('Approve the pending human step (true) or reject it (false)'),
  output: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Data passed to the step after the gate'),
  comment: z.string().optional().describe('Comment of the operator (written to the journal)'),
});

export const pipelineRunResumeTool: ToolDefinition = {
  name: 'pipeline_run_resume',
  description:
    'Apply a human decision to a pipeline run that waits for it (status awaiting_human): '
    + 'approve or reject the pending step, optionally with data and a comment. '
    + 'A run in another status is rejected. Requires write access to the project.',
  parameters: pipelineRunResumeSchema,
  capabilities: [ToolCapability.PIPELINE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argError(this.name, parsed.error.issues);
    }
    const params = parsed.data as {
      run_id: string;
      approved: boolean;
      output?: Record<string, unknown>;
      comment?: string;
    };

    const scope = await loadAutomationScope(ctx, this.name);
    if (!scope.ok) return scope.result;
    const denied = ensureCanEdit(scope, this.name);
    if (denied) return denied;
    const runPort = runsPort(scope.automation, this.name);
    if (!runPort.ok) return runPort.result;
    const { engine } = scope.automation;
    if (!engine) return depsUnavailable(this.name);

    const run = await runPort.runs.getRun(params.run_id);
    if (!run) return runNotFound(params.run_id);
    if (run.projectId !== scope.project.id) return runForeign(params.run_id);
    if (run.status !== 'awaiting_human') return runNotWaiting(run.id, run.status);

    try {
      const updated = await engine.resume(run.id, {
        approved: params.approved,
        ...(params.output ? { output: params.output } : {}),
        ...(params.comment ? { comment: params.comment } : {}),
      });
      return {
        content: sm('pipeline.tool.run_resumed', { run_id: run.id }),
        metadata: {
          runId: run.id,
          status: updated.status,
          i18n: i18nMeta('pipeline.tool.run_resumed', { run_id: run.id }),
        },
      };
    } catch (err) {
      if (err instanceof PipelineEngineError) {
        if (err.code === 'pipeline.invalid_state') return runNotWaiting(run.id, run.status);
        return engineFailure(err, { runId: run.id });
      }
      throw err;
    }
  },
};

// ───────────────────────────── pipeline_run_cancel ─────────────────────────────

const pipelineRunCancelSchema = z.object({
  run_id: z.string().min(1).describe('Id of the run'),
});

export const pipelineRunCancelTool: ToolDefinition = {
  name: 'pipeline_run_cancel',
  description:
    'Cancel a pipeline run of the current project: a run that is still executing is aborted, '
    + 'a run that waits for a human decision is marked as cancelled. '
    + 'A finished run cannot be cancelled. Requires write access to the project.',
  parameters: pipelineRunCancelSchema,
  capabilities: [ToolCapability.PIPELINE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argError(this.name, parsed.error.issues);
    }
    const params = parsed.data as { run_id: string };

    const scope = await loadAutomationScope(ctx, this.name);
    if (!scope.ok) return scope.result;
    const denied = ensureCanEdit(scope, this.name);
    if (denied) return denied;
    const runPort = runsPort(scope.automation, this.name);
    if (!runPort.ok) return runPort.result;
    const { runControl } = scope.automation;
    if (!runControl) return depsUnavailable(this.name);

    const run = await runPort.runs.getRun(params.run_id);
    if (!run) return runNotFound(params.run_id);
    if (run.projectId !== scope.project.id) return runForeign(params.run_id);
    if (TERMINAL_STATUSES.has(run.status)) return runNotWaiting(run.id, run.status);

    // Идущий в этом процессе прогон — отменяем через общий реестр активных
    // прогонов (ADR-101 `run-control.ts`): тот же механизм, что у HTTP-роута.
    const final = await runControl.cancelAndWait(run.id);
    if (final) {
      return {
        content: sm('pipeline.tool.run_cancelled', { run_id: run.id }),
        metadata: {
          runId: run.id,
          status: final.status,
          i18n: i18nMeta('pipeline.tool.run_cancelled', { run_id: run.id }),
        },
      };
    }

    // Прогона нет в реестре этого процесса (пауза HITL или запуск в другом
    // процессе) — помечаем его отменённым в порту, как это делает HTTP-роут.
    runControl.cancelRun(run.id);
    const now = nowISO();
    const cancelled: PipelineRunRecord = {
      ...run,
      status: 'cancelled',
      finishedAt: now,
      updatedAt: now,
      error: 'pipeline.cancelled',
    };
    await runPort.runs.saveRun(cancelled);
    await runPort.runs.appendEvent({
      runId: run.id,
      ts: now,
      type: 'run.failed',
      payload: { code: 'pipeline.cancelled' },
    });
    return {
      content: sm('pipeline.tool.run_cancelled', { run_id: run.id }),
      metadata: {
        runId: run.id,
        status: cancelled.status,
        i18n: i18nMeta('pipeline.tool.run_cancelled', { run_id: run.id }),
      },
    };
  },
};
