import { ReadableStream } from 'node:stream/web';
import { Hono } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import type { SessionManager, EventBus, QueueProcessorManager, ChatOrchestrator, ContextOptimizer } from '../../index.js';
import { MessageRole, SESSION_MODES, generateStreamId, nowISO } from '@itphx/shared';
import type { Message } from '@itphx/shared';
import { enqueueUserMessage, sseEventStream } from '../../index.js';
import { serializeSession, serializeMessage } from '../serialize.js';

const LOCAL_USER_ID = 'local';

export function createSessionRoutes(
  auth: AuthKit,
  sessionManager: SessionManager,
  eventBus: EventBus,
  queueManager: QueueProcessorManager,
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>,
  orchestrator: ChatOrchestrator,
  contextOptimizer?: ContextOptimizer,
): Hono {
  const app = new Hono();
  const agentRegistry = orchestrator.agentRegistry;

  app.get('/', auth.requireAuth, async (c) => {
    const sessions = await sessionManager.listSessions({
      userId: LOCAL_USER_ID,
    });
    return c.json(sessions.map((s) => serializeSession(s, { agentRegistry })));
  });

  app.post('/', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const session = await sessionManager.createSession({
      title: body.name || body.title || undefined,
      projectId: body.project_id || body.projectId || undefined,
      engine: body.engine || 'synth',
      parentId: body.parent_id || body.parentId || undefined,
      sessionOrigin: body.session_origin || body.sessionOrigin || undefined,
      settings: body.settings,
    });
    session.userId = LOCAL_USER_ID;
    session.ownerId = LOCAL_USER_ID;
    await sessionManager.updateSession(session);
    eventBus.publish(session.id, 'session.created', serializeSession(session, { agentRegistry }));
    return c.json(serializeSession(session, { agentRegistry }), 201);
  });

  app.get('/:id', auth.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    return c.json(serializeSession(session, { agentRegistry }));
  });

  app.patch('/:id', auth.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    if (body.project_id !== undefined || body.projectId !== undefined) {
      session.projectId = body.project_id ?? body.projectId;
    }
    if (body.name !== undefined) session.title = body.name;
    if (body.title !== undefined) {
      const prevTitle = session.title;
      session.title = body.title;
      if (prevTitle !== body.title) {
        eventBus.publish(session.id, 'session.renamed', { session_id: session.id, title: body.title, prev_title: prevTitle });
      }
    }
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

  app.delete('/:id', auth.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    eventBus.publish(session.id, 'session.deleted', { session_id: session.id });
    await sessionManager.deleteSession(session.id);
    queueManager.stop(session.id);
    return c.body(null, 204);
  });

  app.get('/:id/status', auth.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    return c.json({
      blocked: !!session.status.blocked,
      pending_count: session.pendingMessages.length,
      processor_running: queueManager.isRunning(session.id),
    });
  });

  app.post('/:id/prompt', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const content = body.content?.trim();

    if (!content) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Контент обязателен' } }, 400);
    }

    const sessionId = c.req.param('id');
    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }

    const streamId = body.messageId || generateStreamId();

    const message: Message = {
      id: generateStreamId(),
      role: MessageRole.USER,
      seq: session.messages.length + 1,
      origin: 'local',
      parts: [{ id: generateStreamId(), type: 'text', data: content }],
      content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      author: 'local',
      agentRole: body.agent || session.settings.agentRole,
      provider: body.provider || session.settings.provider,
      model: body.model || session.settings.model,
      metadata: { ...(body.metadata || {}), stream_id: streamId },
    };

    const result = await enqueueUserMessage(
      sessionManager, eventBus, sessionId, message, queueManager, processMessage,
      (sid, msg) => orchestrator.obfuscateUserMessageForHistory(sid, msg),
    );

    if (!result) {
      return c.json({
        error: { code: 'QUEUE_FULL', message: 'Очередь сообщений заполнена (макс. 5)' },
      }, 429);
    }

    const signal = c.req.raw.signal;

    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          try {
            for await (const event of sseEventStream(eventBus, sessionId, signal)) {
              const line = `data: ${JSON.stringify(event)}\n\n`;
              controller.enqueue(encoder.encode(line));

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

  app.get('/:id/messages', auth.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    return c.json({
      messages: session.messages.map((m, i) => serializeMessage(m, i)),
      session_id: session.id,
      engine: session.engine,
    });
  });

  app.post('/:id/clear', auth.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
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

  app.post('/:id/abort', auth.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    if (session.currentStream) {
      orchestrator.cancel(session.currentStream.streamId);
      session.currentStream.cancelled = true;
      await sessionManager.updateSession(session);
    }
    queueManager.stop(session.id);
    return c.json({ status: 'aborted' });
  });

  app.post('/:id/summarize', auth.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    if (!contextOptimizer) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Context optimizer not configured' } }, 500);
    }
    if (!session.settings.provider || !session.settings.model) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'No provider/model configured for session' } }, 400);
    }
    if (!contextOptimizer.canSummarize(session)) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Need at least 3 active messages since last summary' } }, 400);
    }

    const streamId = generateStreamId();
    const sysMsg: Message = {
      id: streamId,
      role: MessageRole.SYSTEM,
      seq: 0,
      origin: 'local',
      parts: [{ id: generateStreamId(), type: 'text', data: '' }],
      content: '',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      author: 'local',
      metadata: { type: 'summarization_request', reason: 'manual', stream_id: streamId },
    };

    const result = await enqueueUserMessage(sessionManager, eventBus, session.id, sysMsg, queueManager, processMessage);
    if (!result) {
      return c.json({ error: { code: 'QUEUE_FULL', message: 'Queue is full' } }, 429);
    }
    return c.json({ status: 'enqueued', stream_id: streamId });
  });

  app.get('/:id/events', auth.requireAuth, async (c) => {
    const sessionId = c.req.param('id');
    const signal = c.req.raw.signal;

    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          try {
            for await (const event of sseEventStream(eventBus, sessionId, signal)) {
              const line = `data: ${JSON.stringify(event)}\n\n`;
              controller.enqueue(encoder.encode(line));
            }
          } catch {
            // disconnected
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

  app.get('/:id/children', auth.requireAuth, async (c) => {
    const children = await sessionManager.getChildren(c.req.param('id'));
    return c.json(children.map((s) => serializeSession(s, { agentRegistry })));
  });

  app.get('/:id/tree', auth.requireAuth, async (c) => {
    const tree = await sessionManager.getSessionTree(c.req.param('id'));
    return c.json(tree);
  });

  app.post('/:id/fork', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const fork = await sessionManager.forkSession(c.req.param('id'), {
      messageId: body.message_id ?? body.messageId,
      messageIndex: body.message_index ?? body.messageIndex,
      title: body.title,
    });
    eventBus.publish(fork.id, 'session.fork.created', serializeSession(fork, { agentRegistry }));
    return c.json(serializeSession(fork, { agentRegistry }), 201);
  });

  // GET /api/v2/sessions/:id/references — список ссылок
  app.get('/:id/references', auth.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    const refs = await sessionManager.getReferences(c.req.param('id'));
    return c.json({ references: refs });
  });

  // POST /api/v2/sessions/:id/references — добавить ссылку
  app.post('/:id/references', auth.requireAuth, async (c) => {
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
  app.delete('/:id/references/:refSid', auth.requireAuth, async (c) => {
    await sessionManager.removeReference(c.req.param('id'), c.req.param('refSid'));
    eventBus.publish(c.req.param('id'), 'session.reference.removed', { session_id: c.req.param('refSid') });
    return c.body(null, 204);
  });

  // POST /api/v2/sessions/:id/messages/merge — копировать сообщения из другой сессии
  app.post('/:id/messages/merge', auth.requireAuth, async (c) => {
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

    eventBus.publish(c.req.param('id'), 'session.messages.merged', {
      messages: merged.map((m, i) => serializeMessage(m, i)),
      source_session_id: sourceSessionId,
    });

    return c.json({ messages: merged.map((m, i) => serializeMessage(m, i)) }, 201);
  });

  return app;
}
