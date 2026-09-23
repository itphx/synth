import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager } from '@itphx/synth-core';
import type { EventBus } from '@itphx/synth-core';
import type { QueueProcessorManager } from '@itphx/synth-core';
import type { ChatOrchestrator } from '@itphx/synth-core';
import type { ContextOptimizer } from '@itphx/synth-core';
import {
  MessageRole,
  SESSION_MODES,
  generateStreamId,
  nowISO,
  sessionUpdateSchema,
  sessionMcpUpdateSchema,
  createResolveAuthorName,
} from '@itphx/synth-shared';
import type { Message, Session, SessionSettings } from '@itphx/synth-shared';
import type { ProfileStore } from '@itphx/synth-shared';
import { createRateLimiter } from '../middleware/rate-limiter.js';
import {
  enqueueUserMessage,
  sseEventStream,
  DEFAULT_AGENT_ID,
  SubagentResumeError,
  computeSessionStats,
  serializeSession,
  serializeMessage,
} from '@itphx/synth-core';
import { t } from '../lib/i18n.js';
import type { EventHub } from '../events/hub.js';
import type { ProjectStore } from '../storage/project-store.js';

export function createSessionRoutes(
  kit: AuthKit,
  sessionManager: SessionManager,
  eventBus: EventBus,
  queueManager: QueueProcessorManager,
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>,
  orchestrator: ChatOrchestrator,
  eventHub: EventHub,
  contextOptimizer?: ContextOptimizer,
  projectStore?: ProjectStore,
  /** Профили пользователей: display name для статистики (fallback — username). */
  profilesStore?: ProfileStore,
): Hono {
  const app = new Hono();
  const agentRegistry = orchestrator.agentRegistry;

  // AD-071 §2.4: владелец сессии — обычный пользователь, управляющий её MCP-скоупом.
  const isSessionOwner = (session: Session, userId: string): boolean =>
    (session.ownerId ?? session.userId) === userId;

  /**
   * Единый guard доступа к `/:id/*`: владелец сессии или глобальный ADMIN.
   * Применяется к `/prompt`, `/stats`, `/status`, `/mcp` (эндпоинты, читающие
   * содержимое/состояние сессии).
   */
  const canAccessSession = (
    session: Session,
    c: Parameters<typeof kit.isAdmin>[0],
    userId: string,
  ): boolean => isSessionOwner(session, userId) || kit.isAdmin(c);

  /** AD-071 §2.4: эффективный MCP-скоуп сессии (включая отключённые с причиной). */
  const buildSessionMcpPayload = async (session: Session) => {
    const servers = await orchestrator.resolveMcpServers(session);
    return {
      servers,
      enabled: servers.filter((s) => s.enabled).map((s) => s.name),
      disabled: servers.filter((s) => !s.enabled).map((s) => s.name),
      mcpServers: session.settings.mcpServers ?? [],
      mcpDisabledServers: session.settings.mcpDisabledServers ?? [],
    };
  };
  const resolveAuthorName = createResolveAuthorName(profilesStore);

  // GET /api/v2/sessions — список сессий
  app.get('/', kit.requireAuth, async (c) => {
    const user = (await kit.getCurrentUser(c))!;
    const projectId = c.req.query('project_id');
    const sessions = await sessionManager.listSessions({
      projectId: projectId || undefined,
      userId: user.id,
    });
    return c.json(sessions.map((s) => serializeSession(s, { agentRegistry })));
  });

  // POST /api/v2/sessions — создать
  app.post('/', kit.requireAuth, async (c) => {
    const user = (await kit.getCurrentUser(c))!;
    const body = await c.req.json().catch(() => ({}));

    const session = await sessionManager.createSession({
      title: body.name || body.title || undefined,
      projectId: body.project_id || body.projectId || undefined,
      engine: body.engine || 'synth',
      parentId: body.parent_id || body.parentId || undefined,
      sessionOrigin: body.session_origin || body.sessionOrigin || undefined,
      settings: { ...body.settings, agentRole: body.settings?.agentRole ?? DEFAULT_AGENT_ID },
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

  // GET /api/v2/sessions/:id/mcp — эффективный MCP-скоуп (AD-071 §2.4).
  // Показывает все серверы, включая отключённые (reason). RBAC: владелец сессии/ADMIN.
  app.get('/:id/mcp', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    const user = (await kit.getCurrentUser(c))!;
    if (!isSessionOwner(session, user.id) && !kit.isAdmin(c)) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
    }
    return c.json(await buildSessionMcpPayload(session));
  });

  // PUT /api/v2/sessions/:id/mcp — переключение MCP пользователем (AD-071 §2.4),
  // включая opt-out системных серверов. RBAC: владелец сессии/ADMIN.
  app.put('/:id/mcp', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    const user = (await kit.getCurrentUser(c))!;
    if (!isSessionOwner(session, user.id) && !kit.isAdmin(c)) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = sessionMcpUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }

    const { name, enabled, mcpServers, mcpDisabledServers } = parsed.data;
    const known = new Set((await orchestrator.resolveMcpServers(session)).map((s) => s.name));
    const toValidate = name !== undefined
      ? [name]
      : [...(mcpServers ?? []), ...(mcpDisabledServers ?? [])];
    for (const serverName of toValidate) {
      if (!known.has(serverName)) {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: `MCP-сервер "${serverName}" не найден` },
        }, 400);
      }
    }

    if (name !== undefined) {
      // Точечный toggle: enabled → session.enabled; disabled → opt-out.
      const enabledList = new Set(session.settings.mcpServers ?? []);
      const disabledList = new Set(session.settings.mcpDisabledServers ?? []);
      if (enabled === false) {
        enabledList.delete(name);
        disabledList.add(name);
      } else {
        enabledList.add(name);
        disabledList.delete(name);
      }
      session.settings.mcpServers = [...enabledList];
      session.settings.mcpDisabledServers = [...disabledList];
    } else {
      if (mcpServers !== undefined) session.settings.mcpServers = mcpServers;
      if (mcpDisabledServers !== undefined) session.settings.mcpDisabledServers = mcpDisabledServers;
    }

    await sessionManager.updateSession(session);
    eventBus.publish(session.id, 'session.updated', serializeSession(session, { agentRegistry }));
    return c.json(await buildSessionMcpPayload(session));
  });

  // GET /api/v2/sessions/:id/secrets — карта обфускации LLM Gateway (AD-036).
  // RBAC: только ADMIN/AUDITOR — сама карта является секретом.
  app.get('/:id/secrets', kit.requirePermission('ADMIN', 'AUDITOR'), async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    return c.json({ sessionId: session.id, secrets: session.obfuscationMap ?? {} });
  });

  // PATCH /api/v2/sessions/:id — обновить
  app.patch('/:id', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
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

  // DELETE /api/v2/sessions/:id — удалить
  app.delete('/:id', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    await sessionManager.deleteSession(session.id);
    queueManager.stop(session.id);

    // Оповещаем клиентов об удалении сессии
    const user = (await kit.getCurrentUser(c))!;
    eventBus.publish(session.id, 'session.deleted', { session_id: session.id });

    // Отписываем клиентов от удалённой сессии
    eventHub.unsubscribeFromSession(user.id, session.id);

    return c.body(null, 204);
  });

  // POST /api/v2/sessions/:id/fork — ответвление сессии
  app.post('/:id/fork', kit.requireAuth, async (c) => {
    const user = (await kit.getCurrentUser(c))!;
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

  // GET /api/v2/sessions/:id/export — полный экспорт сессии для переноса между
  // мирами (publish/fork). Внутренний формат: объект Session (camelCase) из
  // SessionManager — история сообщений, todos, настройки, заметки, ссылки,
  // чекпоинты, план-флаг и карта обфускации. Не публичный DTO.
  app.get('/:id/export', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    return c.json(session);
  });

  // POST /api/v2/sessions/import — создать сессию из экспорта другой сессии
  // (перенос истории между мирами). Тело: объект экспорта + import.project_id
  // (целевой проект; если не задан — берётся из экспорта). LLM не запускается.
  app.post('/import', kit.requireAuth, async (c) => {
    const user = (await kit.getCurrentUser(c))!;
    const body = await c.req.json().catch(() => ({}));

    const targetProjectId = body.import?.project_id
      ?? body.import?.projectId
      ?? body.project_id
      ?? body.projectId
      ?? undefined;

    if (targetProjectId) {
      if (!projectStore) {
        return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Хранилище проектов недоступно' } }, 500);
      }
      const existing = await projectStore.load(targetProjectId);
      if (!existing) {
        return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Проект не найден' } }, 400);
      }
    }

    const session = await sessionManager.createSession({
      title: typeof body.title === 'string' ? body.title : undefined,
      projectId: targetProjectId,
      engine: typeof body.engine === 'string' ? (body.engine as Session['engine']) : undefined,
      sessionOrigin: (body.session_origin ?? body.sessionOrigin) as Session['sessionOrigin'] | undefined,
      settings: (body.settings ?? {}) as Partial<SessionSettings>,
      userId: user.id,
      ownerId: user.id,
    });

    // Переносим историю и состояние из экспорта.
    // parentId: publish переписывает ссылки на новые remote-id до импорта — сохраняем.
    session.parentId = (body.parent_id ?? body.parentId) as string | undefined;
    const messages: Message[] = Array.isArray(body.messages) ? body.messages as Message[] : [];
    session.messages = messages.map((m) => ({ ...structuredClone(m), seq: 0 }));
    session.messages.forEach((m, i) => { m.seq = i + 1; });
    // pendingMessages — runtime-очередь, переносить бессмысленно.
    session.pendingMessages = [];
    session.todos = (body.todos ?? undefined) as Session['todos'];
    session.stickyNotes = Array.isArray(body.sticky_notes ?? body.stickyNotes)
      ? (body.sticky_notes ?? body.stickyNotes) as Session['stickyNotes']
      : [];
    session.references = Array.isArray(body.references) ? body.references as Session['references'] : [];
    session.checkpoints = Array.isArray(body.checkpoints) ? body.checkpoints as Session['checkpoints'] : [];
    session.mode = (body.mode ?? undefined) as Session['mode'];
    session.planApproved = body.plan_approved ?? body.planApproved ?? false;
    session.branchPoint = body.branch_point ?? body.branchPoint;
    session.obfuscationMap = (body.obfuscation_map ?? body.obfuscationMap) as Session['obfuscationMap'];
    session.createdAt = typeof (body.created_at ?? body.createdAt) === 'string'
      ? (body.created_at ?? body.createdAt)
      : session.createdAt;
    session.updatedAt = nowISO();

    // Сбрасываем runtime-состояние: блокировки/стримы с другого хоста не переносим.
    session.status = {};
    session.currentStream = undefined;
    session.summarizationPending = false;
    session.canSummarize = false;

    const num = (v: unknown, def = 0): number => (typeof v === 'number' ? v : def);
    session.inputTokens = num(body.input_tokens ?? body.inputTokens);
    session.outputTokens = num(body.output_tokens ?? body.outputTokens);
    session.totalTokens = num(body.total_tokens ?? body.totalTokens);
    session.cacheReadTokens = num(body.cache_read_tokens ?? body.cacheReadTokens);
    session.cacheWriteTokens = num(body.cache_write_tokens ?? body.cacheWriteTokens);
    session.reasoningTokens = num(body.reasoning_tokens ?? body.reasoningTokens);
    session.inputCost = num(body.input_cost ?? body.inputCost);
    session.outputCost = num(body.output_cost ?? body.outputCost);
    session.cacheReadCost = num(body.cache_read_cost ?? body.cacheReadCost);
    session.cacheWriteCost = num(body.cache_write_cost ?? body.cacheWriteCost);

    await sessionManager.saveSession(session);

    // Автоматически подписываем активных клиентов на новую сессию
    eventHub.subscribeToSession(user.id, session.id).catch((e: unknown) =>
      console.warn('subscribeToSession failed:', e),
    );
    eventBus.publish(session.id, 'session.created', serializeSession(session, { agentRegistry }));

    return c.json(serializeSession(session, { agentRegistry }), 201);
  });

  // GET /api/v2/sessions/:id/status
  app.get('/:id/status', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    const user = (await kit.getCurrentUser(c))!;
    if (!canAccessSession(session, c, user.id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
    }
    return c.json({
      blocked: !!session.status.blocked,
      pending_count: session.pendingMessages.length,
      processor_running: queueManager.isRunning(session.id),
    });
  });

  // GET /api/v2/sessions/:id/prompt — состав системного промпта (AD-070 §2.5):
  // манифест источников + состояние промпта активного агента + последний promptMeta.
  app.get('/:id/prompt', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    const user = (await kit.getCurrentUser(c))!;
    if (!canAccessSession(session, c, user.id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
    }
    const info = await orchestrator.getPromptInfo(session);
    return c.json(info);
  });

  // GET /api/v2/sessions/:id/stats — статистика по агентам/пользователям
  // (AD-070 §2.6): usage сообщений + рекурсивный usage саб-агентов (tool `task`).
  app.get('/:id/stats', kit.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.session', undefined, c) } }, 404);
    }
    const user = (await kit.getCurrentUser(c))!;
    if (!canAccessSession(session, c, user.id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
    }
    const stats = await computeSessionStats(session, {
      getSession: (id) => sessionManager.getSession(id),
      getModelPricing: (model) => orchestrator.getModelPricing(model),
      resolveAuthorName,
    });
    return c.json(stats);
  });

  // POST /api/v2/sessions/:id/prompt — отправить сообщение (очередь + SSE-стрим)
  app.post('/:id/prompt', kit.requireAuth, createRateLimiter(30, 60_000), async (c) => {
    const user = (await kit.getCurrentUser(c))!;
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
    if (!canAccessSession(session, c, user.id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
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
      (sid, msg) => orchestrator.obfuscateUserMessageForHistory(sid, msg),
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
  // дочернюю сессию саб-агента. Валидация + блокировка синхронно, прогон — в фоне;
  // итог resume пишется в родительскую сессию. 202/400/404/409.
  app.post('/:id/resume-subagent', kit.requireAuth, async (c) => {
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

    const user = (await kit.getCurrentUser(c))!;
    const streamId = generateStreamId();

    const sysMsg: import('@itphx/synth-shared').Message = {
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

    const user = (await kit.getCurrentUser(c))!;
    const streamId = generateStreamId();

    const sysMsg: import('@itphx/synth-shared').Message = {
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
