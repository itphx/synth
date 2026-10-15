// HTTP-эндпоинты переноса проектов между мирами (гибрид, UI-слой поверх remote/transfer.ts).
//   POST /api/v2/projects/:id/publish      — локальный проект → удалённый backend;
//   POST /api/v2/projects/:id/fork-local   — удалённый проект → локальный мир.
// «Всегда всё»: сессии и файлы переносятся безусловно (includeFiles/includeSessions=true).
// Сам перенос выполняет transfer.ts in-process (как CLI `synth project publish|fork`);
// роуты лишь резолвят зависимости (store/sessionManager/workspace) и проверяют доступность
// runtime-подключения к backend (getRemoteClient). Монтируется на тот же префикс, что и
// projects-роуты: пути :id/publish и :id/fork-local не конфликтуют с :id (другой сегментный состав).

import { stat } from 'node:fs/promises';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import type { ProjectRepository } from '../../storage/ports/project-repository.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import type { EventBus } from '../../events/bus.js';
import { isRemoteRef, toLocalId, toRemoteRef, remoteErrorToHttp } from '../../remote/aggregate.js';
import { resolveLocalWorkspace, syncProjectToRemote, forkProjectToLocal } from '../../remote/transfer.js';
import { serializeProject } from '../serialize.js';

/** Преобразовать RemoteError в HTTP-ответ API v2; не-RemoteError → undefined (пробросить дальше). */
function mapRemoteError(c: Context, err: unknown): Response | undefined {
  const http = remoteErrorToHttp(err);
  if (!http) return undefined;
  return c.json(
    { error: { code: http.code, message: err instanceof Error ? err.message : String(err) } },
    http.status as 400 | 401 | 404 | 409 | 500 | 502,
  );
}

/** Ответ на ошибку переноса: RemoteError — по HTTP-статусу, прочее — 500 INTERNAL_ERROR. */
function mapTransferError(c: Context, err: unknown): Response {
  const mapped = mapRemoteError(c, err);
  if (mapped) return mapped;
  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) } },
    500,
  );
}

export function createProjectTransferRoutes(
  auth: AuthKit,
  store: ProjectRepository,
  sessionManager: SessionManager,
  /** Корень локальных workspace ({dataDir}/workspaces) — для resolveLocalWorkspace и forkProjectToLocal. */
  workspacesRoot: string,
  /** Рабочий каталог по умолчанию (для локальных проектов без workspace). */
  defaultWorkingDir: string,
  /**
   * Геттер текущего клиента к удалённому backend (runtime-подключение):
   * возвращает null, когда гибрид не подключён.
   */
  getRemoteClient?: () => RemoteBackendClient | null,
  /**
   * ADR-089: шина событий локального инстанса — для уведомления WS-хаба о
   * сессиях, импортированных `forkProjectToLocal` (авто-подписка клиентов
   * владельца по `session.created`, без переподключения).
   */
  eventBus?: EventBus,
): Hono {
  const app = new Hono();
  const resolveClient = (): RemoteBackendClient | undefined => getRemoteClient?.() ?? undefined;

  // POST /api/v2/projects/:id/publish — локальный проект → сервер.
  // Тело: { remote_project_id?: string } — id существующего удалённого проекта (в форме
  // 'remote:<uuid>' или сырой серверный id): задан → обновление, иначе создание нового.
  app.post('/:id/publish', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    if (isRemoteRef(id)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'Нельзя опубликовать удалённый проект' },
      }, 400);
    }
    const remoteClient = resolveClient();
    if (!remoteClient) {
      return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
    }
    const project = await store.load(id);
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Проект не найден' } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const remoteProjectId = typeof body.remote_project_id === 'string' && body.remote_project_id
      ? toLocalId(body.remote_project_id)
      : undefined;

    const localProjectDir = resolveLocalWorkspace(project, workspacesRoot, defaultWorkingDir);
    try {
      const s = await stat(localProjectDir);
      if (!s.isDirectory()) throw new Error('workspace не является директорией');
    } catch {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `Каталог workspace проекта не найден: ${localProjectDir}`,
        },
      }, 400);
    }

    const localSessions = await sessionManager.listSessions({ projectId: project.id });

    try {
      const stats = await syncProjectToRemote({
        localProject: project,
        remoteClient,
        remoteProjectId,
        includeFiles: true,
        includeSessions: true,
        localProjectDir,
        localSessions,
      });
      return c.json({
        ok: true,
        project_id: toRemoteRef(stats.projectId),
        created: stats.created,
        sessions_imported: stats.sessionsImported,
        files_uploaded: stats.filesUploaded,
      }, 201);
    } catch (err) {
      return mapTransferError(c, err);
    }
  });

  // POST /api/v2/projects/:id/fork-local — удалённый проект → локальный мир.
  // Тело: { local_name?: string } — имя локальной копии (по умолчанию — имя удалённого).
  app.post('/:id/fork-local', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    if (!isRemoteRef(id)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'Склонировать локально можно только удалённый проект' },
      }, 400);
    }
    const remoteClient = resolveClient();
    if (!remoteClient) {
      return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
    }
    const body = await c.req.json().catch(() => ({}));
    const localName = typeof body.local_name === 'string' && body.local_name.trim()
      ? body.local_name.trim()
      : undefined;

    try {
      const stats = await forkProjectToLocal({
        remoteProjectId: toLocalId(id),
        remoteClient,
        localProjectStore: store,
        localSessionManager: sessionManager,
        includeFiles: true,
        includeSessions: true,
        localWorkspacesRoot: workspacesRoot,
        localName,
        eventBus,
      });
      const localProject = await store.load(stats.projectId);
      if (!localProject) {
        return c.json({
          error: { code: 'INTERNAL_ERROR', message: 'Локальный проект не найден после клонирования' },
        }, 500);
      }
      return c.json(serializeProject(localProject), 201);
    } catch (err) {
      return mapTransferError(c, err);
    }
  });

  return app;
}
