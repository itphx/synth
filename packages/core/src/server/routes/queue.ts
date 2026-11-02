import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { SessionManager, QueueProcessorManager, ChatOrchestrator, EventBus } from '../../index.js';
import {
  generateStreamId,
  MessageRole,
  MAX_STEER_INJECTIONS_PER_TURN,
  STEERING_ERROR_CODES,
} from '@itphx/synth-shared';
import type { Message, QueueStatePayload, Session } from '@itphx/synth-shared';
import { enqueueSteerMessage, publishQueueState, reorderPendingMessages } from '../../queue/processor.js';
import { isRemoteRef, toLocalId, remoteErrorToHttp } from '../../remote/aggregate.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import { createSessionAccessGuard, createSessionAccessPredicate } from '../session-access-guard.js';
import type { SessionAccessKind } from '../session-access-guard.js';
import type { LocalOwnerResolver } from '../local-owner.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface QueueRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы по умолчанию. */
export interface QueueRouteMessages {
  sessionNotFound: (c: Context) => string;
  messageNotFoundIndex: (c: Context) => string;
  forbidden: (c: Context) => string;
  /** `POST /:sessionId/steer` — активного хода нет (409 NO_ACTIVE_TURN). */
  noActiveTurn: (c: Context) => string;
  /** `POST /:sessionId/steer` — сообщение уже выполняется в текущем ходе (409). */
  messageAlreadyRunning: (c: Context) => string;
  /** `POST /:sessionId/steer` — превышен лимит инъекций (429). */
  steerLimitExceeded: (c: Context, limit: number) => string;
  /** `POST /:sessionId/reorder` — тело не массив уникальных непустых id (400). */
  invalidReorderIds: (c: Context) => string;
  /** `POST /:sessionId/reorder` — очередь изменилась, клиент должен перечитать (409). */
  queueChanged: (c: Context) => string;
}

export interface QueueRoutesOptions {
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<QueueRouteMessages>;
  /** userId запроса. Core — 'local'; backend — id из AuthKit. */
  resolveUserId?: (c: Context) => string | Promise<string>;
  /** Доступ к содержимому сессии. Core — local-owner; backend — owner|ADMIN. */
  canAccess?: (session: Session, c: Context, userId: string) => boolean | Promise<boolean>;
  /** Доп. правило доступа (например, участие в проекте; `access` — read/write). */
  resolveCanAccessExtra?: (
    session: Session,
    c: Context,
    userId: string,
    access: SessionAccessKind,
  ) => boolean | Promise<boolean>;
  /** Сквозной обзор (ADMIN/LEAD) — доступ ко всем сессиям. */
  resolveElevated?: (c: Context) => boolean | Promise<boolean>;
  /**
   * ADR-089 (standalone): нормализация legacy-владельца (UUID профиля `local`)
   * при доступе к сессии. Managed не задаёт (id реальные).
   */
  localOwnerResolver?: LocalOwnerResolver;
  /**
   * ADR-036: обфускация user-сообщения перед постановкой в очередь инъекций
   * (`POST /:sessionId/steer`) — тот же колбэк, что у `POST /sessions/:id/prompt`.
   */
  obfuscate?: (sessionId: string, message: Message) => Promise<Message>;
}

const LOCAL_USER_ID = 'local';

const DEFAULT_MESSAGES: QueueRouteMessages = {
  sessionNotFound: () => 'Сессия не найдена',
  messageNotFoundIndex: () => 'Сообщение не найдено по индексу',
  forbidden: () => 'Доступ к сессии запрещён',
  noActiveTurn: () => 'Активного хода нет — отправьте сообщение обычной очередью',
  messageAlreadyRunning: () => 'Сообщение уже выполняется',
  steerLimitExceeded: (_c, limit) =>
    `Достигнут лимит вмешательств в ход (макс. ${limit})`,
  invalidReorderIds: () =>
    'Поле ids должно быть массивом уникальных непустых идентификаторов сообщений',
  queueChanged: () =>
    'Очередь изменилась — перечитайте её состояние и повторите перестановку',
};

