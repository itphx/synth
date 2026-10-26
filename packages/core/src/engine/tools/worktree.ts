/**
 * Тулы `git_worktree_*` — инвентарь git-worktree'ов проекта (ADR-114 §5,
 * `docs/WORKTREES.md`).
 *
 * ## Границы
 *
 * - **Проект берётся только из сессии** (`ctx.projectId`): параметра
 *   `project_id` у тулов нет — подсунуть чужой проект агент не может.
 * - Создание worktree **не привязывает** текущую сессию: привязку делает
 *   пользователь (UI) или `PATCH /api/v2/sessions/:id { worktreeId }` —
 *   это осознанно (иначе агент переводил бы свою сессию в новый каталог без
 *   спроса пользователя).
 * - Поведение (git-команды, lifecycle, коды ошибок) — в `WorktreeService`
 *   (`engine/worktree/service.ts`); тулы — тонкая обёртка: разбор аргументов,
 *   поиск записи по имени, текст ответа для модели.
 * - В plan-режиме мутации запрещены **permission-слоем** (ADR-029): тулы
 *   входят в группу `git_write` (`engine/permission/groups.ts`), поэтому
 *   `git_worktree_create/remove/prune` блокируются, а `git_worktree_list`
 *   (группа `git_read`) остаётся доступен.
 * - Тексты — через ключи `shared/i18n` (ADR-041).
 */
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type {
  Project,
  ToolContext,
  ToolDefinition,
  ToolResult,
  WorktreeSummary,
} from '@itphx/synth-shared';
import type { ProjectStoreContract } from '../../storage/project-store.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { WorktreeService } from '../worktree/service.js';
import { isWorktreeError } from '../worktree/errors.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

/**
 * Зависимости тулов из `ToolContext.extra` (упаковка — оркестратор).
 *
 * - `worktreeService` — сервис worktree'ов (ADR-114). Не задан — тулы
 *   недоступны (`worktree.tool.deps_unavailable`).
 * - `projectStore` — порт проектов: по `ctx.projectId` читается проект
 *   (и его `workspace` — корень репозитория для `git worktree add`).
 * - `sessionManager` — читается владелец сессии (аудит `createdBy` в записи
 *   worktree; авторизации он не даёт).
 */
export interface WorktreeToolsExtra {
  worktreeService?: WorktreeService;
  projectStore?: ProjectStoreContract;
  sessionManager?: SessionManager;
}

function getExtra(ctx: ToolContext): WorktreeToolsExtra {
  return (ctx.extra ?? {}) as WorktreeToolsExtra;
}

/** Единый отказ «сервис/хранилище не подключены». */
function depsUnavailable(): ToolResult {
  return {
    content: sm('worktree.tool.deps_unavailable'),
    isError: true,
    metadata: { i18n: i18nMeta('worktree.tool.deps_unavailable') },
  };
}

/** Единый отказ «у сессии нет проекта». */
function noProject(): ToolResult {
  return {
    content: sm('worktree.tool.no_project'),
    isError: true,
    metadata: { i18n: i18nMeta('worktree.tool.no_project') },
  };
}

/** Ошибка разбора аргументов — общий текст соседних тулов. */
function argError(toolName: string, issues: z.ZodIssue[]): ToolResult {
  return {
    content: sm('tool.args_error', {
      tool: toolName,
      issues: issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
    }),
    isError: true,
    metadata: { i18n: i18nMeta('tool.args_error', { tool: toolName }) },
  };
}

type LoadedContext =
  | { ok: false; error: ToolResult }
  | {
      ok: true;
      service: WorktreeService;
      project: Project;
      projectId: string;
      /** Владелец сессии (аудит `createdBy`); пусто — определить не удалось. */
      actor?: string;
    };

/**
 * Общий преамбул: сервис, проект сессии, права.
 *
 * Права на мутацию проекта тут **не** проверяются: их проверяет permission-слой
 * (ADR-029) — жёсткая проверка внутри тула разошлась бы с правилами групп.
 */
async function loadWorktreeContext(ctx: ToolContext): Promise<LoadedContext> {
  const extra = getExtra(ctx);
  if (!extra.worktreeService || !extra.projectStore) {
    return { ok: false, error: depsUnavailable() };
  }
  const projectId = ctx.projectId;
  if (!projectId) return { ok: false, error: noProject() };
  let project: Project | null = null;
  try {
    project = await extra.projectStore.load(projectId);
  } catch {
    project = null;
  }
  if (!project) return { ok: false, error: noProject() };

  let actor: string | undefined;
  if (extra.sessionManager && ctx.sessionId) {
    try {
      const session = await extra.sessionManager.getSession(ctx.sessionId);
      actor = session?.ownerId ?? session?.userId ?? undefined;
    } catch {
      actor = undefined;
    }
  }
  return {
    ok: true,
    service: extra.worktreeService,
    project,
    projectId,
    ...(actor !== undefined ? { actor } : {}),
  };
}

