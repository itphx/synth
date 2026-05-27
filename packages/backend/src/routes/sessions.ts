import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager } from '@synth/core';
import type { EventBus } from '@synth/core';
import type { QueueProcessorManager } from '@synth/core';
import type { ChatOrchestrator } from '@synth/core';
import type { ContextOptimizer } from '@synth/core';
import { MessageRole, generateStreamId, nowISO } from '@synth/shared';
import { enqueueUserMessage, sseEventStream } from '@synth/core';
import { serializeSession } from '../lib/serialize.js';
import { t } from '../lib/i18n.js';
import type { EventHub } from '../events/hub.js';

export function createSessionRoutes(
  kit: AuthKit,
  sessionManager: SessionManager,
  eventBus: EventBus,
  queueManager: QueueProcessorManager,
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>,
  orchestrator: ChatOrchestrator,
  eventHub: EventHub,
  contextOptimizer?: ContextOptimizer,
): Hono {
  const app = new Hono();

  // GET /api/v2/sessions — список сессий
  app.get('/', kit.requireAuth, async (c) => {
    const user = kit.getCurrentUser(c)!;
    const projectId = c.req.query('project_id');
    const sessions = await sessionManager.listSessions({
      projectId: projectId || undefined,
      userId: user.id,
    });
    return c.json(sessions.map(serializeSession));
  });

  // POST /api/v2/sessions — создать
  app.post('/', kit.requireAuth, async (c) => {
    const user = kit.getCurrentUser(c)!;
    const body = await c.req.json().catch(() => ({}));

    const session = await sessionManager.createSession({
      title: body.name || body.title || undefined,
      projectId: body.project_id || body.projectId || undefined,
      engine: body.engine || 'synth',
      settings: body.settings,
    });

    session.userId = user.id;
    session.ownerId = user.id;
    await sessionManager.updateSession(session);

    // Автоматически подписываем активных клиентов на новую сессию
    eventHub.subscribeToSession(user.id, session.id).catch((e: unknown) =>
      console.warn('subscribeToSession failed:', e),
    );

    return c.json(serializeSession(session), 201);
  });

  // GET /api/v2/sessions/:id — получить
  app.get('/:id', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    return c.json(serializeSession(session));
  });

  // PATCH /api/v2/sessions/:id — обновить
  app.patch('/:id', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));

    if (body.project_id !== undefined || body.projectId !== undefined) {
      session.projectId = body.project_id ?? body.projectId;
    }
    if (body.name !== undefined) session.title = body.name;
    if (body.title !== undefined) session.title = body.title;
    if (body.engine !== undefined) session.engine = body.engine;
    if (body.settings !== undefined) {
      session.settings = { ...session.settings, ...(body.settings as Partial<typeof session.settings>) };
    }

    await sessionManager.updateSession(session);
    return c.json(serializeSession(session));
  });

  // DELETE /api/v2/sessions/:id — удалить
  app.delete('/:id', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    await sessionManager.deleteSession(session.id);
    queueManager.stop(session.id);

    // Отписываем клиентов от удалённой сессии
    const user = kit.getCurrentUser(c)!;
    eventHub.unsubscribeFromSession(user.id, session.id);

    return c.body(null, 204);
  });

  // GET /api/v2/sessions/:id/status
  app.get('/:id/status', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    return c.json({
      blocked: !!session.status.blocked,
      pending_count: session.pendingMessages.length,
      processor_running: queueManager.isRunning(session.id),
    });
  });

  // POST /api/v2/sessions/:id/prompt — отправить сообщение (очередь + SSE-стрим)
  app.post('/:id/prompt', kit.requireAuth, async (c) => {
    const user = kit.getCurrentUser(c)!;
    const body = await c.req.json().catch(() => ({}));
    const content = body.content?.trim();

    if (!content) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.contentRequired', undefined, c) } }, 400);
    }

    const sessionId = c.req.param('id');
    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    const streamId = body.messageId || generateStreamId();

    const message = {
      role: MessageRole.USER,
      content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      author: user.username,
      agentRole: body.agent || session.settings.agentRole,
      provider: body.provider || session.settings.provider,
      model: body.model || session.settings.model,
      metadata: { ...(body.metadata || {}), stream_id: streamId },
    };

    // Ставим в очередь
    const result = await enqueueUserMessage(
      sessionManager, eventBus, sessionId, message, queueManager, processMessage,
    );

    if (!result) {
      return c.json({
        error: {
          code: 'QUEUE_FULL',
          message: t('errors.chat.queueFull', { max: 5 }, c),
        },
      }, 429);
    }

    // Возвращаем SSE-стрим, подписанный на EventBus
    const signal = c.req.raw.signal;

    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();

          try {
            for await (const event of sseEventStream(eventBus, sessionId, signal)) {
              const line = `data: ${JSON.stringify(event)}\n\n`;
              controller.enqueue(encoder.encode(line));

              // Останавливаемся после stream.done или stream.error для этого streamId
              if (
                (event.type === 'stream.done' || event.type === 'stream.error' || event.type === 'stream.cancelled')
                && event.data.stream_id === streamId
              ) {
                break;
              }
            }
          } catch {
            // client disconnected
          } finally {
            try { controller.close(); } catch { /* already closed */ }
          }
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      },
    );
  });

  // GET /api/v2/sessions/:id/messages — список сообщений
  app.get('/:id/messages', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    const { serializeMessage } = await import('../lib/serialize.js');
    return c.json({
      messages: session.messages.map((m, i) => serializeMessage(m, i)),
      session_id: session.id,
      engine: session.engine,
    });
  });

  // POST /api/v2/sessions/:id/clear — очистить все сообщения
  app.post('/:id/clear', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    session.messages = session.messages.filter((m) => m.pinned);
    session.pendingMessages = [];
    session.inputTokens = 0;
    session.outputTokens = 0;
    session.totalTokens = 0;
    session.inputCost = 0;
    session.outputCost = 0;
    session.cacheReadCost = 0;
    session.cacheWriteCost = 0;
    await sessionManager.updateSession(session);

    return c.json(serializeSession(session));
  });

  // POST /api/v2/sessions/:id/abort — отменить генерацию
  app.post('/:id/abort', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    if (session.currentStream) {
      orchestrator.cancel(session.currentStream.streamId);
      session.currentStream.cancelled = true;
      await sessionManager.updateSession(session);
    }

    queueManager.stop(session.id);

    return c.json({ status: 'aborted' });
  });

  // POST /api/v2/sessions/:id/summarize — ручная суммаризация (SSE-стрим)
  app.post('/:id/summarize', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    if (!contextOptimizer) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Context optimizer not configured' } }, 500);
    }

    if (!session.settings.provider || !session.settings.model) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'No provider/model configured for session' } }, 400);
    }

    // Проверка на минимальное количество активных сообщений
    const lastSummaryIdx = session.messages.reduceRight(
      (lastIdx, m, i) => (lastIdx >= 0 ? lastIdx : (m.role === 'summary' ? i : -1)), -1,
    );
    const startIdx = lastSummaryIdx >= 0 ? lastSummaryIdx + 1 : 0;
    const activeSinceLast = session.messages
      .slice(startIdx)
      .filter((m) => !m.disabled && !m.hidden && m.role !== 'info' && m.role !== 'summary');
    if (activeSinceLast.length < 3) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Need at least 3 active messages since last summary' } }, 400);
    }

    const signal = c.req.raw.signal;

    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();

          try {
            for await (const event of contextOptimizer!.summarizeStream(session)) {
              if (signal.aborted) break;

              const sseLine = `data: ${JSON.stringify(event)}\n\n`;
              controller.enqueue(encoder.encode(sseLine));

              if (event.type === 'done') {
                await sessionManager.withLock(session.id, async (s) => {
                  const msg = {
                    role: MessageRole.SUMMARY,
                    content: event.content,
                    createdAt: nowISO(),
                    disabled: false,
                    pinned: false,
                    hidden: false,
                    summaryOf: event.indices,
                    model: event.model,
                    usage: event.usage,
                    metadata: { type: 'auto_summary' },
                  };
                  s.messages.push(msg);

                  for (const idx of event.indices) {
                    if (idx >= 0 && idx < s.messages.length && !s.messages[idx]!.pinned) {
                      s.messages[idx]!.disabled = true;
                    }
                  }

                  await sessionManager.saveSession(s);
                });
                break;
              }

              if (event.type === 'error') break;
            }
          } catch {
            // client disconnected
          } finally {
            try { controller.close(); } catch { /* already closed */ }
          }
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      },
    );
  });

  // GET /api/v2/sessions/:id/optimization — настройки оптимизации
  app.get('/:id/optimization', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    return c.json({
      context_optimization: session.settings.contextOptimization,
      sliding_window_type: session.settings.slidingWindowType,
      sliding_window_limit: session.settings.slidingWindowLimit,
      summarization_enabled: session.settings.summarizationEnabled,
      summarize_after_n: session.settings.summarizeAfterN,
      summarize_context_percent: session.settings.summarizeContextPercent,
      summarization_head_messages: session.settings.summarizationHeadMessages,
      summarization_tail_messages: session.settings.summarizationTailMessages,
      context_window_threshold: session.settings.contextWindowThreshold,
    });
  });

  // PATCH /api/v2/sessions/:id/optimization — обновить настройки
  app.patch('/:id/optimization', kit.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));

    await sessionManager.withLock(c.req.param('id'), async (s) => {
      if (body.context_optimization !== undefined) s.settings.contextOptimization = body.context_optimization;
      if (body.sliding_window_type !== undefined) s.settings.slidingWindowType = body.sliding_window_type;
      if (body.sliding_window_limit !== undefined) s.settings.slidingWindowLimit = body.sliding_window_limit;
      if (body.summarization_enabled !== undefined) s.settings.summarizationEnabled = body.summarization_enabled;
      if (body.summarize_after_n !== undefined) s.settings.summarizeAfterN = body.summarize_after_n;
      if (body.summarize_context_percent !== undefined) s.settings.summarizeContextPercent = body.summarize_context_percent;
      if (body.summarization_head_messages !== undefined) s.settings.summarizationHeadMessages = body.summarization_head_messages;
      if (body.summarization_tail_messages !== undefined) s.settings.summarizationTailMessages = body.summarization_tail_messages;
      if (body.context_window_threshold !== undefined) s.settings.contextWindowThreshold = body.context_window_threshold;
      await sessionManager.saveSession(s);
    });

    const updated = await sessionManager.getSession(c.req.param('id'));
    return c.json(serializeSession(updated!));
  });

  // POST /api/v2/sessions/:id/optimization/check — проверить триггеры
  app.post('/:id/optimization/check', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    if (!contextOptimizer) {
      return c.json({ sliding_window: { triggered: false }, summarization: { triggered: false } });
    }

    const swResult = contextOptimizer.shouldApplySlidingWindow(session);
    const sumResult = contextOptimizer.shouldSummarize(session);

    return c.json({
      sliding_window: swResult,
      summarization: sumResult,
      summarization_pending: session.summarizationPending,
    });
  });

  // ===== Sticky Notes =====

  // GET /api/v2/sessions/:id/notes — список заметок
  app.get('/:id/notes', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    return c.json({ notes: session.stickyNotes });
  });

  // POST /api/v2/sessions/:id/notes — создать заметку
  app.post('/:id/notes', kit.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.content?.trim()) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Content is required' } }, 400);
    }

    const now = nowISO();
    const note = {
      id: generateStreamId(),
      content: body.content.trim(),
      createdAt: now,
      updatedAt: now,
      disabled: false,
    };

    await sessionManager.withLock(c.req.param('id'), async (s) => {
      s.stickyNotes.push(note);
      await sessionManager.saveSession(s);
    });

    const updated = await sessionManager.getSession(c.req.param('id'));
    eventBus.publish(c.req.param('id'), 'context.sticky_note_added', { note_id: note.id });
    return c.json({ note, notes: updated!.stickyNotes }, 201);
  });

  // PATCH /api/v2/sessions/:id/notes/:noteId — обновить заметку
  app.patch('/:id/notes/:noteId', kit.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const noteId = c.req.param('noteId');

    await sessionManager.withLock(c.req.param('id'), async (s) => {
      const note = s.stickyNotes.find((n) => n.id === noteId);
      if (!note) throw new Error('Note not found');

      if (body.content !== undefined) note.content = body.content;
      if (body.disabled !== undefined) note.disabled = body.disabled;
      note.updatedAt = nowISO();
      await sessionManager.saveSession(s);
    });

    const updated = await sessionManager.getSession(c.req.param('id'));
    eventBus.publish(c.req.param('id'), 'context.sticky_note_updated', { note_id: noteId });
    return c.json({ notes: updated!.stickyNotes });
  });

  // DELETE /api/v2/sessions/:id/notes/:noteId — удалить заметку
  app.delete('/:id/notes/:noteId', kit.requireAuth, async (c) => {
    const noteId = c.req.param('noteId');

    await sessionManager.withLock(c.req.param('id'), async (s) => {
      s.stickyNotes = s.stickyNotes.filter((n) => n.id !== noteId);
      await sessionManager.saveSession(s);
    });

    const updated = await sessionManager.getSession(c.req.param('id'));
    eventBus.publish(c.req.param('id'), 'context.sticky_note_deleted', { note_id: noteId });
    return c.json({ notes: updated!.stickyNotes });
  });

  return app;
}
