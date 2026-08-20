import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { nowISO, ToolCapability } from '@itphx/synth-shared';
import type {
  ToolDefinition,
  ToolContext,
  Project,
  ProjectPlan,
  PlanColumn,
  PlanItem,
} from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';
import type { ProjectStore } from '../../storage/project-store.js';

export interface PlanToolExtra {
  sessionManager?: SessionManager;
  eventBus?: EventBus;
  sessionId?: string;
  projectStore?: ProjectStore;
}

const DEFAULT_COLUMNS: PlanColumn[] = [
  { id: 'backlog', name: 'Бэклог', order: 0 },
  { id: 'todo', name: 'К выполнению', order: 1 },
  { id: 'in_progress', name: 'В работе', order: 2 },
  { id: 'done', name: 'Готово', order: 3 },
];

const PLAN_PRIORITIES = ['high', 'medium', 'low'] as const;
const DEPENDENCY_RELATIONS = ['blocked_by', 'blocks', 'relates_to'] as const;

/** Дефолтная структура плана с колонками (для проектов, где plan отсутствует). */
function defaultPlan(): ProjectPlan {
  return { version: 1, updatedAt: nowISO(), columns: DEFAULT_COLUMNS.map((c) => ({ ...c })), items: [] };
}

/** Возвращает план проекта; если plan отсутствует — создаёт дефолтную структуру. */
function getPlan(project: Project): ProjectPlan {
  if (!project.plan) {
    project.plan = defaultPlan();
  }
  return project.plan;
}

/**
 * Сохраняет изменённый план: инкрементирует version, обновляет updatedAt
 * плана и проекта, пишет через projectStore.
 */
async function savePlan(projectStore: ProjectStore, project: Project, plan: ProjectPlan): Promise<void> {
  plan.updatedAt = nowISO();
  plan.version += 1;
  project.plan = plan;
  project.updatedAt = nowISO();
  await projectStore.save(project);
}

/**
 * Markdown-представление плана: заголовок, затем по колонкам (в порядке order)
 * список пунктов `[priority] title` (+ description и зависимости при наличии).
 */
export function renderPlanMarkdown(plan: ProjectPlan): string {
  const lines: string[] = [`# План (v${plan.version})`];
  const columns = [...plan.columns].sort((a, b) => a.order - b.order);

  if (plan.items.length === 0) {
    lines.push('');
    lines.push('Пунктов нет');
    return lines.join('\n');
  }

  for (const col of columns) {
    const colItems = plan.items
      .filter((i) => i.columnId === col.id)
      .sort((a, b) => a.order - b.order);
    lines.push('');
    lines.push(`## ${col.name}`);
    if (colItems.length === 0) {
      lines.push('(пусто)');
      continue;
    }
    for (const item of colItems) {
      lines.push(`- [${item.priority}] ${item.title}`);
      if (item.description) {
        lines.push(`  - ${item.description}`);
      }
      if (item.dependsOn.length > 0) {
        const deps = item.dependsOn
          .map((d) => `${d.relation}: ${d.projectId ? `${d.projectId}/` : ''}${d.itemId}`)
          .join(', ');
        lines.push(`  - Зависимости: ${deps}`);
      }
    }
  }
  return lines.join('\n');
}

