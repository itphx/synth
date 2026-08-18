import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager, ContextOptimizer, EventBus } from '@itphx/synth-core';
import { t } from '../lib/i18n.js';

export function createMessageRoutes(
  kit: AuthKit,
  sessionManager: SessionManager,
  contextOptimizer: ContextOptimizer | null,
  eventBus: EventBus,
): Hono {
  const app = new Hono();

  async function recalcCanSummarize(sessionId: string): Promise<void> {
    if (!contextOptimizer) return;
    const s = await sessionManager.getSession(sessionId);
    if (!s) return;
    const can = contextOptimizer.canSummarize(s);

    // Перепроверить флаг summarizationPending при toggle/pin/delete
    let shouldClearPending = false;
    if (s.summarizationPending && s.settings.summarizationEnabled) {
      const sumResult = contextOptimizer.shouldSummarize(s);
      if (!sumResult.triggered) {
        shouldClearPending = true;
      }
    }

    await sessionManager.withLock(sessionId, async (locked) => {
      locked.canSummarize = can;
      if (shouldClearPending) locked.summarizationPending = false;
      await sessionManager.saveSession(locked);
    });

    eventBus.publish(sessionId, 'session.updated', {
      session_id: sessionId,
      can_summarize: can,
      summarization_pending: shouldClearPending ? false : undefined,
      input_tokens: s.inputTokens,
      output_tokens: s.outputTokens,
      total_tokens: s.totalTokens,
      cache_read_tokens: s.cacheReadTokens,
      cache_write_tokens: s.cacheWriteTokens,
      reasoning_tokens: s.reasoningTokens,
      input_cost: s.inputCost,
      output_cost: s.outputCost,
      cache_read_cost: s.cacheReadCost,
      cache_write_cost: s.cacheWriteCost,
    });
  }

  // POST /api/v2/messages/:sessionId/batch — групповая операция
  app.post('/:sessionId/batch', kit.requireAuth, async (c) => {
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
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);

    const result = await sessionManager.batchMessageOperation(
      sessionId,
      action as 'pin' | 'toggle' | 'delete',
      indices,
      state,
    );

    recalcCanSummarize(sessionId);

    return c.json(result, 200);
  });

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
    recalcCanSummarize(sessionId);

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
    recalcCanSummarize(sessionId);

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
    recalcCanSummarize(sessionId);

    return c.json({ success: true });
  });

  // POST /api/v2/messages/:sessionId/:index/retry — отключить сообщения от index и вернуть текст
  app.post('/:sessionId/:index/retry', kit.requireAuth, async (c) => {
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
    const content = msg.content;

    for (let i = index; i < session.messages.length; i++) {
      session.messages[i]!.disabled = true;
    }
    session.pendingMessages = [];
    await sessionManager.updateSession(session);
    recalcCanSummarize(sessionId);

    return c.json({ content, success: true });
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
