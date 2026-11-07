/**
 * Общие помощники проектных HTTP-роутов «план / журнал / инварианты»
 * (PROP-054).
 *
 * Права доступа (ADR-089 §5.5/§5.8, инвариант 21):
 * - чтение — право **чтения** проекта (`canRead`: владелец / любой участник,
 *   включая `VIEWER`, а также `LEAD`/`ADMIN`);
 * - мутации — право **изменения содержимого** (`canEditContent`: `OWNER`/
 *   `EDITOR`/`LEAD`/`ADMIN`).
 *
 * Проверка — **на границе** роута (инвариант 16): обработчик только читает
 * уже проверенный проект и применяет мутацию.
 */
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { Project } from '@itphx/synth-shared';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
export type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики (core и backend — общий). */
export interface ProjectWorkRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения (backend — i18n, core — русские литералы). */
export interface ProjectWorkRouteMessages {
  notFound: (c: Context) => string;
  forbidden: (c: Context) => string;
  invalidBody: (c: Context) => string;
  remoteUnavailable: (c: Context) => string;
}

export const DEFAULT_PROJECT_WORK_MESSAGES: ProjectWorkRouteMessages = {
  notFound: () => 'Проект не найден',
  forbidden: () => 'Доступ запрещён',
  invalidBody: () => 'Некорректное тело запроса',
  remoteUnavailable: () => 'Операция недоступна для удалённого проекта',
};

/** Опции проектных роутов «план / журнал / инварианты». */
export interface ProjectWorkRoutesOptions {
  /** Право чтения проекта (не задано — разрешено; standalone: один пользователь). */
  canRead?: (c: Context, project: Project, userId: string) => boolean | Promise<boolean>;
  /** Право изменения содержимого проекта (не задано — разрешено). */
  canEditContent?: (c: Context, project: Project, userId: string) => boolean | Promise<boolean>;
  /** userId текущего запроса (core — `'local'`, backend — id пользователя). */
  getCurrentUserId?: (c: Context) => string | Promise<string>;
  /** Сообщения (backend — i18n). */
  messages?: Partial<ProjectWorkRouteMessages>;
}

/** Результат проверки доступа к проекту. */
export interface ProjectAccess {
  project: Project;
  userId: string;
}

/**
 * Проверка доступа к проекту по виду операции (`read`/`write`).
 *
 * `null` — доступ есть (проект отдан); иначе — готовый HTTP-ответ
 * (404 — проекта нет, 403 — прав нет).
 */
export type ProjectAccessResult = ProjectAccess | Response;

/**
 * Собрать общий доступ + ответчики ошибок для проектных роутов.
 *
 * `store` — порт хранилища проектов (ADR-096): чтение идёт через него,
 * мутации — через `mutate` в доменных сервисах.
 */
export function createProjectWorkAccess(
  store: { load(id: string): Promise<Project | null> },
  opts: ProjectWorkRoutesOptions,
) {
  const messages: ProjectWorkRouteMessages = {
    ...DEFAULT_PROJECT_WORK_MESSAGES,
    ...opts.messages,
  };

  const currentUserId = async (c: Context): Promise<string> =>
    opts.getCurrentUserId ? await opts.getCurrentUserId(c) : 'local';

  const jsonForbidden = (c: Context) =>
    c.json({ error: { code: 'PROJECT_FORBIDDEN', message: messages.forbidden(c) } }, 403);
  const jsonNotFound = (c: Context) =>
    c.json({ error: { code: 'NOT_FOUND', message: messages.notFound(c) } }, 404);
  const jsonInvalid = (c: Context, detail?: string) =>
    c.json(
      { error: { code: 'VALIDATION_ERROR', message: detail ?? messages.invalidBody(c) } },
      400,
    );
  const jsonRemoteUnavailable = (c: Context) =>
    c.json(
      { error: { code: 'REMOTE_UNAVAILABLE', message: messages.remoteUnavailable(c) } },
      502,
    );

  /**
   * Загрузить проект и проверить право по виду операции.
   *
   * `access: 'read'` — право чтения, `'write'` — право изменения содержимого.
   */
  const authorize = async (
    c: Context,
    projectId: string,
    access: 'read' | 'write',
  ): Promise<ProjectAccessResult> => {
    const project = await store.load(projectId);
    if (!project) return jsonNotFound(c);
    const userId = await currentUserId(c);
    const allowed =
      access === 'read'
        ? opts.canRead
          ? await opts.canRead(c, project, userId)
          : true
        : opts.canEditContent
          ? await opts.canEditContent(c, project, userId)
          : true;
    if (!allowed) return jsonForbidden(c);
    return { project, userId };
  };

  return { messages, currentUserId, jsonForbidden, jsonNotFound, jsonInvalid, jsonRemoteUnavailable, authorize };
}
