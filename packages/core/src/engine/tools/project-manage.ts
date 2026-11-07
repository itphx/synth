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
import { provisionWorkspace, normalizeWorkspace } from '../workspace-provision.js';
import { isAborted, abortedResult } from './abort.js';
import { canEditProject } from './project-access.js';
import { t as sm, i18n as i18nMeta, type SystemMessageKey } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import { embedMultiline } from '../markdown.js';
import {
  ProjectLogService,
  ProjectLogEntryNotFoundError,
  ProjectLogLimitExceededError,
  ProjectLogValidationError,
} from '../project/log-service.js';
import {
  ProjectInvariantsService,
  ProjectInvariantsLimitExceededError,
} from '../project/invariants-service.js';
import { publishProjectUpdated } from '../project/events.js';

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

function missingDepsError(toolName: string) {
  return {
    content: sm('project.deps_unavailable', { tool: toolName }),
    isError: true as const,
    metadata: { i18n: i18nMeta('project.deps_unavailable', { tool: toolName }) },
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
    + 'The session todo list is kept; the project plan is taken from the new project. '
    + 'Workspace: in managed mode the directory is created automatically (auto name derived from the project name); '
    + 'in standalone mode omitting `workspace` leaves the project without a working directory, so file, shell and '
    + 'git tools stay blocked by the workspace gate. An absolute path outside the allowed root cannot be set here — '
    + 'use project_workspace_set (or the UI) for that. The response reports the workspace relative to the root.',
  parameters: projectCreateSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as { name: string; description?: string; workspace?: string };

    const extra = getSessionExtra(ctx);
    if (!extra.sessionManager || !extra.projectStore || !extra.sessionId) {
      return missingDepsError(this.name);
    }

    let session;
    try {
      session = await extra.sessionManager.getSession(extra.sessionId);
    } catch {
      return {
        content: sm('project.session_read_error'),
        isError: true,
        metadata: { i18n: i18nMeta('project.session_read_error') },
      };
    }
    if (!session) {
      return {
        content: sm('project.session_not_found'),
        isError: true,
        metadata: { i18n: i18nMeta('project.session_not_found') },
      };
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
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: sm('project.save_error', { error }),
        isError: true,
        metadata: { i18n: i18nMeta('project.save_error', { error }) },
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
      metadata: {
        ...summary,
        i18n: i18nMeta('project.created', { name: project.name, json: JSON.stringify(summary) }),
      },
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
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as { projectId: string };

    const extra = getSessionExtra(ctx);
    if (!extra.sessionManager || !extra.projectStore || !extra.sessionId) {
      return missingDepsError(this.name);
    }

    let project;
    try {
      project = await extra.projectStore.load(params.projectId);
    } catch {
      return {
        content: sm('project.read_error'),
        isError: true,
        metadata: { i18n: i18nMeta('project.read_error') },
      };
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
      return {
        content: sm('project.session_read_error'),
        isError: true,
        metadata: { i18n: i18nMeta('project.session_read_error') },
      };
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
        i18n: i18nMeta('project.attached', { name: project.name }),
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
      return argErrorResult(this.name, parsed.error.issues);
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

    let updated: Project | null;
    try {
      // Атомарный read-modify-write: правка и запись под локом хранилища
      // (иначе параллельное изменение проекта в другой сессии теряется).
      updated = await extra.projectStore.mutate(project.id, (target) => {
        if (params.name !== undefined) target.name = params.name;
        if (params.description !== undefined) target.description = params.description;
        if (params.icon !== undefined) target.icon = params.icon ?? undefined;
        if (params.color !== undefined) target.color = params.color ?? undefined;
        target.updatedAt = nowISO();
      });
    } catch (err) {
      return {
        content: sm('project.save_error', { error: err instanceof Error ? err.message : String(err) }),
        isError: true,
        metadata: { i18n: i18nMeta('project.save_error', { error: err instanceof Error ? err.message : String(err) }) },
      };
    }
    if (!updated) {
      return { content: sm('project.no_project'), isError: true, metadata: { i18n: i18nMeta('project.no_project') } };
    }

    const sessionId = ctx.sessionId || extra.sessionId;
    extra.eventBus?.publish(sessionId, 'project.updated', { project_id: updated.id });

    return {
      content: sm('project.updated_ok', { name: updated.name }),
      metadata: { id: updated.id, name: updated.name, i18n: i18nMeta('project.updated_ok', { name: updated.name }) },
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
    + 'Managed mode: only paths inside the managed workspaces root are allowed — a path outside it is rejected '
    + '(confirmation is not supported and not applied). '
    + 'Standalone mode: an absolute path outside the root follows the confirm/deny policy; pass '
    + 'confirmOutsideRoot=true to confirm. '
    + 'An empty string, the root directory itself and degenerate paths (".", "..", "/") are rejected — clearing '
    + 'the workspace via this tool is not supported. The directory is created if missing. The response reports the '
    + 'workspace path relative to the managed root. Requires write access to the project.',
  parameters: projectWorkspaceSetSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
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

    // Очистку workspace тулом не поддерживаем: пустая строка — ошибка. Путь,
    // который после нормализации не даёт имени каталога (`"."`, `".."`, `"/"`,
    // `" / "`), — тоже отказ: иначе `normalizeWorkspace` вернул бы `undefined` и
    // workspace молча **очистился** бы, а ответ сообщал бы «workspace set».
    if (!params.workspace.trim() || !normalizeWorkspace(params.workspace)) {
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

    // Метаданные workspace после удачного provisioning записываем атомарно:
    // проект мог измениться другой сессией, пока создавался каталог.
    let updated: Project | null;
    try {
      updated = await extra.projectStore.mutate(project.id, (target) => {
        target.workspace = resolved.workspace;
        target.updatedAt = nowISO();
      });
    } catch (err) {
      return {
        content: sm('project.save_error', { error: err instanceof Error ? err.message : String(err) }),
        isError: true,
        metadata: { i18n: i18nMeta('project.save_error', { error: err instanceof Error ? err.message : String(err) }) },
      };
    }
    if (!updated) {
      return { content: sm('project.no_project'), isError: true, metadata: { i18n: i18nMeta('project.no_project') } };
    }

    const sessionId = ctx.sessionId || extra.sessionId;
    extra.eventBus?.publish(sessionId, 'project.updated', { project_id: updated.id });

    const dir = resolved.dir ?? resolved.workspace ?? '';
    return {
      content: sm('project.workspace_set', { dir }),
      metadata: { workspace: resolved.workspace ?? null, dir, i18n: i18nMeta('project.workspace_set', { dir }) },
    };
  },
};

const projectLogWriteSchema = z.object({
  text: z.string().min(1).describe('Log entry text (Markdown)'),
});

/**
 * project_log_write — добавить запись в журнал проекта.
 *
 * Правка идёт через доменный сервис (`engine/project/log-service.ts`) — тот
 * же, что у HTTP-роута `POST /api/v2/projects/:id/log`, поэтому лимит
 * Markdown и атомарная запись одинаковы. После записи публикуется
 * `project.updated` (`kind: 'log'`) в каналы всех сессий проекта — прежде
 * события не было, и другие клиенты узнавали о правке только при перезагрузке.
 */
export const projectLogWriteTool: ToolDefinition = {
  name: 'project_log_write',
  description:
    'Append an entry to the project work log. The log is a chronological record of work '
    + 'done in the project (stored in the project, visible in the UI). The entry text is Markdown '
    + '(limit 16 KiB). Requires the session to be attached to a project.',
  parameters: projectLogWriteSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
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

    let entry: ProjectLogEntry;
    try {
      entry = await new ProjectLogService(extra.projectStore).append(project.id, {
        text: params.text,
        author: session?.settings.agentRole || 'assistant',
        sessionId: extra.sessionId,
      });
    } catch (err) {
      if (err instanceof ProjectLogLimitExceededError || err instanceof ProjectLogValidationError) {
        return { content: err.message, isError: true };
      }
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: sm('project.log_save_error', { error }),
        isError: true,
        metadata: { i18n: i18nMeta('project.log_save_error', { error }) },
      };
    }

    await publishProjectUpdated(
      { eventBus: extra.eventBus, sessionManager: extra.sessionManager },
      project.id,
      'log',
    );

    const count = (await extra.projectStore.load(project.id))?.log?.length ?? 0;
    return {
      content: sm('project.log_added', { count: String(count) }),
      metadata: { entry, count, i18n: i18nMeta('project.log_added', { count: String(count) }) },
    };
  },
};

const projectLogUpdateSchema = z.object({
  entryId: z.string().min(1).describe('Id of the log entry to update'),
  text: z.string().min(1).describe('New entry text (Markdown)'),
});

/**
 * project_log_update — изменить текст записи журнала (PROP-054).
 *
 * Правка — через доменный сервис журнала; аддитивные `updatedAt`/`updatedBy`
 * проставляются сервисом.
 */
export const projectLogUpdateTool: ToolDefinition = {
  name: 'project_log_update',
  description:
    'Update the text of an existing entry in the project work log. '
    + 'Parameters: { entryId, text }. The text is Markdown (limit 16 KiB). '
    + 'Requires the session to be attached to a project.',
  parameters: projectLogUpdateSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as { entryId: string; text: string };

    const extra = getSessionExtra(ctx);
    if (!extra.sessionManager || !extra.projectStore || !extra.sessionId) {
      return missingDepsError(this.name);
    }

    const { session, project } = await loadSessionProject(ctx);
    if (!project) {
      return { content: NO_PROJECT_LOG_ERROR, isError: true };
    }
    if (!canEditProject(session, project)) {
      return {
        content: sm('project.write_forbidden'),
        isError: true,
        metadata: { i18n: i18nMeta('project.write_forbidden') },
      };
    }

    let entry: ProjectLogEntry;
    try {
      entry = await new ProjectLogService(extra.projectStore).update(project.id, params.entryId, {
        text: params.text,
        updatedBy: session?.settings.agentRole || 'assistant',
      });
    } catch (err) {
      if (err instanceof ProjectLogEntryNotFoundError) {
        return { content: err.message, isError: true };
      }
      if (err instanceof ProjectLogLimitExceededError || err instanceof ProjectLogValidationError) {
        return { content: err.message, isError: true };
      }
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: sm('project.log_save_error', { error }),
        isError: true,
        metadata: { i18n: i18nMeta('project.log_save_error', { error }) },
      };
    }

    await publishProjectUpdated(
      { eventBus: extra.eventBus, sessionManager: extra.sessionManager },
      project.id,
      'log',
    );

    return {
      content: sm('project.updated'),
      metadata: { entry, i18n: i18nMeta('project.updated') },
    };
  },
};