/** Преобразовать RemoteError в HTTP-ответ API v2; не-RemoteError → undefined (пробросить дальше). */
function mapRemoteError(c: Context, err: unknown): Response | undefined {
  const http = remoteErrorToHttp(err);
  if (!http) return undefined;
  return c.json(
    { error: { code: http.code, message: err instanceof Error ? err.message : String(err) } },
    http.status as 400 | 401 | 404 | 409 | 500 | 502,
  );
}

/** 502, если гибрид не настроен, иначе undefined — обрабатываем удалённую сессию. */
function remoteUnavailable(c: Context): Response | undefined {
  return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
}

export function createQueueRoutes(
  auth: QueueRoutesAuth,
  sessionManager: SessionManager,
  queueManager: QueueProcessorManager,
  eventBus: EventBus,
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>,
  getRemoteClient?: () => RemoteBackendClient | null,
  opts?: QueueRoutesOptions,
): Hono {
  const app = new Hono();
  const resolveClient = (): RemoteBackendClient | undefined => getRemoteClient?.() ?? undefined;
  /**
   * Единая семантика с `createSessionRoutes`: `remote:<uuid>` пропускается только
   * при настроенном гибриде (геттер передан); в managed такой id даёт
   * предсказуемый 404, а не 502 «из-за отсутствия геттера».
   */
  const hasRemoteGetter = getRemoteClient !== undefined;
  const messages: QueueRouteMessages = { ...DEFAULT_MESSAGES, ...opts?.messages };
  const resolveUserId = opts?.resolveUserId ?? (() => LOCAL_USER_ID);
  const accessPredicate = createSessionAccessPredicate({
    canAccess: opts?.canAccess,
    resolveCanAccessExtra: opts?.resolveCanAccessExtra,
    localUserId: LOCAL_USER_ID,
    localOwnerResolver: opts?.localOwnerResolver,
  });

  // Авторизация очереди — инвариант на префиксе `/:sessionId`: guard до маршрутов
  // + `requireAuth` в цепочке. Remote-ref пропускается (ADR-042).
  const sessionAccessGuard = createSessionAccessGuard({
    param: 'sessionId',
    resolveSession: (id) => sessionManager.getSession(id),
    resolveUserId,
    isAllowed: async (session, c, userId, access) => {
      if ((await opts?.resolveElevated?.(c)) ?? false) return true;
      return accessPredicate(session, c, userId, access);
    },
    messages: { sessionNotFound: messages.sessionNotFound, forbidden: messages.forbidden },
    skipForId: (id) => hasRemoteGetter && isRemoteRef(id),
  });
  app.use('/:sessionId', auth.requireAuth);
  app.use('/:sessionId', sessionAccessGuard);
  app.use('/:sessionId/*', auth.requireAuth);
  app.use('/:sessionId/*', sessionAccessGuard);

  app.post('/:sessionId/clear', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.queueClear(toLocalId(sessionId));
        return c.json(result);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    let counts: QueueStatePayload = { pendingCount: 0, steerCount: 0 };
    await sessionManager.safeUpdate(sessionId, async (session) => {
      session.pendingMessages = [];
      counts = { pendingCount: 0, steerCount: session.steerInbox?.length ?? 0 };
    });
    queueManager.stop(sessionId);
    // ADR-118 §4: очередь сброшена — состояние очереди (счётчики, без текста).
    publishQueueState(eventBus, sessionId, counts);
    return c.json({ cleared: true });
  });

  app.post('/:sessionId/return', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    const idParam = c.req.query('id');
    const targetId = idParam && idParam.trim() !== '' ? idParam : undefined;
    const indexStr = c.req.query('index');
    const index = indexStr !== undefined ? Number(indexStr) : undefined;
    // Legacy `?index=abc`/отрицательный — ошибка валидации, а не «вся очередь»
    // (и не 500 из remote-клиента): проверяем до hybrid-ветки.
    if (targetId === undefined && index !== undefined && (!Number.isInteger(index) || index < 0)) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'index должен быть неотрицательным целым' } },
        400,
      );
    }

    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.queueReturn(
          toLocalId(sessionId),
          targetId !== undefined ? { id: targetId } : index,
        );
        return c.json(result);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }

    if (targetId !== undefined && !session.pendingMessages.some((m) => m.id === targetId)) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.messageNotFoundIndex(c) } }, 404);
    }
    if (targetId === undefined && index !== undefined && !isNaN(index) && !session.pendingMessages[index]) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.messageNotFoundIndex(c) } }, 404);
    }

    // Активный стрим (не отменённый) продолжает обрабатываться — его user-сообщение
    // из истории удалять нельзя. При зависшей сессии (cancelled=true) — можно.
    const activeStreamId = session.currentStream && !session.currentStream.cancelled
      ? session.currentStream.streamId
      : undefined;

    let texts: string[] = [];
    let remainingCount = 0;
    /** Найден ли элемент по `id` внутри `safeUpdate` (гонка: исчез между чтениями). */
    let idRemoved = false;
    /** ADR-118 §4: id user-сообщений истории, реально удалённых возвратом в поле. */
    const removedMessageIds: string[] = [];
    /** ADR-118 §4: счётчики очереди после извлечения сообщений. */
    let counts: QueueStatePayload = { pendingCount: 0, steerCount: 0 };

    await sessionManager.safeUpdate(sessionId, async (s) => {
      let removedStreamIds: string[] = [];
      if (targetId !== undefined) {
        const msg = s.pendingMessages.find((m) => m.id === targetId);
        if (!msg) return;
        idRemoved = true;
        texts = [msg.content];
        const sid = msg.metadata?.stream_id as string | undefined;
        removedStreamIds = sid ? [sid] : [];
        s.pendingMessages = s.pendingMessages.filter((m) => m.id !== targetId);
      } else if (index !== undefined && !isNaN(index)) {
        const msg = s.pendingMessages[index];
        if (!msg) return;
        texts = [msg.content];
        const sid = msg.metadata?.stream_id as string | undefined;
        removedStreamIds = sid ? [sid] : [];
        s.pendingMessages = s.pendingMessages.filter((_, i) => i !== index);
      } else {
        texts = s.pendingMessages.map((m) => m.content);
        removedStreamIds = s.pendingMessages
          .map((m) => m.metadata?.stream_id as string | undefined)
          .filter((id): id is string => !!id);
        s.pendingMessages = [];
      }
      remainingCount = s.pendingMessages.length;

      // Удаляем возвращённые user-сообщения из истории по stream_id, чтобы при
      // повторной отправке из поля ввода не было дубля. Активный стрим не трогаем.
      if (removedStreamIds.length > 0) {
        const removedSet = new Set(removedStreamIds);
        s.messages = s.messages.filter((m) => {
          if (m.role !== MessageRole.USER) return true;
          const sid = m.metadata?.stream_id as string | undefined;
          if (!sid) return true;
          if (sid === activeStreamId) return true;
          if (!removedSet.has(sid)) return true;
          removedMessageIds.push(m.id);
          return false;
        });
      }

      // Разблокируем сессию: снимаем blocked и currentStream (иначе return
      // оставит сессию в «зависшем» состоянии с pending=0, но blocked).
      if (remainingCount === 0) {
        s.status.blocked = undefined;
        s.status.blockedAt = undefined;
        s.currentStream = undefined;
        // Очередь сброшена — состояние ретрая (повтор) тоже неактуально.
        s.retry = undefined;
      }
      counts = {
        pendingCount: s.pendingMessages.length,
        steerCount: s.steerInbox?.length ?? 0,
      };
    });

    // Элемент исчез между чтением и записью (параллельный `/return`/`/steer`) —
    // честный 404, а не «успех с пустым texts».
    if (targetId !== undefined && !idRemoved) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.messageNotFoundIndex(c) } }, 404);
    }

    if (remainingCount === 0 && !activeStreamId) {
      queueManager.stop(sessionId);
    }

    // ADR-118 §4: сообщения извлечены из очереди — состояние очереди.
    publishQueueState(eventBus, sessionId, counts);
    // ADR-118 §4/§7: возвращённые user-сообщения удалены из истории — другие
    // клиенты убирают их из ленты по `id`.
    for (const messageId of removedMessageIds) {
      eventBus.publish(sessionId, 'message.deleted', { message_id: messageId });
    }

    return c.json({ texts });
  });

  // POST /:sessionId/reorder — переупорядочить обычную очередь (DnD в UI).
  // Тело `{ ids: string[] }` — желаемый порядок; состав должен точно совпадать
  // с текущей очередью, иначе 409 QUEUE_CHANGED (клиент перечитывает очередь).
  // `steerInbox` не трогается (ADR-104: у инъекций своя очередь).
  app.post('/:sessionId/reorder', auth.requireAuth, async (c) => {
    const sessionId = c.req.param('sessionId');
    const body = await c.req.json().catch(() => null) as { ids?: unknown } | null;
    const rawIds = body?.ids;
    if (
      !Array.isArray(rawIds)
      || rawIds.some((id) => typeof id !== 'string' || id.trim() === '')
      || new Set(rawIds as string[]).size !== rawIds.length
    ) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: messages.invalidReorderIds(c) } },
        400,
      );
    }

    const result = await reorderPendingMessages(
      sessionManager,
      eventBus,
      sessionId,
      rawIds as string[],
    );
    if (!result.ok) {
      if (result.reason === 'not_found') {
        return c.json(
          { error: { code: 'SESSION_NOT_FOUND', message: messages.sessionNotFound(c) } },
          404,
        );
      }
      return c.json(
        { error: { code: 'QUEUE_CHANGED', message: messages.queueChanged(c) } },
        409,
      );
    }
    return c.json({ status: 'ok', order: result.order });
  });

  // POST /:sessionId/steer — отправить сообщение из очереди «в разрыв»
  // текущего хода (ADR-104 × ADR-111/ADR-113, как delivery `steer` в inbox).
  // Тело: `{ id?: string; index?: number }` (приоритет `id`, `index` — для
  // совместимости; по умолчанию 0). Сообщение снимается из `pendingMessages`,
  // его user-копия удаляется из истории (по `stream_id`, активный стрим не
  // трогаем — как в `/return`) и уходит в очередь инъекций.
  app.post('/:sessionId/steer', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    const body = await c.req.json().catch(() => null) as { id?: unknown; index?: unknown } | null;
    const rawId = body?.id;
    const targetId = typeof rawId === 'string' && rawId.trim() !== '' ? rawId : undefined;
    const rawIndex = body?.index;
    const index = rawIndex === undefined
      ? 0
      : typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0
        ? rawIndex
        : Number.NaN;

    if (rawId !== undefined && targetId === undefined) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'id должен быть непустой строкой' } },
        400,
      );
    }
    if (targetId === undefined && Number.isNaN(index)) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'index должен быть неотрицательным целым' } },
        400,
      );
    }

    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.queueSteer(
          toLocalId(sessionId),
          targetId !== undefined ? { id: targetId } : { index },
        );
        return c.json(result);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const message = targetId !== undefined
      ? session.pendingMessages.find((m) => m.id === targetId)
      : session.pendingMessages[index];
    if (!message) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.messageNotFoundIndex(c) } }, 404);
    }

    // UI показывает кнопку только при активном ходе; без него сообщению некуда
    // вклиниваться — обычная очередь (`/sessions/:id/prompt`).
    const turnActive = Boolean(session.status?.blocked) || queueManager.isRunning(sessionId);
    if (!turnActive) {
      return c.json({ error: { code: 'NO_ACTIVE_TURN', message: messages.noActiveTurn(c) } }, 409);
    }

    // Активный стрим (не отменённый): его user-сообщение из истории не трогаем
    // (как в `/return`), а само сообщение нельзя отправить «в разрыв» —
    // оно уже выполняется (иначе инъекция вклинится в собственный ход).
    const activeStreamId = session.currentStream && !session.currentStream.cancelled
      ? session.currentStream.streamId
      : undefined;
    const messageStreamId = message.metadata?.stream_id as string | undefined;
    if (activeStreamId && messageStreamId === activeStreamId) {
      return c.json({
        error: { code: 'CONFLICT', message: messages.messageAlreadyRunning(c) },
      }, 409);
    }

    // ADR-118 §4: отправитель (`userId` запроса) — адресат адресного события
    // `message.accepted`.
    const senderUserId = (await resolveUserId(c)) || '';

    // Сначала ставим в очередь инъекций — при отказе (лимит) очередь и история
    // остаются нетронутыми (сообщение не теряется). Перенос из обычной очереди
    // **атомарный** (`fromPending`): снятие из `pendingMessages` и снятие
    // user-копии из истории выполняются под тем же локом, что и постановка, —
    // поэтому к моменту публикации `message.enqueued` сообщения уже нет ни в
    // очереди, ни в истории (иначе клиент считал бы реплику «вернувшейся в
    // очередь» и удалял её из ленты).
    const steered = await enqueueSteerMessage(
      sessionManager,
      eventBus,
      sessionId,
      message,
      MAX_STEER_INJECTIONS_PER_TURN,
      opts?.obfuscate,
      {
        // ADR-118 §3/§4: подтверждение приёма — адресное `message.accepted`.
        messageId: message.id,
        ...(senderUserId ? { recipient: senderUserId } : {}),
        fromPending: { ...(activeStreamId ? { activeStreamId } : {}) },
      },
    );
    if (!steered.accepted) {
      // Сообщения нет в очереди (уже отправлено «в разрыв» или исчезло) —
      // честный 404, а не «успех».
      if (steered.reason === 'not_found') {
        return c.json({
          error: { code: 'NOT_FOUND', message: messages.messageNotFoundIndex(c) },
        }, 404);
      }
      return c.json({
        error: {
          code: STEERING_ERROR_CODES.limitExceeded,
          message: messages.steerLimitExceeded(c, MAX_STEER_INJECTIONS_PER_TURN),
        },
      }, 429);
    }

    // `pending_count` в семействе queue-роутов — длина `pendingMessages`
    // (как у `/clear`/`/resume`), а не размер steer-очереди.
    const updated = await sessionManager.getSession(sessionId);
    // ADR-118 §4: состояние очереди (счётчики, без текста и автора) уже
    // опубликовано `enqueueSteerMessage` — после атомарного переноса.
    return c.json({ steered: true, pending_count: updated?.pendingMessages.length ?? 0 }, 202);
  });

  app.post('/:sessionId/resume', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.queueResume(toLocalId(sessionId));
        return c.json(result);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }

    if (session.pendingMessages.length === 0) {
      return c.json({ resumed: true, pending_count: 0 });
    }

    await sessionManager.forceReleaseLock(sessionId);

    // Используем существующий stream_id первого pending-сообщения, НЕ генерируем
    // новый — иначе Phase 1 нового процессора повторно запушит сообщение в историю.
    // Если stream_id отсутствует — генерируем один раз и сохраняем.
    if (session.pendingMessages[0]) {
      await sessionManager.safeUpdate(sessionId, async (s) => {
        const p = s.pendingMessages[0];
        if (!p) return;
        if (!p.metadata) p.metadata = {};
        if (!p.metadata.stream_id) p.metadata.stream_id = generateStreamId();
      });
    }

    // ADR-118 §4: очередь снова обрабатывается — состояние очереди (счётчики,
    // без текста и автора). Прежний `message.queued` удалён без dual-emit:
    // сообщение не принято заново (его приём уже подтверждён), а о его
    // материализации сообщает `message.delivered` из процессора очереди.
    publishQueueState(eventBus, sessionId, {
      pendingCount: session.pendingMessages.length,
      steerCount: session.steerInbox?.length ?? 0,
    });

    queueManager.createProcessor(
      sessionId, sessionManager, eventBus, processMessage as never,
    );

    return c.json({ resumed: true, pending_count: session.pendingMessages.length });
  });

  // POST /:sessionId/retry-now — немедленный повтор при backoff (без ожидания паузы)
  app.post('/:sessionId/retry-now', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.queueRetryNow(toLocalId(sessionId));
        return c.json(result);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    const retried = queueManager.retryNow(sessionId);
    if (!retried) {
      return c.json({ error: { code: 'CONFLICT', message: 'Процессор не находится в состоянии повтора' } }, 409);
    }
    return c.json({ retried: true });
  });

  // POST /:sessionId/cancel-retry — отменить повторные попытки (снять pending, разблокировать)
  app.post('/:sessionId/cancel-retry', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const sessionId = c.req.param('sessionId');
    if (isRemoteRef(sessionId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.queueCancelRetry(toLocalId(sessionId));
        return c.json(result);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    const cancelled = await queueManager.cancelRetry(sessionId);
    if (!cancelled) {
      return c.json({ error: { code: 'CONFLICT', message: 'Процессор не найден' } }, 409);
    }
    return c.json({ cancelled: true });
  });

  return app;
}
