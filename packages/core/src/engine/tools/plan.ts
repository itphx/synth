import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type {
  ToolDefinition,
  ProjectPlan,
} from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';
import type { ProjectStoreContract } from '../../storage/project-store.js';
import { isAborted, abortedResult } from './abort.js';
import { canEditProject } from './project-access.js';
import { loadSessionProject } from './project-manage.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import { embedMultiline } from '../markdown.js';
import {
  PlanService,
  PlanColumnNotFoundError,
  PlanItemNotFoundError,
  PlanLimitExceededError,
  PlanValidationError,
  getPlan,
} from '../plan/service.js';
import { publishPlanUpdated } from '../plan/events.js';

export interface PlanToolExtra {
  sessionManager?: SessionManager;
  eventBus?: EventBus;
  sessionId?: string;
  projectStore?: ProjectStoreContract;
}

const PLAN_PRIORITIES = ['high', 'medium', 'low'] as const;
const DEPENDENCY_RELATIONS = ['blocked_by', 'blocks', 'relates_to'] as const;

/**
 * Markdown-представление плана: заголовок, затем по колонкам (в порядке order)
 * список пунктов `[priority] title` (+ description и зависимости при наличии).
 */
export function renderPlanMarkdown(plan: ProjectPlan): string {
  const lines: string[] = [sm('plan.markdown_title', { version: String(plan.version) })];
  const columns = [...plan.columns].sort((a, b) => a.order - b.order);

  if (plan.items.length === 0) {
    lines.push('');
    lines.push(sm('plan.markdown_empty'));
    return lines.join('\n');
  }

  for (const col of columns) {
    const colItems = plan.items
      .filter((i) => i.columnId === col.id)
      .sort((a, b) => a.order - b.order);
    lines.push('');
    lines.push(`## ${col.name}`);
    if (colItems.length === 0) {
      lines.push(sm('plan.markdown_column_empty'));
      continue;
    }
    for (const item of colItems) {
      lines.push(`- [${item.priority}] ${item.title}`);
      if (item.description) {
        // Многострочное описание — с отступом продолжения, иначе переводы строк
        // разрывают внешний список (PROP-054, «Markdown»).
        lines.push(embedMultiline('  - ', item.description, '    '));
      }
      if (item.dependsOn.length > 0) {
        const deps = item.dependsOn
          .map((d) => `${d.relation}: ${d.projectId ? `${d.projectId}/` : ''}${d.itemId}`)
          .join(', ');
        lines.push(sm('plan.markdown_dependencies', { deps }));
      }
    }
  }
  return lines.join('\n');
}

async function updateSessionMode(
  sessionManager: SessionManager,
  sessionId: string,
  patch: { mode: 'plan' | 'act'; planApproved?: boolean },
): Promise<boolean> {
  try {
    await sessionManager.withLock(sessionId, async (s) => {
      s.mode = patch.mode;
      if (patch.planApproved !== undefined) s.planApproved = patch.planApproved;
      await sessionManager.saveSession(s);
    });
    return true;
  } catch {
    return false;
  }
}

export const planEnterTool: ToolDefinition = {
  name: 'plan_enter',
  description:
    'Enter plan mode: all file writes (write_file, edit_file, create_directory, delete_file) are blocked. '
    + 'Use it for complex tasks that require investigation and a written plan before making changes. '
    + 'Work with the project plan via plan_read/plan_write. Finish via plan_exit to switch back to act mode.',
  parameters: z.object({}).describe('No parameters required'),
  capabilities: [ToolCapability.RUNTIME],
  async execute(_args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const extra = ctx.extra as PlanToolExtra | undefined;
    if (!extra?.sessionManager || !extra.sessionId) {
      return {
        content: sm('plan.session_manager_unavailable', { tool: 'plan_enter' }),
        isError: true,
        metadata: { i18n: i18nMeta('plan.session_manager_unavailable', { tool: 'plan_enter' }) },
      };
    }
    const ok = await updateSessionMode(extra.sessionManager, extra.sessionId, { mode: 'plan' });
    if (!ok) {
      return { content: sm('plan.enter_failed'), isError: true, metadata: { i18n: i18nMeta('plan.enter_failed') } };
    }
    return {
      content: sm('plan.enter_success'),
      metadata: { mode: 'plan', i18n: i18nMeta('plan.enter_success') },
    };
  },
};

