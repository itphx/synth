import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager } from '@synth/core';
import { t } from '../lib/i18n.js';

export function createMessageRoutes(kit: AuthKit, sessionManager: SessionManager): Hono {
  const app = new Hono();

  // PATCH /api/v2/messages/:sessionId/:index/toggle — переключить disabled
  app.patch('/:sessionId/:index/toggle', kit.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const index = parseInt(c.req.param('index'), 10);

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    if (index < 0 || index >= session.messages.length) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.message', undefined, c) } }, 404);
    }

    session.messages[index]!.disabled = !session.messages[index]!.disabled;
    await sessionManager.updateSession(session);

    return c.json({
      disabled: session.messages[index]!.disabled,
      success: true,
    });
  });

  // PATCH /api/v2/messages/:sessionId/:index/pin — переключить pinned
  app.patch('/:sessionId/:index/pin', kit.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const index = parseInt(c.req.param('index'), 10);

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    if (index < 0 || index >= session.messages.length) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.message', undefined, c) } }, 404);
    }

    session.messages[index]!.pinned = !session.messages[index]!.pinned;
    await sessionManager.updateSession(session);

    return c.json({
      pinned: session.messages[index]!.pinned,
      success: true,
    });
  });

  // DELETE /api/v2/messages/:sessionId/:index — удалить сообщение
  app.delete('/:sessionId/:index', kit.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const index = parseInt(c.req.param('index'), 10);

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    if (index < 0 || index >= session.messages.length) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.message', undefined, c) } }, 404);
    }

    session.messages.splice(index, 1);
    await sessionManager.updateSession(session);

    return c.json({ success: true });
  });

  // GET /api/v2/messages/:sessionId/:index/debug
  app.get('/:sessionId/:index/debug', kit.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const index = parseInt(c.req.param('index'), 10);

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    if (index < 0 || index >= session.messages.length) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.message', undefined, c) } }, 404);
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
