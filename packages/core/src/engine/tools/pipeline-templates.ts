/**
 * ADR-101: встроенные тулы шаблонов пайплайнов инстанца — список и
 * инстанцирование в проект.
 *
 * ## Границы
 *
 * - **Шаблоны инстанца читаются без проекта:** это ресурс инстанса, а не
 *   проекта, поэтому `pipeline_templates` работает по одному рантайму.
 * - **Инстанцирование — в проект сессии.** Аргумент `project_id` у тула **не
 *   принимается**: подсунуть чужой проект нельзя (ADR-075). Гейт — право
 *   изменения содержимого проекта (`canEditProject`): `VIEWER` читает, но не
 *   мутирует (инвариант 21).
 * - **Логика шаблонов — в движке** (`engine/pipelines/authoring.ts`:
 *   `listPipelineTemplates`/`instantiatePipelineFromTemplate`) — там же, откуда
 *   её берёт HTTP-роут: два контура не должны разойтись.
 * - Тексты — только через ключи `shared/i18n` (ADR-041).
 */
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition, ToolResult } from '@itphx/synth-shared';
import {
  instantiatePipelineFromTemplate,
  listPipelineTemplates,
} from '../pipelines/authoring.js';
import { getAutomation, depsUnavailable, ensureCanEdit, loadAutomationScope } from './automation-helpers.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

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

// ───────────────────────────── pipeline_templates ─────────────────────────────

const pipelineTemplatesSchema = z.object({});

export const pipelineTemplatesTool: ToolDefinition = {
  name: 'pipeline_templates',
  description:
    'List the pipeline templates of the instance: the templates of the new ADR-101 format and '
    + 'the legacy definitions of extension packs (the format is shown for each of them). '
    + 'Templates are instance resources — no project is needed.',
  parameters: pipelineTemplatesSchema,
  capabilities: [ToolCapability.PIPELINE],
  async execute(_args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    // Шаблоны инстанца — проект не нужен: нужен только рантайм (порты).
    const automation = getAutomation(ctx);
    if (!automation) return depsUnavailable(this.name);
    const pipelines = automation.pipelines;
    if (!pipelines) return depsUnavailable(this.name);

    const templates = await listPipelineTemplates({
      pipelines,
      ...(automation.templates ? { templates: automation.templates } : {}),
    });
    if (templates.length === 0) {
      return {
        content: sm('pipeline.tool.templates_empty'),
        metadata: { count: 0, i18n: i18nMeta('pipeline.tool.templates_empty') },
      };
    }

    const lines = templates.map((template) => `- ${template.id} «${template.name}» (${template.format})`);
    return {
      content: lines.join('\n'),
      metadata: { count: templates.length },
    };
  },
};

// ──────────────────────────── pipeline_instantiate ────────────────────────────

const pipelineInstantiateSchema = z.object({
  template_id: z.string().min(1).describe('Id of the template'),
  name: z.string().min(1).optional().describe('Name of the new pipeline'),
  ensure: z
    .boolean()
    .optional()
    .describe(
      'Do not create a copy if the project already has a pipeline created from this template',
    ),
});

export const pipelineInstantiateTool: ToolDefinition = {
  name: 'pipeline_instantiate',
  description:
    'Create a draft pipeline of the current project from an instance template. The template is '
    + 'copied into the project as a draft (it still has to be published before it can be run). '
    + 'With ensure the call is idempotent: an existing pipeline of the same template is returned '
    + 'instead of a copy. Requires write access to the project.',
  parameters: pipelineInstantiateSchema,
  capabilities: [ToolCapability.PIPELINE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argError(this.name, parsed.error.issues);
    }
    const params = parsed.data as { template_id: string; name?: string; ensure?: boolean };

    const scope = await loadAutomationScope(ctx, this.name);
    if (!scope.ok) return scope.result;
    const denied = ensureCanEdit(scope, this.name);
    if (denied) return denied;
    const pipelines = scope.automation.pipelines;
    if (!pipelines) return depsUnavailable(this.name);

    const result = await instantiatePipelineFromTemplate({
      pipelines,
      ...(scope.automation.templates ? { templates: scope.automation.templates } : {}),
      templateId: params.template_id,
      projectId: scope.project.id,
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.ensure !== undefined ? { ensure: params.ensure } : {}),
    });

    if (!result.ok) {
      if (result.reason === 'template_not_found') {
        return {
          content: sm('pipeline.tool.template_not_found', { id: params.template_id }),
          isError: true,
          metadata: { i18n: i18nMeta('pipeline.tool.template_not_found', { id: params.template_id }) },
        };
      }
      const problems = (result.problems ?? []).join('; ');
      return {
        content: sm('pipeline.tool.template_unsupported', { id: params.template_id, problems }),
        isError: true,
        metadata: {
          i18n: i18nMeta('pipeline.tool.template_unsupported', {
            id: params.template_id,
            problems,
          }),
        },
      };
    }

    return {
      content: sm('pipeline.tool.instantiated', { id: result.pipeline.id }),
      metadata: {
        pipelineId: result.pipeline.id,
        templateId: params.template_id,
        created: result.created,
        i18n: i18nMeta('pipeline.tool.instantiated', { id: result.pipeline.id }),
      },
    };
  },
};
