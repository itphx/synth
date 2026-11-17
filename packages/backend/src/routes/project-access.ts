/**
 * Managed-доступ к проектным ресурсам автоматизаций (PROP-141, этап 5 B-1/B-2).
 *
 * Право — на **проект ресурса** (ADR-089 §5.5/§5.8, инвариант 21):
 *
 * | Актор                        | чтение                    | мутации                          |
 * |------------------------------|---------------------------|----------------------------------|
 * | владелец проекта             | да                        | да                               |
 * | участник `EDITOR`            | да                        | да                               |
 * | участник `VIEWER`            | да                        | **403** (`VIEWER` не мутирует)   |
 * | `LEAD`/`ADMIN`               | да (сквозной обзор)       | да                               |
 * | чужой `USER`                 | **не видно в списке**     | 403/404                          |
 *
 * Правило доступа — **одно** для HTTP-контура и агентских тулов
 * (`engine/tools/automation-helpers.ts`): источник истины по ролям —
 * `createProjectAccess` (PROP-133), тот же резолвер, что у `routes/processes.ts`
 * и `routes/messages.ts`.
 *
 * **service-key (ADR-052)** — не пользователь проекта (`service:<keyId>` не
 * участник), поэтому ролевая проверка по проекту к нему не применяется:
 * scope проверяет `requireScope`, проекцию `allowedProjects` —
 * `serviceProjectProjection`. Здесь service-key ограничен своей проекцией:
 * список — по `allowedProjects` (не задана — все проекты, пустой список —
 * ничего), а проект вне проекции — 403.
 *
 * Общий хелпер для **расписаний** (`routes/schedules.ts`) и **таймеров**
 * (`routes/timers.ts`): правило одно, копии нет.
 */
import type { Context } from 'hono';
import type { ProjectRepository } from '@itphx/synth-core';
import { getServiceCredential } from '@itphx/synth-core';
import type { User } from '@itphx/synth-shared';
import type { AuthKit } from '../auth/middleware.js';
import { createProjectAccess } from './projects.js';
import { groupsOf } from '../lib/project-principal.js';
import { t } from '../lib/i18n.js';

export interface BackendProjectAccessDeps {
  /** AuthKit backend (OIDC/RBAC). */
  auth: AuthKit;
  /** Порт проектов — по нему резолвятся права на проект ресурса. */
  projectStore: ProjectRepository;
}

/**
 * Реализации опций core-фабрик (расписаний/таймеров): граничная проверка
 * прав на проект и скоуп видимости списка.
 */
export interface BackendProjectAccess {
  /**
   * Граничная проверка доступа к проекту ресурса (инвариант 16):
   * `read` — право чтения, `write` — право изменения содержимого.
   * `null` — доступ разрешён; иначе — готовый ответ (403/404).
   */
  authorizeProject: (
    c: Context,
    projectId: string,
    mode: 'read' | 'write',
  ) => Promise<Response | null>;
  /**
   * Скоуп чтения списка: id проектов, видимых пользователю; `null` — «все»
   * (`ADMIN`/`LEAD` — сквозной обзор; service-key без `allowedProjects`).
   */
  listVisibleProjectIds: (c: Context) => Promise<string[] | null>;
}

/**
 * Собрать managed-правило доступа к проектным ресурсам автоматизаций.
 *
 * Fail-closed: нет пользователя/проекта/прав — отказ; проект не найден — 404
 * (ресурса нет), права не те — 403.
 */
export function createBackendProjectAccess(
  deps: BackendProjectAccessDeps,
): BackendProjectAccess {
  const projectAccess = createProjectAccess(deps.auth);
  type Ctx = Parameters<typeof deps.auth.isAdmin>[0];

  const forbidden = (c: Context) =>
    c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);

  const projectNotFound = (c: Context) =>
    c.json(
      { error: { code: 'NOT_FOUND', message: t('errors.notFound.project', undefined, c) } },
      404,
    );

  const unauthorized = (c: Context) =>
    c.json(
      { error: { code: 'UNAUTHORIZED', message: t('auth.unauthorized', undefined, c) } },
      401,
    );

  const authorizeProject = async (
    c: Context,
    projectId: string,
    mode: 'read' | 'write',
  ): Promise<Response | null> => {
    // ADR-052: service-key — не пользователь проекта (`service:<keyId>` не
    // участник), поэтому ролевую проверку по проекту для него не применяем:
    // scope проверяет `requireScope`, а проекцию `allowedProjects` —
    // `serviceProjectProjection`. Здесь — только граница проекции:
    // проекта вне `allowedProjects` ключ не адресует (403).
    const credential = getServiceCredential(c);
    if (credential) {
      const allowedProjects = credential.allowedProjects;
      if (!allowedProjects || allowedProjects.includes(projectId)) return null;
      return forbidden(c);
    }
    const user = await deps.auth.getCurrentUser(c);
    if (!user) return unauthorized(c);
    const project = await deps.projectStore.load(projectId);
    if (!project) return projectNotFound(c);
    const allowed =
      mode === 'read'
        ? projectAccess.canReadProject(c as never, project, user.id)
        : projectAccess.canEditProjectContent(c as never, project, user.id);
    return allowed ? null : forbidden(c);
  };

  const listVisibleProjectIds = async (c: Context): Promise<string[] | null> => {
    // ADR-052: service-key — область видимости = проекция `allowedProjects`
    // (не задана — все проекты, как и у `isProjectAllowed`). Пустой список —
    // не «всё», а «ничего»: fail-closed.
    const credential = getServiceCredential(c);
    if (credential) return credential.allowedProjects ?? null;
    const ctx = c as unknown as Ctx;
    const user = await deps.auth.getCurrentUser(c);
    if (!user) return [];
    // `ADMIN`/`LEAD` — сквозной обзор (как `resolveElevated` в проектах).
    if (deps.auth.isAdmin(ctx) || deps.auth.hasRole(ctx, 'LEAD')) return null;
    // Остальным — только проекты, доступные для чтения (PROP-133).
    const projects = await deps.projectStore.list({
      userId: user.id,
      groups: groupsOf(c.get('user') as User),
    });
    return projects.map((project) => project.id);
  };

  return { authorizeProject, listVisibleProjectIds };
}
