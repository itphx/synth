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

  return app;
}
