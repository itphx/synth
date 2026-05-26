import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager } from '@synth/core';
import type { EventBus } from '@synth/core';
import type { QueueProcessorManager } from '@synth/core';
import type { ChatOrchestrator } from '@synth/core';
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

  return app;
}
