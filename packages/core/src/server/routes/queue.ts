import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import type { SessionManager, QueueProcessorManager, ChatOrchestrator, EventBus } from '../../index.js';
import { generateStreamId, MessageRole } from '@itphx/synth-shared';
import { isRemoteRef, toLocalId, remoteErrorToHttp } from '../../remote/aggregate.js';
import type { RemoteBackendClient } from '../../remote/client.js';

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
  auth: AuthKit,
  sessionManager: SessionManager,
  queueManager: QueueProcessorManager,
  eventBus: EventBus,
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>,
  remoteClient?: RemoteBackendClient,
): Hono {
  const app = new Hono();

  app.post('/:sessionId/clear', auth.requireAuth, async (c) => {
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
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }

    if (index !== undefined && !isNaN(index) && !session.pendingMessages[index]) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сообщение не найдено по индексу' } }, 404);
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
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
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
