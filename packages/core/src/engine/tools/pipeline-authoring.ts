/**
 * ADR-101: встроенные тулы пайплайнов проекта — **чтение и авторство**.
 *
 * Пять тулов: `pipeline_list`, `pipeline_get`, `pipeline_save`,
 * `pipeline_publish`, `pipeline_delete`. Они дают агенту возможность вести
 * спецификацию пайплайна проекта (черновик → публикация версии → удаление)
 * без обращения к HTTP API.
 *
 * ## Границы
 *
 * - **Проект — только из сессии.** Аргумент `project_id` у тулов **не
 *   принимается**: подсунуть чужой проект нельзя (та же политика, что у
 *   `project_update`/`project_workspace_set`, ADR-075).
 * - **Мутации — по правам проекта.** `save`/`publish`/`delete` требуют права
 *   изменения содержимого проекта (`canEditProject`: владелец/`EDITOR`);
 *   read-уровень (`VIEWER`) только читает (инвариант 21).
 * - **Пайплайн чужого проекта не раскрывается.** Запись с другим
 *   `projectId` (или с `scope:'instance'`) выглядит как отсутствующая —
 *   `pipeline.tool.not_found`.
 * - **Версионирование — общими авторскими операциями** движка
 *   (`engine/pipelines/authoring.ts`): bump черновика, идемпотентность
 *   публикации и префикс id живут в одном месте с HTTP-роутом
 *   (`server/routes/pipeline-project-routes.ts`) — два разных поведения
 *   авторства невозможны.
 * - Тексты — только через ключи `shared/i18n` (ADR-041).
 */
import { z } from 'zod';
import { ToolCapability, pipelineSpecSchema, validatePipelineSpec } from '@itphx/synth-shared';
import type { ToolDefinition, ToolResult } from '@itphx/synth-shared';
import type { PipelineRecord, ProjectPipelineRepository } from '../../storage/ports/index.js';
import {
  PipelineAuthoringError,
  createPipelineDraft,
  deletePipeline,
  publishPipeline,
  updatePipelineDraft,
} from '../pipelines/authoring.js';
import type { AutomationRuntime } from './automation-runtime.js';
import { resolveSessionUserId } from './project-access.js';
import {
  depsUnavailable,
  ensureCanEdit,
  loadAutomationScope,
} from './automation-helpers.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

/**
 * Спецификация в теле тула: серверные поля (`id`/`version`/`status`/
 * `projectId`) необязательны — их проставляет сервер (иначе модель могла бы
 * сослаться на чужой проект или выдать «свою» версию).
 */
const pipelineSpecArgSchema = pipelineSpecSchema.partial({
  id: true,
  version: true,
  status: true,
  projectId: true,
});

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

