import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager } from '@synth/core';
import { MessageRole, generateStreamId, nowISO } from '@synth/shared';
import { serializeSession } from '../lib/serialize.js';
import { t } from '../lib/i18n.js';

export function createSessionRoutes(kit: AuthKit, sessionManager: SessionManager): Hono {
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
      projectId: body.project_id || body.projectId || undefined,
      engine: body.engine || 'synth',
      settings: body.settings,
    });

    session.userId = user.id;
    session.ownerId = user.id;
    await sessionManager.updateSession(session);

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
    });
  });

  // POST /api/v2/sessions/:id/prompt — отправить сообщение (SSE)
  app.post('/:id/prompt', kit.requireAuth, async (c) => {
    const user = kit.getCurrentUser(c)!;
    const body = await c.req.json().catch(() => ({}));
    const content = body.content?.trim();

    if (!content) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.contentRequired', undefined, c) } }, 400);
    }

    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    const streamId = body.messageId || generateStreamId();
    const msgIndex = session.messages.length;

    // Создать сообщение
    const message = {
      role: MessageRole.USER,
      content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      author: user.username,
      agentRole: body.agent,
      metadata: { ...(body.metadata || {}), stream_id: streamId },
      model: body.model,
      provider: body.provider,
    };

    await sessionManager.addMessage(session.id, message);

    // SSE-стрим (заглушка — без реального LLM)
    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const send = (event: string, data: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };

          send('stream.start', { stream_id: streamId });

          // Заглушка ответа
          const reply = t('stub.llmNotConnected', { content: content.slice(0, 200) }, c);
          send('stream.chunk', {
            stream_id: streamId,
            content: reply,
            is_final: false,
          });
          send('stream.chunk', {
            stream_id: streamId,
            content: '',
            is_final: true,
          });
          send('stream.done', {
            stream_id: streamId,
            content: reply,
            message_index: msgIndex + 1,
            pending_count: session.pendingMessages.length,
          });

          // Сохранить ответ как assistant-сообщение
          const assistantMsg = {
            role: MessageRole.ASSISTANT,
            content: reply,
            createdAt: nowISO(),
            disabled: false,
            pinned: false,
            hidden: false,
            author: user.username,
            agentRole: body.agent,
            metadata: { ...(body.metadata || {}), stream_id: streamId },
          };
          await sessionManager.addMessage(session.id, assistantMsg);

          controller.close();
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
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

  // POST /api/v2/sessions/:id/abort — отменить генерацию
  app.post('/:id/abort', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }

    if (session.currentStream) {
      session.currentStream.cancelled = true;
      await sessionManager.updateSession(session);
    }

    return c.json({ status: 'aborted' });
  });

  return app;
}
