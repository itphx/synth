import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager } from '@synth/core';
import type { EventBus } from '@synth/core';
import type { QueueProcessorManager } from '@synth/core';
import type { ChatOrchestrator } from '@synth/core';
import type { ContextOptimizer } from '@synth/core';
import { MessageRole, SESSION_MODES, generateStreamId, nowISO } from '@synth/shared';
import { createRateLimiter } from '../middleware/rate-limiter.js';
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
  const agentRegistry = orchestrator.agentRegistry;

  // GET /api/v2/sessions — список сессий
  app.get('/', kit.requireAuth, async (c) => {
    const user = kit.getCurrentUser(c)!;
    const projectId = c.req.query('project_id');
    const sessions = await sessionManager.listSessions({
      projectId: projectId || undefined,
      userId: user.id,
    });
    return c.json(sessions.map((s) => serializeSession(s, { agentRegistry })));
  });

  // POST /api/v2/sessions — создать
  app.post('/', kit.requireAuth, async (c) => {
    const user = kit.getCurrentUser(c)!;
    const body = await c.req.json().catch(() => ({}));

    const session = await sessionManager.createSession({
      title: body.name || body.title || undefined,
      projectId: body.project_id || body.projectId || undefined,
      engine: body.engine || 'synth',
      parentId: body.parent_id || body.parentId || undefined,
      sessionOrigin: body.session_origin || body.sessionOrigin || undefined,
      settings: body.settings,
      userId: user.id,
      ownerId: user.id,
    });

    // Автоматически подписываем активных клиентов на новую сессию
    eventHub.subscribeToSession(user.id, session.id).catch((e: unknown) =>
      console.warn('subscribeToSession failed:', e),
    );

    // Оповещаем клиентов о новой сессии
    eventBus.publish(session.id, 'session.created', serializeSession(session, { agentRegistry }));

    return c.json(serializeSession(session, { agentRegistry }), 201);
  });

  // GET /api/v2/sessions/:id — получить
  app.get('/:id', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    return c.json(serializeSession(session, { agentRegistry }));
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
    if (body.mode !== undefined) {
      if (!SESSION_MODES.includes(body.mode)) {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: 'mode должен быть "plan", "act" или "yolo"' },
        }, 400);
      }
      session.mode = body.mode;
    }
    if (body.settings !== undefined) {
      session.settings = { ...session.settings, ...(body.settings as Partial<typeof session.settings>) };
    }

    await sessionManager.updateSession(session);
    eventBus.publish(session.id, 'session.updated', serializeSession(session, { agentRegistry }));
    return c.json(serializeSession(session, { agentRegistry }));
  });

  // DELETE /api/v2/sessions/:id — удалить
  app.delete('/:id', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    await sessionManager.deleteSession(session.id);
    queueManager.stop(session.id);

    // Оповещаем клиентов об удалении сессии
    const user = kit.getCurrentUser(c)!;
    eventBus.publish(session.id, 'session.deleted', { session_id: session.id });

    // Отписываем клиентов от удалённой сессии
    eventHub.unsubscribeFromSession(user.id, session.id);

    return c.body(null, 204);
  });

  // POST /api/v2/sessions/:id/fork — ответвление сессии
  app.post('/:id/fork', kit.requireAuth, async (c) => {
    const user = kit.getCurrentUser(c)!;
    const body = await c.req.json().catch(() => ({}));
    const fork = await sessionManager.forkSession(c.req.param('id'), {
      messageId: body.message_id ?? body.messageId,
      messageIndex: body.message_index ?? body.messageIndex,
      title: body.title,
      userId: user.id,
      ownerId: user.id,
    });
    eventHub.subscribeToSession(user.id, fork.id).catch((e: unknown) =>
      console.warn('subscribeToSession failed:', e),
    );
    eventBus.publish(fork.id, 'session.fork.created', serializeSession(fork, { agentRegistry }));
    return c.json(serializeSession(fork, { agentRegistry }), 201);
  });

  // GET /api/v2/sessions/:id/children — дочерние сессии
  app.get('/:id/children', kit.requireAuth, async (c) => {
    const children = await sessionManager.getChildren(c.req.param('id'));
    return c.json(children.map((s) => serializeSession(s, { agentRegistry })));
  });

  // GET /api/v2/sessions/:id/tree — дерево сессий
  app.get('/:id/tree', kit.requireAuth, async (c) => {
    const tree = await sessionManager.getSessionTree(c.req.param('id'));
    return c.json(tree);
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
  app.post('/:id/prompt', kit.requireAuth, createRateLimiter(30, 60_000), async (c) => {
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
      id: streamId,
      role: MessageRole.USER,
      seq: session.messages.length + 1,
      origin: 'local' as const,
      parts: [{ id: generateStreamId(), type: 'text' as const, data: content }],
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

    return c.json(serializeSession(session, { agentRegistry }));
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

  // POST /api/v2/sessions/:id/summarize — запросить суммаризацию (через очередь)
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
    if (!contextOptimizer.canSummarize(session)) {
      return c.json({
        error: { code: 'INVALID_REQUEST', message: 'Need at least 3 active messages since last summary' },
      }, 400);
    }

    const user = kit.getCurrentUser(c)!;
    const streamId = generateStreamId();

    const sysMsg: import('@synth/shared').Message = {
      id: streamId,
      role: MessageRole.SYSTEM,
      seq: 0,
      origin: 'local',
      parts: [{ id: generateStreamId(), type: 'text' as const, data: '' }],
      content: '',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      author: user.username,
      metadata: { type: 'summarization_request', reason: 'manual', stream_id: streamId },
    };

    const result = await enqueueUserMessage(sessionManager, eventBus, session.id, sysMsg, queueManager, processMessage);
    if (!result) {
      return c.json({ error: { code: 'QUEUE_FULL', message: 'Queue is full' } }, 429);
    }

    return c.json({ status: 'enqueued', stream_id: streamId });
  });

  // POST /api/v2/sessions/:id/debug-system-message — отправить отладочное системное сообщение
  app.post('/:id/debug-system-message', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    const user = kit.getCurrentUser(c)!;
    const streamId = generateStreamId();

    const sysMsg: import('@synth/shared').Message = {
      id: streamId,
      role: MessageRole.SYSTEM,
      seq: 0,
      origin: 'local',
      parts: [{ id: generateStreamId(), type: 'text' as const, data: '' }],
      content: '',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      author: user.username,
      metadata: { type: 'debug_system_message', reason: 'manual', stream_id: streamId },
    };

    const result = await enqueueUserMessage(sessionManager, eventBus, session.id, sysMsg, queueManager, processMessage);
    if (!result) {
      return c.json({ error: { code: 'QUEUE_FULL', message: 'Queue is full' } }, 429);
    }

    return c.json({ status: 'enqueued', stream_id: streamId });
  });

  // GET /api/v2/sessions/:id/optimization — настройки оптимизации
  app.get('/:id/optimization', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    return c.json({
      context_optimization: session.settings.contextOptimization,
      sliding_window_mode: session.settings.slidingWindowMode,
      sliding_window_message_limit: session.settings.slidingWindowMessageLimit,
      sliding_window_token_threshold: session.settings.slidingWindowTokenThreshold,
      summarization_enabled: session.settings.summarizationEnabled,
      summarization_trigger_mode: session.settings.summarizationTriggerMode,
      summarize_after_n: session.settings.summarizeAfterN,
      summarize_token_threshold: session.settings.summarizeTokenThreshold,
      summarization_head_messages: session.settings.summarizationHeadMessages,
      summarization_tail_messages: session.settings.summarizationTailMessages,
    });
  });

  // PATCH /api/v2/sessions/:id/optimization — обновить настройки
  app.patch('/:id/optimization', kit.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));

    await sessionManager.withLock(c.req.param('id'), async (s) => {
      if (body.context_optimization !== undefined) s.settings.contextOptimization = body.context_optimization;
      if (body.sliding_window_mode !== undefined) s.settings.slidingWindowMode = body.sliding_window_mode;
      if (body.sliding_window_message_limit !== undefined) s.settings.slidingWindowMessageLimit = body.sliding_window_message_limit;
      if (body.sliding_window_token_threshold !== undefined) s.settings.slidingWindowTokenThreshold = body.sliding_window_token_threshold;
      if (body.summarization_enabled !== undefined) s.settings.summarizationEnabled = body.summarization_enabled;
      if (body.summarization_trigger_mode !== undefined) s.settings.summarizationTriggerMode = body.summarization_trigger_mode;
      if (body.summarize_after_n !== undefined) s.settings.summarizeAfterN = body.summarize_after_n;
      if (body.summarize_token_threshold !== undefined) s.settings.summarizeTokenThreshold = body.summarize_token_threshold;
      if (body.summarization_head_messages !== undefined) s.settings.summarizationHeadMessages = body.summarization_head_messages;
      if (body.summarization_tail_messages !== undefined) s.settings.summarizationTailMessages = body.summarization_tail_messages;
      await sessionManager.saveSession(s);
    });

    const updated = await sessionManager.getSession(c.req.param('id'));
    return c.json(serializeSession(updated!, { agentRegistry }));
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

  // POST /api/v2/sessions/:id/optimization/cancel-summarization — отменить ожидающую суммаризацию
  app.post('/:id/optimization/cancel-summarization', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    await sessionManager.withLock(session.id, async (s) => {
      s.summarizationPending = false;
      await sessionManager.saveSession(s);
    });

    if (contextOptimizer) {
      const updated = await sessionManager.getSession(session.id);
      const can = contextOptimizer.canSummarize(updated!);
      eventBus.publish(session.id, 'session.updated', {
        session_id: session.id,
        can_summarize: can,
        summarization_pending: false,
      });
    }

    return c.json({ success: true });
  });

  // ===== References =====

  // GET /api/v2/sessions/:id/references — список ссылок
  app.get('/:id/references', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    const refs = await sessionManager.getReferences(c.req.param('id'));
    return c.json({ references: refs });
  });

  // POST /api/v2/sessions/:id/references — добавить ссылку
  app.post('/:id/references', kit.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sourceSessionId = body.source_session_id || body.sourceSessionId;
    if (!sourceSessionId) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'source_session_id is required' } }, 400);
    }
    const ref = await sessionManager.addReference(c.req.param('id'), sourceSessionId, {
      label: body.label,
      messageRange: body.message_range || body.messageRange,
      autoSummarize: body.auto_summarize ?? body.autoSummarize ?? false,
      position: body.position,
    });
    eventBus.publish(c.req.param('id'), 'session.reference.added', { reference: ref });
    return c.json({ reference: ref }, 201);
  });

  // DELETE /api/v2/sessions/:id/references/:refSid — удалить ссылку
  app.delete('/:id/references/:refSid', kit.requireAuth, async (c) => {
    await sessionManager.removeReference(c.req.param('id'), c.req.param('refSid'));
    eventBus.publish(c.req.param('id'), 'session.reference.removed', { session_id: c.req.param('refSid') });
    return c.body(null, 204);
  });

  // POST /api/v2/sessions/:id/messages/merge — копировать сообщения из другой сессии
  app.post('/:id/messages/merge', kit.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sourceSessionId = body.source_session_id || body.sourceSessionId;
    const sourceRange = body.source_range || body.sourceRange;
    const position = body.position || 'after';
    const anchorMessageId = body.anchor_message_id || body.anchorMessageId;
    const summarize = body.summarize || false;

    if (!sourceSessionId || !sourceRange || !Array.isArray(sourceRange) || sourceRange.length !== 2) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'source_session_id and source_range are required' } }, 400);
    }

    const merged = await sessionManager.mergeMessages(c.req.param('id'), sourceSessionId, {
      sourceRange: sourceRange as [number, number],
      position: position as 'after' | 'before',
      anchorMessageId,
      summarize,
    });

    const { serializeMessage } = await import('../lib/serialize.js');
    eventBus.publish(c.req.param('id'), 'session.messages.merged', {
      messages: merged.map((m, i) => serializeMessage(m, i)),
      source_session_id: sourceSessionId,
    });

    return c.json({ messages: merged.map((m, i) => serializeMessage(m, i)) }, 201);
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