const projectLogDeleteSchema = z.object({
  entryId: z.string().min(1).describe('Id of the log entry to delete'),
});

/**
 * project_log_delete — удалить запись журнала (PROP-054).
 */
export const projectLogDeleteTool: ToolDefinition = {
  name: 'project_log_delete',
  description:
    'Delete an entry from the project work log. Parameters: { entryId }. '
    + 'Requires the session to be attached to a project.',
  parameters: projectLogDeleteSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as { entryId: string };

    const extra = getSessionExtra(ctx);
    if (!extra.sessionManager || !extra.projectStore || !extra.sessionId) {
      return missingDepsError(this.name);
    }

    const { session, project } = await loadSessionProject(ctx);
    if (!project) {
      return { content: NO_PROJECT_LOG_ERROR, isError: true };
    }
    if (!canEditProject(session, project)) {
      return {
        content: sm('project.write_forbidden'),
        isError: true,
        metadata: { i18n: i18nMeta('project.write_forbidden') },
      };
    }

    try {
      await new ProjectLogService(extra.projectStore).remove(project.id, params.entryId);
    } catch (err) {
      if (err instanceof ProjectLogEntryNotFoundError) {
        return { content: err.message, isError: true };
      }
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: sm('project.log_save_error', { error }),
        isError: true,
        metadata: { i18n: i18nMeta('project.log_save_error', { error }) },
      };
    }

    await publishProjectUpdated(
      { eventBus: extra.eventBus, sessionManager: extra.sessionManager },
      project.id,
      'log',
    );

    return {
      content: sm('project.updated'),
      metadata: { i18n: i18nMeta('project.updated') },
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

    // Многострочный текст записи — с отступом продолжения, иначе переводы
    // строк разрывают внешний список (PROP-054, «Markdown»).
    const lines = log.map((e) => embedMultiline(`- ${e.createdAt} — `, e.text, '  '));
    return {
      content: sm('project.log_list', { count: String(log.length), items: lines.join('\n') }),
      metadata: {
        count: log.length,
        i18n: i18nMeta('project.log_list', { count: String(log.length), items: lines.join('\n') }),
      },
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
  invariants: z.string().describe('Project invariants text (Markdown, limit 64 KiB)'),
});

