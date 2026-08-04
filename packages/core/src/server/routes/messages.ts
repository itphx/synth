import { Hono } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import type { SessionManager } from '../../index.js';

export function createMessageRoutes(
  auth: AuthKit,
  sessionManager: SessionManager,
): Hono {
  const app = new Hono();

  // POST /api/v2/messages/:sessionId/batch — групповая операция
  app.post('/:sessionId/batch', auth.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const body = await c.req.json<{ action: string; indices: number[]; state?: boolean }>();
    const { action, indices, state } = body;

    if (!['pin', 'toggle', 'delete'].includes(action)) {
      return c.json({ error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } }, 400);
    }
    if (!Array.isArray(indices) || indices.length === 0) {
      return c.json({ error: { code: 'INVALID_INDICES', message: 'indices must be a non-empty array' } }, 400);
    }

    const session = await sessionManager.getSession(sessionId);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);

    const result = await sessionManager.batchMessageOperation(
      sessionId,
      action as 'pin' | 'toggle' | 'delete',
      indices,
      state,
    );

    return c.json(result, 200);
  });

  // PATCH /api/v2/messages/:sessionId/:index/toggle — переключить disabled
  app.patch('/:sessionId/:index/toggle', auth.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const index = parseInt(c.req.param('index'), 10);

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    if (index < 0 || index >= session.messages.length) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сообщение не найдено' } }, 404);
    }

    const disabled = await sessionManager.withLock(sessionId, async (locked) => {
      locked.messages[index]!.disabled = !locked.messages[index]!.disabled;
      await sessionManager.updateSession(locked);
      return locked.messages[index]!.disabled;
    });

    return c.json({ disabled, success: true });
  });

  // PATCH /api/v2/messages/:sessionId/:index/pin — переключить pinned
  app.patch('/:sessionId/:index/pin', auth.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const index = parseInt(c.req.param('index'), 10);

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    if (index < 0 || index >= session.messages.length) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сообщение не найдено' } }, 404);
    }

    const pinned = await sessionManager.withLock(sessionId, async (locked) => {
      locked.messages[index]!.pinned = !locked.messages[index]!.pinned;
      await sessionManager.updateSession(locked);
      return locked.messages[index]!.pinned;
    });

    return c.json({ pinned, success: true });
  });

  // DELETE /api/v2/messages/:sessionId/:index — удалить сообщение
  app.delete('/:sessionId/:index', auth.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const index = parseInt(c.req.param('index'), 10);

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    if (index < 0 || index >= session.messages.length) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сообщение не найдено' } }, 404);
    }

    await sessionManager.withLock(sessionId, async (locked) => {
      locked.messages.splice(index, 1);
      locked.messages.forEach((m, i) => { m.seq = i + 1; });
      await sessionManager.updateSession(locked);
    });

    return c.json({ success: true });
  });

  // POST /api/v2/messages/:sessionId/:index/retry — отключить сообщения от index и вернуть текст
  app.post('/:sessionId/:index/retry', auth.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const index = parseInt(c.req.param('index'), 10);

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    if (index < 0 || index >= session.messages.length) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сообщение не найдено' } }, 404);
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

    return c.json({ content, success: true });
  });

  // GET /api/v2/messages/:sessionId/:index/debug
  app.get('/:sessionId/:index/debug', auth.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const index = parseInt(c.req.param('index'), 10);

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    if (index < 0 || index >= session.messages.length) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сообщение не найдено' } }, 404);
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