export const planExitTool: ToolDefinition = {
  name: 'plan_exit',
  description:
    'Approve the current plan: switches the session back to act mode (writes allowed) and marks the plan as approved. '
    + 'The plan itself lives in the project (managed via plan_write) and is not passed as an argument here.',
  parameters: z.object({}).describe('No parameters required'),
  capabilities: [ToolCapability.RUNTIME],
  async execute(_args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const extra = ctx.extra as PlanToolExtra | undefined;
    if (!extra?.sessionManager || !extra.sessionId) {
      return { content: sm('plan.session_manager_unavailable', { tool: 'plan_exit' }), isError: true, metadata: { i18n: i18nMeta('plan.session_manager_unavailable', { tool: 'plan_exit' }) } };
    }

    const ok = await updateSessionMode(extra.sessionManager, extra.sessionId, {
      mode: 'act',
      planApproved: true,
    });
    if (!ok) {
      return { content: sm('plan.exit_failed'), isError: true, metadata: { i18n: i18nMeta('plan.exit_failed') } };
    }

    let projectId = '';
    try {
      const session = await extra.sessionManager.getSession(extra.sessionId);
      projectId = session?.projectId ?? '';
    } catch {
      // проект не определить — событие публикуем с пустым project_id
    }

    extra.eventBus?.publish(extra.sessionId, 'plan.approved', {
      session_id: extra.sessionId,
      project_id: projectId,
    });

    return {
      content: sm('plan.exit_success'),
      metadata: { mode: 'act', plan_approved: true, i18n: i18nMeta('plan.exit_success') },
    };
  },
};

export const planReadTool: ToolDefinition = {
  name: 'plan_read',
  description:
    'Read the current project plan as markdown. Returns a kanban-style view grouped by columns. '
    + 'The plan is bound to the project — if the session has no project, the plan is unavailable.',
  parameters: z.object({}),
  capabilities: [ToolCapability.RUNTIME],
  async execute(_args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const { project } = await loadSessionProject(ctx);
    if (!project) {
      return { content: sm('plan.no_project_read'), metadata: { i18n: i18nMeta('plan.no_project_read') } };
    }
    const plan = getPlan(project);
    return { content: renderPlanMarkdown(plan), metadata: { plan } };
  },
};

export const planListTool: ToolDefinition = {
  name: 'plan_list',
  description:
    'Return the current project plan as a structured JSON: { version, updatedAt, columns: [...], items: [...] } '
    + '(the full ProjectPlan). The plan is bound to the project.',
  parameters: z.object({}),
  capabilities: [ToolCapability.RUNTIME],
  async execute(_args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const { project } = await loadSessionProject(ctx);
    if (!project) {
      return {
        content: sm('plan.no_project_read'),
        isError: true,
      };
    }
    const plan = getPlan(project);
    return { content: JSON.stringify(plan), metadata: { plan } };
  },
};

const planDependencySchema = z.object({
  projectId: z.string().optional().describe('Project id of the dependency (empty = the same project)'),
  itemId: z.string().describe('Id of the plan item the current item depends on'),
  relation: z.enum(DEPENDENCY_RELATIONS).describe('Dependency relation type'),
});

const planWriteSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create_item'),
    title: z.string().min(1).describe('Item title'),
    description: z.string().optional().describe('Item description (Markdown)'),
    columnId: z.string().optional().describe('Target column id (default: backlog)'),
    priority: z.enum(PLAN_PRIORITIES).optional().describe('Item priority (default: medium)'),
    dependsOn: z.array(planDependencySchema).optional().describe('Item dependencies'),
    tags: z.array(z.string()).optional().describe('Item tags'),
  }),
  z.object({
    action: z.literal('update_item'),
    itemId: z.string().describe('Item id to update'),
    title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New description (Markdown)'),
    priority: z.enum(PLAN_PRIORITIES).optional().describe('New priority'),
    tags: z.array(z.string()).optional().describe('New tags'),
  }),
  z.object({
    action: z.literal('move_item'),
    itemId: z.string().describe('Item id to move'),
    columnId: z.string().describe('Target column id'),
    order: z.number().optional().describe('Position within the column (0-based)'),
    beforeItemId: z.string().optional().describe('Place the item before this item'),
    afterItemId: z.string().optional().describe('Place the item after this item'),
  }),
  z.object({
    action: z.literal('delete_item'),
    itemId: z.string().describe('Item id to delete'),
  }),
  z.object({
    action: z.literal('set_dependencies'),
    itemId: z.string().describe('Item id'),
    dependsOn: z.array(planDependencySchema).describe('Full list of dependencies (replaces existing)'),
  }),
  z.object({
    action: z.literal('add_column'),
    name: z.string().min(1).describe('Column name'),
    wipLimit: z.number().optional().describe('Work-in-progress limit'),
  }),
  z.object({
    action: z.literal('update_column'),
    columnId: z.string().describe('Column id to update'),
    name: z.string().optional().describe('New column name'),
    wipLimit: z.number().optional().describe('New work-in-progress limit'),
  }),
  z.object({
    action: z.literal('delete_column'),
    columnId: z.string().describe('Column id to delete'),
    moveItemsTo: z.string().describe('Column id to move the items into (must differ from the deleted one)'),
  }),
  z.object({
    action: z.literal('reorder_columns'),
    order: z.array(z.string()).describe('Full list of column ids in the desired order'),
  }),
]);

