import { ReadableStream } from 'node:stream/web';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { SessionManager, EventBus, QueueProcessorManager, ChatOrchestrator, ContextOptimizer, RequestSessionService } from '../../index.js';
import type { SessionTree } from '../../sessions/manager.js';
import { MessageRole, SESSION_MODES, generateStreamId, nowISO, sessionUpdateSchema, createResolveAuthorName, PROJECT_ICON_KEYS, PROJECT_COLOR_KEYS, isProjectIconKey, isProjectColorKey, isSteerMode, DEFAULT_STEER_MODE, MAX_STEER_INJECTIONS_PER_TURN, STEERING_ERROR_CODES } from '@itphx/synth-shared';
import type { Message, Session, QuestionStatus, SessionWorktree, AttachmentsConfig } from '@itphx/synth-shared';
import type { ProfileStore } from '@itphx/synth-shared';
import { enqueueUserMessage, enqueueSteerMessage, sseEventStream, DEFAULT_AGENT_ID, SubagentResumeError, computeSessionStats } from '../../index.js';
import { serializeSession, serializeMessage, redactSessionSecretValues } from '../serialize.js';
import type { ProjectStoreLike } from '../../storage/project-store.js';
import { isRemoteRef, toLocalId, toRemoteRef, toRemote, mergeItems, remoteErrorToHttp } from '../../remote/aggregate.js';
import { RemoteError } from '../../remote/types.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import { requireScope, checkServiceProjectProjection } from '../service-scope.js';
import { resolveUserPrincipal } from '../../engine/authority/principal.js';
import type { ScopeGuardFactory, ServiceProjectProjectionGuard } from '../service-scope.js';
import { createSessionAccessGuard, createSessionAccessPredicate } from '../session-access-guard.js';
import type { SessionAccessKind } from '../session-access-guard.js';
import { createSessionModeGuard, getSessionModeDecision } from '../session-mode-guard.js';
import { deriveSessionParticipants } from '../../engine/authority/participants.js';
import { applySessionMode } from '../../engine/authority/mode.js';
import type { LocalOwnerResolver } from '../local-owner.js';
import type { AnalyticsRecorder } from '../../analytics/recorder.js';
import { sessionAxes } from '../../analytics/recorder.js';
import { MEMORY_NAMESPACE } from '../../engine/plugins/memory-namespace.js';
import type { MemoryFactRepository } from '../../storage/ports/memory-fact-repository.js';
import type { MemoryIndexRepository } from '../../storage/ports/memory-index-repository.js';
// Этап 1 roadmap 0.13 (блок 3): «вопрос пользователю» (`ask_user`).
import { questionAnswerSchema, questionCancelSchema } from '@itphx/synth-shared';
import type { QuestionService } from '../../engine/question/service.js';
import {
  QuestionAlreadySettledError,
  QuestionInvalidAnswerError,
  QuestionNotFoundError,
} from '../../engine/question/types.js';
import type { WorktreeService } from '../../engine/worktree/service.js';
import { publishWorktreeUpdated, type WorktreeUpdatedInput } from '../../engine/worktree/events.js';
// ADR-115: вложения сообщений — сервис (blob-хранилище + лимиты) и роуты загрузки/раздачи.
import { AttachmentService } from '../../engine/attachments/service.js';
import { createAttachmentRoutes } from './attachments.js';
import type { BlobRefRepository } from '../../storage/ports/blob-ref-repository.js';
import type { BlobStore } from '../../storage/ports/blob-store.js';
import { makeMediaPart, appendMediaPlaceholders } from '@itphx/synth-shared';
import type { Part } from '@itphx/synth-shared';

const LOCAL_USER_ID = 'local';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно, как в providers.ts). */
export interface SessionRoutesAuth {
  requireAuth: Middleware;
}

