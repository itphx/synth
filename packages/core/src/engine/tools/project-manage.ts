import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { nowISO, ToolCapability, PROJECT_ICON_KEYS, PROJECT_COLOR_KEYS, isProjectIconKey, isProjectColorKey } from '@itphx/synth-shared';
import type {
  ToolDefinition,
  ToolContext,
  Project,
  ProjectLogEntry,
  Session,
  WorkspaceOutsideRootPolicy,
} from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';
import type { ProjectStoreContract } from '../../storage/project-store.js';
import { provisionWorkspace } from '../workspace-provision.js';
import { isAborted, abortedResult } from './abort.js';
import { canEditProject } from './project-access.js';
import { t as sm, i18n as i18nMeta, type SystemMessageKey } from '../system-messages.js';

export interface ProjectManageExtra {
  sessionManager?: SessionManager;
  projectStore?: ProjectStoreContract;
  sessionId?: string;
  eventBus?: EventBus;
  /** ADR-075: корень managed-workspace для резолва относительного `workspace`. */
  workspacesRoot?: string;
  /** ADR-075: managed-режим (backend) — строгая проверка пути workspace. */
  workspaceManaged?: boolean;
  /** ADR-075: политика абсолютного workspace вне `workspacesRoot`. */
  getWorkspaceOutsideRootPolicy?: () => WorkspaceOutsideRootPolicy | Promise<WorkspaceOutsideRootPolicy>;
}

/** Извлекает зависимости для project_create / project_attach из ctx.extra. */
export function getSessionExtra(ctx: ToolContext): ProjectManageExtra {
  return (ctx.extra ?? {}) as ProjectManageExtra;
}

/** Резолв политики workspace вне root (дефолт — `confirm`). */
async function resolveOutsideRootPolicy(extra: ProjectManageExtra): Promise<WorkspaceOutsideRootPolicy> {
  return (await extra.getWorkspaceOutsideRootPolicy?.()) ?? 'confirm';
}

/** i18n-ключ ошибки provisioning workspace по коду результата. */
function workspaceErrorKey(code: string): SystemMessageKey {
  switch (code) {
    case 'WORKSPACE_OUTSIDE_ROOT_DENIED':
      return 'project.workspace_denied';
    case 'WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED':
      return 'project.workspace_confirm_required';
    case 'WORKSPACE_CREATE_FAILED':
      return 'project.workspace_create_error';
    default:
      return 'project.workspace_invalid';
  }
}

/** Единый isError-результат ошибки provisioning workspace (с i18n-метаданными). */
function workspaceErrorResult(code: string, message: string) {
  const key = workspaceErrorKey(code);
  const params = key === 'project.workspace_create_error' ? { error: message } : undefined;
  return {
    content: sm(key, params),
    isError: true as const,
    metadata: { i18n: i18nMeta(key, params) },
  };
}

/**
 * Привязывает сессию к проекту (ADR-040): ставит projectId, сбрасывает
 * planApproved (план берётся от нового проекта) и публикует session.moved.
 *
 * ADR-114 §3.4: привязка к worktree **снимается** — worktree принадлежит
 * старому проекту, а чужая привязка дала бы сессии каталог вне её проекта.
 * Факт снятия виден в событии `session.moved` (`worktree_detached`) и в ответе
 * тула (`worktree_detached` в metadata).
 */
export async function attachSessionToProject(
  sessionManager: SessionManager,
  projectStore: ProjectStoreContract,
  eventBus: EventBus | undefined,
  sessionId: string,
  projectId: string,
): Promise<boolean> {
  let worktreeDetached = false;
  await sessionManager.withLock(sessionId, async (s) => {
    s.projectId = projectId;
    s.planApproved = false;
    // ADR-114: привязка к worktree принадлежит проекту — перенос её снимает.
    if (s.worktree) {
      s.worktree = undefined;
      worktreeDetached = true;
    }
    await sessionManager.saveSession(s);
  });
  eventBus?.publish(sessionId, 'session.moved', {
    session_id: sessionId,
    project_id: projectId,
    ...(worktreeDetached ? { worktree_detached: true } : {}),
  });
  return worktreeDetached;
}

function argError(toolName: string, issues: z.ZodIssue[]): string {
  return sm('tool.args_error', { tool: toolName, issues: issues
    .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
    .join('; ') });
}

const NO_PROJECT_LOG_ERROR = sm('project.log_no_project');
const NO_PROJECT_INVARIANTS_ERROR = sm('project.invariants_no_project');