type PlanWriteInput = z.infer<typeof planWriteSchema>;

/**
 * Компактный итог правки плана: id изменённого объекта + краткая сводка.
 * Полный markdown плана — в `plan_read` (в ответ `plan_write` он не входит:
 * ответ должен быть коротким).
 */
function renderPlanActionSummary(
  params: PlanWriteInput,
  result: ProjectPlan,
): string {
  const lines: string[] = [sm('plan.markdown_title', { version: String(result.version) })];
  const columnName = (id: string): string =>
    result.columns.find((c) => c.id === id)?.name ?? id;
  switch (params.action) {
    case 'create_item': {
      const item = result.items[result.items.length - 1];
      if (item) lines.push(`- ${item.id} [${item.priority}] ${item.title} → ${columnName(item.columnId)}`);
      break;
    }
    case 'update_item': {
      const item = result.items.find((i) => i.id === params.itemId);
      if (item) lines.push(`- ${item.id} [${item.priority}] ${item.title}`);
      break;
    }
    case 'move_item': {
      const item = result.items.find((i) => i.id === params.itemId);
      if (item) lines.push(`- ${item.id} → ${columnName(item.columnId)}`);
      break;
    }
    case 'delete_item': {
      lines.push(`- ${params.itemId} (deleted)`);
      break;
    }
    case 'set_dependencies': {
      const item = result.items.find((i) => i.id === params.itemId);
      lines.push(`- ${params.itemId} (${item?.dependsOn.length ?? 0} deps)`);
      break;
    }
    case 'add_column': {
      const column = result.columns[result.columns.length - 1];
      if (column) lines.push(`- ${column.id} ${column.name}`);
      break;
    }
    case 'update_column': {
      const column = result.columns.find((c) => c.id === params.columnId);
      if (column) lines.push(`- ${column.id} ${column.name}`);
      break;
    }
    case 'delete_column': {
      lines.push(`- ${params.columnId} (deleted, items → ${params.moveItemsTo})`);
      break;
    }
    case 'reorder_columns': {
      const names = [...result.columns]
        .sort((a, b) => a.order - b.order)
        .map((c) => c.name);
      lines.push(names.join(' → '));
      break;
    }
  }
  return lines.join('\n');
}


/**
 * plan_write.
 *
 * ADR-075/D5: запись плана — проектные данные, поэтому применяется тот же гейт
 * `canEditProject` (владелец/редактор), что и к `project_log_write`/
 * `project_invariants_write`. `project.plan` в HTTP-RBAC отнесён к контентным
 * полям (`PUT /api/v2/projects/:id`); в core-standalone `plan_write` — основной
 * путь записи плана.
 */
