import { ReadableStream } from 'node:stream/web';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import type { SessionManager, EventBus, QueueProcessorManager, ChatOrchestrator, ContextOptimizer } from '../../index.js';
import { MessageRole, SESSION_MODES, generateStreamId, nowISO, sessionUpdateSchema, createResolveAuthorName } from '@itphx/synth-shared';
import type { Message, Session } from '@itphx/synth-shared';
import type { ProfileStore } from '@itphx/synth-shared';
import { enqueueUserMessage, sseEventStream, DEFAULT_AGENT_ID, SubagentResumeError, computeSessionStats } from '../../index.js';
import { serializeSession, serializeMessage } from '../serialize.js';
import type { ProjectStore } from '../../storage/project-store.js';
import { isRemoteRef, toLocalId, toRemoteRef, toRemote, mergeItems, remoteErrorToHttp } from '../../remote/aggregate.js';
import { RemoteError } from '../../remote/types.js';
import type { RemoteBackendClient } from '../../remote/client.js';

const LOCAL_USER_ID = 'local';

/** Преобразовать RemoteError в HTTP-ответ API v2; не-RemoteError → undefined (пробросить дальше). */
function mapRemoteError(c: Context, err: unknown): Response | undefined {
  const http = remoteErrorToHttp(err);
  if (!http) return undefined;
  return c.json(
    { error: { code: http.code, message: err instanceof Error ? err.message : String(err) } },
    http.status as 400 | 401 | 404 | 409 | 500 | 502,
  );
}