export interface SessionRoutesDeps {
  sessionManager: SessionManager;
  eventBus: EventBus;
  queueManager: QueueProcessorManager;
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>;
  orchestrator: ChatOrchestrator;
  contextOptimizer?: ContextOptimizer;
  projectStore?: ProjectStoreLike;
  profilesStore?: ProfileStore;
  /**
   * Гибрид. ВАЖНО: если поле НЕ передано (undefined) — все remote/hybrid-ветки
   * полностью отключены (managed backend). Если передано, но возвращает null —
   * прежнее поведение core (502 REMOTE_UNAVAILABLE и т.п.).
   */
  getRemoteClient?: () => RemoteBackendClient | null;
  /**
   * ADR-089: единый funnel создания сессий. Задан — `POST /` идёт через
   * `requestSessionService.request` (эмит `session_requested`, единые правила);
   * не задан — прежний прямой `SessionManager.createSession` (fallback).
   */
  requestSessionService?: RequestSessionService;
  /**
   * ADR-102: сборщик аналитики — меры `activity` (`aborts`) из роутов сессий.
   * Не задан — запись не выполняется.
   */
  analytics?: AnalyticsRecorder;
  /**
   * ADR-107: память сессии — `GET /:id/memory` (вкладка «Память»).
   * Не задан — эндпоинт отвечает `provider.active:false`, `readiness:'unavailable'`.
   */
  memory?: {
    facts: MemoryFactRepository;
    indexes: MemoryIndexRepository;
    isPluginActive: () => boolean;
  };
  /**
   * Этап 1 roadmap 0.13 (блок 3): сервис «вопрос пользователю» (`ask_user`).
   *
   * Не задан — вопросы в этой сборке не работают: `GET /:id/questions`
   * отвечает 503, `POST .../answer|cancel` — 503.
   */
  questionService?: QuestionService;
  /**
   * ADR-114: сервис worktree'ов — привязка сессии к worktree
   * (`PATCH /api/v2/sessions/:id { worktreeId }`).
   *
   * Не задан — поле `worktreeId` в PATCH игнорируется (привязка недоступна).
   */
  worktreeService?: WorktreeService;
  /**
   * ADR-115: вложения сообщений — blob-хранилище, учёт ссылок и лимиты
   * (`POST /:id/attachments`, `GET /:id/attachments/:partId`,
   * `attachments` в теле промпта).
   *
   * Не задан — контур вложений не монтируется, поле `attachments` в промпте
   * даёт `400 VALIDATION_ERROR` (молча терять вложение нельзя).
   */
  attachments?: {
    blobs: BlobStore;
    blobRefs?: BlobRefRepository;
    config: AttachmentsConfig;
  };
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы по умолчанию. */
export interface SessionRouteMessages {
  sessionNotFound: (c: Context) => string;
  forbidden: (c: Context) => string;
  contentRequired: (c: Context) => string;
  queueFull: (c: Context, max: number) => string;
  /** ADR-104: превышен лимит инъекций на ход (`mode: 'steer'`/`'interrupt'`). */
  steerLimitExceeded: (c: Context, max: number) => string;
  /** ADR-115: `attachments` в теле промпта — не массив непустых строк. */
  invalidAttachments: (c: Context) => string;
  /** ADR-115: указанные пути объектов не найдены/невалидны (перечень). */
  attachmentsInvalid: (c: Context, paths: string[]) => string;
  /** ADR-115: контур вложений не подключён (`deps.attachments` не задан). */
  attachmentsUnavailable: (c: Context) => string;
  /** ADR-115: вложений больше, чем `attachments.maxFilesPerMessage`. */
  attachmentsLimitExceeded: (c: Context, max: number) => string;
  /** ADR-115: превышена квота сессии `attachments.maxBytesPerSession`. */
  tooLarge: (c: Context) => string;
}

export interface SessionRoutesOptions {
  /** userId запроса. Core — 'local'; backend — user.id. */
  resolveUserId?: (c: Context) => string | Promise<string>;
  /** Владелец при создании сессии. По умолчанию — resolveUserId(). */
  resolveOwner?: (c: Context) => string | Promise<string>;
  /** Передавать владельца в forkSession. Core — false; backend — true. */
  forkWithOwner?: boolean;
  /** Доступ к содержимому сессии (status/prompt/stats). Core — local-owner; backend — owner|ADMIN. */
  canAccess?: (session: Session, c: Context, userId: string) => boolean | Promise<boolean>;
  /** author пользовательских сообщений. Core — 'local'; backend — username. */
  resolveAuthor?: (c: Context) => string | Promise<string>;
  /** id пользовательского сообщения: 'generated' (core) | 'stream' (backend). */
  promptMessageId?: 'generated' | 'stream';
  /** Публиковать session.renamed при смене title. Core — true; backend — false. */
  publishRenamed?: boolean;
  /** Публиковать session.deleted ДО удаления. Core — true; backend — false. */
  publishDeletedBefore?: boolean;
  /** EventHub-хуки (backend): подписка/отписка. */
  onSessionCreated?: (userId: string, sessionId: string) => void | Promise<void>;
  onSessionDeleted?: (userId: string, sessionId: string) => void | Promise<void>;
  onSessionForked?: (userId: string, sessionId: string) => void | Promise<void>;
  /** Доп. middleware на POST /:id/prompt (rate limiter). */
  promptMiddleware?: Middleware[];
  /** Доп. middleware на POST /:id/fork (rate limiter; backend). */
  forkMiddleware?: Middleware[];
  /** Доп. middleware на POST /:id/messages/merge (rate limiter; backend). */
  mergeMiddleware?: Middleware[];
  /** Регистрировать core-only роут `GET /:id/events`. Core — true; backend — false. */
  enableSessionEvents?: boolean;
  messages?: Partial<SessionRouteMessages>;
  /**
   * Агент по умолчанию для новой сессии без `settings.agentRole` (runtime-настройка
   * «Агенты»). По умолчанию — `DEFAULT_AGENT_ID` ('assistant' при первом развёртывании).
   */
  resolveDefaultAgent?: () => string | Promise<string>;
  /**
   * ADR-089: сквозной обзор (ADMIN/LEAD) — `GET /` возвращает все сессии.
   * `undefined`/`false` — прежнее поведение (только свои).
   */
  resolveElevated?: (c: Context) => boolean | Promise<boolean>;
  /**
   * ADR-089: проекты, участником которых является пользователь (owner или
   * `members`) — для видимости проектных сессий в списке. Не задан — только свои.
   */
  resolveMemberProjectIds?: (c: Context, userId: string) => Promise<string[]> | string[];
  /**
   * ADR-089: доп. проверка доступа к сессии по id (например, участие в проекте).
   * Вызывается, когда `opts.canAccess` не дал положительный ответ. `access`
   * различает чтение/мутацию (backend: VIEWER-участник читает, но не мутирует).
   */
  resolveCanAccessExtra?: (
    session: Session,
    c: Context,
    userId: string,
    access: SessionAccessKind,
  ) => boolean | Promise<boolean>;
  /**
   * Регистрировать ли собственный prefix-guard доступа к сессии (по умолчанию —
   * да). Backend ставит `false` и вешает ОДИН guard на весь ресурс `/api/v2/sessions`
   * сам (чтобы покрыть и backend-only маршруты export/debug/optimization/notes той
   * же семантикой) — иначе получилось бы два источника правил.
   */
  registerAccessGuard?: boolean;
  /**
   * ADR-052 (этап I): фабрика scope-guard'а для service-key. По умолчанию —
   * `requireScope` из core (нет service-key в контексте → пропускает).
   */
  scopeGuard?: ScopeGuardFactory;
  /**
   * ADR-052 (этап I): гейт **проектной проекции service-key** (`allowedProjects`).
   * По умолчанию — `checkServiceProjectProjection` из core (нет
   * service-key/`allowedProjects` → пропускает). Это не RBAC.
   */
  serviceProjectProjection?: ServiceProjectProjectionGuard;
  /**
   * ADR-089 (standalone): нормализация legacy-владельца (UUID профиля `local`,
   * созданный до фикса резолвера внешней идентичности) при чтении — список
   * сессий (`GET /`) и доступ по id. Managed не задаёт (id реальные).
   */
  localOwnerResolver?: LocalOwnerResolver;
  /**
   * ADR-036: право видеть РЕАЛЬНЫЕ значения секретов в обычном чтении сессии
   * (`GET /`, `GET /:id`, `GET /:id/messages` → `messages[].metadata.secrets`).
   *
   * Значения секретов — привилегия читателя, а не «свойство ответа»: по
   * умолчанию (политика не задана) реальные значения видит только ВЛАДЕЛЕЦ
   * сессии (`ownerId ?? userId` === текущий пользователь) — fail-closed.
   * Standalone (один локальный пользователь, `resolveUserId` → `local`)
   * поведение прежнее: владелец видит свои значения.
   *
   * Backend задаёт правило явно: владелец сессии + `ADMIN`/`AUDITOR` (тот же
   * набор привилегий, что у `GET /:id/secrets`); остальным читателям
   * (участник проекта, `LEAD` без владения) значения вычищаются.
   */
  canRevealSecrets?: (c: Context, session: Session) => boolean | Promise<boolean>;
}

const DEFAULT_MESSAGES: SessionRouteMessages = {
  sessionNotFound: () => 'Сессия не найдена',
  forbidden: () => 'Доступ к сессии запрещён',
  contentRequired: () => 'Контент обязателен',
  queueFull: (_c: Context, max: number) => `Очередь сообщений заполнена (макс. ${max})`,
  steerLimitExceeded: (_c: Context, max: number) =>
    `Достигнут лимит вмешательств в ход (макс. ${max} сообщений на ход)`,
  invalidAttachments: () => 'Поле attachments должно быть массивом непустых путей объектов',
  attachmentsInvalid: (_c: Context, paths: string[]) =>
    `Вложения не найдены или недопустимы: ${paths.join(', ')}`,
  attachmentsUnavailable: () => 'Вложения не поддерживаются в этой сборке',
  attachmentsLimitExceeded: (_c: Context, max: number) =>
    `Слишком много вложений в сообщении (макс. ${max})`,
  tooLarge: () => 'Суммарный объём вложений сессии превышает допустимый',
};

/**
 * ADR-115: нормализация `attachments` из тела промпта.
 * `undefined` — поля не было; `null` — поле есть, но невалидно (не массив
 * непустых строк). Дубли путей схлопываются (content-addressed: тот же объект).
 */
function normalizeAttachmentPaths(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return null;
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') return null;
    paths.push(item.trim());
  }
  return Array.from(new Set(paths));
}

/** ADR-115: медиа-части сообщения (для учёта квоты сессии и ссылок на объекты). */
function mediaPartsOf(parts: Part[]): Array<{ blobPath: string; size: number }> {
  const result: Array<{ blobPath: string; size: number }> = [];
  for (const part of parts) {
    if (part.type !== 'image' && part.type !== 'audio' && part.type !== 'video' && part.type !== 'file') {
      continue;
    }
    const data = part.data as { blobPath?: unknown; size?: unknown };
    if (typeof data?.blobPath !== 'string') continue;
    result.push({
      blobPath: data.blobPath,
      size: typeof data.size === 'number' ? data.size : 0,
    });
  }
  return result;
}

/** ADR-115: суммарный объём вложений в истории сессии (квота `maxBytesPerSession`). */
function sessionAttachmentBytes(session: Session): number {
  let total = 0;
  for (const message of session.messages) {
    for (const media of mediaPartsOf(message.parts)) total += media.size;
  }
  return total;
}

/**
 * ADR-115: зафиксировать ссылки сообщения на объекты вложений (`blob_refs`).
 * Best-effort: сбой учёта не отменяет принятое сообщение (GC потом увидит
 * объект сиротой только по TTL — данные не теряются).
 */
async function registerAttachmentRefs(
  blobRefs: BlobRefRepository | undefined,
  messageId: string,
  parts: Part[],
): Promise<void> {
  if (!blobRefs) return;
  try {
    for (const media of mediaPartsOf(parts)) {
      await blobRefs.add({ blobPath: media.blobPath, ownerKind: 'message', ownerId: messageId });
    }
  } catch {
    // учёт ссылок — производная: сообщение уже принято
  }
}

/** Сообщение о недопустимом значении метаданных с перечнем допустимых ключей. */
function invalidMetaMessage(label: 'icon' | 'color', value: unknown, allowed: readonly string[]): string {
  return `Недопустимое значение ${label}: "${String(value)}". Допустимые: ${allowed.join(', ')}`;
}

/**
 * ADR-104: идёт ли сейчас ход сессии (есть чему вмешиваться).
 *
 * `status.blocked` ставит процессор очереди на время хода, `isRunning` —
 * живой процессор сессии. Оба признака нужны: между фазами процессора флаг
 * `blocked` может быть ещё не выставлен.
 */
function isTurnActive(session: Session, queueManager: QueueProcessorManager): boolean {
  return !!session.status?.blocked || queueManager.isRunning(session.id);
}

/**
 * Hono не принимает spread массива middleware в app.post (перегрузки — фиксированные
 * кортежи), поэтому guard + promptMiddleware собираются в один middleware.
 * Порядок сохраняется: requireAuth → promptMiddleware → handler.
 */
function chainMiddleware(middlewares: Middleware[]): Middleware {
  return async (c, next) => {
    let lastIndex = -1;
    // Короткое замыкание middleware (например, 429 rate limiter) надо вернуть в
    // Hono через замыкание, а не через `return next()`: промежуточные middleware
    // (requireAuth) не пробрасывают возврат next() — иначе ответ терялся, а запрос
    // падал в handler/500 («Context is not finalized»).
    let shortCircuit: Response | undefined;
    const dispatch = async (index: number): Promise<Response | void> => {
      if (index <= lastIndex) throw new Error('next() called multiple times');
      lastIndex = index;
      const mw = middlewares[index];
      if (!mw) {
        await next();
        return shortCircuit;
      }
      const res = await mw(c, (() => dispatch(index + 1)) as () => Promise<void>);
      if (res instanceof Response && !shortCircuit) shortCircuit = res;
      return shortCircuit;
    };
    return dispatch(0);
  };
}

