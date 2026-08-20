import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition, ToolContext } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';
import type { ProjectStore } from '../../storage/project-store.js';

export interface ProjectManageExtra {
  sessionManager?: SessionManager;
  projectStore?: ProjectStore;
  sessionId?: string;
  eventBus?: EventBus;
}

/** Извлекает зависимости для project_create / project_attach из ctx.extra. */
export function getSessionExtra(ctx: ToolContext): ProjectManageExtra {
  return (ctx.extra ?? {}) as ProjectManageExtra;
}

/**
 * Привязывает сессию к проекту (AD-040): ставит projectId, сбрасывает
 * planApproved (план берётся от нового проекта) и публикует session.moved.
 */
export async function attachSessionToProject(
  sessionManager: SessionManager,
  projectStore: ProjectStore,
  eventBus: EventBus | undefined,
  sessionId: string,
  projectId: string,
): Promise<void> {
  await sessionManager.withLock(sessionId, async (s) => {
    s.projectId = projectId;
    s.planApproved = false;
    await sessionManager.saveSession(s);
  });
  eventBus?.publish(sessionId, 'session.moved', {
    session_id: sessionId,
    project_id: projectId,
  });
}

function argError(toolName: string, issues: z.ZodIssue[]): string {
  return `Ошибка аргументов инструмента "${toolName}": ${issues
    .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
    .join('; ')}`;
}

const projectCreateSchema = z.object({
  name: z.string().min(1).describe('Project name'),
  description: z.string().optional().describe('Project description'),
  workspace: z.string().optional().describe('Workspace path of the project'),
});

const projectAttachSchema = z.object({
  projectId: z.string().min(1).describe('Id of the project to attach the session to'),
});

export const projectCreateTool: ToolDefinition = {
  name: 'project_create',
  description:
    'Create a new project and attach the current session to it. '
    + 'Use it when the task requires a plan or long-term work with files, but the session has no project yet. '
    + 'The session todo list is kept; the project plan is taken from the new project.',
  parameters: projectCreateSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as { name: string; description?: string; workspace?: string };

    const extra = getSessionExtra(ctx);
    if (!extra.sessionManager || !extra.projectStore || !extra.sessionId) {
      return {
        content: 'Ошибка: менеджер сессий или хранилище проектов недоступно для project_create',
        isError: true,
      };
    }

    let session;
    try {
      session = await extra.sessionManager.getSession(extra.sessionId);
    } catch {
      return { content: 'Ошибка: не удалось прочитать сессию', isError: true };
    }
    if (!session) {
      return { content: 'Ошибка: сессия не найдена', isError: true };
    }

    const ownerId = session.ownerId || session.userId || 'local';
    const project = extra.projectStore.create(params.name, ownerId, {
      description: params.description,
      workspace: params.workspace,
    });

    try {
      await extra.projectStore.save(project);
    } catch (err) {
      return {
        content: `Ошибка сохранения проекта: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    await attachSessionToProject(
      extra.sessionManager,
      extra.projectStore,
      extra.eventBus,
      extra.sessionId,
      project.id,
    );

    const summary = { id: project.id, name: project.name, workspace: project.workspace ?? null };
    return {
      content: `Проект "${project.name}" создан и привязан к сессии.\n${JSON.stringify(summary)}`,
      metadata: summary,
    };
  },
};

export const projectAttachTool: ToolDefinition = {
  name: 'project_attach',
  description:
    'Attach the current session to an existing project by id. '
    + 'The session todo list is kept; the project plan is taken from the target project. '
    + 'Errors if the project does not exist.',
  parameters: projectAttachSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as { projectId: string };

    const extra = getSessionExtra(ctx);
    if (!extra.sessionManager || !extra.projectStore || !extra.sessionId) {
      return {
        content: 'Ошибка: менеджер сессий или хранилище проектов недоступно для project_attach',
        isError: true,
      };
    }

    let project;
    try {
      project = await extra.projectStore.load(params.projectId);
    } catch {
      return { content: 'Ошибка: не удалось прочитать проект', isError: true };
    }
    if (!project) {
      return { content: `Проект ${params.projectId} не найден`, isError: true };
    }

    await attachSessionToProject(
      extra.sessionManager,
      extra.projectStore,
      extra.eventBus,
      extra.sessionId,
      project.id,
    );

    return {
      content: `Сессия привязана к проекту "${project.name}".`,
      metadata: { id: project.id, name: project.name },
    };
  },
};