/**
 * Текст ошибки сервиса.
 *
 * Ошибки подсистемы worktree несут машинный код и русский текст
 * (`engine/worktree/errors.ts`) — он и уходит в ответ: модель читает понятную
 * причину, UI — код из `metadata`.
 */
function serviceError(err: unknown): ToolResult {
  if (isWorktreeError(err)) {
    return {
      content: err.message,
      isError: true,
      metadata: { worktree_error: err.code },
    };
  }
  return {
    content: sm('tool.exec_error', {
      tool: 'git_worktree',
      error: err instanceof Error ? err.message : String(err),
    }),
    isError: true,
  };
}

/** «да/нет» для булевых полей сводки (LLM-канал — en). */
function yesNo(value: boolean | undefined): string {
  if (value === undefined) return 'unknown';
  return value ? 'yes' : 'no';
}

/** Строка сводки worktree для таблицы ответа. */
function summaryRow(summary: WorktreeSummary): string {
  return sm('worktree.tool.list_row', {
    name: summary.name,
    branch: summary.branch,
    directory: summary.directory,
    dirty: yesNo(summary.dirty),
    attached: summary.attachedSessionId ?? 'none',
    exists: yesNo(summary.exists),
  });
}

// ── Схемы аргументов ─────────────────────────────────────────────────────────

const worktreeCreateParamsSchema = z.object({
  branch: z.string().min(1).optional().describe('Branch of the new worktree'),
  name: z.string().min(1).optional().describe('Directory name of the new worktree (slug)'),
  repoPath: z
    .string()
    .min(1)
    .optional()
    .describe('Repository of the project relative to its workspace (default: workspace root)'),
  from: z.string().min(1).optional().describe('Base ref of the new branch (default: current HEAD)'),
});

const worktreeRemoveParamsSchema = z.object({
  name: z.string().min(1).optional().describe('Directory name of the worktree to remove'),
  worktreeId: z.string().min(1).optional().describe('Id of the worktree record to remove'),
  force: z.boolean().optional().describe('Remove even with uncommitted changes'),
});

const worktreePruneParamsSchema = z.object({}).strict();

// ── Тулы ─────────────────────────────────────────────────────────────────────

/**
 * `git_worktree_list` — инвентарь worktree'ов проекта сессии.
 *
 * Читающий тул (группа `git_read`): в plan-режиме доступен.
 */
export const gitWorktreeListTool: ToolDefinition = {
  name: 'git_worktree_list',
  description:
    'List the git worktrees of the current project: name, branch, directory, dirty state, '
    + 'attached session and whether the directory still exists. Read-only.',
  parameters: z.object({}).strict(),
  capabilities: [ToolCapability.GIT_READ],
  async execute(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const loaded = await loadWorktreeContext(ctx);
    if (!loaded.ok) return loaded.error;
    try {
      const summaries = await loaded.service.list(loaded.projectId, loaded.project);
      if (summaries.length === 0) {
        return { content: sm('worktree.tool.list_empty') };
      }
      const header = sm('worktree.tool.list_header', { count: String(summaries.length) });
      const rows = summaries.map(summaryRow);
      return { content: [header, ...rows].join('\n') };
    } catch (err) {
      return serviceError(err);
    }
  },
};

/**
 * `git_worktree_create` — создать вторичную рабочую копию репозитория.
 *
 * **Не привязывает** текущую сессию: привязку делает пользователь (UI) или
 * `PATCH /api/v2/sessions/:id { worktreeId }`.
 */
export const gitWorktreeCreateTool: ToolDefinition = {
  name: 'git_worktree_create',
  description:
    'Create a git worktree (secondary working copy) of the current project repository. '
    + 'The worktree is NOT attached to the current session: the user attaches it via '
    + 'PATCH /api/v2/sessions/:id { "worktreeId": "<id>" } or in the UI.',
  parameters: worktreeCreateParamsSchema,
  capabilities: [ToolCapability.GIT_WRITE],
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = worktreeCreateParamsSchema.safeParse(params ?? {});
    if (!parsed.success) return argError('git_worktree_create', parsed.error.issues);
    const loaded = await loadWorktreeContext(ctx);
    if (!loaded.ok) return loaded.error;
    try {
      const result = await loaded.service.create(
        loaded.projectId,
        loaded.project,
        parsed.data,
        loaded.actor,
      );
      const content = sm('worktree.tool.created', {
        name: result.worktree.name,
        branch: result.worktree.branch,
        directory: result.worktree.directory,
        // Id записи уходит **в текст**: без него агент не может привязать
        // сессию к созданному worktree (в `metadata` модель не смотрит).
        worktree_id: result.worktree.id,
      });
      return {
        content: result.setup && !result.setup.ok
          ? `${content}\nStartup script failed: ${result.setup.error ?? `exit code ${result.setup.exitCode ?? '?'}`}`
          : content,
        metadata: {
          worktree_id: result.worktree.id,
          ...(result.setup ? { setup: result.setup } : {}),
        },
      };
    } catch (err) {
      return serviceError(err);
    }
  },
};

