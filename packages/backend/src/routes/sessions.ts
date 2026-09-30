import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager } from '@itphx/synth-core';
import type { EventBus } from '@itphx/synth-core';
import type { QueueProcessorManager } from '@itphx/synth-core';
import type { ChatOrchestrator } from '@itphx/synth-core';
import type { ContextOptimizer } from '@itphx/synth-core';
import {
  MessageRole,
  generateStreamId,
  nowISO,
  sessionMcpUpdateSchema,
} from '@itphx/synth-shared';
import type { Message, Session, SessionSettings } from '@itphx/synth-shared';
import type { ProfileStore } from '@itphx/synth-shared';
import { createRateLimiter } from '../middleware/rate-limiter.js';
import {
  enqueueUserMessage,
  serializeSession,
  createSessionRoutes as createCoreSessionRoutes,
} from '@itphx/synth-core';
import { t } from '../lib/i18n.js';
import type { EventHub } from '../events/hub.js';
import type { ProjectStore } from '@itphx/synth-core';

/**
 * Backend-обёртка над core-фабрикой сессий (ТД-1, фаза B2). Здесь остаются только
 * backend-специфичные роуты (MCP-скоуп сессии, секреты, export/import, отладка,
 * оптимизация контекста, sticky notes). Общая логика (список/создание/чтение/
 * изменение/удаление, status/prompt/stats, очередь+SSE, children/tree/fork,
 * references, merge) — в `createSessionRoutes` из `@itphx/synth-core`.
 *
 * RBAC: core-фабрика параметризуется `resolveUserId`/`resolveOwner`/`resolveAuthor`,
 * `canAccess` (владелец|ADMIN) и EventHub-хуками; remote/hybrid-ветки отключены
 * (getRemoteClient не передаётся). `GET /:id/events` на backend не регистрируется.
 */
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
  /** Агент по умолчанию для новых сессий без `settings.agentRole` (runtime-настройка). */
  resolveDefaultAgent?: () => string | Promise<string>,
): Hono {
  const app = new Hono();
  const agentRegistry = orchestrator.agentRegistry;

  // AD-071 §2.4: владелец сессии — обычный пользователь, управляющий её MCP-скоупом.
  const isSessionOwner = (session: Session, userId: string): boolean =>
    (session.ownerId ?? session.userId) === userId;

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

  // Общая логика — в core-фабрике (backend-специфика выше). Регистрируем её
  // последней: статические/backend-only сегменты должны матчиться раньше.
  app.route('/', createCoreSessionRoutes(
    { requireAuth: kit.requireAuth },
    { sessionManager, eventBus, queueManager, processMessage, orchestrator, contextOptimizer, projectStore, profilesStore },
    {
      resolveUserId: async (c) => (await kit.getCurrentUser(c))!.id,
      resolveOwner:  async (c) => (await kit.getCurrentUser(c))!.id,
      forkWithOwner: true,
      canAccess: (session, c, userId) => isSessionOwner(session, userId) || kit.isAdmin(c as Parameters<typeof kit.isAdmin>[0]),
      resolveAuthor: async (c) => (await kit.getCurrentUser(c))!.username,
      promptMessageId: 'stream',
      publishRenamed: false,
      publishDeletedBefore: false,
      onSessionCreated: (userId, sessionId) => { void eventHub.subscribeToSession(userId, sessionId).catch((e: unknown) => console.warn('subscribeToSession failed:', e)); },
      onSessionDeleted: (userId, sessionId) => { eventHub.unsubscribeFromSession(userId, sessionId); },
      onSessionForked:  (userId, sessionId) => { void eventHub.subscribeToSession(userId, sessionId).catch((e: unknown) => console.warn('subscribeToSession failed:', e)); },
      promptMiddleware: [createRateLimiter(30, 60_000)],
      enableSessionEvents: false,
      resolveDefaultAgent,
      messages: {
        sessionNotFound: (c) => t('errors.notFound.session', undefined, c),
        forbidden: (c) => t('auth.forbidden', undefined, c),
        contentRequired: (c) => t('errors.validation.contentRequired', undefined, c),
        queueFull: (c, max) => t('errors.chat.queueFull', { max }, c),
      },
    },
  ));

  return app;
}
