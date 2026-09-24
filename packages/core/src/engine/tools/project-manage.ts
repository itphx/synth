import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, normalize, resolve } from 'node:path';
import { z } from 'zod';
import { nowISO, ToolCapability } from '@itphx/synth-shared';
import type {
  ToolDefinition,
  ToolContext,
  Project,
  ProjectLogEntry,
  Session,
} from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';
import type { ProjectStore } from '../../storage/project-store.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

export interface ProjectManageExtra {
  sessionManager?: SessionManager;
  projectStore?: ProjectStore;
  sessionId?: string;
  eventBus?: EventBus;
  /** AD-075: корень managed-workspace для резолва относительного `workspace`. */
  workspacesRoot?: string;
}

/** Извлекает зависимости для project_create / project_attach из ctx.extra. */
export function getSessionExtra(ctx: ToolContext): ProjectManageExtra {
  return (ctx.extra ?? {}) as ProjectManageExtra;
}

/**
 * AD-075: абсолютный каталог workspace проекта. Абсолютный путь — как есть
 * (normalize), относительный — относительно `workspacesRoot`.
 */
function resolveWorkspaceDir(workspace: string, workspacesRoot?: string): string {
  return isAbsolute(workspace)
    ? normalize(workspace)
    : resolve(workspacesRoot || process.cwd(), workspace);
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
  return sm('tool.args_error', { tool: toolName, issues: issues
    .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
    .join('; ') });
}

const NO_PROJECT_LOG_ERROR = sm('project.log_no_project');
const NO_PROJECT_INVARIANTS_ERROR = sm('project.invariants_no_project');

/** Загружает сессию и её проект. project === null, если проекта нет (или сессия не найдена). */
async function loadSessionProject(
  ctx: ToolContext,
): Promise<{ session: Session | null; project: Project | null }> {
  const extra = getSessionExtra(ctx);
  if (!extra.projectStore || !extra.sessionManager) {
    return { session: null, project: null };
  }
  const sessionId = ctx.sessionId || extra.sessionId;
  if (!sessionId) return { session: null, project: null };
  try {
    const session = await extra.sessionManager.getSession(sessionId);
    if (!session) return { session: null, project: null };
    if (!session.projectId) return { session, project: null };
    const project = await extra.projectStore.load(session.projectId);
    return { session, project };
  } catch {
    return { session: null, project: null };
  }
}

function missingDepsError(toolName: string): { content: string; isError: true } {
  return {
    content: sm('project.deps_unavailable', { tool: toolName }),
    isError: true,
  };
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
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as { name: string; description?: string; workspace?: string };

    const extra = getSessionExtra(ctx);
    if (!extra.sessionManager || !extra.projectStore || !extra.sessionId) {
      return {
        content: sm('project.deps_unavailable', { tool: 'project_create' }),
        isError: true,
      };
    }

    let session;
    try {
      session = await extra.sessionManager.getSession(extra.sessionId);
    } catch {
      return { content: sm('project.session_read_error'), isError: true };
    }
    if (!session) {
      return { content: sm('project.session_not_found'), isError: true };
    }

    const ownerId = session.ownerId || session.userId || 'local';

    // AD-075: каталог workspace создаётся до сохранения проекта.
    if (params.workspace) {
      try {
        await mkdir(resolveWorkspaceDir(params.workspace, extra.workspacesRoot), { recursive: true });
      } catch (err) {
        return {
          content: sm('project.workspace_create_error', { error: err instanceof Error ? err.message : String(err) }),
          isError: true,
        };
      }
    }

    const project = extra.projectStore.create(params.name, ownerId, {
      description: params.description,
      workspace: params.workspace,
    });

    try {
      await extra.projectStore.save(project);
    } catch (err) {
      return {
        content: sm('project.save_error', { error: err instanceof Error ? err.message : String(err) }),
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
      content: sm('project.created', { name: project.name, json: JSON.stringify(summary) }),
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
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as { projectId: string };

    const extra = getSessionExtra(ctx);
    if (!extra.sessionManager || !extra.projectStore || !extra.sessionId) {
      return {
        content: sm('project.deps_unavailable', { tool: 'project_attach' }),
        isError: true,
      };
    }

    let project;
    try {
      project = await extra.projectStore.load(params.projectId);
    } catch {
      return { content: sm('project.read_error'), isError: true };
    }
    if (!project) {
      return { content: sm('project.not_found', { id: params.projectId }), isError: true, metadata: { i18n: i18nMeta('project.not_found', { id: params.projectId }) } };
    }

    await attachSessionToProject(
      extra.sessionManager,
      extra.projectStore,
      extra.eventBus,
      extra.sessionId,
      project.id,
    );

    return {
      content: sm('project.attached', { name: project.name }),
      metadata: { id: project.id, name: project.name },
    };
  },
};

const projectLogWriteSchema = z.object({
  text: z.string().min(1).describe('Log entry text'),
});

export const projectLogWriteTool: ToolDefinition = {
  name: 'project_log_write',
  description:
    'Append an entry to the project work log. The log is a chronological record of work '
    + 'done in the project (stored in the project, visible in the UI). Requires the session '
    + 'to be attached to a project.',
  parameters: projectLogWriteSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as { text: string };

    const extra = getSessionExtra(ctx);
    if (!extra.sessionManager || !extra.projectStore || !extra.sessionId) {
      return missingDepsError(this.name);
    }

    const { session, project } = await loadSessionProject(ctx);
    if (!project) {
      return { content: NO_PROJECT_LOG_ERROR, isError: true };
    }

    const entry: ProjectLogEntry = {
      id: randomUUID(),
      text: params.text,
      createdAt: nowISO(),
      sessionId: extra.sessionId,
      author: session?.settings.agentRole || 'assistant',
    };

    const log = project.log ?? [];
    log.push(entry);
    project.log = log;
    project.updatedAt = nowISO();

    try {
      await extra.projectStore.save(project);
    } catch (err) {
      return {
        content: sm('project.log_save_error', { error: err instanceof Error ? err.message : String(err) }),
        isError: true,
      };
    }

    return {
      content: sm('project.log_added', { count: String(log.length) }),
      metadata: { entry, count: log.length },
    };
  },
};