/**
 * `git_worktree_remove` — удалить worktree (каталог + ветку + запись).
 *
 * Требует явного `force`, если в каталоге есть незакоммиченные изменения;
 * привязанная к живой сессии работаtree удалить нельзя.
 */
export const gitWorktreeRemoveTool: ToolDefinition = {
  name: 'git_worktree_remove',
  description:
    'Remove a git worktree of the current project (by name or id). '
    + 'Refuses to remove a worktree with uncommitted changes unless force: true is passed, '
    + 'and refuses to remove one attached to a live session.',
  parameters: worktreeRemoveParamsSchema,
  capabilities: [ToolCapability.GIT_WRITE],
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = worktreeRemoveParamsSchema.safeParse(params ?? {});
    if (!parsed.success) return argError('git_worktree_remove', parsed.error.issues);
    const loaded = await loadWorktreeContext(ctx);
    if (!loaded.ok) return loaded.error;

    const { name, worktreeId, force } = parsed.data;
    if (!name && !worktreeId) {
      return {
        content: sm('tool.args_error', {
          tool: 'git_worktree_remove',
          issues: 'name: either "name" or "worktreeId" is required',
        }),
        isError: true,
        metadata: { i18n: i18nMeta('tool.args_error', { tool: 'git_worktree_remove' }) },
      };
    }

    let targetId = worktreeId;
    let targetName = name ?? worktreeId ?? '';
    if (!targetId) {
      // Поиск по имени: записи инвентаря — по `name` (slug каталога).
      try {
        const summaries = await loaded.service.list(loaded.projectId, loaded.project);
        const found = summaries.find((item) => item.name === name);
        if (!found) {
          return {
            content: sm('worktree.tool.not_found', { id: String(name) }),
            isError: true,
            metadata: { i18n: i18nMeta('worktree.tool.not_found', { id: String(name) }) },
          };
        }
        targetId = found.id;
        targetName = found.name;
      } catch (err) {
        return serviceError(err);
      }
    }

    try {
      const record = await loaded.service.remove(
        loaded.projectId,
        targetId,
        loaded.project,
        force ? { force: true } : {},
      );
      return {
        content: sm('worktree.tool.removed', { name: record.name }),
        metadata: { worktree_id: record.id },
      };
    } catch (err) {
      if (isWorktreeError(err) && err.code === 'WORKTREE_DIRTY') {
        return {
          content: sm('worktree.tool.force_required', { name: targetName }),
          isError: true,
          metadata: { i18n: i18nMeta('worktree.tool.force_required', { name: targetName }), force_required: true },
        };
      }
      if (isWorktreeError(err) && err.code === 'WORKTREE_BUSY') {
        const sessionId = (err as { sessionId?: string }).sessionId ?? 'unknown';
        return {
          content: sm('worktree.tool.busy', { name: targetName, session: sessionId }),
          isError: true,
          metadata: { i18n: i18nMeta('worktree.tool.busy', { name: targetName, session: sessionId }) },
        };
      }
      return serviceError(err);
    }
  },
};

/**
 * `git_worktree_prune` — убрать записи инвентаря без каталога + почистить
 * метаданные git (`git worktree prune`).
 */
export const gitWorktreePruneTool: ToolDefinition = {
  name: 'git_worktree_prune',
  description:
    'Prune the git worktree inventory of the current project: remove records whose directory '
    + 'no longer exists and run "git worktree prune" to clean git metadata. Live worktrees are not touched.',
  parameters: worktreePruneParamsSchema,
  capabilities: [ToolCapability.GIT_WRITE],
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = worktreePruneParamsSchema.safeParse(params ?? {});
    if (!parsed.success) return argError('git_worktree_prune', parsed.error.issues);
    const loaded = await loadWorktreeContext(ctx);
    if (!loaded.ok) return loaded.error;
    try {
      const result = await loaded.service.prune(loaded.projectId, loaded.project);
      return {
        content: sm('worktree.tool.pruned', {
          records: String(result.recordsRemoved),
          git_pruned: yesNo(result.gitPruned),
        }),
        metadata: { records_removed: result.recordsRemoved, git_pruned: result.gitPruned },
      };
    } catch (err) {
      return serviceError(err);
    }
  },
};
