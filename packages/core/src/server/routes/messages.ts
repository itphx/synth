import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { SessionManager } from '../../index.js';
import { isRemoteRef, toLocalId, remoteErrorToHttp } from '../../remote/aggregate.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import type { Session } from '@itphx/synth-shared';
import { createSessionAccessGuard, createSessionAccessPredicate } from '../session-access-guard.js';
import type { SessionAccessKind } from '../session-access-guard.js';
import type { LocalOwnerResolver } from '../local-owner.js';
import type { BlobRefRepository } from '../../storage/ports/blob-ref-repository.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface MessageRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы по умолчанию. */
export interface MessageRouteMessages {
  sessionNotFound: (c: Context) => string;
  messageNotFound: (c: Context) => string;
  forbidden: (c: Context) => string;
}

export interface MessageRoutesOptions {
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<MessageRouteMessages>;
  /**
   * Хук после успешной локальной мутации (batch/toggle/pin/delete/retry),
   * вызывается с await. Backend использует его для пересчёта `canSummarize`.
   */
  onMessagesChanged?: (sessionId: string, c: Context) => void | Promise<void>;
  /** userId запроса. Core — 'local'; backend — id из AuthKit. */
  resolveUserId?: (c: Context) => string | Promise<string>;
  /** Доступ к содержимому сессии. Core — local-owner; backend — owner|ADMIN. */
  canAccess?: (session: Session, c: Context, userId: string) => boolean | Promise<boolean>;
  /** Доп. правило доступа (например, участие в проекте; `access` — read/write). */
  resolveCanAccessExtra?: (
    session: Session,
    c: Context,
    userId: string,
    access: SessionAccessKind,
  ) => boolean | Promise<boolean>;
  /** Сквозной обзор (ADMIN/LEAD) — доступ ко всем сессиям. */
  resolveElevated?: (c: Context) => boolean | Promise<boolean>;
  /**
   * ADR-089 (standalone): нормализация legacy-владельца (UUID профиля `local`)
   * при доступе к сессии. Managed не задаёт (id реальные).
   */
  localOwnerResolver?: LocalOwnerResolver;
  /**
   * ADR-115: учёт ссылок на объекты blob-хранилища. Сообщения действительно
   * удаляются (splice) — при удалении снимаем ссылки владельца
   * (`ownerKind: 'message'`), иначе объект вложений никогда не станет
   * сиротой и не будет вычищен GC.
   */
  blobRefs?: BlobRefRepository;
}

const LOCAL_USER_ID = 'local';

const DEFAULT_MESSAGES: MessageRouteMessages = {
  sessionNotFound: () => 'Сессия не найдена',
  messageNotFound: () => 'Сообщение не найдено',
  forbidden: () => 'Доступ к сессии запрещён',
};

/** Преобразовать RemoteError в HTTP-ответ API v2; не-RemoteError → undefined (пробросить дальше). */
function mapRemoteError(c: Context, err: unknown): Response | undefined {
  const http = remoteErrorToHttp(err);
  if (!http) return undefined;
  return c.json(
    { error: { code: http.code, message: err instanceof Error ? err.message : String(err) } },
    http.status as 400 | 401 | 404 | 409 | 500 | 502,
  );
}

/** 502, если гибрид не настроен, иначе undefined — обрабатываем удалённую сессию. */
function remoteUnavailable(c: Context): Response | undefined {
  return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
}

