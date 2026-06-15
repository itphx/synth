import { Hono } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import type { SessionManager, QueueProcessorManager, ChatOrchestrator, EventBus } from '../../index.js';
import { generateStreamId } from '@synth/shared';

export function createQueueRoutes(
  auth: AuthKit,
  sessionManager: SessionManager,
  queueManager: QueueProcessorManager,
  eventBus: EventBus,
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>,
): Hono {
  const app = new Hono();

  app.post('/:sessionId/clear', auth.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    await sessionManager.safeUpdate(sessionId, async (session) => {
      session.pendingMessages = [];
    });
    queueManager.stop(sessionId);
    return c.json({ cleared: true });
  });

  app.post('/:sessionId/return', auth.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }

    const hasActiveStream = session.currentStream != null;
    const msgs = hasActiveStream ? session.pendingMessages.slice(1) : session.pendingMessages;
    const texts = msgs.map((m) => m.content);

    await sessionManager.safeUpdate(sessionId, async (s) => {
      if (hasActiveStream) {
        s.pendingMessages = s.pendingMessages.slice(0, 1);
      } else {
        s.pendingMessages = [];
      }
    });

    if (session.pendingMessages.length === 0) {
      queueManager.stop(sessionId);
    }

    return c.json({ texts });
  });

  app.post('/:sessionId/resume', auth.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }

    if (session.pendingMessages.length === 0) {
      return c.json({ resumed: true, pending_count: 0 });
    }

    await sessionManager.forceReleaseLock(sessionId);

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
