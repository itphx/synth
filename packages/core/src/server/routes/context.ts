import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Project, Session } from '@itphx/synth-shared';
import type { AuthKit } from '../../auth/local.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { InstructionsInfo, InstructionsInfoResolver } from '../../engine/context/instructions.js';

const LOCAL_USER_ID = 'local';

/** Структурный контракт хранилища проектов (core/backend реализации совместимы). */
export interface ContextProjectStore {
  load(id: string): Promise<Project | null>;
}

export interface ContextRoutesMessages {
  missingScope: string;
  sessionNotFound: string;
  projectNotFound: string;
  forbiddenSession: string;
  forbiddenProject: string;
  internal: string;
}

const DEFAULT_MESSAGES: ContextRoutesMessages = {
  missingScope: 'Укажите session_id или project_id',
  sessionNotFound: 'Сессия не найдена',
  projectNotFound: 'Проект не найден',
  forbiddenSession: 'Недостаточно прав для доступа к сессии',
  forbiddenProject: 'Недостаточно прав для доступа к проекту',
  internal: 'Хранилище не настроено',
};

export interface ContextRoutesOptions {
  /**
   * Резолвер снимка проектных инструкций (AD-069 Фаза 2a) — общий core-модуль.
   * Для сессии без проекта вызывается с `workspace: undefined`.
   */
  resolveInstructions: InstructionsInfoResolver;
  sessionManager?: SessionManager;
  projectStore?: ContextProjectStore;
  /** Резолв абсолютного рабочего каталога проекта по id (как в skills-роутах). */
  resolveProjectWorkspace?: (projectId: string) => Promise<string | undefined>;
  /** Окно модели для капа (по умолчанию — динамический кап от дефолтного окна). */
  resolveContextWindow?: (session: Session | null, project: Project | null) => number | undefined;
  /** Резолв id текущего пользователя (standalone — `local`). */
  resolveUserId?: (c: Context) => string | Promise<string>;
  /** Доступ к сессии (владелец|ADMIN). Standalone — owner local/none. */
  canAccess?: (session: Session, c: Context, userId: string) => boolean | Promise<boolean>;
  /** Доступ к проекту (owner/LEAD/ADMIN). Standalone — разрешено. */
  canAccessProject?: (project: Project, c: Context, userId: string) => boolean | Promise<boolean>;
  /** Локализованные сообщения (backend — `t()`). */
  messages?: (c: Context) => ContextRoutesMessages;
}

/**
 * AD-069 §9.3: read-only прозрачность проектных инструкций.
 *
 * `GET /instructions?session_id=<id>` — снимок для workspace проекта сессии
 * (сессия без проекта → пустой результат с причиной `no-project`).
 * `GET /instructions?project_id=<id>` — снимок для проекта.
 *
 * RBAC — как у аналогов: сессия — владелец|ADMIN (`canAccess`), проект —
 * owner/LEAD/ADMIN (`canAccessProject`). Резолвер (discovery/threat-scan)
 * не дублируется — передан через `opts.resolveInstructions`.
 */
export function createContextRoutes(auth: AuthKit, opts: ContextRoutesOptions): Hono {
  const app = new Hono();
  const messages = (c: Context): ContextRoutesMessages => opts.messages?.(c) ?? DEFAULT_MESSAGES;
  const resolveUserId = opts.resolveUserId ?? (() => LOCAL_USER_ID);

  // Standalone: владелец `local`/без владельца — доступен; backend переопределяет
  // `opts.canAccess` (владелец|ADMIN), как в session-роутах.
  const canAccess = async (session: Session, c: Context, userId: string): Promise<boolean> => {
    if (opts.canAccess) return opts.canAccess(session, c, userId);
    const owner = session.ownerId ?? session.userId;
    return !owner || owner === LOCAL_USER_ID;
  };

  // Standalone — однопользовательский режим; backend переопределяет
  // `opts.canAccessProject` (owner/LEAD/ADMIN), как project-роуты.
  const canAccessProject = async (project: Project, c: Context, userId: string): Promise<boolean> => {
    if (opts.canAccessProject) return opts.canAccessProject(project, c, userId);
    return true;
  };

  const fail = (c: Context, status: 400 | 403 | 404 | 500, code: string, message: string) =>
    c.json({ error: { code, message } }, status);

  app.get('/instructions', auth.requireAuth, async (c) => {
    const sessionId = c.req.query('session_id');
    const projectId = c.req.query('project_id');
    const userId = await resolveUserId(c);

    if (sessionId) {
      if (!opts.sessionManager) return fail(c, 500, 'INTERNAL_ERROR', messages(c).internal);
      const session = await opts.sessionManager.getSession(sessionId);
      if (!session) return fail(c, 404, 'NOT_FOUND', messages(c).sessionNotFound);
      if (!(await canAccess(session, c, userId))) {
        return fail(c, 403, 'FORBIDDEN', messages(c).forbiddenSession);
      }

      const linkedProjectId = session.projectId;
      const project = linkedProjectId && opts.projectStore
        ? await opts.projectStore.load(linkedProjectId).catch(() => null)
        : null;
      const workspace = linkedProjectId && opts.resolveProjectWorkspace
        ? await opts.resolveProjectWorkspace(linkedProjectId).catch(() => undefined)
        : undefined;

      const info: InstructionsInfo = await opts.resolveInstructions({
        workspace,
        projectId: linkedProjectId,
        contextWindow: opts.resolveContextWindow?.(session, project),
      });
      return c.json({ session_id: sessionId, ...info });
    }

    if (projectId) {
      if (!opts.projectStore) return fail(c, 500, 'INTERNAL_ERROR', messages(c).internal);
      const project = await opts.projectStore.load(projectId);
      if (!project) return fail(c, 404, 'NOT_FOUND', messages(c).projectNotFound);
      if (!(await canAccessProject(project, c, userId))) {
        return fail(c, 403, 'FORBIDDEN', messages(c).forbiddenProject);
      }

      const workspace = opts.resolveProjectWorkspace
        ? await opts.resolveProjectWorkspace(projectId).catch(() => undefined)
        : project.workspace || undefined;

      const info: InstructionsInfo = await opts.resolveInstructions({
        workspace,
        projectId,
        contextWindow: opts.resolveContextWindow?.(null, project),
      });
      return c.json({ project_id: projectId, ...info });
    }

    return fail(c, 400, 'VALIDATION_ERROR', messages(c).missingScope);
  });

  return app;
}
