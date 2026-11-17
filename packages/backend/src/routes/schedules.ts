/**
 * Managed-доступ к расписаниям планировщика (PROP-141, этап 5 B-1).
 *
 * Правило доступа — **общее** для проектных ресурсов автоматизаций: вынесено
 * в `routes/project-access.ts` (`createBackendProjectAccess`) и переиспользуется
 * таймерами (`routes/timers.ts`) — копии правила нет.
 *
 * | Актор                        | чтение (`GET /`, `GET /:id/jobs`) | мутации (`POST`/`PUT`/`DELETE`/`run`) |
 * |------------------------------|-----------------------------------|----------------------------------------|
 * | владелец проекта             | да                                 | да                                     |
 * | участник `EDITOR`            | да                                 | да                                     |
 * | участник `VIEWER`            | да                                 | **403** (`VIEWER` не мутирует)         |
 * | `LEAD`/`ADMIN`               | да (сквозной обзор)                | да                                     |
 * | чужой `USER`                 | **не видно в списке**, 403/404     | 403/404                                |
 *
 * Прежний `requireAdmin` на все мутации снят (PROP-141, решение владельца
 * 2026-11-17): EDITOR/OWNER управляют автоматизациями своего проекта.
 *
 * **service-key (ADR-052)** — не пользователь проекта (`service:<keyId>` не
 * участник), поэтому ролевая проверка по проекту к нему не применяется:
 * scope проверяет `requireScope`, проекцию `allowedProjects` —
 * `serviceProjectProjection`. Здесь service-key ограничен своей проекцией:
 * список — по `allowedProjects` (не задана — все проекты, пустой список —
 * ничего), а проект вне проекции — 403.
 */
import type { ProjectRepository } from '@itphx/synth-core';
import type { AuthKit } from '../auth/middleware.js';
import { createBackendProjectAccess } from './project-access.js';
import type { BackendProjectAccess } from './project-access.js';

export interface BackendScheduleAccessDeps {
  /** AuthKit backend (OIDC/RBAC). */
  auth: AuthKit;
  /** Порт проектов — по нему резолвятся права на проект расписания. */
  projectStore: ProjectRepository;
}

/**
 * Реализации опций core-фабрики расписаний (`createSchedulerRoutes`):
 * граничная проверка прав на проект и скоуп видимости списка.
 */
export type BackendScheduleAccess = BackendProjectAccess;

/**
 * Собрать managed-правило доступа к расписаниям.
 *
 * Правило — общее для автоматизаций (`createBackendProjectAccess`); здесь
 * только привязка к зависимостям расписаний.
 */
export function createBackendScheduleAccess(
  deps: BackendScheduleAccessDeps,
): BackendScheduleAccess {
  return createBackendProjectAccess(deps);
}