/** Единый отказ «некорректная спецификация» (список проблем). */
function invalidSpec(problems: string[]): ToolResult {
  const text = problems.join('; ');
  return {
    content: sm('pipeline.tool.invalid_spec', { problems: text }),
    isError: true,
    metadata: { i18n: i18nMeta('pipeline.tool.invalid_spec', { problems: text }) },
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

/**
 * Пайплайн проекта по id.
 *
 * `null` — такого пайплайна нет **или** он принадлежит другому проекту
 * (существование чужого ресурса не раскрывается — тот же 404-на-границе,
 * что у HTTP-роута).
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

// ─────────────────────────────── pipeline_list ───────────────────────────────

const pipelineListSchema = z.object({});

export const pipelineListTool: ToolDefinition = {
  name: 'pipeline_list',
  description:
    'List the pipelines of the current project with their draft and published versions. '
    + 'Pipelines belong to the project of the session; the project cannot be chosen by argument.',
  parameters: pipelineListSchema,
  capabilities: [ToolCapability.PIPELINE],
  async execute(_args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const scope = await loadAutomationScope(ctx, this.name);
    if (!scope.ok) return scope.result;
    const port = pipelinesPort(scope.automation, this.name);
    if (!port.ok) return port.result;

    const records = await port.pipelines.listPipelines({
      scope: 'project',
      projectId: scope.project.id,
    });
    if (records.length === 0) {
      return {
        content: sm('pipeline.tool.list_empty'),
        metadata: { count: 0, projectId: scope.project.id, i18n: i18nMeta('pipeline.tool.list_empty') },
      };
    }

    const lines = records.map(
      (record) =>
        `- ${record.id} «${record.name}» — draft v${record.draftVersion}, published v${record.publishedVersion ?? '—'}`,
    );
    return {
      content: lines.join('\n'),
      metadata: { count: records.length, projectId: scope.project.id },
    };
  },
};

// ─────────────────────────────── pipeline_get ────────────────────────────────

const pipelineGetSchema = z.object({
  pipeline_id: z.string().min(1).describe('Id of the pipeline'),
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Published version to show (default: the latest published one)'),
});

export const pipelineGetTool: ToolDefinition = {
  name: 'pipeline_get',
  description:
    'Show one pipeline of the current project: its draft specification, the published version '
    + '(a specific one or the latest published) and the problems found in the draft. '
    + 'A pipeline of another project is reported as not found.',
  parameters: pipelineGetSchema,
  capabilities: [ToolCapability.PIPELINE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argError(this.name, parsed.error.issues);
    }
    const params = parsed.data as { pipeline_id: string; version?: number };

    const scope = await loadAutomationScope(ctx, this.name);
    if (!scope.ok) return scope.result;
    const port = pipelinesPort(scope.automation, this.name);
    if (!port.ok) return port.result;

    const record = await loadProjectPipeline(port.pipelines, scope.project.id, params.pipeline_id);
    if (!record) return pipelineNotFound(params.pipeline_id);

    // Опубликованная версия: запрошенная — иначе последняя опубликованная.
    let publishedVersion = record.publishedVersion;
    let published = null;
    if (params.version !== undefined) {
      publishedVersion = params.version;
      published = await port.pipelines.getVersion(record.id, params.version);
      if (!published) {
        return {
          content: sm('pipeline.tool.not_published', { id: record.id }),
          isError: true,
          metadata: { i18n: i18nMeta('pipeline.tool.not_published', { id: record.id }) },
        };
      }
    } else if (record.publishedVersion !== undefined) {
      published = await port.pipelines.getVersion(record.id, record.publishedVersion);
    }

    const draft = record.draft ?? null;
    const validation = draft ? validatePipelineSpec(draft) : { ok: true as const };
    const problems = validation.ok ? [] : validation.problems;

    const lines: string[] = [
      `Pipeline «${record.name}» (${record.id}) — draft v${record.draftVersion}, published v${publishedVersion ?? '—'}`,
      JSON.stringify(
        {
          pipeline: {
            id: record.id,
            name: record.name,
            description: record.description ?? null,
            draftVersion: record.draftVersion,
            publishedVersion: record.publishedVersion ?? null,
            updatedAt: record.updatedAt,
          },
          draft,
          published,
        },
        null,
        2,
      ),
    ];
    if (problems.length > 0) {
      lines.push('Problems:');
      for (const problem of problems) lines.push(`- ${problem}`);
    }

    return {
      content: lines.join('\n'),
      metadata: {
        pipelineId: record.id,
        ...(publishedVersion !== undefined ? { version: publishedVersion } : {}),
      },
    };
  },
};

// ─────────────────────────────── pipeline_save ───────────────────────────────

const pipelineSaveSchema = z.object({
  pipeline_id: z
    .string()
    .min(1)
    .optional()
    .describe('Id of the pipeline to update (omit to create a new draft)'),
  name: z.string().min(1).optional().describe('Name of the pipeline'),
  description: z.string().optional().describe('Description of the pipeline'),
  spec: pipelineSpecArgSchema.describe('Pipeline specification (draft)'),
});

export const pipelineSaveTool: ToolDefinition = {
  name: 'pipeline_save',
  description:
    'Create or update the draft specification of a pipeline of the current project. '
    + 'Without pipeline_id a new draft is created; with it the existing draft is replaced '
    + 'without bumping the version. Publishing is a separate step (pipeline_publish). '
    + 'Requires write access to the project.',
  parameters: pipelineSaveSchema,
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
      name?: string;
      description?: string;
      spec: z.infer<typeof pipelineSpecArgSchema>;
    };

    const scope = await loadAutomationScope(ctx, this.name);
    if (!scope.ok) return scope.result;
    const denied = ensureCanEdit(scope, this.name);
    if (denied) return denied;
    const port = pipelinesPort(scope.automation, this.name);
    if (!port.ok) return port.result;

    try {
      let record: PipelineRecord;
      if (params.pipeline_id === undefined) {
        record = await createPipelineDraft({
          pipelines: port.pipelines,
          projectId: scope.project.id,
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.description !== undefined ? { description: params.description } : {}),
          spec: params.spec,
        });
      } else {
        const existing = await loadProjectPipeline(
          port.pipelines,
          scope.project.id,
          params.pipeline_id,
        );
        if (!existing) return pipelineNotFound(params.pipeline_id);
        record = await updatePipelineDraft({
          pipelines: port.pipelines,
          record: existing,
          spec: params.spec,
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.description !== undefined ? { description: params.description } : {}),
        });
      }

      const version = record.draftVersion;
      return {
        content: sm('pipeline.tool.saved', { id: record.id, version: String(version) }),
        metadata: {
          pipelineId: record.id,
          version,
          i18n: i18nMeta('pipeline.tool.saved', { id: record.id, version: String(version) }),
        },
      };
    } catch (err) {
      if (err instanceof PipelineAuthoringError) return invalidSpec(err.problems);
      throw err;
    }
  },
};

// ────────────────────────────── pipeline_publish ──────────────────────────────

const pipelinePublishSchema = z.object({
  pipeline_id: z.string().min(1).describe('Id of the pipeline'),
});

export const pipelinePublishTool: ToolDefinition = {
  name: 'pipeline_publish',
  description:
    'Publish the draft of a pipeline of the current project as an immutable version. '
    + 'Publishing without changes is idempotent — no extra version is created. '
    + 'Requires write access to the project.',
  parameters: pipelinePublishSchema,
  capabilities: [ToolCapability.PIPELINE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argError(this.name, parsed.error.issues);
    }
    const params = parsed.data as { pipeline_id: string };

    const scope = await loadAutomationScope(ctx, this.name);
    if (!scope.ok) return scope.result;
    const denied = ensureCanEdit(scope, this.name);
    if (denied) return denied;
    const port = pipelinesPort(scope.automation, this.name);
    if (!port.ok) return port.result;

    const record = await loadProjectPipeline(port.pipelines, scope.project.id, params.pipeline_id);
    if (!record) return pipelineNotFound(params.pipeline_id);

    try {
      const result = await publishPipeline({
        pipelines: port.pipelines,
        record,
        publishedBy: resolveSessionUserId(scope.session),
      });
      const version = result.published.version;
      return {
        content: sm('pipeline.tool.published', {
          id: result.published.pipelineId,
          version: String(version),
        }),
        metadata: {
          pipelineId: result.published.pipelineId,
          version,
          i18n: i18nMeta('pipeline.tool.published', {
            id: result.published.pipelineId,
            version: String(version),
          }),
        },
      };
    } catch (err) {
      if (err instanceof PipelineAuthoringError) return invalidSpec(err.problems);
      throw err;
    }
  },
};

// ────────────────────────────── pipeline_delete ──────────────────────────────

const pipelineDeleteSchema = z.object({
  pipeline_id: z.string().min(1).describe('Id of the pipeline'),
});

export const pipelineDeleteTool: ToolDefinition = {
  name: 'pipeline_delete',
  description:
    'Delete a pipeline of the current project. Executions of the pipeline are kept. '
    + 'Requires write access to the project.',
  parameters: pipelineDeleteSchema,
  capabilities: [ToolCapability.PIPELINE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argError(this.name, parsed.error.issues);
    }
    const params = parsed.data as { pipeline_id: string };

    const scope = await loadAutomationScope(ctx, this.name);
    if (!scope.ok) return scope.result;
    const denied = ensureCanEdit(scope, this.name);
    if (denied) return denied;
    const port = pipelinesPort(scope.automation, this.name);
    if (!port.ok) return port.result;

    const record = await loadProjectPipeline(port.pipelines, scope.project.id, params.pipeline_id);
    if (!record) return pipelineNotFound(params.pipeline_id);

    const deleted = await deletePipeline({ pipelines: port.pipelines, pipelineId: record.id });
    if (!deleted) return pipelineNotFound(params.pipeline_id);

    return {
      content: sm('pipeline.tool.deleted', { id: record.id }),
      metadata: {
        pipelineId: record.id,
        i18n: i18nMeta('pipeline.tool.deleted', { id: record.id }),
      },
    };
  },
};
