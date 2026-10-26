/**
 * Managed-правило доступа к реестру фоновых прогонов (PROP-096/097).
 *
 * Право на прогон — это право на его **сессию-владельца**:
 * - **владелец** сессии — да;
 * - **ADMIN** — да (сквозной доступ к инстансу);
 * - **участник проекта** сессии: чтение — `canReadProject` (любая роль, в т.ч.
 *   `VIEWER`), изменение — `canEditProjectContent` (`OWNER`/`EDITOR`/`LEAD`/
 *   `ADMIN`). Read-доступ **не** расширяет права на изменение (инвариант 21):
 *   `VIEWER` читает прогон, но не может его остановить или удалить;
 * - **LEAD** — сквозной доступ к содержимому проекта (как у `canManageProject`).
 *
 * Правило одно и то же для HTTP-контура и для любых других потребителей
 * (его же использует `createProjectAccess` — источник истины по ролям).
 */
import type { Context } from 'hono';
import type { Project, Session } from '@itphx/synth-shared';
import type { ProjectRepository, SessionAccessKind } from '@itphx/synth-core';
import type { AuthKit } from '../auth/middleware.js';
import { createProjectAccess } from './projects.js';

export interface BackendProcessAccessDeps {
  /** AuthKit backend (OIDC/RBAC). */
  auth: AuthKit;
  /** Порт проектов — по нему резолвятся права на проект сессии. */
  projectStore: ProjectRepository;
}

/** Предикат доступа к прогону (совместим с `SessionAccessPredicate` core). */
export type BackendProcessAccess = (
  session: Session,
  c: Context,
  userId: string,
  access: SessionAccessKind,
) => Promise<boolean>;

/**
 * Собрать правило доступа к фоновым прогонам для managed-контура.
 *
 * Fail-closed: сессия без проекта и не своего владельца — отказ; проект не
 * найден — отказ.
 */
export function createBackendProcessAccess(
  deps: BackendProcessAccessDeps,
): BackendProcessAccess {
  const projectAccess = createProjectAccess(deps.auth);
  type Ctx = Parameters<typeof deps.auth.isAdmin>[0];

  return async (session, c, userId, access): Promise<boolean> => {
    const owner = session.ownerId ?? session.userId;
    if (owner && owner === userId) return true;
    if (deps.auth.isAdmin(c as Ctx)) return true;
    if (!session.projectId) return false;
    const project: Project | null = await deps.projectStore.load(session.projectId);
    if (!project) return false;
    const ctx = c as Ctx;
    return access === 'read'
      ? projectAccess.canReadProject(ctx, project, userId)
      : projectAccess.canEditProjectContent(ctx, project, userId);
  };
}