/** Загружает сессию и её проект. project === null, если проекта нет (или сессия не найдена). */
export async function loadSessionProject(
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

    // ADR-075: нормализация + создание каталога workspace через общий provisioning
    // (та же политика/containment, что у HTTP-роута — обход политики закрыт).
    const resolved = await provisionWorkspace(
      extra.projectStore,
      params.name,
      params.workspace,
      undefined,
      extra.workspacesRoot,
      await resolveOutsideRootPolicy(extra),
      extra.workspaceManaged === true,
    );
    if (!resolved.ok) {
      return workspaceErrorResult(resolved.code, resolved.message);
    }

    const project = extra.projectStore.create(params.name, ownerId, {
      description: params.description,
      workspace: resolved.workspace,
    });

    try {
      await extra.projectStore.save(project);
    } catch (err) {
      return {
        content: sm('project.save_error', { error: err instanceof Error ? err.message : String(err) }),
        isError: true,
      };
    }

    const worktreeDetached = await attachSessionToProject(
      extra.sessionManager,
      extra.projectStore,
      extra.eventBus,
      extra.sessionId,
      project.id,
    );

    const summary = {
      id: project.id,
      name: project.name,
      workspace: project.workspace ?? null,
      // ADR-114: привязка к worktree снята (привязка принадлежит проекту).
      ...(worktreeDetached ? { worktree_detached: true } : {}),
    };
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

    // Безопасность (ADR-075/D5): привязка сессии к чужому проекту выдаёт агенту его
    // workspace — чтение/запись файлов. Проверяем права на целевой проект тем же
    // механизмом, что и запись проектных данных (`canEditProject`: owner/EDITOR;
    // глобальные роли LEAD/ADMIN в core недоступны — известное ограничение core).
    let session: Session | null = null;
    try {
      session = await extra.sessionManager.getSession(extra.sessionId);
    } catch {
      return { content: sm('project.session_read_error'), isError: true };
    }
    if (!canEditProject(session, project)) {
      return {
        content: sm('project.write_forbidden'),
        isError: true,
        metadata: { i18n: i18nMeta('project.write_forbidden') },
      };
    }

    const worktreeDetached = await attachSessionToProject(
      extra.sessionManager,
      extra.projectStore,
      extra.eventBus,
      extra.sessionId,
      project.id,
    );

    return {
      content: sm('project.attached', { name: project.name }),
      metadata: {
        id: project.id,
        name: project.name,
        // ADR-114: привязка к worktree снята (worktree принадлежит старому
        // проекту — чужая привязка дала бы каталог вне нового проекта).
        ...(worktreeDetached ? { worktree_detached: true } : {}),
      },
    };
  },
};

const projectUpdateSchema = z.object({
  name: z.string().min(1).optional().describe('New project name'),
  description: z.string().optional().describe('New project description'),
  icon: z.enum(PROJECT_ICON_KEYS).nullable().optional()
    .describe(`Project icon key. Allowed: ${PROJECT_ICON_KEYS.join(', ')}`),
  color: z.enum(PROJECT_COLOR_KEYS).nullable().optional()
    .describe(`Project color key (palette a1..a16). Allowed: ${PROJECT_COLOR_KEYS.join(', ')}`),
});

/** Понятная ошибка невалидного значения метаданных проекта (i18n + допустимые ключи). */
function invalidMetaResult(
  key: 'project.invalid_icon' | 'project.invalid_color',
  value: unknown,
  allowed: readonly string[],
) {
  const params = { value: String(value), allowed: allowed.join(', ') };
  return {
    content: sm(key, params),
    isError: true as const,
    metadata: { i18n: i18nMeta(key, params) },
  };
}