export const planWriteTool: ToolDefinition = {
  name: 'plan_write',
  description:
    'Modify the project plan (kanban). Actions: '
    + 'create_item (title, description?, columnId?, priority?, dependsOn?, tags?), '
    + 'update_item (itemId, title?, description?, priority?, tags?), '
    + 'move_item (itemId, columnId, beforeItemId?/afterItemId? or order?), delete_item (itemId), '
    + 'set_dependencies (itemId, dependsOn), add_column (name, wipLimit?), '
    + 'update_column (columnId, name?, wipLimit?), delete_column (columnId, moveItemsTo), '
    + 'reorder_columns (order — full list of column ids). '
    + 'Returns a compact summary (id of the changed object and the new plan version); '
    + 'use plan_read for the full plan as markdown. The plan is bound to the project.',
  parameters: planWriteSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as PlanWriteInput;
    const extra = ctx.extra as PlanToolExtra | undefined;
    if (!extra?.projectStore) {
      return { content: sm('plan.project_store_unavailable'), isError: true, metadata: { i18n: i18nMeta('plan.project_store_unavailable') } };
    }

    const { session, project } = await loadSessionProject(ctx);
    if (!project) {
      return { content: sm('plan.no_project'), isError: true, metadata: { i18n: i18nMeta('plan.no_project') } };
    }
    // ADR-075/D5: менять план вправе только владелец/редактор (до мутации).
    if (!canEditProject(session, project)) {
      return {
        content: sm('project.write_forbidden'),
        isError: true,
        metadata: { i18n: i18nMeta('project.write_forbidden') },
      };
    }

    // Доменный сервис плана: атомарный read-modify-write (`ProjectRepository.mutate`),
    // нормализация порядка, версия и лимиты Markdown — одни и те же, что у
    // HTTP-роутов (`/api/v2/projects/:id/plan*`).
    const service = new PlanService(extra.projectStore);
    let savedPlan: ProjectPlan;
    try {
      switch (params.action) {
        case 'create_item':
          savedPlan = await service.createItem(project.id, {
            title: params.title,
            ...(params.description !== undefined ? { description: params.description } : {}),
            ...(params.columnId !== undefined ? { columnId: params.columnId } : {}),
            ...(params.priority !== undefined ? { priority: params.priority } : {}),
            ...(params.dependsOn !== undefined ? { dependsOn: params.dependsOn } : {}),
            ...(params.tags !== undefined ? { tags: params.tags } : {}),
          });
          break;
        case 'update_item':
          savedPlan = await service.updateItem(project.id, params.itemId, {
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.description !== undefined ? { description: params.description } : {}),
            ...(params.priority !== undefined ? { priority: params.priority } : {}),
            ...(params.tags !== undefined ? { tags: params.tags } : {}),
          });
          break;
        case 'move_item':
          savedPlan = await service.moveItem(project.id, params.itemId, {
            columnId: params.columnId,
            ...(params.order !== undefined ? { order: params.order } : {}),
            ...(params.beforeItemId !== undefined ? { beforeItemId: params.beforeItemId } : {}),
            ...(params.afterItemId !== undefined ? { afterItemId: params.afterItemId } : {}),
          });
          break;
        case 'delete_item':
          savedPlan = await service.deleteItem(project.id, params.itemId);
          break;
        case 'set_dependencies':
          savedPlan = await service.updateItem(project.id, params.itemId, {
            dependsOn: params.dependsOn,
          });
          break;
        case 'add_column':
          savedPlan = await service.addColumn(project.id, {
            name: params.name,
            ...(params.wipLimit !== undefined ? { wipLimit: params.wipLimit } : {}),
          });
          break;
        case 'update_column':
          savedPlan = await service.updateColumn(project.id, params.columnId, {
            ...(params.name !== undefined ? { name: params.name } : {}),
            ...(params.wipLimit !== undefined ? { wipLimit: params.wipLimit } : {}),
          });
          break;
        case 'delete_column':
          savedPlan = await service.deleteColumn(project.id, params.columnId, {
            moveItemsTo: params.moveItemsTo,
            // Версия не передаётся: оптимистичная блокировка — механизм
            // HTTP-клиента (UI), у агента правка всегда «свежая».
          });
          break;
        case 'reorder_columns':
          savedPlan = await service.reorderColumns(project.id, {
            order: params.order,
          });
          break;
      }
    } catch (err) {
      if (err instanceof PlanItemNotFoundError) {
        return {
          content: sm('plan.item_not_found', { itemId: err.itemId }),
          isError: true,
          metadata: { i18n: i18nMeta('plan.item_not_found', { itemId: err.itemId }) },
        };
      }
      if (err instanceof PlanColumnNotFoundError) {
        return {
          content: sm('plan.column_not_found', { columnId: err.columnId }),
          isError: true,
          metadata: { i18n: i18nMeta('plan.column_not_found', { columnId: err.columnId }) },
        };
      }
      if (err instanceof PlanValidationError || err instanceof PlanLimitExceededError) {
        return { content: err.message, isError: true };
      }
      return {
        content: sm('plan.save_error', { error: err instanceof Error ? err.message : String(err) }),
        isError: true,
      };
    }

    // ADR-039/ADR-118 §4, PROP-054: план проекта изменён — событие
    // `plan.updated` идёт в каналы **всех сессий проекта** (не только текущей),
    // payload — `{project_id, version}`.
    await publishPlanUpdated(
      { eventBus: extra.eventBus, sessionManager: extra.sessionManager },
      project.id,
      savedPlan.version,
    );

    return {
      content: renderPlanActionSummary(params, savedPlan),
      metadata: { plan: savedPlan },
    };
  },
};