/** Возвращает проект сессии по session.projectId (null — если проекта нет). */
async function getProjectForSession(ctx: ToolContext): Promise<Project | null> {
  const extra = ctx.extra as PlanToolExtra | undefined;
  if (!extra?.projectStore) return null;
  const sessionId = ctx.sessionId || extra.sessionId;
  if (!sessionId || !extra.sessionManager) return null;
  try {
    const session = await extra.sessionManager.getSession(sessionId);
    if (!session?.projectId) return null;
    return await extra.projectStore.load(session.projectId);
  } catch {
    return null;
  }
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

function argError(toolName: string, issues: z.ZodIssue[]): string {
  return `Ошибка аргументов инструмента "${toolName}": ${issues
    .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
    .join('; ')}`;
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
    const extra = ctx.extra as PlanToolExtra | undefined;
    if (!extra?.sessionManager || !extra.sessionId) {
      return {
        content: 'Ошибка: менеджер сессий недоступен для plan_enter',
        isError: true,
      };
    }
    const ok = await updateSessionMode(extra.sessionManager, extra.sessionId, { mode: 'plan' });
    if (!ok) {
      return { content: 'Ошибка: не удалось переключить сессию в режим plan', isError: true };
    }
    return {
      content:
        'Режим plan активирован: запись файлов заблокирована, чтение разрешено. '
        + 'Исследуй задачу, работай с планом через plan_read/plan_write и заверши через plan_exit '
        + 'для перехода в режим act.',
      metadata: { mode: 'plan' },
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
    const extra = ctx.extra as PlanToolExtra | undefined;
    if (!extra?.sessionManager || !extra.sessionId) {
      return { content: 'Ошибка: менеджер сессий недоступен для plan_exit', isError: true };
    }

    const ok = await updateSessionMode(extra.sessionManager, extra.sessionId, {
      mode: 'act',
      planApproved: true,
    });
    if (!ok) {
      return { content: 'Ошибка: не удалось переключить сессию в режим act', isError: true };
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
      content: 'План утверждён. Режим act активирован: запись файлов разрешена.',
      metadata: { mode: 'act', plan_approved: true },
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
    const project = await getProjectForSession(ctx);
    if (!project) {
      return { content: 'Проект отсутствует: план недоступен (план привязан к проекту)' };
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
    const project = await getProjectForSession(ctx);
    if (!project) {
      return {
        content: 'Проект отсутствует: план недоступен (план привязан к проекту)',
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
    description: z.string().optional().describe('Item description'),
    columnId: z.string().optional().describe('Target column id (default: backlog)'),
    priority: z.enum(PLAN_PRIORITIES).optional().describe('Item priority (default: medium)'),
    dependsOn: z.array(planDependencySchema).optional().describe('Item dependencies'),
  }),
  z.object({
    action: z.literal('update_item'),
    itemId: z.string().describe('Item id to update'),
    title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New description'),
    priority: z.enum(PLAN_PRIORITIES).optional().describe('New priority'),
    tags: z.array(z.string()).optional().describe('New tags'),
  }),
  z.object({
    action: z.literal('move_item'),
    itemId: z.string().describe('Item id to move'),
    columnId: z.string().describe('Target column id'),
    order: z.number().optional().describe('New position within the column'),
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
]);

type PlanWriteInput = z.infer<typeof planWriteSchema>;

function applyPlanWrite(plan: ProjectPlan, params: PlanWriteInput): { error?: string } {
  switch (params.action) {
    case 'create_item': {
      const columnId = params.columnId ?? 'backlog';
      const column = plan.columns.find((c) => c.id === columnId);
      if (!column) return { error: `Ошибка: колонка "${columnId}" не найдена` };
      const maxOrder = plan.items
        .filter((i) => i.columnId === columnId)
        .reduce((max, i) => Math.max(max, i.order), -1);
      const now = nowISO();
      const item: PlanItem = {
        id: randomUUID(),
        title: params.title,
        description: params.description,
        columnId,
        priority: params.priority ?? 'medium',
        order: maxOrder + 1,
        dependsOn: params.dependsOn ?? [],
        createdAt: now,
        updatedAt: now,
      };
      plan.items.push(item);
      return {};
    }
    case 'update_item': {
      const item = plan.items.find((i) => i.id === params.itemId);
      if (!item) return { error: `Ошибка: пункт плана с id "${params.itemId}" не найден` };
      if (params.title !== undefined) item.title = params.title;
      if (params.description !== undefined) item.description = params.description;
      if (params.priority !== undefined) item.priority = params.priority;
      if (params.tags !== undefined) item.tags = params.tags;
      item.updatedAt = nowISO();
      return {};
    }
    case 'move_item': {
      const item = plan.items.find((i) => i.id === params.itemId);
      if (!item) return { error: `Ошибка: пункт плана с id "${params.itemId}" не найден` };
      const column = plan.columns.find((c) => c.id === params.columnId);
      if (!column) return { error: `Ошибка: колонка "${params.columnId}" не найдена` };
      item.columnId = params.columnId;
      if (params.order !== undefined) item.order = params.order;
      item.updatedAt = nowISO();
      return {};
    }
    case 'delete_item': {
      const idx = plan.items.findIndex((i) => i.id === params.itemId);
      if (idx < 0) return { error: `Ошибка: пункт плана с id "${params.itemId}" не найден` };
      plan.items.splice(idx, 1);
      return {};
    }
    case 'set_dependencies': {
      const item = plan.items.find((i) => i.id === params.itemId);
      if (!item) return { error: `Ошибка: пункт плана с id "${params.itemId}" не найден` };
      item.dependsOn = params.dependsOn;
      item.updatedAt = nowISO();
      return {};
    }
    case 'add_column': {
      const order = plan.columns.reduce((max, c) => Math.max(max, c.order), -1) + 1;
      const column: PlanColumn = {
        id: randomUUID(),
        name: params.name,
        order,
        ...(params.wipLimit !== undefined ? { wipLimit: params.wipLimit } : {}),
      };
      plan.columns.push(column);
      return {};
    }
  }
}

export const planWriteTool: ToolDefinition = {
  name: 'plan_write',
  description:
    'Modify the project plan (kanban). Actions: '
    + 'create_item (title, description?, columnId?, priority?, dependsOn?), '
    + 'update_item (itemId, title?, description?, priority?, tags?), '
    + 'move_item (itemId, columnId, order?), delete_item (itemId), '
    + 'set_dependencies (itemId, dependsOn), add_column (name, wipLimit?). '
    + 'Returns the updated plan as markdown. The plan is bound to the project.',
  parameters: planWriteSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as PlanWriteInput;
    const extra = ctx.extra as PlanToolExtra | undefined;
    if (!extra?.projectStore) {
      return { content: 'Ошибка: хранилище проектов недоступно для plan_write', isError: true };
    }

    const project = await getProjectForSession(ctx);
    if (!project) {
      return { content: 'Ошибка: проект отсутствует (план привязан к проекту)', isError: true };
    }
    const plan = getPlan(project);

    const result = applyPlanWrite(plan, params);
    if (result.error) {
      return { content: result.error, isError: true };
    }

    try {
      await savePlan(extra.projectStore, project, plan);
    } catch (err) {
      return {
        content: `Ошибка сохранения плана: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    return { content: renderPlanMarkdown(plan), metadata: { plan } };
  },
};