/** Преобразовать RemoteError в HTTP-ответ API v2; не-RemoteError → undefined (пробросить дальше). */
function mapRemoteError(c: Context, err: unknown): Response | undefined {
  const http = remoteErrorToHttp(err);
  if (!http) return undefined;
  return c.json(
    { error: { code: http.code, message: err instanceof Error ? err.message : String(err) } },
    http.status as 400 | 401 | 404 | 409 | 500 | 502,
  );
}

/**
 * API сессий (ADR-017/ADR-033/ADR-040/ADR-042). Общая реализация для core (standalone)
 * и backend (managed): core использует дефолты (один пользователь `local`, гибрид
 * через getRemoteClient), backend параметризует RBAC, owner/author, EventHub-хуки
 * и отключает remote-ветки (getRemoteClient не передаётся).
 */
export function createSessionRoutes(
  auth: SessionRoutesAuth,
  deps: SessionRoutesDeps,
  opts: SessionRoutesOptions = {},
): Hono {
  const app = new Hono();
  const { sessionManager, eventBus, queueManager, processMessage, orchestrator } = deps;
  /** ADR-102: сборщик `activity` (aborts) — не задан → no-op. */
  const analytics = deps.analytics;
  const agentRegistry = orchestrator.agentRegistry;

  const resolveClient = (): RemoteBackendClient | undefined => deps.getRemoteClient?.() ?? undefined;
  /** Гибридные ветки активны только если геттер передан (в managed — нет). */
  const hasRemoteGetter = deps.getRemoteClient !== undefined;

  const resolveUserId = opts.resolveUserId ?? (() => LOCAL_USER_ID);
  const resolveOwner = opts.resolveOwner ?? resolveUserId;
  const forkWithOwner = opts.forkWithOwner ?? false;
  const enableSessionEvents = opts.enableSessionEvents ?? true;
  const resolveAuthor = opts.resolveAuthor ?? (() => LOCAL_USER_ID);
  const resolveDefaultAgent = opts.resolveDefaultAgent ?? (() => DEFAULT_AGENT_ID);
  const promptMessageId = opts.promptMessageId ?? 'generated';
  const publishRenamed = opts.publishRenamed ?? true;
  const publishDeletedBefore = opts.publishDeletedBefore ?? true;
  const promptMiddleware = opts.promptMiddleware ?? [];
  const forkMiddleware = opts.forkMiddleware ?? [];
  const mergeMiddleware = opts.mergeMiddleware ?? [];
  const messages: SessionRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const resolveAuthorName = createResolveAuthorName(deps.profilesStore);
  // ADR-052 (этап I): scope-гейты service-key и проектная проекция сессии.
  const scoped = opts.scopeGuard ?? requireScope;
  const serviceProjectProjection = opts.serviceProjectProjection ?? checkServiceProjectProjection;

  /**
   * ADR-071/безопасность: доступ к локальной сессии. Standalone — однопользовательский
   * режим (владелец `local`); легаси-сессии без владельца считаются доступными,
   * чтобы не ломать существующие данные. Backend переопределяет через opts.canAccess.
   * ADR-089: `opts.resolveCanAccessExtra` (напр. участник проекта / LEAD) даёт доступ
   * по id, если базовый `canAccess` отказал.
   */
  const canAccessSession = createSessionAccessPredicate({
    canAccess: opts.canAccess,
    resolveCanAccessExtra: opts.resolveCanAccessExtra,
    localUserId: LOCAL_USER_ID,
    localOwnerResolver: opts.localOwnerResolver,
  });

  /**
   * Авторизация сессий как инвариант на префиксе: guard вешается один раз до
   * маршрутов и покрывает все `:id`-маршруты (включая будущие). `requireAuth`
   * идёт в той же цепочке ДО guard'а — иначе `resolveUserId` не имел бы
   * пользователя. Remote-ref (`remote:<uuid>`) пропускается: проверка — на
   * удалённой стороне (ADR-042).
   */
  const sessionAccessGuard = createSessionAccessGuard({
    param: 'id',
    resolveSession: (id) => sessionManager.getSession(id),
    resolveUserId,
    isAllowed: async (session, c, userId, access) => {
      if ((await opts.resolveElevated?.(c)) ?? false) return true;
      return canAccessSession(session, c, userId, access);
    },
    messages: { sessionNotFound: messages.sessionNotFound, forbidden: messages.forbidden },
    skipForId: (id) => hasRemoteGetter && isRemoteRef(id),
  });
  if (opts.registerAccessGuard !== false) {
    app.use('/:id', auth.requireAuth);
    app.use('/:id', sessionAccessGuard);
    app.use('/:id/*', auth.requireAuth);
    app.use('/:id/*', sessionAccessGuard);
  }

  /**
   * ADR-115: контур вложений — монтируется **внутрь** приложения сессий, то есть
   * под тем же prefix-guard'ом (вид доступа `read`/`write` решает он, инвариант 16).
   * Сервис собирается здесь: blob-порт + учёт ссылок + лимиты из конфига.
   */
  const attachmentConfig = deps.attachments?.config;
  const attachmentService = deps.attachments
    ? new AttachmentService({ blobs: deps.attachments.blobs, config: deps.attachments.config })
    : undefined;
  if (attachmentService && attachmentConfig) {
    app.route(
      '/',
      createAttachmentRoutes(
        { sessionManager, service: attachmentService, config: attachmentConfig },
        { messages: { sessionNotFound: messages.sessionNotFound } },
      ),
    );
  }

  /**
   * ADR-106 Ф4 (шаг C): смена режима сессии — **вторая** привилегия, отдельная
   * от доступа к сессии (доступ решает prefix-guard выше). Guard решает, чей это
   * режим: одиночная сессия — общий режим (прежнее поведение), многопользовательская
   * — режим только того, кто его выставил (`modeByPrincipal`), иначе смена
   * режима одним участником меняла бы решения для ходов другого.
   *
   * Проверка — на границе (инвариант 16): обработчик только применяет решение.
   */
  const sessionModeGuard = createSessionModeGuard({
    param: 'id',
    resolveSession: (id) => sessionManager.getSession(id),
    resolveUserId,
    resolveParticipants: async (session) => {
      if (!session.projectId || !deps.projectStore) {
        return deriveSessionParticipants(session, null);
      }
      const project = await deps.projectStore.load(session.projectId).catch(() => null);
      return deriveSessionParticipants(session, project);
    },
    resolveElevated: async (c) => (await opts.resolveElevated?.(c)) ?? false,
    messages: { sessionNotFound: messages.sessionNotFound, forbidden: messages.forbidden },
    skipForId: (id) => hasRemoteGetter && isRemoteRef(id),
  });

  /**
   * ADR-036: право раскрыть реальные значения секретов читателю сессии.
   *
   * Политика задаётся backend'ом (`opts.canRevealSecrets`); дефолт — только
   * владелец сессии (fail-closed). Проверка — здесь, в ОДНОЙ точке: обработчики
   * только форматируют ответ по решению (инвариант 16 — правило не дублируется
   * между guard'ом и обработчиком).
   */
  const resolveCanRevealSecrets = async (
    c: Context,
    session: Session,
    userId?: string,
  ): Promise<boolean> => {
    if (opts.canRevealSecrets) return (await opts.canRevealSecrets(c, session)) === true;
    const owner = session.ownerId ?? session.userId;
    if (!owner) return false;
    const uid = userId ?? (await resolveUserId(c));
    if (owner === uid) return true;
    // ADR-089 (standalone): legacy-владелец (UUID профиля `local`) — локальный.
    if (opts.localOwnerResolver && (await opts.localOwnerResolver.isLocalOwner(owner))) {
      return await opts.localOwnerResolver.isLocalOwner(uid);
    }
    return false;
  };

  /**
   * ADR-036: сериализация сессии ДЛЯ ОТВЕТА — реальные значения секретов
   * (`messages[].metadata.secrets`) отдаются только читателю с правом
   * раскрытия; остальным — тот же разговор без значений (ключи-плейсхолдеры
   * остаются, клиент показывает «значение скрыто»).
   *
   * Очистка — на КОПИИ ответа: сохранённая сессия не мутируется.
   */
  const serializeForReader = async (c: Context, session: Session, userId?: string) => {
    const canReveal = await resolveCanRevealSecrets(c, session, userId);
    return serializeSession(session, { agentRegistry, redactSecrets: !canReveal });
  };

  /**
   * Локальная фильтрация списка по project_id. remote-ref (`remote:<uuid>`)
   * фильтровать локально нельзя — его обрабатывает remote-ветка/вызывающая сторона.
   */
  const filterByProject = (items: Session[], projectId?: string): Session[] =>
    projectId && !isRemoteRef(projectId) ? items.filter((s) => s.projectId === projectId) : items;

  app.get('/', auth.requireAuth, scoped('sessions:read'), async (c) => {
    const projectId = c.req.query('project_id') || undefined;
    const userId = await resolveUserId(c);
    // ADR-089: видимость списка. elevated (ADMIN/LEAD) — все сессии; иначе свои
    // личные + сессии проектов-участий (командная видимость).
    const elevated = (await opts.resolveElevated?.(c)) ?? false;
    const memberProjectIds = elevated
      ? []
      : (await opts.resolveMemberProjectIds?.(c, userId)) ?? [];
    let sessions: Session[];
    if (elevated) {
      sessions = await sessionManager.listSessions({});
    } else {
      // ADR-089 (standalone): legacy-владелец (UUID профиля `local`) трактуется
      // как локальный — иначе такие сессии выпадают из списка `local`.
      const ownerIds = opts.localOwnerResolver
        ? [...(await opts.localOwnerResolver.resolveLocalOwnerIds())]
        : undefined;
      sessions = memberProjectIds.length > 0
        ? await sessionManager.listSessions({ userId, projectIds: memberProjectIds, ownerIds })
        : await sessionManager.listSessions({ userId, ownerIds });
    }

    if (!hasRemoteGetter) {
      return c.json(await Promise.all(filterByProject(sessions, projectId).map((s) => serializeForReader(c, s, userId))));
    }

    const remoteClient = resolveClient();

    // Запрос удалённого мира без настроенного гибрида — ошибка, а не локальный список.
    if (projectId && isRemoteRef(projectId) && !remoteClient) {
      return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
    }

    if (!remoteClient) {
      return c.json(await Promise.all(filterByProject(sessions, projectId).map((s) => serializeForReader(c, s, userId))));
    }

    try {
      if (projectId && isRemoteRef(projectId)) {
        const remote = (await remoteClient.listSessions(toLocalId(projectId))) as Array<Record<string, unknown>>;
        return c.json(mergeItems([], remote, { remoteProjectId: projectId }));
      }
      // Локальные сериализуем в DTO ДО объединения — иначе в merged-список
      // попадут сырые Session (camelCase) рядом с remote-DTO (snake_case).
      const localDto = await Promise.all(
        filterByProject(sessions, projectId).map((s) => serializeForReader(c, s, userId)),
      );
      const remote = (await remoteClient.listSessions(projectId)) as Array<Record<string, unknown>>;
      return c.json(mergeItems(localDto, remote));
    } catch (err) {
      // Offline-деградация: сервер недоступен — отдаём локальный мир.
      if (err instanceof RemoteError) {
        console.warn(`[hybrid] удалённый backend недоступен (${err.code}): ${err.message}`);
        if (projectId && isRemoteRef(projectId)) return c.json([]);
        return c.json(
          await Promise.all(filterByProject(sessions, projectId).map((s) => serializeForReader(c, s, userId))),
        );
      }
      throw err;
    }
  });

  app.post('/', auth.requireAuth, scoped('sessions:create'), async (c) => {
    const body = await c.req.json().catch(() => ({}));

    // Гибрид: создание удалённой сессии на backend (только при настроенном геттере).
    if (hasRemoteGetter && body.origin === 'remote') {
      const remoteClient = resolveClient();
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

    const owner = await resolveOwner(c);

    // ADR-052 (этап I): проектная проекция — сессия адресует проект
    // (`project_id`/`projectId`); при заданном `allowedProjects` чужой проект → 403.
    const createDenied = serviceProjectProjection(c, body.project_id || body.projectId || undefined);
    if (createDenied) return createDenied;

    // Метаданные (icon/color): только канонические ключи; null/undefined — сброс.
    if (body.icon !== undefined && body.icon !== null && !isProjectIconKey(body.icon)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: invalidMetaMessage('icon', body.icon, PROJECT_ICON_KEYS) },
      }, 400);
    }
    if (body.color !== undefined && body.color !== null && !isProjectColorKey(body.color)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: invalidMetaMessage('color', body.color, PROJECT_COLOR_KEYS) },
      }, 400);
    }

    // ADR-089: создание сессии — тоже событие. При заданном funnel идём через
    // `RequestSessionService.request` (эмит `session_requested`, единые правила);
    // иначе — прямой materialization-примитив `SessionManager.createSession`.
    const sessionInput = {
      title: body.name || body.title || undefined,
      icon: body.icon ?? undefined,
      color: body.color ?? undefined,
      projectId: body.project_id || body.projectId || undefined,
      parentId: body.parent_id || body.parentId || undefined,
      sessionOrigin: body.session_origin || body.sessionOrigin || undefined,
      settings: { ...body.settings, agentRole: body.settings?.agentRole ?? await resolveDefaultAgent() },
    };
    const created = deps.requestSessionService
      ? await deps.requestSessionService.request(
          { initiator: 'user', intent: 'explicit', ...sessionInput },
          { userId: owner },
        )
      : await sessionManager.createSession({ ...sessionInput, userId: owner });
    if (!created) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Не удалось создать сессию' } }, 500);
    }
    const session = created;
    // ADR-075/D5: createSession сам проставляет ownerId из userId; выставляем
    // явно для совместимости и чтобы serializeSession отдавал owner_id.
    session.ownerId = owner;
    await sessionManager.updateSession(session);
    // Хук подписки EventHub вызываем ДО publish: EventBus не буферизует события,
    // и `session.created` с 0 подписчиков теряется (backend подписывал клиента раньше).
    await opts.onSessionCreated?.(await resolveUserId(c), session.id);
    eventBus.publish(session.id, 'session.created', serializeSession(session, { agentRegistry }));
    return c.json(serializeSession(session, { agentRegistry }), 201);
  });

  app.get('/:id', auth.requireAuth, scoped('sessions:read'), async (c) => {
    const id = c.req.param('id');
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
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
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const readonlyDenied = serviceProjectProjection(c, session.projectId);
    if (readonlyDenied) return readonlyDenied;
    // ADR-036: реальные значения секретов — только читателю с правом раскрытия.
    return c.json(await serializeForReader(c, session));
  });

  app.patch('/:id', auth.requireAuth, scoped('sessions:prompt'), sessionModeGuard, async (c) => {
    const id = c.req.param('id');
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
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
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const patchDenied = serviceProjectProjection(c, session.projectId);
    if (patchDenied) return patchDenied;
    const body = await c.req.json().catch(() => ({}));

    // Валидация тела PATCH (sessionUpdateSchema): невалидные settings/name → 400.
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

    // ADR-040: перенос сессии между проектами (project_id). Валидируем существование
    // нового проекта и публикуем session.moved при фактической смене проекта.
    // (Валидация/авторизация — по предварительному чтению; сама мутация — под локом ниже.)
    const projectParam = body.project_id ?? body.projectId;
    if (projectParam !== undefined) {
      if (projectParam) {
        if (!deps.projectStore) {
          return c.json({
            error: { code: 'INTERNAL_ERROR', message: 'Хранилище проектов недоступно' },
          }, 500);
        }
        const existing = await deps.projectStore.load(projectParam);
        if (!existing) {
          return c.json({
            error: { code: 'PROJECT_NOT_FOUND', message: 'Проект не найден' },
          }, 400);
        }
      }
      // ADR-052 (этап I): проектная проекция — и старая, и новая цель сессии.
      const moveDenied = serviceProjectProjection(c, projectParam || undefined);
      if (moveDenied) return moveDenied;
    }

    // Валидация mode — до лока (не зависит от сессии; 400 ничего не пишет).
    if (body.mode !== undefined && !SESSION_MODES.includes(body.mode)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'mode должен быть "plan", "act" или "yolo"' },
      }, 400);
    }

    // ADR-114: привязка сессии к worktree (`worktreeId`).
    //   - `null`      — снять привязку;
    //   - `'<id>'`    — привязать к записи worktree **целевого** проекта сессии
    //                   (запись чужого проекта выглядит как отсутствующая —
    //                   существование не выдаётся, ADR-114 §5.2).
    //
    // Здесь — **только разбор тела** (не зависит от состояния сессии). Резолв
    // записи и проверку принадлежности проекту делаем **под локом** (внутри
    // `withLock`): иначе параллельный перенос сессии в другой проект мог бы
    // привязать worktree прежнего проекта — чтение проекта вне лока races с
    // переносом (ADR-114 §3.4).
    const hasWorktreeParam = Object.prototype.hasOwnProperty.call(body, 'worktreeId');
    const worktreeParam = hasWorktreeParam ? (body as { worktreeId?: unknown }).worktreeId : undefined;
    const worktreeRequest = !hasWorktreeParam
      ? undefined
      : worktreeParam === null
        ? { kind: 'unbind' as const }
        : (typeof worktreeParam === 'string' && worktreeParam.trim().length > 0
          ? { kind: 'bind' as const, id: worktreeParam }
          : null);
    if (hasWorktreeParam && !worktreeRequest) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'worktreeId должен быть строкой или null',
        },
      }, 400);
    }

    // read-modify-write сессии — только под `SessionManager.withLock`: без лока
    // параллельные PATCH/clear/skills затирают правки друг друга (lost update —
    // победитель сохраняет свой снапшот целиком). Внутри лока сессия перечитывается.
    const {
      updatedSession,
      prevProjectId,
      prevTitle,
      projectChanged,
      worktreeDetached,
      worktreeError,
      worktreeEvents,
    } = await sessionManager.withLock(id, async (s) => {
      const prevProjectId = s.projectId;
      const prevWorktreeId = s.worktree?.worktreeId;
      let projectChanged = false;
      let worktreeDetached = false;
      let worktreeRebound = false;
      const worktreeEvents: WorktreeUpdatedInput[] = [];
      if (projectParam !== undefined) {
        const resolved = projectParam || undefined;
        if (prevProjectId !== resolved) {
          s.projectId = resolved;
          s.planApproved = false;
          projectChanged = true;
          // ADR-114 §3.4: worktree принадлежит проекту — при переносе сессии
          // привязка снимается (иначе каталог был бы вне нового проекта).
          if (s.worktree) {
            s.worktree = undefined;
            worktreeDetached = true;
            // Инвентарь **старого** проекта изменился: запись отвязалась.
            if (prevProjectId) {
              worktreeEvents.push({
                projectId: prevProjectId,
                ...(prevWorktreeId !== undefined ? { worktreeId: prevWorktreeId } : {}),
                action: 'detached',
              });
            }
          }
        }
      }
      // ADR-114: привязка/отвязка worktree — резолв **под локом** (свежая
      // сессия): проект сессии к этому моменту уже актуален (возможен перенос
      // тем же PATCH'ем), поэтому запись ищется именно в нём.
      let worktreeBinding: SessionWorktree | undefined;
      let worktreeUnbind = false;
      let worktreeError:
        | { status: number; code: string; message: string }
        | undefined;
      if (worktreeRequest?.kind === 'unbind') {
        worktreeUnbind = true;
      } else if (worktreeRequest?.kind === 'bind') {
        const targetProjectId = session.projectId;
        if (!targetProjectId) {
          worktreeError = {
            status: 400,
            code: 'VALIDATION_ERROR',
            message: 'Привязать worktree можно только сессии с проектом',
          };
        } else if (!deps.worktreeService) {
          worktreeError = {
            status: 400,
            code: 'VALIDATION_ERROR',
            message: 'Привязка к worktree в этом инстансе недоступна',
          };
        } else {
          const summaries = await deps.worktreeService.list(targetProjectId);
          const found = summaries.find((item) => item.id === worktreeRequest.id);
          if (!found) {
            worktreeError = {
              status: 404,
              code: 'WORKTREE_NOT_FOUND',
              message: 'Worktree не найден',
            };
          } else if (found.exists === false) {
            worktreeError = {
              status: 409,
              code: 'WORKTREE_DIRECTORY_MISSING',
              message: `Каталог worktree не найден: ${found.directory}`,
            };
          } else {
            worktreeBinding = {
              worktreeId: found.id,
              projectId: found.projectId,
              ...(found.repoPath !== undefined ? { repoPath: found.repoPath } : {}),
              directory: found.directory,
              branch: found.branch,
            };
          }
        }
      }
      if (worktreeError) {
        // Ошибка привязки — сессия не меняется вовсе (в т.ч. перенос проекта):
        // запись не сохраняем, события не публикуем.
        return {
          updatedSession: s,
          prevProjectId,
          prevTitle: undefined,
          projectChanged,
          worktreeDetached,
          worktreeRebound: false,
          worktreeError,
          worktreeEvents,
        };
      }
      // ADR-114: привязка/отвязка worktree (после смены проекта: привязка
      // должна принадлежать проекту сессии на момент записи).
      if (worktreeBinding) {
        s.worktree = worktreeBinding;
        worktreeRebound = true;
        worktreeEvents.push({
          projectId: s.projectId ?? '',
          worktreeId: worktreeBinding.worktreeId,
          action: 'attached',
        });
      } else if (worktreeUnbind) {
        s.worktree = undefined;
        worktreeRebound = true;
        // Отвязка без прежней привязки — ничего не изменилось: события нет.
        if (prevWorktreeId && s.projectId) {
          worktreeEvents.push({
            projectId: s.projectId,
            worktreeId: prevWorktreeId,
            action: 'detached',
          });
        }
      }
      if (body.name !== undefined) s.title = body.name;
      let prevTitle: string | undefined;
      if (body.title !== undefined) {
        prevTitle = s.title;
        s.title = body.title;
      }
      if (body.icon !== undefined) s.icon = parsed.data.icon ?? undefined;
      if (body.color !== undefined) s.color = parsed.data.color ?? undefined;
      if (body.mode !== undefined) {
        // ADR-106 Ф4 (шаг C): область режима решает граничный guard — общий
        // режим сессии (одиночная сессия) или режим только этого принципала
        // (многопользовательская сессия: чужие ходы не меняются).
        const modeDecision = getSessionModeDecision(c);
        applySessionMode(s, body.mode, modeDecision?.scope ?? { kind: 'session' });
      }
      if (parsed.data.settings !== undefined) {
        s.settings = { ...s.settings, ...parsed.data.settings };
      }
      await sessionManager.updateSession(s);
      return {
        updatedSession: s,
        prevProjectId,
        prevTitle,
        projectChanged,
        worktreeDetached,
        worktreeRebound,
        worktreeError: undefined,
        worktreeEvents,
      };
    });

    if (worktreeError) {
      return c.json(
        { error: { code: worktreeError.code, message: worktreeError.message } },
        worktreeError.status as 400 | 404 | 409,
      );
    }

    // Порядок публикации сохранён: renamed → updated → moved.
    if (publishRenamed && prevTitle !== undefined && prevTitle !== body.title) {
      eventBus.publish(updatedSession.id, 'session.renamed', { session_id: updatedSession.id, title: body.title, prev_title: prevTitle });
    }
    eventBus.publish(updatedSession.id, 'session.updated', serializeSession(updatedSession, { agentRegistry }));
    if (projectChanged) {
      eventBus.publish(updatedSession.id, 'session.moved', {
        session_id: updatedSession.id,
        project_id: updatedSession.projectId ?? null,
        prev_project_id: prevProjectId ?? null,
        // ADR-114 §3.4: привязка к worktree снята (worktree принадлежит
        // старому проекту) — факт снятия виден в событии.
        ...(worktreeDetached ? { worktree_detached: true } : {}),
      });
    }
    // ADR-114 §6: привязка/отвязка worktree — инвентарь проекта изменился
    // (статус записи attached/detached) → событие в каналы сессий проекта.
    for (const event of worktreeEvents) {
      await publishWorktreeUpdated({ eventBus, sessionStore: sessionManager }, event);
    }
    return c.json(serializeSession(updatedSession, { agentRegistry }));
  });

  app.delete('/:id', auth.requireAuth, scoped('sessions:prompt'), async (c) => {
    const id = c.req.param('id');
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
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
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const deleteDenied = serviceProjectProjection(c, session.projectId);
    if (deleteDenied) return deleteDenied;
    const userId = await resolveUserId(c);
    if (publishDeletedBefore) {
      eventBus.publish(session.id, 'session.deleted', { session_id: session.id });
    }
    await sessionManager.deleteSession(session.id);
    queueManager.stop(session.id);
    // ADR-115: сообщения удалены вместе с сессией — снимаем ссылки на объекты
    // вложений (нести туда `removeByOwner` не нужно — владелец именно сообщение).
    if (deps.attachments?.blobRefs) {
      const blobRefs = deps.attachments.blobRefs;
      for (const message of session.messages) {
        await blobRefs.removeByOwner('message', message.id).catch(() => 0);
      }
    }
    if (!publishDeletedBefore) {
      eventBus.publish(session.id, 'session.deleted', { session_id: session.id });
    }
    await opts.onSessionDeleted?.(userId, session.id);
    return c.body(null, 204);
  });

  app.get('/:id/status', auth.requireAuth, scoped('sessions:read'), async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const statusDenied = serviceProjectProjection(c, session.projectId);
    if (statusDenied) return statusDenied;
    // Доступ к сессии — единственная точка истины: prefix-guard выше. Повторная
    // проверка здесь недопустима (давала разные правила: guard учитывает elevated
    // ADMIN/LEAD, а handler — нет → ложный 403 для LEAD).
    return c.json({
      blocked: !!session.status.blocked,
      pending_count: session.pendingMessages.length,
      processor_running: queueManager.isRunning(session.id),
    });
  });

  // GET /api/v2/sessions/:id/prompt — состав системного промпта (ADR-070 §2.5):
  // манифест источников + состояние промпта активного агента + последний promptMeta.
  app.get('/:id/prompt', auth.requireAuth, scoped('sessions:read'), async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const accessDenied = serviceProjectProjection(c, session.projectId);
    if (accessDenied) return accessDenied;
    // Доступ — у prefix-guard (единая точка истины); здесь не дублируем.
    const info = await orchestrator.getPromptInfo(session);
    return c.json(info);
  });

  /**
   * GET /api/v2/sessions/:id/memory — память сессии (ADR-107, вкладка «Память»).
   *
   * Только агрегаты: блоки памяти из **последнего** хода (`promptMeta.memory`),
   * число активных фактов в скоупе и индексы в скоупе. Текстов фактов/чанков
   * нет — доступ к содержимому остаётся у портала (ADMIN).
   *
   * Доступ — у prefix-guard (инвариант 16); здесь не дублируем.
   */
  app.get('/:id/memory', auth.requireAuth, scoped('sessions:read'), async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const accessDenied = serviceProjectProjection(c, session.projectId);
    if (accessDenied) return accessDenied;

    const memory = deps.memory;
    const providerActive = memory ? memory.isPluginActive() : false;

    // ADR-107: эффективная политика памяти проекта. Поле не задано/проект не
    // загружен — память включена (не блокируем). Сессия без проекта — `null`.
    let projectMemoryEnabled = true;
    if (session.projectId && deps.projectStore) {
      try {
        const project = await deps.projectStore.load(session.projectId);
        projectMemoryEnabled = project?.memory?.enabled !== false;
      } catch {
        projectMemoryEnabled = true;
      }
    }
    const projectMemory = session.projectId
      ? { enabled: projectMemoryEnabled }
      : null;

    const lastContext = (() => {
      for (let i = session.messages.length - 1; i >= 0; i -= 1) {
        const meta = session.messages[i]?.promptMeta?.memory;
        if (meta) return meta;
      }
      return null;
    })();

    if (!memory || !providerActive) {
      return c.json({
        provider: { active: providerActive },
        scope: { ...(session.projectId ? { projectId: session.projectId } : {}) },
        projectMemory,
        lastContext,
        facts: { active: 0 },
        indexes: {
          total: 0, project: 0, instance: 0, ready: 0, building: 0, failed: 0,
          items: [],
        },
        readiness: 'unavailable',
      });
    }

    let activeFacts = 0;
    try {
      const facts = await memory.facts.list({
        namespace: MEMORY_NAMESPACE,
        status: 'active',
        limit: 1000,
      });
      activeFacts = facts.filter((fact) =>
        session.projectId
          ? fact.projectId === undefined || fact.projectId === session.projectId
          : fact.projectId === undefined,
      ).length;
    } catch {
      // Порт недоступен — показываем 0, но readiness не притворяется healthy.
    }

    /** Индекс в скоупе сессии для вкладки «Память». */
    type SessionMemoryIndexItem = {
      id: string;
      name: string;
      scope: 'project' | 'instance';
      state: string;
      enabled: boolean;
      projectId?: string;
    };
    const items: SessionMemoryIndexItem[] = [];
    try {
      const records = await memory.indexes.listIndexes({ namespace: MEMORY_NAMESPACE, limit: 1000 });
      for (const index of records) {
        const inScope = index.scope === 'instance'
          || (session.projectId ? index.projectId === session.projectId : index.projectId === undefined);
        if (!inScope) continue;
        items.push({
          id: index.id,
          name: index.name,
          scope: index.scope,
          state: index.state,
          // Инстансный индекс отключить нельзя — он всегда включён.
          enabled: index.scope === 'instance' ? true : index.enabled !== false,
          ...(index.projectId ? { projectId: index.projectId } : {}),
        });
      }
    } catch {
      // см. выше — агрегаты деградируют, ответ остаётся валидным.
    }
    // Детерминированный порядок — по имени, тайбрейкер — id.
    items.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    // Агрегаты считаются из `items` (один проход, не два).
    const indexes = {
      total: items.length,
      project: 0,
      instance: 0,
      ready: 0,
      building: 0,
      failed: 0,
      items,
    };
    for (const index of items) {
      if (index.scope === 'instance') indexes.instance += 1;
      else indexes.project += 1;
      if (index.state === 'ready') indexes.ready += 1;
      else if (index.state === 'building') indexes.building += 1;
      else if (index.state === 'failed') indexes.failed += 1;
    }

    return c.json({
      provider: { active: true },
      scope: { ...(session.projectId ? { projectId: session.projectId } : {}) },
      projectMemory,
      lastContext,
      facts: { active: activeFacts },
      indexes,
      readiness: indexes.failed > 0 ? 'degraded' : 'ready',
    });
  });

  // GET /api/v2/sessions/:id/stats — статистика по агентам/пользователям
  // (ADR-070 §2.6): usage сообщений + рекурсивный usage саб-агентов (tool `task`).
  app.get('/:id/stats', auth.requireAuth, scoped('sessions:read'), async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const accessDenied = serviceProjectProjection(c, session.projectId);
    if (accessDenied) return accessDenied;
    // Доступ — у prefix-guard (единая точка истины); здесь не дублируем.
    const stats = await computeSessionStats(session, {
      getSession: (id) => sessionManager.getSession(id),
      getModelPricing: (model) => orchestrator.getModelPricing(model),
      resolveAuthorName,
    });
    return c.json(stats);
  });

  app.post('/:id/prompt', chainMiddleware([auth.requireAuth, scoped('sessions:prompt'), ...promptMiddleware]), async (c) => {
    const sessionId = c.req.param('id');

    // Гибрид: удалённая сессия исполняется backend — пробрасываем upstream Response
    // как есть (SSE-стрим), без локального оркестратора.
    if (hasRemoteGetter && isRemoteRef(sessionId)) {
      const remoteClient = resolveClient();
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      const body = await c.req.json().catch(() => ({}));
      // ADR-104 (этап 3): режим отправки доезжает до удалённой стороны (тело
      // пробрасывается как есть) и клиент получает явный ответ, если удалённая
      // сторона режим НЕ применила.
      const mode = isSteerMode(body.mode) ? body.mode : DEFAULT_STEER_MODE;
      try {
        const response = await remoteClient.promptSession(toLocalId(sessionId), body, { signal: c.req.raw.signal });
        if (mode === 'queue') return response;
        // Удалённая сторона применила режим → отвечает `202` (ack без
        // SSE-тела). Иначе режим не применён (нет активного хода на удалённой
        // стороне или удалённая версия режим не знает) — сообщение ушло
        // обычной очередью, отвечаем явным ack'ом.
        if (response.status === 202) {
          const payload = await response.json().catch(() => ({}));
          return c.json({ ...(payload as Record<string, unknown>), mode_applied: true }, 202);
        }
        await response.body?.cancel().catch(() => {});
        return c.json({
          status: 'queued',
          mode_applied: false,
          stream_id: typeof body.messageId === 'string' ? body.messageId : undefined,
        }, 202);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    const body = await c.req.json().catch(() => ({}));
    const content = body.content?.trim();

    if (!content) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.contentRequired(c) } }, 400);
    }

    // ADR-104: режим отправки. Неизвестное значение — как `queue` (обратная
    // совместимость: поле необязательное).
    const mode = isSteerMode(body.mode) ? body.mode : DEFAULT_STEER_MODE;

    const session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const promptDenied = serviceProjectProjection(c, session.projectId);
    if (promptDenied) return promptDenied;
    // Доступ — у prefix-guard (единая точка истины): он учитывает владельца,
    // участника проекта и сквозной обзор ADMIN/LEAD. Здесь остаётся только
    // специфика тела запроса (проверка контента выше).

    // ADR-115: вложения — пути объектов blob-хранилища (`attachments/<sha2>/<sha256>`),
    // полученные из `POST /sessions/:id/attachments`. Порядок частей: текст,
    // затем вложения. Неизвестный/невалидный путь — 400 с перечнем проблемных
    // (молча терять вложение нельзя: модель получила бы текст без картинки).
    const rawAttachments = (body as { attachments?: unknown }).attachments;
    const attachmentPaths = normalizeAttachmentPaths(rawAttachments);
    if (rawAttachments !== undefined && !attachmentPaths) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: messages.invalidAttachments(c) } },
        400,
      );
    }
    const attachmentConfig = deps.attachments?.config;
    if (attachmentPaths && attachmentPaths.length > 0) {
      if (!attachmentService || !attachmentConfig) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: messages.attachmentsUnavailable(c) } },
          400,
        );
      }
      if (attachmentPaths.length > attachmentConfig.maxFilesPerMessage) {
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: messages.attachmentsLimitExceeded(c, attachmentConfig.maxFilesPerMessage),
            },
          },
          400,
        );
      }
    }

    const messageParts: Part[] = [{ id: generateStreamId(), type: 'text', data: content }];
    if (attachmentPaths && attachmentPaths.length > 0 && attachmentService) {
      const broken: string[] = [];
      let addedBytes = 0;
      for (const blobPath of attachmentPaths) {
        const media = await attachmentService.buildMediaPart(blobPath);
        if (!media) {
          broken.push(blobPath);
          continue;
        }
        messageParts.push(makeMediaPart(media.type, media.data));
        addedBytes += media.data.size;
      }
      if (broken.length > 0) {
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: messages.attachmentsInvalid(c, broken),
            },
          },
          400,
        );
      }
      // Квота сессии считается по частям сообщений (а не по ссылкам): она про
      // объём, который реально уйдёт провайдеру из этой сессии.
      const sessionLimit = attachmentConfig?.maxBytesPerSession;
      if (sessionLimit && addedBytes > 0) {
        const used = sessionAttachmentBytes(session);
        if (used + addedBytes > sessionLimit) {
          return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: messages.tooLarge(c) } }, 413);
        }
      }
    }

    // `content` — производная от частей: медиа-часть оставляет плейсхолдер
    // (`[image: name.png]`), иначе факт вложения теряется в строковых производных.
    // Маркер может прийти уже из композера (он вставляет его при прикреплении) —
    // тогда второй раз он не добавляется (appendMediaPlaceholders).
    const messageContent = appendMediaPlaceholders(content, messageParts);

    const streamId = body.messageId || generateStreamId();
    const author = await resolveAuthor(c);
    // ADR-106 Ф4: принципал ввода фиксируется **при приёме ввода** (здесь —
    // на постановке в очередь). Не аутентифицирован → не задан → fallback
    // на владельца сессии (совместимость).
    const turnPrincipal = resolveUserPrincipal(await resolveUserId(c));

    const message: Message = {
      id: promptMessageId === 'stream' ? streamId : generateStreamId(),
      role: MessageRole.USER,
      seq: session.messages.length + 1,
      origin: 'local',
      parts: messageParts,
      content: messageContent,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      author,
      agentRole: body.agent || session.settings.agentRole,
      provider: body.provider || session.settings.provider,
      model: body.model || session.settings.model,
      metadata: { ...(body.metadata || {}), stream_id: streamId },
    };

    // ADR-104: `steer` — вмешательство в активный ход (без прерывания
    // генерации), `interrupt` — прерывание текущей генерации с продолжением
    // хода. Если активного хода нет — ведём себя как обычная очередь
    // (сообщение начнёт новый ход).
    if (mode !== 'queue' && isTurnActive(session, queueManager)) {
      const interruptMode = mode === 'interrupt';
      const steerResult = await enqueueSteerMessage(
        sessionManager, eventBus, sessionId, message, MAX_STEER_INJECTIONS_PER_TURN,
        (sid, msg) => orchestrator.obfuscateUserMessageForHistory(sid, msg),
        { interrupt: interruptMode, ...(turnPrincipal ? { principal: turnPrincipal } : {}) },
      );
      if (!steerResult.accepted) {
        return c.json({
          error: {
            code: STEERING_ERROR_CODES.limitExceeded,
            message: messages.steerLimitExceeded(c, MAX_STEER_INJECTIONS_PER_TURN),
          },
        }, 429);
      }
      // ADR-115: сообщение принято — фиксируем ссылки на объекты вложений
      // (по ним работает дедуп и GC; снимаются при удалении сообщения).
      await registerAttachmentRefs(deps.attachments?.blobRefs, message.id, messageParts);
      if (interruptMode) {
        // Прерываем текущую генерацию: ход НЕ завершается («Стоп» — отдельный
        // механизм, ADR-005) — обрывается только стрим, а сообщение
        // вплетается на ближайшей границе шага. Порядок важен: сообщение уже
        // в очереди инъекций, поэтому инъекция гарантированно попадёт в ход.
        const liveStreamId = session.currentStream?.streamId;
        if (liveStreamId) orchestrator.interrupt(liveStreamId);
      }
      // Отдельный стрим не запускается — сообщение вплетается в текущий ход,
      // поэтому отвечаем статусом без SSE.
      return c.json({
        status: interruptMode ? 'interrupted' : 'steered',
        stream_id: streamId,
        pending_count: steerResult.pending,
        // ADR-104 (этап 3): локальная сторона применила режим сама.
        mode_applied: true,
      }, 202);
    }

    const result = await enqueueUserMessage(
      sessionManager, eventBus, sessionId, message, queueManager, processMessage,
      (sid, msg) => orchestrator.obfuscateUserMessageForHistory(sid, msg),
      turnPrincipal ? { principal: turnPrincipal } : undefined,
    );

    if (!result) {
      return c.json({
        error: { code: 'QUEUE_FULL', message: messages.queueFull(c, 5) },
      }, 429);
    }

    // ADR-115: сообщение принято — фиксируем ссылки на объекты вложений.
    await registerAttachmentRefs(deps.attachments?.blobRefs, message.id, messageParts);

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

  app.get('/:id/messages', auth.requireAuth, scoped('sessions:read'), async (c) => {
    const id = c.req.param('id');
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
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
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const messagesDenied = serviceProjectProjection(c, session.projectId);
    if (messagesDenied) return messagesDenied;
    // ADR-036: тот же носитель секретов, что и в `GET /:id` — право раскрытия
    // то же (решается в одной точке — `resolveCanRevealSecrets`).
    const canReveal = await resolveCanRevealSecrets(c, session);
    return c.json({
      messages: session.messages.map((m, i) => serializeMessage(m, i, { redactSecrets: !canReveal })),
      session_id: session.id,
    });
  });

  app.post('/:id/clear', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    const existing = await sessionManager.getSession(id);
    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    // read-modify-write сессии — только под `SessionManager.withLock`: без лока
    // конкурентная правка (PATCH/сообщение) затирается снапшотом clear (lost update).
    const session = await sessionManager.withLock(id, async (s) => {
      s.messages = s.messages.filter((m) => m.pinned);
      s.pendingMessages = [];
      s.inputTokens = 0;
      s.outputTokens = 0;
      s.totalTokens = 0;
      s.inputCost = 0;
      s.outputCost = 0;
      s.cacheReadCost = 0;
      s.cacheWriteCost = 0;
      await sessionManager.updateSession(s);
      return s;
    });
    return c.json(serializeSession(session, { agentRegistry }));
  });

  app.post('/:id/abort', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
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
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    // Персистентный флаг отмены (ADR-005): работает и когда `currentStream`/
    // cancel-token отсутствуют (сессия в очереди / backoff / между итерациями),
    // когда `orchestrator.cancel` — no-op. Пишем под локом, чтобы не потерять
    // конкурентную запись процессора; сбрасывает флаг сам процессор.
    await sessionManager.withLock(id, async (s) => {
      s.status.cancelRequested = true;
      s.status.cancelRequestedAt = nowISO();
      await sessionManager.saveSession(s);
    });

    // Graceful-отмена активного стрима: оркестратор публикует stream.cancelled
    // и сохраняет частичный ответ (если токен ещё жив).
    if (session.currentStream) {
      orchestrator.cancel(session.currentStream.streamId);
    }

    // Прерываем backoff/активный LLM-вызов и цикл процессора немедленно.
    // Очистку pendingMessages/blocked/currentStream/флага выполняет сам
    // QueueProcessor. НЕ вызываем queueManager.stop() — иначе сессия остаётся
    // «зависшей» (stalled). Если процессора нет — снимаем флаг, иначе следующий
    // запуск ложно отменится.
    if (!queueManager.requestStop(id)) {
      await sessionManager.withLock(id, async (s) => {
        s.status.cancelRequested = undefined;
        s.status.cancelRequestedAt = undefined;
        await sessionManager.saveSession(s);
      });
    }
    // ADR-102: мера `activity.aborts` — на осях `user`/`project` сессии.
    void analytics?.recordActivity('aborts', sessionAxes(session));
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
    const id = c.req.param('id');
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
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
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    if (!deps.contextOptimizer) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Context optimizer not configured' } }, 500);
    }
    if (!session.settings.provider || !session.settings.model) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'No provider/model configured for session' } }, 400);
    }
    if (!deps.contextOptimizer.canSummarize(session)) {
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
      author: await resolveAuthor(c),
      metadata: { type: 'summarization_request', reason: 'manual', stream_id: streamId },
    };

    // ADR-106 Ф4: принципал инициатора (ручная суммаризация — ввод от
    // пользователя, а не системный ход).
    const summarizerPrincipal = resolveUserPrincipal(await resolveUserId(c));
    const result = await enqueueUserMessage(
      sessionManager, eventBus, session.id, sysMsg, queueManager, processMessage,
      undefined,
      summarizerPrincipal ? { principal: summarizerPrincipal } : undefined,
    );
    if (!result) {
      return c.json({ error: { code: 'QUEUE_FULL', message: 'Queue is full' } }, 429);
    }
    return c.json({ status: 'enqueued', stream_id: streamId });
  });

  // Core-only: сессионный SSE-стрим. У managed backend есть только глобальный
  // `/api/v2/events`, поэтому backend передаёт enableSessionEvents: false.
  if (enableSessionEvents) {
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
  }

  app.get('/:id/children', auth.requireAuth, async (c) => {
    const children = await sessionManager.getChildren(c.req.param('id'));
    // ADR-036: у детей своя привилегия раскрытия (владелец — свой).
    return c.json(await Promise.all(children.map((s) => serializeForReader(c, s))));
  });

  app.get('/:id/tree', auth.requireAuth, async (c) => {
    const tree = await sessionManager.getSessionTree(c.req.param('id'));
    // ADR-036: дерево отдаёт СЫРЫЕ сессии — значения секретов вычищаются
    // на копии (та же привилегия раскрытия, что и в `GET /:id`).
    const redactNode = async (node: SessionTree): Promise<SessionTree> => {
      const session = node.session;
      let visible = session;
      if (session) {
        const canReveal = await resolveCanRevealSecrets(c, session);
        visible = canReveal ? session : redactSessionSecretValues(session);
      }
      return {
        session: visible,
        children: await Promise.all(node.children.map(redactNode)),
      };
    };
    return c.json(await redactNode(tree));
  });

  app.post('/:id/fork', chainMiddleware([auth.requireAuth, ...forkMiddleware]), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const forkOptions: { messageId?: string; messageIndex?: number; title?: string; userId?: string; ownerId?: string } = {
      messageId: body.message_id ?? body.messageId,
      messageIndex: body.message_index ?? body.messageIndex,
      title: body.title,
    };
    if (forkWithOwner) {
      const owner = await resolveOwner(c);
      forkOptions.userId = owner;
      forkOptions.ownerId = owner;
    }
    const fork = await sessionManager.forkSession(c.req.param('id'), forkOptions);
    // ADR-115: форк копирует сообщения (с вложениями) под новыми id — копия тоже
    // владелец объектов (`blob_refs`), иначе после удаления исходного сообщения
    // GC счёл бы объект сиротой, а форк показывал бы битую картинку.
    if (deps.attachments?.blobRefs) {
      const blobRefs = deps.attachments.blobRefs;
      for (const message of fork.messages) {
        await registerAttachmentRefs(blobRefs, message.id, message.parts);
      }
    }
    // См. POST /: подписка EventHub до publish (иначе session.fork.created теряется).
    await opts.onSessionForked?.(await resolveUserId(c), fork.id);
    eventBus.publish(fork.id, 'session.fork.created', serializeSession(fork, { agentRegistry }));
    return c.json(serializeSession(fork, { agentRegistry }), 201);
  });

  // GET /api/v2/sessions/:id/references — список ссылок
  app.get('/:id/references', auth.requireAuth, async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
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
  app.post('/:id/messages/merge', chainMiddleware([auth.requireAuth, ...mergeMiddleware]), async (c) => {
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

    // ADR-115: скопированные сообщения получают собственные ссылки на объекты
    // вложений (иначе GC мог бы удалить объект, на который смотрит копия).
    if (deps.attachments?.blobRefs) {
      const blobRefs = deps.attachments.blobRefs;
      for (const message of merged) {
        await registerAttachmentRefs(blobRefs, message.id, message.parts);
      }
    }

    eventBus.publish(c.req.param('id'), 'session.messages.merged', {
      messages: merged.map((m, i) => serializeMessage(m, i)),
      source_session_id: sourceSessionId,
    });

    return c.json({ messages: merged.map((m, i) => serializeMessage(m, i)) }, 201);
  });

  // ===========================================================================
  // Этап 1 roadmap 0.13 (блок 3): вопросы пользователю (`ask_user`).
  //
  // Вопрос — персистентная запись сессии: агент задал вопрос и ждёт ответа.
  // Ответ приходит по `id` вопроса (`POST /:id/questions/:qid/answer`), поэтому
  // маршруты живут внутри фабрики сессий — под тем же prefix-guard'ом доступа
  // (инвариант 16: проверок доступа в обработчиках нет).
  //
  // Вид доступа выводится из HTTP-метода самим guard'ом:
  // - `GET /:id/questions` — **чтение** (владелец сессии, ADMIN/LEAD, участник
  //   проекта с правом чтения);
  // - `POST /:id/questions/:qid/answer|cancel` — **write** (владелец сессии,
  //   ADMIN/LEAD, участник проекта с правом изменения содержимого).
  //
  // Осознанное решение: ответ на вопрос отнесён к write-уровню, хотя сам
  // ответ не меняет проект — это действие **пользователя** в ходе сессии
  // (как `POST /:id/prompt`), поэтому VIEWER-участник проекта не отвечает.
  // ===========================================================================

  /** Статусы вопроса в фильтре `GET /:id/questions`. */
  const QUESTION_STATUSES: readonly QuestionStatus[] = ['pending', 'answered', 'cancelled'];
  /** Дефолтный лимит выборки вопросов. */
  const DEFAULT_QUESTIONS_LIMIT = 50;
  /** Верхняя граница лимита выборки вопросов. */
  const MAX_QUESTIONS_LIMIT = 200;

  /** Ответ 503 — сервис вопросов не подключён (сборка без подсистемы). */
  const questionsUnavailable = (c: Context) =>
    c.json({ error: { code: 'QUESTION_UNAVAILABLE', message: 'Вопросы пользователю недоступны' } }, 503);

  // GET /api/v2/sessions/:id/questions — вопросы сессии.
  app.get('/:id/questions', auth.requireAuth, scoped('sessions:read'), async (c) => {
    const questionService = deps.questionService;
    if (!questionService) return questionsUnavailable(c);

    const status = c.req.query('status');
    if (status !== undefined && !QUESTION_STATUSES.includes(status as QuestionStatus)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: `Недопустимый status: ${status}` },
      }, 400);
    }
    const limitRaw = c.req.query('limit');
    let limit = DEFAULT_QUESTIONS_LIMIT;
    if (limitRaw !== undefined) {
      const parsedLimit = Number(limitRaw);
      if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: 'limit должен быть положительным числом' },
        }, 400);
      }
      limit = Math.min(Math.floor(parsedLimit), MAX_QUESTIONS_LIMIT);
    }

    const questions = await questionService.list({
      sessionId: c.req.param('id'),
      ...(status ? { status: status as QuestionStatus } : {}),
      limit,
    });
    return c.json({ questions });
  });

  // POST /api/v2/sessions/:id/questions/:qid/answer — ответ пользователя.
  app.post('/:id/questions/:qid/answer', auth.requireAuth, scoped('sessions:prompt'), async (c) => {
    const questionService = deps.questionService;
    if (!questionService) return questionsUnavailable(c);

    const body = await c.req.json().catch(() => null);
    const parsed = questionAnswerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'answers должен быть массивом массивов строк' },
      }, 400);
    }

    const sessionId = c.req.param('id');
    const questionId = c.req.param('qid');
    // Вопрос другой сессии не виден — 404 (не 403: не выдаём факт существования).
    const record = await questionService.get(questionId);
    if (!record || record.sessionId !== sessionId) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Вопрос не найден' } }, 404);
    }

    try {
      const answeredBy = await resolveUserId(c);
      const question = await questionService.answer(questionId, parsed.data.answers, answeredBy);
      return c.json({ question });
    } catch (err) {
      if (err instanceof QuestionAlreadySettledError) {
        return c.json({
          error: { code: 'CONFLICT', message: 'Вопрос уже закрыт (отвечен или отменён)' },
        }, 409);
      }
      if (err instanceof QuestionInvalidAnswerError) {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: `Некорректный ответ: ${err.reason}` },
        }, 400);
      }
      if (err instanceof QuestionNotFoundError) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Вопрос не найден' } }, 404);
      }
      throw err;
    }
  });

  // POST /api/v2/sessions/:id/questions/:qid/cancel — отмена вопроса.
  app.post('/:id/questions/:qid/cancel', auth.requireAuth, scoped('sessions:prompt'), async (c) => {
    const questionService = deps.questionService;
    if (!questionService) return questionsUnavailable(c);

    const body = await c.req.json().catch(() => ({}));
    const parsed = questionCancelSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'reason должен быть строкой' },
      }, 400);
    }

    const sessionId = c.req.param('id');
    const questionId = c.req.param('qid');
    const record = await questionService.get(questionId);
    if (!record || record.sessionId !== sessionId) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Вопрос не найден' } }, 404);
    }

    try {
      const question = await questionService.cancel(
        questionId,
        parsed.data.reason ?? 'user',
        await resolveUserId(c),
      );
      return c.json({ question });
    } catch (err) {
      if (err instanceof QuestionAlreadySettledError) {
        return c.json({
          error: { code: 'CONFLICT', message: 'Вопрос уже закрыт (отвечен или отменён)' },
        }, 409);
      }
      if (err instanceof QuestionNotFoundError) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Вопрос не найден' } }, 404);
      }
      throw err;
    }
  });

  return app;
}