export const projectUpdateTool: ToolDefinition = {
  name: 'project_update',
  description:
    'Update the current project of the session (name, description, icon, color). '
    + 'Only the provided fields are changed. Requires write access to the project.',
  parameters: projectUpdateSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    // Понятное сообщение с перечнем допустимых ключей (до общего argError схемы).
    const rawArgs = (args ?? {}) as Record<string, unknown>;
    if (rawArgs.icon !== undefined && rawArgs.icon !== null && !isProjectIconKey(rawArgs.icon)) {
      return invalidMetaResult('project.invalid_icon', rawArgs.icon, PROJECT_ICON_KEYS);
    }
    if (rawArgs.color !== undefined && rawArgs.color !== null && !isProjectColorKey(rawArgs.color)) {
      return invalidMetaResult('project.invalid_color', rawArgs.color, PROJECT_COLOR_KEYS);
    }

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as { name?: string; description?: string; icon?: string | null; color?: string | null };

    const extra = getSessionExtra(ctx);
    if (!extra.sessionManager || !extra.projectStore || !extra.sessionId) {
      return missingDepsError(this.name);
    }

    const { session, project } = await loadSessionProject(ctx);
    if (!project) {
      return { content: sm('project.no_project'), isError: true, metadata: { i18n: i18nMeta('project.no_project') } };
    }
    // ADR-075/D5: менять проект вправе только владелец/редактор (до мутации).
    if (!canEditProject(session, project)) {
      return {
        content: sm('project.write_forbidden'),
        isError: true,
        metadata: { i18n: i18nMeta('project.write_forbidden') },
      };
    }

    if (params.name !== undefined) project.name = params.name;
    if (params.description !== undefined) project.description = params.description;
    if (params.icon !== undefined) project.icon = params.icon ?? undefined;
    if (params.color !== undefined) project.color = params.color ?? undefined;
    project.updatedAt = nowISO();

    try {
      await extra.projectStore.save(project);
    } catch (err) {
      return {
        content: sm('project.save_error', { error: err instanceof Error ? err.message : String(err) }),
        isError: true,
      };
    }

    const sessionId = ctx.sessionId || extra.sessionId;
    extra.eventBus?.publish(sessionId, 'project.updated', { project_id: project.id });

    return {
      content: sm('project.updated_ok', { name: project.name }),
      metadata: { id: project.id, name: project.name, i18n: i18nMeta('project.updated_ok', { name: project.name }) },
    };
  },
};

const projectWorkspaceSetSchema = z.object({
  workspace: z.string().min(1).describe('Project workspace path'),
  confirmOutsideRoot: z.boolean().optional().describe('Confirm a workspace outside the allowed root'),
});

export const projectWorkspaceSetTool: ToolDefinition = {
  name: 'project_workspace_set',
  description:
    'Set the working directory (workspace) of the current project. '
    + 'The directory is created if missing. Paths outside the allowed root may be denied or require confirmation. '
    + 'Requires write access to the project.',
  parameters: projectWorkspaceSetSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as { workspace: string; confirmOutsideRoot?: boolean };

    const extra = getSessionExtra(ctx);
    if (!extra.sessionManager || !extra.projectStore || !extra.sessionId) {
      return missingDepsError(this.name);
    }

    const { session, project } = await loadSessionProject(ctx);
    if (!project) {
      return { content: sm('project.no_project'), isError: true, metadata: { i18n: i18nMeta('project.no_project') } };
    }
    // ADR-075/D5: смена workspace вправе только владелец/редактор (до мутации).
    if (!canEditProject(session, project)) {
      return {
        content: sm('project.write_forbidden'),
        isError: true,
        metadata: { i18n: i18nMeta('project.write_forbidden') },
      };
    }

    // Очистку workspace тулом не поддерживаем: пустая строка — ошибка.
    if (!params.workspace.trim()) {
      return {
        content: sm('project.workspace_invalid'),
        isError: true,
        metadata: { i18n: i18nMeta('project.workspace_invalid') },
      };
    }

    const resolved = await provisionWorkspace(
      extra.projectStore,
      project.name,
      params.workspace,
      params.confirmOutsideRoot,
      extra.workspacesRoot,
      await resolveOutsideRootPolicy(extra),
      extra.workspaceManaged === true,
    );
    if (!resolved.ok) {
      return workspaceErrorResult(resolved.code, resolved.message);
    }

    project.workspace = resolved.workspace;
    project.updatedAt = nowISO();

    try {
      await extra.projectStore.save(project);
    } catch (err) {
      return {
        content: sm('project.save_error', { error: err instanceof Error ? err.message : String(err) }),
        isError: true,
      };
    }

    const sessionId = ctx.sessionId || extra.sessionId;
    extra.eventBus?.publish(sessionId, 'project.updated', { project_id: project.id });

    const dir = resolved.dir ?? resolved.workspace ?? '';
    return {
      content: sm('project.workspace_set', { dir }),
      metadata: { workspace: resolved.workspace ?? null, dir, i18n: i18nMeta('project.workspace_set', { dir }) },
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
    // ADR-075/D5: писать лог проекта вправе только владелец/редактор (до мутации).
    if (!canEditProject(session, project)) {
      return {
        content: sm('project.write_forbidden'),
        isError: true,
        metadata: { i18n: i18nMeta('project.write_forbidden') },
      };
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

    const { session, project } = await loadSessionProject(ctx);
    if (!project) {
      return { content: NO_PROJECT_INVARIANTS_ERROR, isError: true };
    }
    // ADR-075/D5: менять инварианты вправе только владелец/редактор (до мутации).
    if (!canEditProject(session, project)) {
      return {
        content: sm('project.write_forbidden'),
        isError: true,
        metadata: { i18n: i18nMeta('project.write_forbidden') },
      };
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
