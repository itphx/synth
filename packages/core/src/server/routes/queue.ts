import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { SessionManager, QueueProcessorManager, ChatOrchestrator, EventBus } from '../../index.js';
import { generateStreamId, MessageRole } from '@itphx/synth-shared';
import type { Session } from '@itphx/synth-shared';
import { isRemoteRef, toLocalId, remoteErrorToHttp } from '../../remote/aggregate.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import { createSessionAccessGuard, createSessionAccessPredicate } from '../session-access-guard.js';
import type { SessionAccessKind } from '../session-access-guard.js';
import type { LocalOwnerResolver } from '../local-owner.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface QueueRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы по умолчанию. */
export interface QueueRouteMessages {
  sessionNotFound: (c: Context) => string;
  messageNotFoundIndex: (c: Context) => string;
  forbidden: (c: Context) => string;
}

export interface QueueRoutesOptions {
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<QueueRouteMessages>;
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
}

const LOCAL_USER_ID = 'local';

const DEFAULT_MESSAGES: QueueRouteMessages = {
  sessionNotFound: () => 'Сессия не найдена',
  messageNotFoundIndex: () => 'Сообщение не найдено по индексу',
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

export function createQueueRoutes(
  auth: QueueRoutesAuth,
  sessionManager: SessionManager,
  queueManager: QueueProcessorManager,
  eventBus: EventBus,
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>,
  getRemoteClient?: () => RemoteBackendClient | null,
  opts?: QueueRoutesOptions,
): Hono {
  const app = new Hono();
  const resolveClient = (): RemoteBackendClient | undefined => getRemoteClient?.() ?? undefined;
  /**
   * Единая семантика с `createSessionRoutes`: `remote:<uuid>` пропускается только
   * при настроенном гибриде (геттер передан); в managed такой id даёт
   * предсказуемый 404, а не 502 «из-за отсутствия геттера».
   */
  const hasRemoteGetter = getRemoteClient !== undefined;
  const messages: QueueRouteMessages = { ...DEFAULT_MESSAGES, ...opts?.messages };
  const resolveUserId = opts?.resolveUserId ?? (() => LOCAL_USER_ID);
  const accessPredicate = createSessionAccessPredicate({
    canAccess: opts?.canAccess,
    resolveCanAccessExtra: opts?.resolveCanAccessExtra,
    localUserId: LOCAL_USER_ID,
    localOwnerResolver: opts?.localOwnerResolver,
  });

  // Авторизация очереди — инвариант на префиксе `/:sessionId`: guard до маршрутов
  // + `requireAuth` в цепочке. Remote-ref пропускается (ADR-042).
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

  app.post('/:sessionId/clear', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.queueClear(toLocalId(sessionId));
        return c.json(result);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    await sessionManager.safeUpdate(sessionId, async (session) => {
      session.pendingMessages = [];
    });
    queueManager.stop(sessionId);
    return c.json({ cleared: true });
  });

  app.post('/:sessionId/return', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    const indexStr = c.req.query('index');
    const index = indexStr !== undefined ? parseInt(indexStr, 10) : undefined;

    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.queueReturn(toLocalId(sessionId), index);
        return c.json(result);
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

    if (index !== undefined && !isNaN(index) && !session.pendingMessages[index]) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.messageNotFoundIndex(c) } }, 404);
    }

    // Активный стрим (не отменённый) продолжает обрабатываться — его user-сообщение
    // из истории удалять нельзя. При зависшей сессии (cancelled=true) — можно.
    const activeStreamId = session.currentStream && !session.currentStream.cancelled
      ? session.currentStream.streamId
      : undefined;

    let texts: string[] = [];
    let remainingCount = 0;

    await sessionManager.safeUpdate(sessionId, async (s) => {
      let removedStreamIds: string[] = [];
      if (index !== undefined && !isNaN(index)) {
        const msg = s.pendingMessages[index];
        if (!msg) return;
        texts = [msg.content];
        const sid = msg.metadata?.stream_id as string | undefined;
        removedStreamIds = sid ? [sid] : [];
        s.pendingMessages = s.pendingMessages.filter((_, i) => i !== index);
      } else {
        texts = s.pendingMessages.map((m) => m.content);
        removedStreamIds = s.pendingMessages
          .map((m) => m.metadata?.stream_id as string | undefined)
          .filter((id): id is string => !!id);
        s.pendingMessages = [];
      }
      remainingCount = s.pendingMessages.length;

      // Удаляем возвращённые user-сообщения из истории по stream_id, чтобы при
      // повторной отправке из поля ввода не было дубля. Активный стрим не трогаем.
      if (removedStreamIds.length > 0) {
        s.messages = s.messages.filter((m) => {
          if (m.role !== MessageRole.USER) return true;
          const sid = m.metadata?.stream_id as string | undefined;
          if (!sid) return true;
          if (sid === activeStreamId) return true;
          return !removedStreamIds.includes(sid);
        });
      }

      // Разблокируем сессию: снимаем blocked и currentStream (иначе return
      // оставит сессию в «зависшем» состоянии с pending=0, но blocked).
      if (remainingCount === 0) {
        s.status.blocked = undefined;
        s.status.blockedAt = undefined;
        s.currentStream = undefined;
      }
    });

    if (remainingCount === 0 && !activeStreamId) {
      queueManager.stop(sessionId);
    }

    return c.json({ texts });
  });

  app.post('/:sessionId/resume', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.queueResume(toLocalId(sessionId));
        return c.json(result);
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

    if (session.pendingMessages.length === 0) {
      return c.json({ resumed: true, pending_count: 0 });
    }

    await sessionManager.forceReleaseLock(sessionId);

    // Используем существующий stream_id первого pending-сообщения, НЕ генерируем
    // новый — иначе Phase 1 нового процессора повторно запушит сообщение в историю.
    // Если stream_id отсутствует — генерируем один раз и сохраняем.
    const firstMsg = session.pendingMessages[0];
    let streamId: string | undefined;
    let alreadyInHistory = false;
    if (firstMsg) {
      await sessionManager.safeUpdate(sessionId, async (s) => {
        const p = s.pendingMessages[0];
        if (!p) return;
        if (!p.metadata) p.metadata = {};
        if (!p.metadata.stream_id) p.metadata.stream_id = generateStreamId();
        streamId = p.metadata.stream_id as string;
        alreadyInHistory = s.messages.some(
          (m) => m.role === MessageRole.USER && m.metadata?.stream_id === streamId,
        );
      });

      if (streamId && !alreadyInHistory) {
        eventBus.publish(sessionId, 'message.queued', {
          stream_id: streamId,
          pending_count: session.pendingMessages.length,
          message: firstMsg.content,
          agent_role: firstMsg.agentRole,
          author: firstMsg.author,
        });
      }
    }

    queueManager.createProcessor(
      sessionId, sessionManager, eventBus, processMessage as never,
    );

    return c.json({ resumed: true, pending_count: session.pendingMessages.length });
  });

  // POST /:sessionId/retry-now — немедленный повтор при backoff (без ожидания паузы)
  app.post('/:sessionId/retry-now', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.queueRetryNow(toLocalId(sessionId));
        return c.json(result);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    const retried = queueManager.retryNow(sessionId);
    if (!retried) {
      return c.json({ error: { code: 'CONFLICT', message: 'Процессор не находится в состоянии повтора' } }, 409);
    }
    return c.json({ retried: true });
  });

  // POST /:sessionId/cancel-retry — отменить повторные попытки (снять pending, разблокировать)
  app.post('/:sessionId/cancel-retry', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.queueCancelRetry(toLocalId(sessionId));
        return c.json(result);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    const cancelled = await queueManager.cancelRetry(sessionId);
    if (!cancelled) {
      return c.json({ error: { code: 'CONFLICT', message: 'Процессор не найден' } }, 409);
    }
    return c.json({ cancelled: true });
  });

  return app;
}
