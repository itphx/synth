import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager } from '@synth/core';
import { t } from '../lib/i18n.js';

export function createQueueRoutes(kit: AuthKit, sessionManager: SessionManager): Hono {
  const app = new Hono();

  // POST /api/v2/queue/:sessionId/clear — очистить очередь
  app.post('/:sessionId/clear', kit.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    const count = session.pendingMessages.length;
    session.pendingMessages = [];
    await sessionManager.updateSession(session);

    return c.json({ cleared: count });
  });

  // POST /api/v2/queue/:sessionId/return — вернуть очередь в input
  app.post('/:sessionId/return', kit.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    const texts: string[] = session.pendingMessages.map((m) => m.content);
    session.pendingMessages = [];
    await sessionManager.updateSession(session);

    return c.json({ texts });
  });

  // POST /api/v2/queue/:sessionId/resume — возобновить обработку
  app.post('/:sessionId/resume', kit.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    // Разблокировать
    session.status.blocked = undefined;
    session.status.blockedAt = undefined;
    await sessionManager.updateSession(session);

    return c.json({ resumed: true, pending_count: session.pendingMessages.length });
  });

  return app;
}