/**
 * project_invariants_write — заменить текст инвариантов проекта.
 *
 * Правка — через доменный сервис (`engine/project/invariants-service.ts`):
 * лимит Markdown (64 КиБ) и last-write-wins. После записи публикуется
 * `project.updated` (`kind: 'invariants'`) — прежде события не было.
 */
export const projectInvariantsWriteTool: ToolDefinition = {
  name: 'project_invariants_write',
  description:
    'Set the project invariants — the rules and constraints the model must follow while '
    + 'working on the project. Replaces the existing value. The text is Markdown (limit 64 KiB). '
    + 'Requires the session to be attached to a project.',
  parameters: projectInvariantsWriteSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
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

    try {
      await new ProjectInvariantsService(extra.projectStore).set(project.id, params.invariants);
    } catch (err) {
      if (err instanceof ProjectInvariantsLimitExceededError) {
        return { content: err.message, isError: true };
      }
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: sm('project.invariants_save_error', { error }),
        isError: true,
        metadata: { i18n: i18nMeta('project.invariants_save_error', { error }) },
      };
    }

    await publishProjectUpdated(
      { eventBus: extra.eventBus, sessionManager: extra.sessionManager },
      project.id,
      'invariants',
    );

    return { content: sm('project.invariants_saved'), metadata: { i18n: i18nMeta('project.invariants_saved') } };
  },
};