export const projectLogReadTool: ToolDefinition = {
  name: 'project_log_read',
  description:
    'Return the project work log as markdown. Each line is "- {createdAt} — {text}". '
    + 'Requires the session to be attached to a project.',
  parameters: z.object({}),
  capabilities: [ToolCapability.RUNTIME],
  async execute(_args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const extra = getSessionExtra(ctx);
    if (!extra.sessionManager || !extra.projectStore || !extra.sessionId) {
      return missingDepsError(this.name);
    }

    const { project } = await loadSessionProject(ctx);
    if (!project) {
      return { content: NO_PROJECT_LOG_ERROR, isError: true };
    }

    const log = project.log ?? [];
    if (log.length === 0) {
      return { content: sm('project.log_empty'), metadata: { count: 0, i18n: i18nMeta('project.log_empty') } };
    }

    const lines = log.map((e) => `- ${e.createdAt} — ${e.text}`);
    return {
      content: sm('project.log_list', { count: String(log.length), items: lines.join('\n') }),
      metadata: { count: log.length },
    };
  },
};

export const projectInvariantsReadTool: ToolDefinition = {
  name: 'project_invariants_read',
  description:
    'Return the project invariants — the rules and constraints the model must follow while '
    + 'working on the project. Requires the session to be attached to a project.',
  parameters: z.object({}),
  capabilities: [ToolCapability.RUNTIME],
  async execute(_args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const extra = getSessionExtra(ctx);
    if (!extra.sessionManager || !extra.projectStore || !extra.sessionId) {
      return missingDepsError(this.name);
    }

    const { project } = await loadSessionProject(ctx);
    if (!project) {
      return { content: NO_PROJECT_INVARIANTS_ERROR, isError: true };
    }

    const invariants = project.invariants?.trim();
    if (!invariants) {
      return { content: sm('project.invariants_empty'), metadata: { i18n: i18nMeta('project.invariants_empty') } };
    }

    return { content: invariants };
  },
};

const projectInvariantsWriteSchema = z.object({
  invariants: z.string().describe('Project invariants text'),
});

export const projectInvariantsWriteTool: ToolDefinition = {
  name: 'project_invariants_write',
  description:
    'Set the project invariants — the rules and constraints the model must follow while '
    + 'working on the project. Replaces the existing value. Requires the session to be '
    + 'attached to a project.',
  parameters: projectInvariantsWriteSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as { invariants: string };

    const extra = getSessionExtra(ctx);
    if (!extra.sessionManager || !extra.projectStore || !extra.sessionId) {
      return missingDepsError(this.name);
    }

    const { project } = await loadSessionProject(ctx);
    if (!project) {
      return { content: NO_PROJECT_INVARIANTS_ERROR, isError: true };
    }

    project.invariants = params.invariants;
    project.updatedAt = nowISO();

    try {
      await extra.projectStore.save(project);
    } catch (err) {
      return {
        content: sm('project.invariants_save_error', { error: err instanceof Error ? err.message : String(err) }),
        isError: true,
      };
    }

    return { content: sm('project.invariants_saved'), metadata: { i18n: i18nMeta('project.invariants_saved') } };
  },
};