export function createMessageRoutes(
  auth: MessageRoutesAuth,
  sessionManager: SessionManager,
  getRemoteClient?: () => RemoteBackendClient | null,
  opts?: MessageRoutesOptions,
): Hono {
  const app = new Hono();
  const resolveClient = (): RemoteBackendClient | undefined => getRemoteClient?.() ?? undefined;
  /**
   * Гибридные ветки активны только если геттер вообще передан (в managed его нет).
   * Единая семантика с `createSessionRoutes`: `remote:<uuid>` пропускается только
   * при настроенном гибриде; в managed такой id даёт предсказуемый 404 (нет
   * локальной сессии), а не 502 «REMOTE_UNAVAILABLE из-за отсутствия геттера».
   */
  const hasRemoteGetter = getRemoteClient !== undefined;
  const messages: MessageRouteMessages = { ...DEFAULT_MESSAGES, ...opts?.messages };
  const onMessagesChanged = opts?.onMessagesChanged;
  const blobRefs = opts?.blobRefs;
  const resolveUserId = opts?.resolveUserId ?? (() => LOCAL_USER_ID);
  const accessPredicate = createSessionAccessPredicate({
    canAccess: opts?.canAccess,
    resolveCanAccessExtra: opts?.resolveCanAccessExtra,
    localUserId: LOCAL_USER_ID,
    localOwnerResolver: opts?.localOwnerResolver,
  });

  // Авторизация сообщений — инвариант на префиксе `/:sessionId` (не вызов «по
  // списку» в каждом хендлере): guard до маршрутов + `requireAuth` в цепочке.
  // Remote-ref пропускается (сессия на удалённой стороне — ADR-042).
  const sessionAccessGuard = createSessionAccessGuard({
    param: 'sessionId',
    resolveSession: (id) => sessionManager.getSession(id),
    resolveUserId,
    isAllowed: async (session, c, userId, access) => {
      if ((await opts?.resolveElevated?.(c)) ?? false) return true;
      return accessPredicate(session, c, userId, access);
    },
    messages: { sessionNotFound: messages.sessionNotFound, forbidden: messages.forbidden },
    skipForId: (id) => hasRemoteGetter && isRemoteRef(id),
  });
  app.use('/:sessionId', auth.requireAuth);
  app.use('/:sessionId', sessionAccessGuard);
  app.use('/:sessionId/*', auth.requireAuth);
  app.use('/:sessionId/*', sessionAccessGuard);

  // POST /api/v2/messages/:sessionId/batch — групповая операция
  app.post('/:sessionId/batch', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    // Пустое/невалидное тело не должно ронять запрос 500-й из-за `c.req.json()`:
    // парсим толерантно и отдаём 400 в формате проекта.
    const body = await c.req
      .json<{ action: string; indices: number[]; state?: boolean }>()
      .catch(() => ({} as { action: string; indices: number[]; state?: boolean }));

    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.messagesBatch(toLocalId(sessionId), body as Record<string, unknown>);
        return c.json(result, 200);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    const { action, indices, state } = body;

    if (typeof action !== 'string' || !['pin', 'toggle', 'delete'].includes(action)) {
      return c.json({
        error: {
          code: 'INVALID_ACTION',
          message: `action is required and must be one of: pin, toggle, delete (got: ${String(action)})`,
        },
      }, 400);
    }
    if (!Array.isArray(indices) || indices.length === 0) {
      return c.json({ error: { code: 'INVALID_INDICES', message: 'indices must be a non-empty array' } }, 400);
    }

    const session = await sessionManager.getSession(sessionId);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);

    // ADR-115: id сообщений, которые будут удалены — зафиксировать ДО операции
    // (после splice индексы съезжают). Ссылки на объекты вложений снимаются
    // по id: иначе объект вложений никогда не станет сиротой и не уйдёт в GC.
    const deletedMessageIds = action === 'delete' && blobRefs
      ? indices.map((index) => session.messages[index]?.id).filter((id): id is string => !!id)
      : [];

    const result = await sessionManager.batchMessageOperation(
      sessionId,
      action as 'pin' | 'toggle' | 'delete',
      indices,
      state,
    );

    for (const messageId of deletedMessageIds) {
      await blobRefs!.removeByOwner('message', messageId).catch(() => 0);
    }

    await onMessagesChanged?.(sessionId, c);

    return c.json(result, 200);
  });

  // PATCH /api/v2/messages/:sessionId/:index/toggle — переключить disabled
  app.patch('/:sessionId/:index/toggle', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    const index = parseInt(c.req.param('index'), 10);

    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.messageToggle(toLocalId(sessionId), index);
        return c.json(result, 200);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    if (index < 0 || index >= session.messages.length) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.messageNotFound(c) } }, 404);
    }

    const disabled = await sessionManager.withLock(sessionId, async (locked) => {
      locked.messages[index]!.disabled = !locked.messages[index]!.disabled;
      await sessionManager.updateSession(locked);
      return locked.messages[index]!.disabled;
    });

    await onMessagesChanged?.(sessionId, c);

    return c.json({ disabled, success: true });
  });

  // PATCH /api/v2/messages/:sessionId/:index/pin — переключить pinned
  app.patch('/:sessionId/:index/pin', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    const index = parseInt(c.req.param('index'), 10);

    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.messagePin(toLocalId(sessionId), index);
        return c.json(result, 200);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    if (index < 0 || index >= session.messages.length) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.messageNotFound(c) } }, 404);
    }

    const pinned = await sessionManager.withLock(sessionId, async (locked) => {
      locked.messages[index]!.pinned = !locked.messages[index]!.pinned;
      await sessionManager.updateSession(locked);
      return locked.messages[index]!.pinned;
    });

    await onMessagesChanged?.(sessionId, c);

    return c.json({ pinned, success: true });
  });

  // DELETE /api/v2/messages/:sessionId/:index — удалить сообщение
  app.delete('/:sessionId/:index', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    const index = parseInt(c.req.param('index'), 10);

    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.messageDelete(toLocalId(sessionId), index);
        return c.json(result, 200);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    if (index < 0 || index >= session.messages.length) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.messageNotFound(c) } }, 404);
    }

    await sessionManager.withLock(sessionId, async (locked) => {
      // ADR-115: сообщение удаляется — снимаем его ссылки на объекты вложений.
      const removedId = locked.messages[index]?.id;
      locked.messages.splice(index, 1);
      locked.messages.forEach((m, i) => { m.seq = i + 1; });
      await sessionManager.updateSession(locked);
      if (blobRefs && removedId) await blobRefs.removeByOwner('message', removedId).catch(() => 0);
    });

    await onMessagesChanged?.(sessionId, c);

    return c.json({ success: true });
  });

  // POST /api/v2/messages/:sessionId/:index/retry — отключить сообщения от index и вернуть текст
  app.post('/:sessionId/:index/retry', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    const index = parseInt(c.req.param('index'), 10);

    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.messageRetry(toLocalId(sessionId), index);
        return c.json(result, 200);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    if (index < 0 || index >= session.messages.length) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.messageNotFound(c) } }, 404);
    }

    const msg = session.messages[index]!;
    const content = msg.content;

    await sessionManager.withLock(sessionId, async (locked) => {
      for (let i = index; i < locked.messages.length; i++) {
        locked.messages[i]!.disabled = true;
      }
      locked.pendingMessages = [];
      await sessionManager.updateSession(locked);
    });

    await onMessagesChanged?.(sessionId, c);

    return c.json({ content, success: true });
  });

  // GET /api/v2/messages/:sessionId/:index/debug
  app.get('/:sessionId/:index/debug', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    const index = parseInt(c.req.param('index'), 10);

    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.messageDebug(toLocalId(sessionId), index);
        return c.json(result, 200);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    if (index < 0 || index >= session.messages.length) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.messageNotFound(c) } }, 404);
    }

    const msg = session.messages[index]!;
    return c.json({
      role: msg.role,
      content: msg.content.slice(0, 200),
      model: msg.model,
      provider: msg.provider,
      usage: msg.usage,
      debug_data: msg.debugData || {},
      metadata: msg.metadata || {},
      tool_calls: msg.toolCalls,
    });
  });

  return app;
}
