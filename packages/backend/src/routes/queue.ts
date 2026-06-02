import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager, QueueProcessorManager, ChatOrchestrator, EventBus } from '@synth/core';
import { generateStreamId } from '@synth/shared';
import { t } from '../lib/i18n.js';

export function createQueueRoutes(
  kit: AuthKit,
  sessionManager: SessionManager,
  queueManager: QueueProcessorManager,
  eventBus: EventBus,
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>,
): Hono {
  const app = new Hono();

  // POST /api/v2/queue/:sessionId/clear — очистить очередь
  app.post('/:sessionId/clear', kit.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');

    await sessionManager.safeUpdate(sessionId, async (session) => {
      session.pendingMessages = [];
    });

    queueManager.stop(sessionId);

    return c.json({ cleared: true });
  });

  // POST /api/v2/queue/:sessionId/return — вернуть очередь (тексты сообщений)
  // ?index=N — вернуть только одно сообщение
  app.post('/:sessionId/return', kit.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const indexStr = c.req.query('index');
    const index = indexStr !== undefined ? parseInt(indexStr, 10) : undefined;
    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    let texts: string[];
    if (index !== undefined && !isNaN(index)) {
      const msg = session.pendingMessages[index];
      if (!msg) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Message not found at index' } }, 404);
      }
      texts = [msg.content];
      await sessionManager.safeUpdate(sessionId, async (s) => {
        s.pendingMessages = s.pendingMessages.filter((_, i) => i !== index);
      });
    } else {
      const hasActiveStream = session.currentStream != null
      const msgs = hasActiveStream ? session.pendingMessages.slice(1) : session.pendingMessages
      texts = msgs.map((m) => m.content);
      await sessionManager.safeUpdate(sessionId, async (s) => {
        if (hasActiveStream) {
          s.pendingMessages = s.pendingMessages.slice(0, 1);
        } else {
          s.pendingMessages = [];
        }
      });
    }

    if (session.pendingMessages.length === 0) {
      queueManager.stop(sessionId);
    }

    return c.json({ texts });
  });

  // POST /api/v2/queue/:sessionId/resume — возобновить обработку
  app.post('/:sessionId/resume', kit.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    if (session.pendingMessages.length === 0) {
      return c.json({ resumed: true, pending_count: 0 });
    }

    // Разблокировать и запустить процессор заново
    await sessionManager.forceReleaseLock(sessionId);

    // Сообщения уже в очереди — не переенквеиваем, иначе будет дубликат.
    // Публикуем message.queued вручную и стартуем процессор.
    const firstMsg = session.pendingMessages[0];
    if (firstMsg) {
      if (!firstMsg.metadata) firstMsg.metadata = {};
      if (!firstMsg.metadata.stream_id) firstMsg.metadata.stream_id = generateStreamId();

      eventBus.publish(sessionId, 'message.queued', {
        stream_id: firstMsg.metadata.stream_id,
        pending_count: session.pendingMessages.length,
        message: firstMsg.content,
        agent_role: firstMsg.agentRole,
        author: firstMsg.author,
      });
    }

    queueManager.createProcessor(
      sessionId, sessionManager, eventBus, processMessage as never,
    );

    return c.json({ resumed: true, pending_count: session.pendingMessages.length });
  });

  return app;
}