export function createSessionRoutes(
  auth: AuthKit,
  sessionManager: SessionManager,
  eventBus: EventBus,
  queueManager: QueueProcessorManager,
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>,
  orchestrator: ChatOrchestrator,
  contextOptimizer?: ContextOptimizer,
  projectStore?: ProjectStore,
  /** Профили пользователей: display name для статистики (fallback — username). */
  profilesStore?: ProfileStore,
  /**
   * Геттер текущего клиента к удалённому backend (runtime-подключение):
   * возвращает null, когда гибрид не подключён. Роуты резолвят клиента
   * в начале каждого хэндлера, а не при создании фабрики.
   */
  getRemoteClient?: () => RemoteBackendClient | null,
): Hono {
  const app = new Hono();
  const agentRegistry = orchestrator.agentRegistry;
  const resolveClient = (): RemoteBackendClient | undefined => getRemoteClient?.() ?? undefined;
  const resolveAuthorName = createResolveAuthorName(profilesStore);

  /**
   * AD-071/безопасность: доступ к локальной сессии. Standalone — однопользовательский
   * режим (владелец `local`); легаси-сессии без владельца считаются доступными,
   * чтобы не ломать существующие данные.
   */
  const canAccessSession = (session: Session): boolean => {
    const owner = session.ownerId ?? session.userId;
    return !owner || owner === LOCAL_USER_ID;
  };

  app.get('/', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const projectId = c.req.query('project_id') || undefined;
    const sessions = await sessionManager.listSessions({
      userId: LOCAL_USER_ID,
    });

    // Запрос удалённого мира без настроенного гибрида — ошибка, а не локальный список.
    if (projectId && isRemoteRef(projectId) && !remoteClient) {
      return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
    }

    if (!remoteClient) {
      return c.json(sessions.map((s) => serializeSession(s, { agentRegistry })));
    }

    try {
      if (projectId && isRemoteRef(projectId)) {
        const remote = (await remoteClient.listSessions(toLocalId(projectId))) as Array<Record<string, unknown>>;
        return c.json(mergeItems([], remote, { remoteProjectId: projectId }));
      }
      // Локальные сериализуем в DTO ДО объединения — иначе в merged-список
      // попадут сырые Session (camelCase) рядом с remote-DTO (snake_case).
      const localDto = sessions.map((s) => serializeSession(s, { agentRegistry }));
      const remote = (await remoteClient.listSessions(projectId)) as Array<Record<string, unknown>>;
      return c.json(mergeItems(localDto, remote));
    } catch (err) {
      // Offline-деградация: сервер недоступен — отдаём локальный мир.
      if (err instanceof RemoteError) {
        console.warn(`[hybrid] удалённый backend недоступен (${err.code}): ${err.message}`);
        if (projectId && isRemoteRef(projectId)) return c.json([]);
        return c.json(sessions.map((s) => serializeSession(s, { agentRegistry })));
      }
      throw err;
    }
  });

  app.post('/', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const body = await c.req.json().catch(() => ({}));

    // Гибрид: создание удалённой сессии на backend.
    if (body.origin === 'remote') {
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      const forwarded: Record<string, unknown> = { ...body };
      delete forwarded.origin;
      if (typeof forwarded.project_id === 'string') forwarded.project_id = toLocalId(forwarded.project_id);
      if (typeof forwarded.projectId === 'string') forwarded.projectId = toLocalId(forwarded.projectId);
      try {
        const created = (await remoteClient.createSession(forwarded)) as Record<string, unknown>;
        return c.json(toRemote(created), 201);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    const session = await sessionManager.createSession({
      title: body.name || body.title || undefined,
      projectId: body.project_id || body.projectId || undefined,
      engine: body.engine || 'synth',
      parentId: body.parent_id || body.parentId || undefined,
      sessionOrigin: body.session_origin || body.sessionOrigin || undefined,
      settings: { ...body.settings, agentRole: body.settings?.agentRole ?? DEFAULT_AGENT_ID },
    });
    session.userId = LOCAL_USER_ID;
    session.ownerId = LOCAL_USER_ID;
    await sessionManager.updateSession(session);
    eventBus.publish(session.id, 'session.created', serializeSession(session, { agentRegistry }));
    return c.json(serializeSession(session, { agentRegistry }), 201);
  });

  app.get('/:id', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const id = c.req.param('id');
    if (isRemoteRef(id)) {
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      try {
        const remote = (await remoteClient.getSession(toLocalId(id))) as Record<string, unknown>;
        return c.json(toRemote(remote));
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    const session = await sessionManager.getSession(id);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    return c.json(serializeSession(session, { agentRegistry }));
  });

  app.patch('/:id', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const id = c.req.param('id');
    if (isRemoteRef(id)) {
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      const body = await c.req.json().catch(() => ({}));
      try {
        const updated = (await remoteClient.updateSession(toLocalId(id), body)) as Record<string, unknown>;
        return c.json(toRemote(updated));
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    const session = await sessionManager.getSession(id);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));

    // Валидация тела PATCH (sessionUpdateSchema): невалидные settings/engine/name → 400.
    // title/mode/project_id не входят в схему и обрабатываются отдельно ниже из body.
    const parsed = sessionUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Некорректные данные: ' + parsed.error.issues.map(i => i.path.join('.') + ' ' + i.message).join('; '),
        },
      }, 400);
    }

    // AD-040: перенос сессии между проектами (project_id). Валидируем существование
    // нового проекта и публикуем session.moved при фактической смене проекта.
    const prevProjectId = session.projectId;
    let projectChanged = false;
    if (body.project_id !== undefined || body.projectId !== undefined) {
      const newProjectId: string | null | undefined = body.project_id ?? body.projectId;
      if (newProjectId) {
        if (!projectStore) {
          return c.json({
            error: { code: 'INTERNAL_ERROR', message: 'Хранилище проектов недоступно' },
          }, 500);
        }
        const existing = await projectStore.load(newProjectId);
        if (!existing) {
          return c.json({
            error: { code: 'PROJECT_NOT_FOUND', message: 'Проект не найден' },
          }, 400);
        }
      }
      const resolved = newProjectId || undefined;
      if (prevProjectId !== resolved) {
        session.projectId = resolved;
        session.planApproved = false;
        projectChanged = true;
      }
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
    if (parsed.data.settings !== undefined) {
      session.settings = { ...session.settings, ...parsed.data.settings };
    }
    await sessionManager.updateSession(session);
    eventBus.publish(session.id, 'session.updated', serializeSession(session, { agentRegistry }));
    if (projectChanged) {
      eventBus.publish(session.id, 'session.moved', {
        session_id: session.id,
        project_id: session.projectId ?? null,
        prev_project_id: prevProjectId ?? null,
      });
    }
    return c.json(serializeSession(session, { agentRegistry }));
  });

  app.delete('/:id', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const id = c.req.param('id');
    if (isRemoteRef(id)) {
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      try {
        await remoteClient.deleteSession(toLocalId(id));
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
      return c.body(null, 204);
    }
    const session = await sessionManager.getSession(id);
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
    if (!canAccessSession(session)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ к сессии запрещён' } }, 403);
    }
    return c.json({
      blocked: !!session.status.blocked,
      pending_count: session.pendingMessages.length,
      processor_running: queueManager.isRunning(session.id),
    });
  });

  // GET /api/v2/sessions/:id/prompt — состав системного промпта (AD-070 §2.5):
  // манифест источников + состояние промпта активного агента + последний promptMeta.
  app.get('/:id/prompt', auth.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    if (!canAccessSession(session)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ к сессии запрещён' } }, 403);
    }
    const info = await orchestrator.getPromptInfo(session);
    return c.json(info);
  });

  // GET /api/v2/sessions/:id/stats — статистика по агентам/пользователям
  // (AD-070 §2.6): usage сообщений + рекурсивный usage саб-агентов (tool `task`).
  app.get('/:id/stats', auth.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    if (!canAccessSession(session)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ к сессии запрещён' } }, 403);
    }
    const stats = await computeSessionStats(session, {
      getSession: (id) => sessionManager.getSession(id),
      getModelPricing: (model) => orchestrator.getModelPricing(model),
      resolveAuthorName,
    });
    return c.json(stats);
  });

  app.post('/:id/prompt', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('id');

    // Гибрид: удалённая сессия исполняется backend — пробрасываем upstream Response
    // как есть (SSE-стрим), без локального оркестратора.
    if (isRemoteRef(sessionId)) {
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      const body = await c.req.json().catch(() => ({}));
      try {
        return await remoteClient.promptSession(toLocalId(sessionId), body, { signal: c.req.raw.signal });
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    const body = await c.req.json().catch(() => ({}));
    const content = body.content?.trim();

    if (!content) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Контент обязателен' } }, 400);
    }

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    if (!canAccessSession(session)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ к сессии запрещён' } }, 403);
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
    const remoteClient = resolveClient();
    const id = c.req.param('id');
    if (isRemoteRef(id)) {
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      try {
        const result = (await remoteClient.getSessionMessages(toLocalId(id))) as Record<string, unknown>;
        // session_id в ответе — ссылка на сущность: приводим к remote-ref.
        const out = { ...result };
        if (typeof out.session_id === 'string') out.session_id = toRemoteRef(out.session_id);
        return c.json(out);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    const session = await sessionManager.getSession(id);
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
    const remoteClient = resolveClient();
    const id = c.req.param('id');
    if (isRemoteRef(id)) {
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      try {
        const result = await remoteClient.abortSession(toLocalId(id));
        return c.json(result);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    const session = await sessionManager.getSession(id);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }
    // Отмена стрима: прерываем fetch через cancelToken (orchestrator.cancel).
    // Очистку pendingMessages/blocked/currentStream выполняет сам QueueProcessor —
    // при cancelled processStream публикует stream.cancelled и возвращает {},
    // после чего процессор снимает blocked и очищает currentStream в успешной ветке.
    // НЕ вызываем queueManager.stop() — иначе сессия остаётся «зависшей» (stalled).
    if (session.currentStream) {
      orchestrator.cancel(session.currentStream.streamId);
    }
    return c.json({ status: 'aborted' });
  });

  // POST /api/v2/sessions/:id/resume-subagent — возобновить прерванную/ошибочную
  // дочернюю сессию саб-агента (B2). Валидация + блокировка синхронно, прогон —
  // в фоне; итог resume пишется в родительскую сессию.
  app.post('/:id/resume-subagent', auth.requireAuth, async (c) => {
    try {
      const result = await orchestrator.startSubagentResume(c.req.param('id'));
      return c.json(result, 202);
    } catch (err) {
      if (err instanceof SubagentResumeError) {
        return c.json({ error: { code: err.code, message: err.message } }, err.httpStatus as 400 | 404 | 409);
      }
      return c.json({ error: { code: 'INTERNAL_ERROR', message: String(err) } }, 500);
    }
  });

  app.post('/:id/summarize', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const id = c.req.param('id');
    if (isRemoteRef(id)) {
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      try {
        const result = await remoteClient.summarizeSession(toLocalId(id));
        return c.json(result);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    const session = await sessionManager.getSession(id);
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
