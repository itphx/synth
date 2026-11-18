import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { SessionManager, EventBus, QueueProcessorManager, ChatOrchestrator, ContextOptimizer, RequestSessionService } from '../../index.js';
import type { CompressionMode } from '../../engine/context/optimizer.js';
import type { SessionTree } from '../../sessions/manager.js';
import { MessageRole, SESSION_MODES, generateStreamId, nowISO, sessionUpdateSchema, sessionMcpUpdateSchema, createResolveAuthorName, PROJECT_ICON_KEYS, PROJECT_COLOR_KEYS, isProjectIconKey, isProjectColorKey, isSteerMode, DEFAULT_STEER_MODE, MAX_STEER_INJECTIONS_PER_TURN, STEERING_ERROR_CODES } from '@itphx/synth-shared';
import type { Message, Session, QuestionStatus, SessionWorktree, AttachmentsConfig, StickyNotesLimits } from '@itphx/synth-shared';
import type { ProfileStore } from '@itphx/synth-shared';
import { enqueueUserMessage, enqueueSteerMessage, DEFAULT_AGENT_ID, SubagentResumeError, computeSessionStats } from '../../index.js';
import { serializeSession, serializeMessage, redactSessionSecretValues } from '../serialize.js';
import type { SerializeSessionOptions } from '../serialize.js';
// Общие помощники постраничной выдачи (`limit`/`offset`/`next_offset`) — один
// контракт на все списки с пагинацией (сессии, проекты, пайплайны).
import { paginate, parseBoundedInt } from '../pagination.js';
import type { ProjectStoreLike } from '../../storage/project-store.js';
import type { ExecutionProfileCatalog } from '../../execution/profile-binding.js';
import {
  isRemoteRef, toLocalId, toRemoteRef, toRemote, mergeItems, remoteErrorToHttp,
  toRemoteSessionMemory,
} from '../../remote/aggregate.js';
// Гибридный merge списков: общий порядок миров + нарезка страницы после merge.
import { localEntries, remoteEntries, sortHybridList, sliceRemoteMessages } from './hybrid-list.js';
import type { HybridListEntry } from './hybrid-list.js';
import { RemoteError } from '../../remote/types.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import { requireScope, checkServiceProjectProjection, getServiceCredential } from '../service-scope.js';
import { resolveAgentRoleAlias } from '../../engine/agents/migrations.js';
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
import { dropSteerInjections } from '../../engine/steering/apply.js';
// ADR-041: строки движка — через ключи `shared/i18n` (не литералы).
import { t as sm, i18n as i18nMeta } from '../../engine/system-messages.js';
import { requeueMessages, publishQueueState, queueCounts } from '../../queue/processor.js';
// PROP-142 §3: бюджет автовосстановления прерванных ходов (сброс — ручной
// повтор через `POST /:id/recovery/retry`).
import { resetRecoveryState } from '../../sessions/recovery.js';
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
// ADR-126 §4: сниппеты (`#`) — раскрытие в приёме промпта (до очереди).
import type { SnippetService } from '../../engine/snippets/service.js';
// ADR-126 §2: `@user` — граница «агенту / пользователю» (разбор упоминаний).
import {
  resolveMentionableUsers,
  resolveUserMentionSplit,
  validateExplicitMentions,
  type UserMentionSplit,
} from '../../engine/input-surface/user-mentions.js';
import { resolveFileMentions } from '../../engine/input-surface/file-mentions.js';
// ADR-118 §2: монотонный `ord` — счётчик порядка записи в историю.
import { nextOrd } from '../../storage/message-write.js';
// PROP-132: контекст терминала, приходящий с клиента вместе с вопросом
// (`POST /:id/prompt`, поле `context`) — служебное сообщение с выводом
// терминала, которое доставляется **перед** вопросом.
import {
  buildTerminalContextMessage,
  parseTerminalContext,
} from '../../engine/terminal/context-message.js';
import { warning } from '../../logger.js';
// ADR-111 §detach: авто-перевод блокирующих прогонов в фон при steer.
import { autoDetachOnSteer } from '../../engine/background/auto-detach.js';
import type { ActiveRunDetachResult } from '../../engine/background/active-runs.js';
// ADR-115: вложения сообщений — сервис (blob-хранилище + лимиты) и роуты загрузки/раздачи.
import {
  AttachmentService,
  attachmentModalityOf,
  type AttachmentThumbnailProvider,
} from '../../engine/attachments/service.js';
import { createAttachmentRoutes } from './attachments.js';
import { createSessionTodoRoutes } from './session-todos.js';
// ADR-126 §5: реестр скриптов проекта (`!`-запуск) — HTTP-контур в контуре сессии.
import { createSessionScriptRoutes } from './session-scripts.js';
import type { SessionScriptRouteMessages } from './session-scripts.js';
import type { ScriptService } from '../../engine/scripts/service.js';
import type { CommandAuditLog } from '../../engine/security/command-audit.js';
import type { PermissionConfig } from '@itphx/synth-shared';
import type { BlobRefRepository } from '../../storage/ports/blob-ref-repository.js';
import type { BlobStore } from '../../storage/ports/blob-store.js';
// ADR-111 §detach: вид блокирующего прогона (`POST /:id/background`).
import type { ActiveRunKind } from '../../engine/background/active-runs.js';
// ADR-111/ADR-113: реестр фоновых прогонов — «Стоп» останавливает и дочерние
// прогоны (решение 2026-10-28).
import type { BackgroundRunService } from '../../engine/background/service.js';
import { makeMediaPart, appendMediaPlaceholders } from '@itphx/synth-shared';
import type { Part } from '@itphx/synth-shared';
// ADR-106 Ф3 / ADR-005: HTTP-ответ на подтверждение (`permission_reply` без WS)
// принимает решение через тот же реестр подтверждений.
import type { ApprovalRegistry, PendingApproval } from '../../engine/permission/approval.js';
import type { AuthorityPrincipal } from '@itphx/synth-shared';
// PROP-141 (Часть D): единая модель переноса сессии между проектами —
// сервис (единственный шов: блокеры, согласие, порядок эффектов).
import {
  SessionMoveError,
  type SessionMoveConsent,
  type SessionMoveResult,
  type SessionMoveService,
} from '../../sessions/move-service.js';

const LOCAL_USER_ID = 'local';

/**
 * Размер страницы списка сессий по умолчанию и максимум.
 * Решение владельца: список сессий **всегда пагинируется** — полный список
 * (тем более с историей) на больших инстансах давал пик heap и OOM.
 */
export const DEFAULT_SESSIONS_LIMIT = 100;
export const MAX_SESSIONS_LIMIT = 500;

/**
 * Размер страницы истории сообщений по умолчанию и максимум
 * (`GET /api/v2/sessions/:id/messages`).
 */
export const DEFAULT_MESSAGES_LIMIT = 200;
export const MAX_MESSAGES_LIMIT = 500;

/**
 * Ключ порядка истории для пагинации: значение, по которому сравниваются
 * «старше/новее» сообщения.
 */
type MessagePageKey = (message: Message, index: number) => number;

/**
 * Выбирает пригодный ключ порядка истории.
 *
 * Штатно это `seq` (позиционный номер, строго возрастает по массиву истории).
 * В legacy-сессиях (до миграции ADR-118) `seq` не уникален и не монотонен:
 * часть сообщений имеет `seq = 0`/`NaN` вперемешку с нормальными номерами.
 * Курсор по такому `seq` «залипал» на `next_before = 0`, следующий запрос
 * `before=0` отдавал пустую страницу, и кнопка «Загрузить старые» исчезала.
 * Поэтому ключ выбирается по фактическим данным: `seq` → `ord` (монотонный
 * счётчик записи, ADR-118) → позиция в массиве (`0..n-1`).
 */
function resolveMessagePageKey(messages: Message[]): MessagePageKey {
  const numeric = (value: number | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  /** Ключ пригоден, только если он есть у всех и строго возрастает по истории. */
  const monotonic = (pick: (message: Message) => number | undefined): boolean => {
    for (let i = 0; i < messages.length; i += 1) {
      const value = pick(messages[i]!);
      if (!numeric(value)) return false;
      if (i > 0) {
        const previous = pick(messages[i - 1]!);
        if (!numeric(previous) || value <= previous) return false;
      }
    }
    return true;
  };
  if (messages.length > 0) {
    if (monotonic((message) => message.seq)) {
      return (message) => message.seq!;
    }
    if (monotonic((message) => message.ord)) {
      return (message) => message.ord!;
    }
  }
  // Позиция в массиве уникальна и возрастает всегда.
  return (_message, index) => index;
}

/**
 * Страница истории сообщений (`GET /api/v2/sessions/:id/messages`).
 *
 * Без `before` отдаётся **последняя** страница (самые новые), с `before` —
 * страница строго старше курсора.
 *
 * `before`/`next_before` — **непрозрачный** для клиента курсор: это значение
 * выбранного ключа (`seq`/`ord`/позиция), а не обязательно `seq`. Клиент
 * обязан возвращать ровно то, что получил в `next_before`.
 *
 * - `has_more` — есть ещё более старые сообщения за пределами страницы;
 * - `next_before` — курсор следующей (более старой) страницы: ключ первой
 *   записи текущей страницы; `null`, если более старых сообщений нет.
 * - `startIndex` — позиция первой записи страницы в **полной** истории
 *   (нужно для `index` в DTO — клиент склеивает страницы). Страница — префикс
 *   истории, поэтому позиционная формула сохраняется.
 */
function selectMessagePage(
  messages: Message[],
  limit: number,
  before: number | undefined,
): { page: Message[]; hasMore: boolean; nextBefore: number | null; startIndex: number } {
  const keyOf = resolveMessagePageKey(messages);
  // Без курсора — вся история; с курсором — только строго более старые.
  const eligible = messages
    .map((message, index) => ({ message, key: keyOf(message, index) }))
    .filter((entry) => before === undefined || entry.key < before);
  const startIndex = Math.max(0, eligible.length - limit);
  const page = eligible.slice(startIndex);
  const hasMore = page.length < eligible.length;
  const nextBefore = hasMore && page.length > 0 ? page[0]!.key : null;
  return { page: page.map((entry) => entry.message), hasMore, nextBefore, startIndex };
}

/** Дефолтные лимиты заметок сессии (совпадают со схемой `stickyNotesLimitsSchema`). */
const DEFAULT_STICKY_NOTE_LIMITS: StickyNotesLimits = { maxCount: 50, maxChars: 2000 };

/**
 * DTO ожидающего подтверждения (ADR-029) — восстановление полосы
 * подтверждения после перезагрузки страницы.
 *
 * Формат — **snake_case, как payload события `permission.asked`**
 * (`approval_id`/`tool`/`arguments`/`reason`/`ask_timeout_ms`), чтобы клиент
 * переиспользовал разбор карточки. Дополнительно:
 * - `asked_at` — ISO-8601 момент публикации запроса (от него клиент считает
 *   остаток таймера: `asked_at + ask_timeout_ms`);
 * - `held` — пользователь нажал «Остановить таймер» (`permission.hold`):
 *   запрос живёт до ответа, таймер не ставится.
 *
 * `preview`/`save` — **только если они есть** в запросе (аддитивно, как в
 * событии `permission.asked`).
 *
 * `trigger` — структурная причина ask'а («виновник»): machine-readable id
 * сообщения + параметры; аддитивно, поле появляется только если оно есть.
 */
function toPendingPermissionDto(pending: PendingApproval): Record<string, unknown> {
  const { request } = pending;
  return {
    approval_id: request.approvalId,
    tool: request.toolName,
    arguments: request.arguments,
    reason: request.reason,
    asked_at: pending.askedAt,
    ask_timeout_ms: pending.timeoutMs,
    held: pending.held,
    ...(request.preview ? { preview: request.preview } : {}),
    ...(request.save ? { save: request.save } : {}),
    ...(request.commands ? { commands: request.commands } : {}),
    ...(request.saveDirectories ? { saveDirectories: request.saveDirectories } : {}),
    ...(request.trigger ? { trigger: request.trigger } : {}),
    // ADR-029: ожидание, восстановленное после рестарта инстанса: отвечающего
    // waiter'а уже нет, поэтому ответ применяется как **грант в сессии**, а не
    // будит прежний вызов. Таймера после рестарта нет (`held: true`) — запрос
    // живёт до ответа.
    ...(pending.restored ? { restored: true } : {}),
  };
}

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
  /**
   * ADR-111 §detach: авто-перевод блокирующих прогонов в фон при
   * вмешательстве пользователя (steer/interrupt, сообщение в очередь занятой
   * сессии). Шов для тестов; по умолчанию — `autoDetachOnSteer` с живым
   * мастер-выключателем оркестратора (`background.enabled`).
   */
  autoDetachOnSteer?: (req: {
    sessionId: string;
    enabled: boolean;
  }) => Promise<ActiveRunDetachResult>;
  contextOptimizer?: ContextOptimizer;
  projectStore?: ProjectStoreLike;
  /**
   * Рабочий каталог по умолчанию (`env SYNTH_DEFAULT_WORKSPACE` → config →
   * `{dataDir}/workspaces/default`). Фоллбек для сессии **без проекта**:
   * `!`-запуск в оркестраторе резолвит декларации из него же, поэтому реестр
   * скриптов (`GET /:id/scripts`) обязан смотреть туда же — иначе скрипт
   * запускается, а автокомплит его не видит.
   */
  defaultWorkingDir?: string;
  /**
   * PROP-135 Ф6a: каталог профилей исполнения (`execution.remote`).
   *
   * Задан — `PATCH /:id { settings: { executorProfile } }` проверяет
   * существование профиля в каталоге (иначе `400 VALIDATION_ERROR`). Не задан
   * (inline/instance-пул) — проверка существования пропускается, значение
   * сохраняется как раньше. Потолки (`project.executor.allowedProfiles` /
   * `agentDefinition.allowedProfiles`) проверяет binding хода: запрещённый
   * профиль не выбирается (fail-closed, откат на `defaultProfile`).
   */
  executionProfileCatalog?: ExecutionProfileCatalog;
  /**
   * PROP-135 (браузерный контур): каталог браузерных профилей
   * (`execution.remote.browserProfiles`; пусто → `[browserProfile]`) —
   * валидация `settings.browserProfile` (PATCH /:id). Не задан — проверка
   * существования пропускается.
   */
  browserProfileCatalog?: ExecutionProfileCatalog;
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
   * Единый реестр фоновых прогонов (ADR-111/ADR-113).
   *
   * «Стоп» (`POST /:id/abort`) его **не** использует: прерывается только
   * активный ход (решение 2026-10-31), фоновые прогоны живут и останавливаются
   * отдельно (`POST /api/v2/processes/:id/stop`, «Стоп» дочерней сессии).
   * Опция остаётся в контракте фабрики — проводка сборки (`deps.ts`) общая.
   */
  backgroundService?: BackgroundRunService;
  /**
   * ADR-114: сервис worktree — привязка сессии к worktree
   * (`PATCH /api/v2/sessions/:id { worktreeId }`).
   *
   * Не задан — поле `worktreeId` в PATCH игнорируется (привязка недоступна).
   */
  worktreeService?: WorktreeService;
  /**
   * PROP-141 (Часть D): единая модель переноса сессии между проектами.
   *
   * Сервис — единственный шов: проверка блокеров, разбор согласия
   * (`move_consent`), детерминированный порядок эффектов и перенос поддерева
   * сессий. Не задан (деградированный инстанс) — смена проекта выполняется
   * прежним путём (под локом, без проверки привязанного состояния).
   */
  moveService?: SessionMoveService;
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
    /**
     * Настройки вложений: статический снимок **или** резолвер (runtime-настройки
     * из админки применяются на каждый вызов, ADR-115).
     */
    config: AttachmentsConfig | (() => AttachmentsConfig);
    /**
     * ADR-115: провайдер серверных миниатюр (`?variant=thumb`). Задан —
     * `AttachmentService.upload` генерирует миниатюру асинхронно.
     */
    thumbnails?: AttachmentThumbnailProvider;
  };
  /**
   * ADR-106 Ф3: реестр подтверждений — ответ на запрос подтверждения
   * (`POST /:id/permissions/:approvalId`) принимает только носитель
   * покрывающего гранта. Не задан — слой Authority выключен/в shadow,
   * поведение прежнее (ответ принимается по факту доступа к сессии).
   */
  approvalRegistry?: ApprovalRegistry;
  /**
   * Проверка доступности пары провайдер/модель **до постановки в очередь**
   * (`POST /:id/prompt`). Не задана — проверка выключена (обратная
   * совместимость и герметичные тесты). `undefined` из метода — записи в
   * каталоге нет, не блокируем (каталог может быть неполным/удалённым).
   */
  llmAvailability?: {
    isProviderEnabled?: (name: string) => boolean | undefined;
    isModelEnabled?: (provider: string, model: string) => boolean | undefined;
  };
  /**
   * ADR-126 §4: сервис сниппетов (`#`) — раскрытие `#токен` в **пользовательском**
   * тексте на входе промпта (до очереди и до LLM).
   *
   * Не задан — раскрытия нет (текст уходит как есть).
   */
  snippetService?: SnippetService;
  /**
   * ADR-126 §4: абсолютный рабочий каталог проекта по id — для project-уровня
   * сниппетов. Резолв — тот же, что в snippet-routes (относительный workspace
   * — от `workspacesRoot`, абсолютный — как есть).
   */
  resolveProjectWorkspace?: (projectId: string) => Promise<string | undefined>;
  /**
   * ADR-126 §5: сервис реестра скриптов проекта (`!`-запуск) — HTTP-контур
   * `/api/v2/sessions/:id/scripts*` (список/детали/запуск).
   *
   * Не задан — контура нет (деградированное хранилище: фоновые процессы не
   * создаются — запускать некуда).
   */
  scriptService?: ScriptService;
  /**
   * ADR-126 §5: правила прав инстанса — fallback для правила
   * `permission.rules.script` (собственные правила сессии важнее).
   */
  permissionConfig?: PermissionConfig;
  /**
   * ADR-136: журнал исполнений команд — запись `script.run` (только
   * метаданные: имя скрипта, cwd, число аргументов, origin).
   */
  commandAudit?: CommandAuditLog;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы по умолчанию. */
export interface SessionRouteMessages {
  sessionNotFound: (c: Context) => string;
  /** `GET /:id/messages/:messageId` — сообщения с таким id в сессии нет (404). */
  messageNotFound: (c: Context) => string;
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
  /** ADR-115: вложения выключены администратором (`attachments.enabled=false`). */
  attachmentsDisabled: (c: Context) => string;
  /** ADR-115: семейство MIME выключено в `attachments.modalities`. */
  attachmentsModalityDisabled: (c: Context, mime: string) => string;
  /** ADR-115: вложений больше, чем `attachments.maxFilesPerMessage`. */
  attachmentsLimitExceeded: (c: Context, max: number) => string;
  /** ADR-115: превышена квота сессии `attachments.maxBytesPerSession`. */
  tooLarge: (c: Context) => string;
  /** ADR-111 §detach: неизвестный `type` в теле перевода в фон (400 `VALIDATION_ERROR`). */
  detachInvalidType?: (c: Context) => string;
  /** ADR-111 §detach: перевод в фон в этой сборке не поддержан (400 `DETACH_UNSUPPORTED`). */
  detachUnsupported?: (c: Context) => string;
  /** Невалидный ответ на подтверждение: неизвестный `action` или пустой `approvalId` (400). */
  permissionInvalid: (c: Context) => string;
  /** Отказ реестра подтверждений (403 `APPROVAL_DENIED`): ответ не принят. */
  permissionDenied: (c: Context, reason: string) => string;
  /** Заметки с таким id в сессии нет (404 `NOT_FOUND`). */
  noteNotFound: (c: Context) => string;
  /** Лимит заметок сессии исчерпан (409 `LIMIT_EXCEEDED`), `max` — предел инстанса. */
  noteLimitReached: (c: Context, max: number) => string;
  /** Текст заметки длиннее `maxChars` (400 `VALIDATION_ERROR`), `max` — предел инстанса. */
  noteTooLong: (c: Context, max: number) => string;
  /** Провайдер отключён администратором (400 `PROVIDER_DISABLED`). */
  providerDisabled: (c: Context, provider: string) => string;
  /** Модель отключена администратором (400 `MODEL_DISABLED`). */
  modelDisabled: (c: Context, provider: string, model: string) => string;
  /**
   * ADR-126 §2: `@user` недоступен/неизвестен (400 `VALIDATION_ERROR`).
   * Перечень проблемных id — в `details.user_ids`.
   */
  unknownMentionUsers?: (c: Context, userIds: string[]) => string;
  /** ADR-126 §2: поле `mentions` в теле промпта невалидно по форме. */
  invalidMentions?: (c: Context) => string;
  /** ADR-126 §2: `@file` не разрешён/не прочитан (400 `VALIDATION_ERROR`). */
  invalidFileMentions?: (c: Context, paths: string[], reasons: string[]) => string;
  /**
   * PROP-132: поле `context` тела промпта невалидно (400 `VALIDATION_ERROR`).
   * `reason` — понятная причина отказа от разбора контекста.
   */
  terminalContextInvalid?: (c: Context, reason: string) => string;
  /**
   * PROP-132: контекст терминала вместе с `mode=interrupt` (400
   * `VALIDATION_ERROR`) — контекст нельзя вклинить перед interrupt-сообщением.
   */
  terminalContextWithInterrupt?: (c: Context) => string;
  /**
   * PROP-142 §1: вложения в продолжении дочерней сессии саб-агента не
   * поддержаны (400 `VALIDATION_ERROR`).
   */
  attachmentsToSubagentChild?: (c: Context) => string;
  /**
   * PROP-142 §3.7: ручной повтор восстановления, пока сессия занята
   * (409 `LOCKED`).
   */
  recoveryLocked?: (c: Context) => string;
}

export interface SessionRoutesOptions {
  /** userId запроса. Core — 'local'; backend — user.id. */
  resolveUserId?: (c: Context) => string | Promise<string>;
  /**
   * ADR-140 Ф2: **группы** пользователя запроса (снимок claim'а IdP).
   *
   * Группы кладутся в принципал хода **при приёме ввода** (ADR-106 Ф4) —
   * снимок: пересчёт в середине хода недопустим. Отдаёт `undefined`/пусто —
   * групп нет (fail-closed, гранты по группам не применяются).
   *
   * Core standalone — опция не задана (групп нет). Backend — `groupsOf(user)`.
   */
  resolveUserGroups?: (c: Context) => readonly string[] | undefined;
  /** Владелец при создании сессии. По умолчанию — resolveUserId(). */
  resolveOwner?: (c: Context) => string | Promise<string>;
  /** Передавать владельца в forkSession. Core — false; backend — true. */
  forkWithOwner?: boolean;
  /** Доступ к содержимому сессии (status/prompt/stats). Core — local-owner; backend — owner|ADMIN. */
  canAccess?: (session: Session, c: Context, userId: string) => boolean | Promise<boolean>;
  /** author пользовательских сообщений. Core — 'local'; backend — username. */
  resolveAuthor?: (c: Context) => string | Promise<string>;
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
  messages?: Partial<SessionRouteMessages>;
  /**
   * ADR-126 §5: тексты HTTP-контура скриптов (`/sessions/:id/scripts*`) —
   * backend передаёт i18n-функции, core — русские литералы по умолчанию.
   */
  scriptMessages?: Partial<SessionScriptRouteMessages>;
  /**
   * Instance-wide лимиты заметок сессии (`context.stickyNotes`): максимум
   * заметок и символов в заметке. Резолвер читается при каждой операции с
   * заметкой — runtime-настройка админки применяется без рестарта.
   * Не задан — константы схемы 50/2000.
   */
  getStickyNoteLimits?: () => StickyNotesLimits;
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
  /**
   * Принципал, отвечающий на запрос подтверждения (ADR-106 Ф3) — **аутентифицированный**
   * пользователь запроса, а не присланный клиентом. Backend передаёт роли
   * пользователя, core — локального пользователя с ролью `ADMIN`.
   */
  resolvePermissionResponder?: (c: Context) => AuthorityPrincipal | Promise<AuthorityPrincipal>;
}

const DEFAULT_MESSAGES: SessionRouteMessages = {
  sessionNotFound: () => 'Сессия не найдена',
  messageNotFound: () => 'Сообщение не найдено',
  forbidden: () => 'Доступ к сессии запрещён',
  contentRequired: () => 'Контент обязателен',
  queueFull: (_c: Context, max: number) => `Очередь сообщений заполнена (макс. ${max})`,
  steerLimitExceeded: (_c: Context, max: number) =>
    `Достигнут лимит вмешательств в ход (макс. ${max} сообщений на ход)`,
  invalidAttachments: () => 'Поле attachments должно быть массивом непустых путей объектов',
  attachmentsInvalid: (_c: Context, paths: string[]) =>
    `Вложения не найдены или недопустимы: ${paths.join(', ')}`,
  attachmentsUnavailable: () => 'Вложения не поддерживаются в этой сборке',
  attachmentsDisabled: () => 'Вложения отключены администратором',
  attachmentsModalityDisabled: (_c: Context, mime: string) =>
    `Категория вложений для типа ${mime} отключена в настройках`,
  attachmentsLimitExceeded: (_c: Context, max: number) =>
    `Слишком много вложений в сообщении (макс. ${max})`,
  tooLarge: () => 'Суммарный объём вложений сессии превышает допустимый',
  detachInvalidType: () => 'Неизвестный тип блокирующего прогона (ожидается subagent или process)',
  detachUnsupported: () => 'Перевод идущего прогона в фон в этой сборке не поддерживается',
  permissionInvalid: () => 'Невалидный ответ на подтверждение: ожидается action = allow | deny | hold',
  permissionDenied: (_c: Context, reason: string) => `Подтверждение не принято: ${reason}`,
  noteNotFound: () => 'Заметка не найдена',
  noteLimitReached: (_c: Context, max: number) => `Достигнут лимит заметок сессии (макс. ${max})`,
  noteTooLong: (_c: Context, max: number) => `Текст заметки слишком длинный (макс. ${max} символов)`,
  providerDisabled: (_c: Context, provider: string) =>
    `Провайдер «${provider}» отключён — выберите другую модель`,
  modelDisabled: (_c: Context, provider: string, model: string) =>
    `Модель ${provider}/${model} отключена — выберите другую модель`,
  unknownMentionUsers: (_c: Context, userIds: string[]) =>
    `Упомянутые пользователи недоступны: ${userIds.join(', ')}`,
  invalidMentions: () => 'Поле mentions должно быть массивом упоминаний корректной формы',
  invalidFileMentions: (_c: Context, paths: string[], reasons: string[]) =>
    `Не удалось прочитать файлы: ${paths.map((path, index) => `${path} (${reasons[index] ?? 'error'})`).join(', ')}`,
  terminalContextInvalid: (_c: Context, reason: string) => reason,
  terminalContextWithInterrupt: () =>
    'Контекст терминала нельзя отправлять вместе с mode=interrupt',
  attachmentsToSubagentChild: () =>
    'Вложения в дочернюю сессию саб-агента не поддерживаются',
  recoveryLocked: () => 'Сессия занята — повтор восстановления невозможен',
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

/**
 * PROP-142 §2: тело `POST /:id/resume-subagent` — необязательные указания
 * продолжения: `{prompt?, model?, provider?}`.
 *
 * Пустое тело — «никаких указаний» (прежнее поведение: только маркер resume).
 * Невалидный тип поля — 400 `VALIDATION_ERROR`: молча игнорировать нельзя
 * (клиент думает, что пара сменилась, а прогон пошёл со старой).
 */
export type SubagentResumeBody = {
  /** Новые указания для ребёнка (текст) — обычное user-сообщение в его истории. */
  prompt?: string;
  /** Новая модель прогона ребёнка. */
  model?: string;
  /** Новый провайдер прогона ребёнка. */
  provider?: string;
};

/**
 * Разбор тела resume-subagent. `null` — тело невалидно (400).
 * Пустая строка — «указание не задано» (поле игнорируется, как отсутствующее).
 */
function parseSubagentResumeBody(body: unknown): SubagentResumeBody | null {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const result: SubagentResumeBody = {};
  const prompt = record.prompt;
  if (prompt !== undefined && prompt !== null) {
    if (typeof prompt !== 'string') return null;
    result.prompt = prompt;
  }
  const model = record.model;
  if (model !== undefined && model !== null) {
    if (typeof model !== 'string') return null;
    result.model = model;
  }
  const provider = record.provider;
  if (provider !== undefined && provider !== null) {
    if (typeof provider !== 'string') return null;
    result.provider = provider;
  }
  return result;
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
 * ADR-135 (аддендум): потолки профилей сессии — агент (по роли) ∩ проект.
 *
 * Список, **заданный** областью, — потолок (пустой = «профилей нет»); не
 * заданный — ограничения от области нет. Эффективный потолок — пересечение
 * заданных списков; ни один не задан — потолка нет (`undefined`).
 */
interface SessionProfileCeilings {
  execAllowed?: string[];
  browserAllowed?: string[];
}

/** Пересечение двух списков потолка (`undefined` — ограничения нет). */
function intersectCeilings(
  agent: readonly string[] | undefined,
  project: readonly string[] | undefined,
): string[] | undefined {
  if (agent === undefined && project === undefined) return undefined;
  const base = agent ?? project ?? [];
  const other = agent === undefined ? project : agent;
  if (other === undefined) return [...base];
  return base.filter((name) => other.includes(name));
}

/**
 * Потолки профилей сессии: агент (по `settings.agentRole`, с алиасами прежнего
 * набора ролей) и проект сессии. Недоступные источники (нет реестра/стора,
 * ошибка чтения) — ограничения не добавляют (fail-closed на неизвестном
 * запрете не ломает правку сессии).
 */
async function resolveSessionProfileCeilings(
  session: Session,
  deps: SessionRoutesDeps,
): Promise<SessionProfileCeilings> {
  let agentAllowed: string[] | undefined;
  let agentBrowserAllowed: string[] | undefined;
  const registry = deps.orchestrator?.agentRegistry ?? null;
  const role = session.settings.agentRole;
  if (registry && role) {
    const found = registry.get(role)
      ?? (resolveAgentRoleAlias(role) ? registry.get(resolveAgentRoleAlias(role)!) : undefined);
    agentAllowed = found?.allowedProfiles;
    agentBrowserAllowed = found?.allowedBrowserProfiles;
  }
  let projectAllowed: string[] | undefined;
  let projectBrowserAllowed: string[] | undefined;
  if (deps.projectStore && session.projectId) {
    try {
      const project = await deps.projectStore.load(session.projectId);
      projectAllowed = project?.executor?.allowedProfiles;
      projectBrowserAllowed = project?.executor?.allowedBrowserProfiles;
    } catch {
      // Проект недоступен — ограничения проекта не применяются.
    }
  }
  return {
    execAllowed: intersectCeilings(agentAllowed, projectAllowed),
    browserAllowed: intersectCeilings(agentBrowserAllowed, projectBrowserAllowed),
  };
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

/**
 * ADR-118 §3: нормализация клиентского `messageId` — единая точка для
 * standalone- и hybrid-ветки приёма. Не строка, пустая строка или одни
 * пробелы → пусто (вызывающий выдаёт серверный id); иначе — обрезанное значение.
 */
function normalizeClientMessageId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
 * PROP-141 (Часть D): разбор согласия на последствия переноса сессии.
 *
 * Флаги явные: «согласиться на всё» одним `force` нельзя. Необъектное
 * значение — `'invalid'` (роут отвечает 400), `undefined`/`null` — согласия
 * нет (перенос без согласия блокируется при блокерах).
 */
function parseMoveConsent(raw: unknown): SessionMoveConsent | 'invalid' | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const value = raw as Record<string, unknown>;
  const result: SessionMoveConsent = {};
  if (value.stop_running !== undefined) {
    if (typeof value.stop_running !== 'boolean') return 'invalid';
    result.stop_running = value.stop_running;
  }
  if (value.cancel_automations !== undefined) {
    if (typeof value.cancel_automations !== 'boolean') return 'invalid';
    result.cancel_automations = value.cancel_automations;
  }
  return result;
}

/**
 * PROP-132: снять контекст терминала из очереди инъекций (`steerInbox`).
 *
 * Контекст ставится в `steerInbox` **первым** (ADR-104), вопрос — следом. Если
 * вопрос отклонён (лимит инъекций на ход), контекст снимается: иначе в ходе
 * остался бы вывод терминала без вопроса, к которому он относится.
 *
 * Публикуется `steer.dropped` (причина `limit`) — тот же контракт, что у
 * отклонённой инъекции (`queue/processor.ts`).
 */
async function dropTerminalContextFromSteer(
  sessionManager: SessionManager,
  eventBus: EventBus,
  sessionId: string,
  contextMessage: Message,
): Promise<void> {
  try {
    // Очередь инъекций — метаданные: точечная правка под локом порта, история
    // не перезаписывается (параллельная дозапись сообщений не теряется).
    // `updatedAt` двигаем (паритет с прежним явным `s.updatedAt = nowISO()`).
    const result = await sessionManager.mutateMeta(sessionId, (meta) => {
      const inbox = meta.steerInbox ?? [];
      const next = inbox.filter((m) => m.id !== contextMessage.id);
      if (next.length === inbox.length) return null;
      meta.steerInbox = next;
      // Счётчики очереди изменились — `queue.state` (иначе панель очереди в UI
      // показала бы лишнюю инъекцию).
      return queueCounts(meta);
    }, { shouldWrite: (state) => state !== null });
    // Сессия исчезла — снимать нечего (прежний ранний выход из `withLock`).
    if (!result.found) return;
    if (result.value) {
      publishQueueState(eventBus, sessionId, result.value);
    }
  } catch {
    // Сессия исчезла — снимать нечего (ошибка не должна ломать ответ 429).
    return;
  }
  eventBus.publish(sessionId, 'steer.dropped', {
    reason: 'limit',
    code: STEERING_ERROR_CODES.limitExceeded,
    limit: MAX_STEER_INJECTIONS_PER_TURN,
    dropped_count: 1,
    error: sm('steer.limit_exceeded', { limit: String(MAX_STEER_INJECTIONS_PER_TURN) }),
    i18n: i18nMeta('steer.limit_exceeded', { limit: String(MAX_STEER_INJECTIONS_PER_TURN) }),
  });
}

/**
 * PROP-132: откатить контекст терминала из истории сессии.
 *
 * Контекст пишется в историю **до** вопроса (контракт — «контекст раньше
 * вопроса»). Если вопрос не принят (очередь полна), контекст снимается: иначе
 * в истории остался бы вывод терминала без вопроса. Публикуется
 * `message.deleted` — мутация адресуется по `id` (ADR-118 §7).
 *
 * @internal Экспорт — для тестов (путь достижим только из приёма промпта).
 */
export async function dropTerminalContextFromHistory(
  sessionManager: SessionManager,
  eventBus: EventBus,
  sessionId: string,
  contextMessage: Message,
): Promise<void> {
  let removed = false;
  try {
    // Правка истории — точечная (`mutateHistory`): свежий документ читается под
    // локом порта, параллельная дозапись сообщений не теряется. `updatedAt`
    // двигается (паритет с прежним явным `s.updatedAt = nowISO()`); контекста в
    // истории уже нет — записи нет (`shouldWrite`).
    const result = await sessionManager.mutateHistory(sessionId, (s) => {
      const next = s.messages.filter((m) => m.id !== contextMessage.id);
      if (next.length === s.messages.length) return false;
      s.messages = next;
      return true;
    }, { shouldWrite: (changed) => changed });
    removed = result.ok && result.value;
  } catch {
    // Сессия исчезла — откатывать нечего (ошибка не должна ломать ответ 429).
    return;
  }
  // Ничего не удалено (контекста в истории нет) — событий нет: иначе клиенты
  // убрали бы из ленты сообщение, которое там осталось.
  if (!removed) return;
  eventBus.publish(sessionId, 'message.deleted', { message_id: contextMessage.id });
  const fresh = await sessionManager.getSession(sessionId).catch(() => null);
  if (fresh) eventBus.publish(sessionId, 'session.updated', serializeSession(fresh));
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
/**
 * ADR-126 §2: собрать доступных для `@user` участников и разбить текст на
 * агентскую часть и пользовательский хвост.
 *
 * Участники выводятся из сессии/проекта (`deriveSessionParticipants`), профиль
 * добавляет username/displayName; общий список пользователей не раскрывается.
 */
async function resolveSessionUserMentions(
  session: Session,
  text: string,
  body: unknown,
  deps: SessionRoutesDeps,
): Promise<UserMentionSplit & { malformed: boolean }> {
  const project = session.projectId && deps.projectStore
    ? await deps.projectStore.load(session.projectId).catch(() => null)
    : null;
  const participants = deriveSessionParticipants(session, project);
  const users = await resolveMentionableUsers(participants, deps.profilesStore);
  const explicit = validateExplicitMentions(
    (body as { mentions?: unknown } | null | undefined)?.mentions,
    users,
  );
  const split = resolveUserMentionSplit({ text, users, explicit });
  return { ...split, malformed: explicit.malformed };
}

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

  /**
   * ADR-111 §detach: авто-перевод блокирующих прогонов в фон при вмешательстве
   * пользователя (steer/interrupt) и при сообщении в занятую сессию (queue).
   *
   * Мастер-выключатель (`background.enabled`) читается **живым** геттером
   * оркестратора: runtime-настройка действует без рестарта. Ошибка перевода не
   * пробрасывается — приём сообщения важнее (причина уходит в лог).
   */
  const detachBlockingRuns = async (sessionId: string): Promise<void> => {
    const enabled = typeof orchestrator.isBackgroundEnabled === 'function'
      ? orchestrator.isBackgroundEnabled()
      : true;
    try {
      if (deps.autoDetachOnSteer) {
        await deps.autoDetachOnSteer({ sessionId, enabled });
        return;
      }
      // Реестра активных прогонов нет (минимальный оркестратор в тестах/иной
      // сборке) — переводить нечего.
      if (!orchestrator.activeRuns) return;
      await autoDetachOnSteer({ orchestrator, sessionId, enabled, eventBus });
    } catch (err) {
      warning('ROUTES', `авто-detach при вмешательстве не удался: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const resolveClient = (): RemoteBackendClient | undefined => deps.getRemoteClient?.() ?? undefined;
  /** Гибридные ветки активны только если геттер передан (в managed — нет). */
  const hasRemoteGetter = deps.getRemoteClient !== undefined;

  /**
   * Гибрид (ADR-042): выполнить панельный запрос к удалённой сессии.
   *
   * Возвращает готовый Response (ответ или ошибка удалённой стороны) либо
   * `null` — запрос локальный. Ветка активна только при переданном
   * `getRemoteClient` (managed backend его не передаёт, поведение прежнее).
   * `run` получает **локальный** id (без `remote:`); `map` переписывает id
   * ответа в `remote:` (инвариант 7).
   */
  const forwardRemoteSession = async (
    c: Context,
    id: string,
    run: (client: RemoteBackendClient, localId: string) => Promise<unknown>,
    map?: (result: unknown) => unknown,
    status: 200 | 201 | 202 | 204 = 200,
  ): Promise<Response | null> => {
    if (!hasRemoteGetter || !isRemoteRef(id)) return null;
    const remoteClient = resolveClient();
    if (!remoteClient) {
      return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
    }
    try {
      const result = await run(remoteClient, toLocalId(id));
      if (status === 204) return c.body(null, 204);
      return c.json((map ? map(result) : result) as never, status);
    } catch (err) {
      const mapped = mapRemoteError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  };

  const resolveUserId = opts.resolveUserId ?? (() => LOCAL_USER_ID);
  /**
   * ADR-140 Ф2: группы пользователя запроса (снимок claim'а IdP). Фабрика
   * кладёт их в принципал хода **при приёме ввода** — дальше группы не
   * пересчитываются (снимок, ADR-106 Ф4). Не задана — групп нет (fail-closed).
   */
  const resolveUserGroups = opts.resolveUserGroups ?? (() => [] as readonly string[]);
  const resolveOwner = opts.resolveOwner ?? resolveUserId;
  const forkWithOwner = opts.forkWithOwner ?? false;
  const resolveAuthor = opts.resolveAuthor ?? (() => LOCAL_USER_ID);
  const resolveDefaultAgent = opts.resolveDefaultAgent ?? (() => DEFAULT_AGENT_ID);
  const publishRenamed = opts.publishRenamed ?? true;
  const publishDeletedBefore = opts.publishDeletedBefore ?? true;
  const promptMiddleware = opts.promptMiddleware ?? [];
  const forkMiddleware = opts.forkMiddleware ?? [];
  const mergeMiddleware = opts.mergeMiddleware ?? [];
  const messages: SessionRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  /** Лимиты заметок инстанса (`context.stickyNotes`); по умолчанию — 50/2000. */
  const getStickyNoteLimits = opts.getStickyNoteLimits ?? (() => DEFAULT_STICKY_NOTE_LIMITS);
  const resolveAuthorName = createResolveAuthorName(deps.profilesStore);
  /**
   * Принципал ответа на подтверждение по умолчанию (standalone): единственный
   * локальный пользователь, роль `ADMIN` (как и весь core-режим). Backend
   * передаёт реального пользователя и его роли (`opts.resolvePermissionResponder`).
   */
  const defaultPermissionResponder = async (c: Context): Promise<AuthorityPrincipal> => ({
    kind: 'user',
    id: (await resolveUserId(c)) || LOCAL_USER_ID,
    roles: ['ADMIN'],
    groups: [...(resolveUserGroups(c) ?? [])],
  });
  // ADR-052 (этап I): scope-гейты service-key и проектная проекция сессии.
  const scoped = opts.scopeGuard ?? requireScope;
  const serviceProjectProjection = opts.serviceProjectProjection ?? checkServiceProjectProjection;

  /**
   * ADR-114 §5.2: резолв записи worktree для привязки сессии.
   *
   * Запись чужого проекта выглядит как отсутствующая (существование не
   * выдаётся). Резолв вынесен из тела PATCH: при переносе проекта запись
   * ищется **до** переноса (проект-цель известен из запроса), иначе неудачная
   * привязка откатила бы уже выполненный перенос.
   */
  const resolveWorktreeBinding = async (
    projectId: string | undefined,
    worktreeId: string,
  ): Promise<
    | { binding: SessionWorktree }
    | { error: { status: 400 | 404 | 409; code: string; message: string } }
  > => {
    if (!projectId) {
      return {
        error: {
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Привязать worktree можно только сессии с проектом',
        },
      };
    }
    if (!deps.worktreeService) {
      return {
        error: {
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Привязка к worktree в этом инстансе недоступна',
        },
      };
    }
    const summaries = await deps.worktreeService.list(projectId);
    const found = summaries.find((item) => item.id === worktreeId);
    if (!found) {
      return { error: { status: 404, code: 'WORKTREE_NOT_FOUND', message: 'Worktree не найден' } };
    }
    if (found.exists === false) {
      return {
        error: {
          status: 409,
          code: 'WORKTREE_DIRECTORY_MISSING',
          message: `Каталог worktree не найден: ${found.directory}`,
        },
      };
    }
    return {
      binding: {
        worktreeId: found.id,
        projectId: found.projectId,
        ...(found.repoPath !== undefined ? { repoPath: found.repoPath } : {}),
        directory: found.directory,
        branch: found.branch,
      },
    };
  };

  /**
   * ADR-126 §2: рабочий каталог сессии для `@file` — привязанный git-worktree
   * (ADR-114) или workspace проекта.
   *
   * Путь проекта резолвится тем же правилом, что и в snippet-routes
   * (`resolveProjectWorkspace` из сборки), иначе относительный workspace
   * смотрелся бы относительно cwd процесса.
   */
  const resolveSessionWorkspace = async (session: Session): Promise<string | undefined> => {
    const worktreeDir = session.worktree?.directory?.trim();
    if (worktreeDir) return worktreeDir;
    const projectWorkspace = await resolveProjectWorkspaceOnly(session);
    // Сессия без проекта: тот же фоллбек, что у `_resolveWorkingDir`
    // оркестратора (`!` резолвит `.synth/scripts` из default workspace).
    return projectWorkspace ?? deps.defaultWorkingDir;
  };

  /**
   * ADR-126 §4: проектные сниппеты — **всегда** workspace проекта, а не
   * worktree сессии (решение владельца 2026-11-14). Сниппет — уровень проекта,
   * а не ветки; trust и редактор в панели «Проект» смотрят на тот же каталог.
   */
  const resolveProjectWorkspaceOnly = async (session: Session): Promise<string | undefined> => {
    const projectId = session.projectId;
    if (!projectId) return undefined;
    if (deps.resolveProjectWorkspace) {
      const resolved = await deps.resolveProjectWorkspace(projectId).catch(() => undefined);
      if (resolved) return resolved;
    }
    const project = await deps.projectStore?.load(projectId).catch(() => null);
    return project?.workspace;
  };

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
   * Сервис собирается здесь: blob-порт + учёт ссылок + резолвер настроек
   * (runtime из админки применяется на каждый вызов, без рестарта).
   */
  const resolveAttachmentConfig = (): AttachmentsConfig => {
    const source = deps.attachments!.config;
    return typeof source === 'function' ? source() : source;
  };
  const attachmentService = deps.attachments
    ? new AttachmentService({
        blobs: deps.attachments.blobs,
        config: resolveAttachmentConfig,
        ...(deps.attachments.thumbnails ? { thumbnails: deps.attachments.thumbnails } : {}),
      })
    : undefined;
  if (attachmentService) {
    app.route(
      '/',
      createAttachmentRoutes(
        { sessionManager, service: attachmentService, config: resolveAttachmentConfig },
        { messages: { sessionNotFound: messages.sessionNotFound } },
      ),
    );
  }

  /**
   * ADR-130: список задач сессии (ToDo) — точечные HTTP-операции
   * (`/api/v2/sessions/:id/todos*`). Монтируется **внутрь** приложения
   * сессий, то есть под тем же prefix-guard'ом (вид доступа `read`/`write`
   * решает он, инвариант 16). Логика — в доменном сервисе
   * (`engine/todo/service.ts`), тот же, что у инструментов `todo_*`.
   * Гибрид (ADR-042/ADR-130): для `remote:`-сессии запрос форвардится на
   * удалённый backend (права/валидация — там).
   */
  app.route(
    '/',
    createSessionTodoRoutes({
      requireAuth: auth.requireAuth,
      sessionManager,
      eventBus: deps.eventBus,
      getRemoteClient: () => resolveClient() ?? null,
    }),
  );

  /**
   * ADR-126 §5: реестр скриптов проекта (`!`-запуск) — HTTP-контур
   * (`/api/v2/sessions/:id/scripts*`). Монтируется **внутрь** приложения
   * сессий, то есть под тем же prefix-guard'ом (вид доступа `read`/`write`
   * решает он, инвариант 16). Логика запуска — в доменном сервисе
   * (`engine/scripts/service.ts`), тот же, что у тулов `script_list`/
   * `script_run`.
   *
   * Сервиса нет (деградированное хранилище: фоновые процессы не создаются) —
   * контура нет: маршруты не монтируются вовсе (404, как у `/processes`).
   *
   * Гибрид (ADR-042/ADR-126 §5): для `remote:`-сессии запрос форвардится на
   * удалённый backend (права/валидация — там).
   */
  if (deps.scriptService) {
    app.route(
      '/',
      createSessionScriptRoutes(
        {
          requireAuth: auth.requireAuth,
          sessionManager,
          scriptService: deps.scriptService,
          // Рабочий каталог сессии — worktree или workspace проекта (там
          // лежат декларации `.synth/scripts`).
          resolveWorkingDir: resolveSessionWorkspace,
          getRemoteClient: () => resolveClient() ?? null,
          ...(deps.permissionConfig ? { permissionConfig: deps.permissionConfig } : {}),
          ...(deps.commandAudit ? { commandAudit: deps.commandAudit } : {}),
        },
        {
          messages: opts.scriptMessages,
        },
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
  const serializeForReader = async (
    c: Context,
    session: Session,
    userId?: string,
    serializeOpts?: Pick<
      SerializeSessionOptions,
      'includeMessages' | 'includePromptStates' | 'contextOptimizer' | 'pendingApprovals'
    >,
  ) => {
    const canReveal = await resolveCanRevealSecrets(c, session, userId);
    return serializeSession(session, {
      agentRegistry,
      redactSecrets: !canReveal,
      ...serializeOpts,
    });
  };

  /**
   * ADR-029: число ожидающих ответа подтверждений по сессиям.
   *
   * Считается **один раз на запрос** (один проход по реестру ожиданий), а не
   * на каждую сессию страницы. Нужно дереву сессий: после перезагрузки
   * страницы живой стор клиента пуст, а метка «ждёт подтверждения прав»
   * должна остаться (поле DTO `pending_approvals`).
   *
   * Seam не задан (частичный мок оркестратора в тестах) — счётчик пустой,
   * поле `pending_approvals` = 0 (ожиданий нет).
   */
  const pendingApprovalCounts = (): Map<string, number> =>
    orchestrator.listPendingApprovalCounts?.() ?? new Map<string, number>();

  /**
   * ADR-029: число ожиданий подтверждения для DTO сессии (`pending_approvals`).
   *
   * Источник — **менеджер ожиданий** (`PermissionApprovalManager.listPendingCounts`):
   * он считает и живые ожидания (реестр в памяти процесса), и восстановленные
   * после рестарта инстанса (снимок из хранилища ожиданий). Документ сессии
   * в этом не участвует: запись ожидания в него — полная замена истории, а
   * результаты параллельных тулов пишутся точечно (`appendMessage`,
   * ADR-118 §4) → гонка lost update.
   */
  const pendingApprovalCount = (session: Session, liveCounts: Map<string, number>): number =>
    liveCounts.get(session.id) ?? 0;

  /**
   * Ответ списка `GET /`: история сообщений и состояние промпта не отдаются.
   * `listSessions(...)` **всегда лёгкий** (метаданные без истории), а этот DTO
   * не добавляет её обратно. Очередь (`pending_messages`/`pending_count`),
   * статус, `current_stream`, настройки и счётчики сохраняются.
   */
  const LIST_SERIALIZE_OPTS = { includeMessages: false, includePromptStates: false } as const;

  /**
   * Точечный ответ сессии (`GET /:id`, PATCH, create, clear, fork): та же
   * сводка, что и в списке, но без `prompt_states` — история в DTO не нужна
   * (её отдаёт `GET /:id/messages`).
   */
  const SUMMARY_SERIALIZE_OPTS = { includeMessages: false } as const;

  /**
   * Локальная фильтрация списка по project_id. remote-ref (`remote:<uuid>`)
   * фильтровать локально нельзя — его обрабатывает remote-ветка/вызывающая сторона.
   */
  const filterByProject = (items: Session[], projectId?: string): Session[] =>
    projectId && !isRemoteRef(projectId) ? items.filter((s) => s.projectId === projectId) : items;

  /**
   * Страница списка сессий: `{sessions, total, offset, limit, next_offset}`.
   *
   * - `total` — число видимых сессий (после фильтра видимости и `project_id`);
   * - `next_offset` — курсор следующей страницы (`null`, если страница последняя);
   * - `remote_offline` — аддитивный признак offline-деградации гибрида: удалённая
   *   сторона недоступна, в странице только локальный мир (ADR-123).
   */
  const listPage = <T>(
    sessions: T[],
    total: number,
    offset: number,
    limit: number,
    nextOffset: number | null,
    options: { remoteOffline?: boolean } = {},
  ) => ({
    sessions,
    total,
    offset,
    limit,
    next_offset: nextOffset,
    ...(options.remoteOffline ? { remote_offline: true } : {}),
  });

  app.get('/', auth.requireAuth, scoped('sessions:read'), async (c) => {
    const projectId = c.req.query('project_id') || undefined;
    // Пагинация списка (решение владельца): страница по умолчанию 100, максимум
    // 500. Нечисловой/отрицательный `limit`/`offset` → 400 (не молча правим).
    const limit = parseBoundedInt(c.req.query('limit'), DEFAULT_SESSIONS_LIMIT, MAX_SESSIONS_LIMIT);
    if (limit === null) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'limit должен быть целым числом' } }, 400);
    }
    const offset = parseBoundedInt(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER);
    if (offset === null) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'offset должен быть целым числом' } }, 400);
    }
    const userId = await resolveUserId(c);
    // ADR-089: видимость списка. elevated (ADMIN/LEAD) — все сессии; иначе свои
    // личные + сессии проектов-участий (командная видимость).
    const elevated = (await opts.resolveElevated?.(c)) ?? false;
    const memberProjectIds = elevated
      ? []
      : (await opts.resolveMemberProjectIds?.(c, userId)) ?? [];
    let sessions: Session[];
    if (elevated) {
      // Список **всегда лёгкий** (метаданные без истории): список не должен
      // загружать `messages` всех сессий (на больших инстансах это OOM).
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

    // Видимость уже применена менеджером; дальше — фильтр проекта.
    const visible = filterByProject(sessions, projectId);

    // ADR-029: число висящих подтверждений по сессиям — **один раз на запрос**
    // (один проход по реестру ожиданий), не на каждую сессию страницы.
    // Нужно дереву сессий: после перезагрузки страницы живой стор клиента
    // пуст, а метка «ждёт подтверждения прав» должна остаться.
    const pendingCounts = pendingApprovalCounts();
    const serializeLocalPage = (items: Session[]) =>
      Promise.all(
        items.map((s) => serializeForReader(c, s, userId, {
          ...LIST_SERIALIZE_OPTS,
          pendingApprovals: pendingApprovalCount(s, pendingCounts),
        })),
      );

    if (!hasRemoteGetter) {
      // Локальный мир: страница нарезается сразу (сериализуем только страницу).
      const { page, total, next_offset: localNextOffset } = paginate(visible, offset, limit);
      const localDto = await serializeLocalPage(page);
      return c.json(listPage(localDto, total, offset, limit, localNextOffset));
    }

    const remoteClient = resolveClient();

    // Запрос удалённого мира без настроенного гибрида — ошибка, а не локальный список.
    if (projectId && isRemoteRef(projectId) && !remoteClient) {
      return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
    }

    if (!remoteClient) {
      const { page, total, next_offset: localNextOffset } = paginate(visible, offset, limit);
      const localDto = await serializeLocalPage(page);
      return c.json(listPage(localDto, total, offset, limit, localNextOffset));
    }

    try {
      // Гибрид: список **обоих** миров. Удалённая сторона забирается целиком
      // (обход страниц), merge сортируется по времени записи, и только потом
      // нарезается страница — иначе порядок «новые сверху» ломался бы на
      // границе миров, а курсор `next_offset` нельзя было бы выдать.
      const remoteProjectId = projectId && isRemoteRef(projectId) ? toLocalId(projectId) : projectId;
      const remoteAll = await remoteClient.listAllSessions(remoteProjectId);
      // Локальные сессии удалённого проекта не существуют — мир «local» пуст.
      const localList = projectId && isRemoteRef(projectId) ? [] : visible;
      // Фильтр по проекту на клиенте нужен только для remote-ref проекта
      // (удалённая сторона фильтрует сама по локальному id проекта).
      const remoteFilter = projectId && isRemoteRef(projectId) ? { remoteProjectId: projectId } : undefined;
      const entries: HybridListEntry<unknown>[] = [
        ...localEntries(localList),
        ...remoteEntries(mergeItems([], remoteAll.items, remoteFilter)),
      ];
      const sorted = sortHybridList(entries);
      const { page, total, next_offset } = paginate(sorted, offset, limit);
      // Локальные записи сериализуем только для страницы (история в DTO не идёт).
      // Локальные сессии получают счётчик подтверждений; удалённые — DTO
      // приходит от удалённой стороны (там же считается свой счётчик).
      const items = await Promise.all(
        page.map((entry) => (entry.origin === 'local'
          ? serializeForReader(c, entry.value as Session, userId, {
            ...LIST_SERIALIZE_OPTS,
            pendingApprovals: pendingApprovalCount(entry.value as Session, pendingCounts),
          })
          : entry.value as Record<string, unknown>)),
      );
      // Кап страниц удалённого обхода: список неполон — курсор выдавать нельзя.
      if (remoteAll.truncated) {
        console.warn('[hybrid] удалённый список сессий обрезан капом страниц — next_offset не выдаётся');
        return c.json(listPage(items, total, offset, limit, null));
      }
      return c.json(listPage(items, total, offset, limit, next_offset));
    } catch (err) {
      // Offline-деградация: сервер недоступен — отдаём локальный мир и
      // отмечаем это аддитивным `remote_offline` (UI не должен выглядеть так,
      // будто удалённые сессии пропали).
      if (err instanceof RemoteError) {
        console.warn(`[hybrid] удалённый backend недоступен (${err.code}): ${err.message}`);
        if (projectId && isRemoteRef(projectId)) {
          return c.json(listPage([], 0, offset, limit, null, { remoteOffline: true }));
        }
        const { page, total, next_offset: localNextOffset } = paginate(visible, offset, limit);
        const localDto = await serializeLocalPage(page);
        return c.json(listPage(localDto, total, offset, limit, localNextOffset, { remoteOffline: true }));
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
    // Правка — точечная: полная запись снимка затёрла бы параллельную
    // дозапись сообщений (порт `mutateMeta`, `updatedAt` двигается — паритет
    // с прежним `updateSession`).
    session.ownerId = owner;
    const owned = await sessionManager.mutateMeta(session.id, (meta) => {
      meta.ownerId = owner;
    });
    if (owned.found) session.updatedAt = owned.session.updatedAt;
    // Хук подписки EventHub вызываем ДО publish: EventBus не буферизует события,
    // и `session.created` с 0 подписчиков теряется (backend подписывал клиента раньше).
    await opts.onSessionCreated?.(await resolveUserId(c), session.id);
    eventBus.publish(session.id, 'session.created', serializeSession(session, { agentRegistry }));
    // Точечный ответ — сводка без истории (история — в `GET /:id/messages`).
    // ADR-119: `context_usage` — занятость контекста «прямо сейчас».
    return c.json(
      serializeSession(session, {
        agentRegistry,
        ...SUMMARY_SERIALIZE_OPTS,
        contextOptimizer: deps.contextOptimizer,
      }),
      201,
    );
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
    // Сводка без истории: полная история — в `GET /:id/messages`.
    // ADR-119: `context_usage` — занятость контекста «прямо сейчас»
    // (в списке сессий оценка не считается — она линейна по истории).
    // ADR-029: `pending_approvals` — число висящих подтверждений сессии
    // (точечный DTO показывается в UI и должен быть согласован со списком).
    return c.json(
      await serializeForReader(c, session, undefined, {
        ...SUMMARY_SERIALIZE_OPTS,
        contextOptimizer: deps.contextOptimizer,
        pendingApprovals: pendingApprovalCount(session, pendingApprovalCounts()),
      }),
    );
  });

  app.patch('/:id', auth.requireAuth, scoped('sessions:prompt'), sessionModeGuard, async (c) => {
    const id = c.req.param('id');
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      const body = await c.req.json().catch(() => ({}));
      // PROP-141 (Часть D): перенос удалённой сессии не поддерживается —
      // удалённый backend решает это сам, локальный контур не переносит.
      if (body.project_id !== undefined || body.projectId !== undefined) {
        return c.json({
          error: {
            code: 'SESSION_MOVE_REMOTE_UNSUPPORTED',
            message: 'Сессия удалённого инстанса не переносится между проектами',
          },
        }, 409);
      }
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

    // Регенерация заголовка: `title: ""` (пустая строка) — пересобрать имя
    // сессии по диалогу (force). Непустой `title` — обычное переименование.
    const titleRegeneration = typeof body.title === 'string' && body.title.trim() === '';

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

    // PROP-135 Ф6a: профиль исполнения сессии должен существовать в каталоге
    // (`execution.remote.profiles`). Каталога нет (inline/instance-пул/тесты) —
    // проверка пропускается, значение сохраняется как раньше. Пустая строка —
    // явный сброс (роутер возьмёт профиль агента/проекта/инстанса).
    const requestedExecutorProfile = parsed.data.settings?.executorProfile;
    if (requestedExecutorProfile !== undefined) {
      const profile = requestedExecutorProfile.trim();
      if (profile === '') {
        // Явный сброс (`executorProfile: ""`): ключ не сохраняем — binding
        // возьмёт профиль агента/проекта/инстанса.
        parsed.data.settings!.executorProfile = undefined;
      } else {
        const catalog = deps.executionProfileCatalog;
        if (catalog && catalog.profiles.length > 0 && !catalog.profiles.includes(profile)) {
          return c.json({
            error: {
              code: 'VALIDATION_ERROR',
              message: `Неизвестный профиль исполнения: "${profile}". Доступные: ${catalog.profiles.join(', ')}`,
            },
          }, 400);
        }
      }
    }

    // PROP-135 (браузерный контур): браузерный профиль сессии — отдельный
    // каталог. Пустая строка — явный сброс (наследование агент→проект→инстанс).
    const requestedBrowserProfile = parsed.data.settings?.browserProfile;
    if (requestedBrowserProfile !== undefined) {
      const profile = requestedBrowserProfile.trim();
      if (profile === '') {
        parsed.data.settings!.browserProfile = undefined;
      } else {
        const browserCatalog = deps.browserProfileCatalog;
        if (
          browserCatalog
          && browserCatalog.profiles.length > 0
          && !browserCatalog.profiles.includes(profile)
        ) {
          return c.json({
            error: {
              code: 'VALIDATION_ERROR',
              message: `Профиль браузера не найден: "${profile}". Доступные: ${browserCatalog.profiles.join(', ')}`,
            },
          }, 400);
        }
      }
    }

    // ADR-135 (аддендум): профиль сессии обязан входить в список разрешённых
    // (потолок агента/проекта). Список задан (в том числе пустой) — это потолок;
    // пустой список = «профилей нет» (fail-closed).
    if (
      requestedExecutorProfile !== undefined
      && requestedExecutorProfile.trim() !== ''
      || requestedBrowserProfile !== undefined
      && requestedBrowserProfile.trim() !== ''
    ) {
      const ceilings = await resolveSessionProfileCeilings(session, deps);
      const execProfile = (requestedExecutorProfile ?? '').trim();
      const browserProfile = (requestedBrowserProfile ?? '').trim();
      if (execProfile !== '' && ceilings.execAllowed !== undefined
        && !ceilings.execAllowed.includes(execProfile)) {
        return c.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `Профиль исполнения должен входить в список разрешённых: ${execProfile}`,
          },
        }, 400);
      }
      if (browserProfile !== '' && ceilings.browserAllowed !== undefined
        && !ceilings.browserAllowed.includes(browserProfile)) {
        return c.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `Профиль браузера должен входить в список разрешённых: ${browserProfile}`,
          },
        }, 400);
      }
    }

    // ADR-040: перенос сессии между проектами (project_id). Валидируем существование
    // нового проекта; сама мутация — единым шовом `SessionMoveService` (PROP-141,
    // Часть D): блокеры, согласие, детерминированный порядок эффектов.
    // (Валидация/авторизация — по предварительному чтению.)
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

    // PROP-141 (Часть D): перенос сессии между проектами — единый шов.
    //
    // Порядок: 1) согласие (`move_consent`) — даёт только человек; 2) привязка
    // к worktree резолвится ДО переноса (проект-цель известен из запроса — иначе
    // неудачная привязка откатила бы уже выполненный перенос); 3) сам перенос.
    //
    // Без согласия при блокерах — 409 `SESSION_HAS_ATTACHED_STATE` с `details`
    // (counts + компактный список `{id, kind, name}`).
    let moveResult: SessionMoveResult | null = null;
    let preResolvedWorktree: SessionWorktree | undefined;
    let prevProjectBeforeMove: string | undefined;
    if (projectParam !== undefined) {
      const targetProjectId = projectParam || undefined;
      if (targetProjectId !== session.projectId) {
        // 1. Согласие: service-key согласие не даёт (403).
        const consentRaw = (body as { move_consent?: unknown; moveConsent?: unknown }).move_consent
          ?? (body as { moveConsent?: unknown }).moveConsent;
        const consent = parseMoveConsent(consentRaw);
        if (consent === 'invalid') {
          return c.json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'move_consent должен быть объектом с полями stop_running/cancel_automations',
            },
          }, 400);
        }
        if (consent && getServiceCredential(c)) {
          return c.json({
            error: {
              code: 'FORBIDDEN',
              message: 'Согласие на последствия переноса даёт только человек',
            },
          }, 403);
        }
        // 2. Привязка к worktree — резолвим до переноса.
        if (worktreeRequest?.kind === 'bind') {
          const resolved = await resolveWorktreeBinding(targetProjectId, worktreeRequest.id);
          if ('error' in resolved) {
            return c.json(
              { error: { code: resolved.error.code, message: resolved.error.message } },
              resolved.error.status as 400 | 404 | 409,
            );
          }
          preResolvedWorktree = resolved.binding;
        }
        // 3. Перенос — единый шов. Сервиса нет (деградированный инстанс) —
        // смена проекта выполняется прежним путём (под локом, без проверки
        // привязанного состояния): перенос остаётся доступным.
        if (deps.moveService) {
          prevProjectBeforeMove = session.projectId;
          try {
            moveResult = await deps.moveService.move({
              sessionId: id,
              targetProjectId,
              actor: (await resolveUserId(c)) || LOCAL_USER_ID,
              ...(consent ? { consent } : {}),
            });
          } catch (err) {
            if (err instanceof SessionMoveError) {
              return c.json({
                error: {
                  code: err.code,
                  message: err.message,
                  ...(err.details ? { details: err.details } : {}),
                },
              }, err.status as 400 | 404 | 409);
            }
            throw err;
          }
        }
      }
    }

    // ADR-114: привязка worktree — резолв записи **до** мутации: мутатор
    // `mutateMeta` строго синхронный (ждать I/O под локом порта нельзя).
    // Проект-цель известен: при переносе — из запроса, иначе проект сессии из
    // предварительного чтения. Принадлежность проекту перепроверяется внутри
    // мутатора по свежему `projectId` — резолв вне лока не должен привязать
    // worktree прежнего проекта (ADR-114 §3.4).
    let resolvedWorktree: SessionWorktree | undefined;
    let worktreeResolveError: { status: number; code: string; message: string } | undefined;
    if (worktreeRequest?.kind === 'bind') {
      if (preResolvedWorktree) {
        // Перенос проекта уже выполнен — запись worktree разрешена до него
        // (проект-цель известен), резолвить заново не нужно.
        resolvedWorktree = preResolvedWorktree;
      } else {
        const bindingProjectId = projectParam !== undefined
          ? (projectParam || undefined)
          : session.projectId;
        const resolved = await resolveWorktreeBinding(bindingProjectId, worktreeRequest.id);
        if ('error' in resolved) worktreeResolveError = resolved.error;
        else resolvedWorktree = resolved.binding;
      }
    }

    // Правка сессии — **точечно**, под локом порта (`mutateMeta`): полная запись
    // снимка (`saveSession`) затирала параллельную дозапись сообщений и правки
    // других запросов (lost update). `updatedAt` двигается — паритет с прежним
    // `updateSession`.
    const outcome = await sessionManager.mutateMeta<{
      prevProjectId?: string;
      prevTitle?: string;
      projectChanged: boolean;
      worktreeDetached: boolean;
      worktreeEvents: WorktreeUpdatedInput[];
      worktreeError?: { status: number; code: string; message: string };
    }>(id, (s) => {
      const prevProjectId = s.projectId;
      const prevWorktreeId = s.worktree?.worktreeId;
      let projectChanged = false;
      let worktreeDetached = false;
      const worktreeEvents: WorktreeUpdatedInput[] = [];
      // Ошибка резолва записи worktree (резолв — вне мутатора: `list` это I/O) —
      // сессия не меняется вовсе (в т.ч. перенос проекта): записи и событий нет.
      if (worktreeResolveError) {
        return {
          prevProjectId,
          prevTitle: undefined,
          projectChanged: false,
          worktreeDetached: false,
          worktreeEvents,
          worktreeError: worktreeResolveError,
        };
      }
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
      // Запись чужого проекта: `projectId` сессии мог смениться между резолвом
      // (вне лока) и мутацией — привязку не применяем, сессия не меняется
      // (для запроса это тот же «чужой worktree», что и в отсутствии записи).
      if (resolvedWorktree && resolvedWorktree.projectId !== s.projectId) {
        return {
          prevProjectId,
          prevTitle: undefined,
          projectChanged,
          worktreeDetached,
          worktreeEvents,
          worktreeError: {
            status: 404,
            code: 'WORKTREE_NOT_FOUND',
            message: 'Worktree не найден',
          },
        };
      }
      // ADR-114: привязка/отвязка worktree (после смены проекта: привязка
      // должна принадлежать проекту сессии на момент записи).
      if (resolvedWorktree) {
        s.worktree = resolvedWorktree;
        worktreeEvents.push({
          projectId: s.projectId ?? '',
          worktreeId: resolvedWorktree.worktreeId,
          action: 'attached',
        });
      } else if (worktreeRequest?.kind === 'unbind') {
        s.worktree = undefined;
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
      if (titleRegeneration) {
        // Регенерация заголовка: имя здесь НЕ меняем — его пересоберёт
        // оркестратор после лока (LLM-вызов под локом сессии запрещён).
        prevTitle = s.title;
      } else if (body.title !== undefined) {
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
        // Семантика прежняя: поверх текущих настроек (merge по ключам верхнего
        // уровня), а не замена объекта целиком.
        s.settings = { ...s.settings, ...parsed.data.settings };
      }
      return {
        prevProjectId,
        prevTitle,
        projectChanged,
        worktreeDetached,
        worktreeEvents,
        worktreeError: undefined,
      };
    }, {
      // Ошибка привязки worktree — записи нет (паритет с прежним ранним выходом).
      shouldWrite: (value) => value.worktreeError === undefined,
    });

    if (!outcome.found) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    if (outcome.value.worktreeError) {
      const worktreeError = outcome.value.worktreeError;
      return c.json(
        { error: { code: worktreeError.code, message: worktreeError.message } },
        worktreeError.status as 400 | 404 | 409,
      );
    }
    const { prevProjectId, prevTitle, projectChanged, worktreeDetached, worktreeEvents } = outcome.value;
    // Свежий полный снимок — для событий и ответа: `mutateMeta` возвращает
    // метаданные без истории, а DTO сессии строится из сессии.
    const updatedSession = await sessionManager.getSession(id);
    if (!updatedSession) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }

    // Регенерация заголовка (`title: ""`) — ПОСЛЕ блока локов: LLM-вызов под
    // локом сессии запрещён. Не удалось пересобрать имя — оставляем текущий
    // заголовок (остальные поля PATCH уже применены).
    let resultSession = updatedSession;
    if (titleRegeneration) {
      let regenerated: Session | null = null;
      try {
        regenerated = await deps.orchestrator.regenerateTitle(id);
      } catch {
        regenerated = null;
      }
      if (regenerated) {
        resultSession = regenerated;
        if (publishRenamed && prevTitle !== undefined && regenerated.title !== prevTitle) {
          eventBus.publish(id, 'session.renamed', {
            session_id: id,
            title: regenerated.title,
            prev_title: prevTitle,
          });
        }
      }
    }

    // Порядок публикации сохранён: renamed → updated → moved.
    if (!titleRegeneration && publishRenamed && prevTitle !== undefined && prevTitle !== body.title) {
      eventBus.publish(updatedSession.id, 'session.renamed', { session_id: updatedSession.id, title: body.title, prev_title: prevTitle });
    }
    eventBus.publish(resultSession.id, 'session.updated', serializeSession(resultSession, { agentRegistry }));
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
    // PROP-141 (Часть D): перенос сессии снял привязку к worktree (ADR-114 §3.4)
    // — инвентарь **старого** проекта изменился, событие публикует сервис
    // переноса через effects (сам `worktree.updated` — здесь).
    if (moveResult && prevProjectBeforeMove) {
      for (const effect of moveResult.effects) {
        if (effect.kind !== 'worktree' || effect.action !== 'detached') continue;
        await publishWorktreeUpdated(
          { eventBus, sessionStore: sessionManager },
          { projectId: prevProjectBeforeMove, worktreeId: effect.id, action: 'detached' },
        );
      }
    }
    // Точечный ответ — сводка без истории (история — в `GET /:id/messages`).
    // ADR-119: `context_usage` — занятость контекста «прямо сейчас».
    return c.json(
      serializeSession(resultSession, {
        agentRegistry,
        ...SUMMARY_SERIALIZE_OPTS,
        contextOptimizer: deps.contextOptimizer,
      }),
    );
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
    const id = c.req.param('id');
    // Гибрид: состояние удалённой сессии (очередь/ход) знает только её backend.
    const forwarded = await forwardRemoteSession(c, id, (client, localId) => client.getSessionStatus(localId));
    if (forwarded) return forwarded;
    const session = await sessionManager.getSession(id);
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
    const id = c.req.param('id');
    // Гибрид: состав промпта собирается на стороне сессии (её история/модель).
    const forwarded = await forwardRemoteSession(c, id, (client, localId) => client.getSessionPrompt(localId));
    if (forwarded) return forwarded;
    const session = await sessionManager.getSession(id);
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
    const memoryId = c.req.param('id');
    // Гибрид (ADR-042): память удалённой сессии живёт на сервере — проксируем
    // запрос целиком (локальных портов памяти у неё нет). id в ответе
    // переписываются в `remote:` (индексы адресуются на сервере).
    if (hasRemoteGetter && isRemoteRef(memoryId)) {
      const remoteClient = resolveClient();
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      try {
        const remote = (await remoteClient.getSessionMemory(toLocalId(memoryId))) as Record<string, unknown>;
        return c.json(toRemoteSessionMemory(remote));
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    const session = await sessionManager.getSession(memoryId);
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

  // ===== ADR-119: оптимизация контекста (вкладка «Контекст») =====
  //
  // Настройки сессии (`contextOptimization`, `compactionKeepTokens`, …) —
  // **локальные для сессии**: движок `ContextOptimizer` читает их на core,
  // поэтому маршруты живут в общей фабрике (standalone, гибрид, backend), а не
  // только в backend. В гибриде `remote:`-сессия форвардится на удалённый
  // backend (настройки её мира).
  //
  // Доступ — у prefix-guard ресурса (инвариант 16): проверок в обработчиках нет.
  // После сохранения публикуется `session.updated` — мутация видна другому
  // клиенту (инвариант 27).

  /** Поля ответа GET-запроса оптимизации (контракт вкладки «Контекст»). */
  const buildSessionOptimizationPayload = (session: Session) => ({
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
    summarization_keep_tokens: session.settings.summarizationKeepTokens,
    compaction_keep_tokens: session.settings.compactionKeepTokens,
    compaction_token_threshold: session.settings.compactionTokenThreshold,
  });

  app.get('/:id/optimization', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      try {
        const remote = await remoteClient.getSessionOptimization(toLocalId(id));
        return c.json(remote as Record<string, unknown>);
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
    return c.json(buildSessionOptimizationPayload(session));
  });

  app.patch('/:id/optimization', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      try {
        const updated = await remoteClient.updateSessionOptimization(toLocalId(id), body);
        return c.json(toRemote(updated as Record<string, unknown>));
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    const existing = await sessionManager.getSession(id);
    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // Настройки оптимизации — метаданные: точечная правка под локом порта
    // (история не перезаписывается). `updatedAt` не двигаем — паритет с прежним
    // `saveSession` (настройки вкладки «Контекст» не «оживляют» сессию).
    await sessionManager.mutateMeta(id, (s) => {
      if (body.context_optimization !== undefined) s.settings.contextOptimization = body.context_optimization as Session['settings']['contextOptimization'];
      if (body.sliding_window_mode !== undefined) s.settings.slidingWindowMode = body.sliding_window_mode as Session['settings']['slidingWindowMode'];
      if (body.sliding_window_message_limit !== undefined) s.settings.slidingWindowMessageLimit = body.sliding_window_message_limit as number;
      if (body.sliding_window_token_threshold !== undefined) s.settings.slidingWindowTokenThreshold = body.sliding_window_token_threshold as number;
      if (body.summarization_enabled !== undefined) s.settings.summarizationEnabled = body.summarization_enabled as boolean;
      if (body.summarization_trigger_mode !== undefined) s.settings.summarizationTriggerMode = body.summarization_trigger_mode as Session['settings']['summarizationTriggerMode'];
      if (body.summarize_after_n !== undefined) s.settings.summarizeAfterN = body.summarize_after_n as number;
      if (body.summarize_token_threshold !== undefined) s.settings.summarizeTokenThreshold = body.summarize_token_threshold as number;
      if (body.summarization_head_messages !== undefined) s.settings.summarizationHeadMessages = body.summarization_head_messages as number;
      if (body.summarization_tail_messages !== undefined) s.settings.summarizationTailMessages = body.summarization_tail_messages as number;
      if (body.summarization_keep_tokens !== undefined) s.settings.summarizationKeepTokens = body.summarization_keep_tokens as number;
      if (body.compaction_keep_tokens !== undefined) s.settings.compactionKeepTokens = body.compaction_keep_tokens as number;
      if (body.compaction_token_threshold !== undefined) s.settings.compactionTokenThreshold = body.compaction_token_threshold as number;
    }, { touchUpdatedAt: false });

    const updated = await sessionManager.getSession(id);
    if (!updated) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    eventBus.publish(updated.id, 'session.updated', serializeSession(updated, { agentRegistry, ...SUMMARY_SERIALIZE_OPTS }));
    return c.json(
      serializeSession(updated, {
        agentRegistry,
        ...SUMMARY_SERIALIZE_OPTS,
        contextOptimizer: deps.contextOptimizer,
      }),
    );
  });

  app.post('/:id/optimization/check', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      try {
        const remote = await remoteClient.checkSessionOptimization(toLocalId(id));
        return c.json(remote as Record<string, unknown>);
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
    const optimizer = deps.contextOptimizer;
    if (!optimizer) {
      // Фоллбек прежнего backend-хендлера: подсистема оптимизации не подключена.
      return c.json({
        sliding_window: { triggered: false },
        summarization: { triggered: false },
        compression: { triggered: false, reason: 'none', mode: null },
      });
    }
    const swResult = optimizer.shouldApplySlidingWindow(session);
    const sumResult = optimizer.shouldSummarize(session);
    const compression = typeof optimizer.shouldCompress === 'function'
      ? optimizer.shouldCompress(session)
      : { ...optimizer.shouldSummarize(session), mode: 'summarization' as const };
    return c.json({
      sliding_window: swResult,
      summarization: sumResult,
      compression,
      summarization_pending: session.summarizationPending,
    });
  });

  app.post('/:id/optimization/cancel-summarization', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      try {
        const remote = await remoteClient.cancelSessionSummarization(toLocalId(id));
        return c.json(remote as Record<string, unknown>);
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
    // Флаг — метаданные: точечная правка под локом порта. `updatedAt` не
    // двигаем — паритет с прежним `saveSession` (отмена сжатия не «оживляет»
    // сессию в списках).
    await sessionManager.mutateMeta(session.id, (meta) => {
      meta.summarizationPending = false;
    }, { touchUpdatedAt: false });
    const optimizer = deps.contextOptimizer;
    if (optimizer) {
      const updated = await sessionManager.getSession(session.id);
      const can = updated ? optimizer.canSummarize(updated) : false;
      eventBus.publish(session.id, 'session.updated', {
        session_id: session.id,
        can_summarize: can,
        summarization_pending: false,
      });
    }
    return c.json({ success: true });
  });

  // ===== ADR-071 §2.4: MCP-скоуп сессии (вкладка «Сессия»/MCP) =====
  //
  // Общая реализация для standalone/гибрида. Managed backend регистрирует
  // собственные `/:id/mcp` РАНЬШЕ core-фабрики и сохраняет прежнюю, более
  // строгую политику (владелец|ADMIN) — порядок регистрации оставляет её в силе.
  // Доступ core-версии — prefix-guard ресурса (инвариант 16).

  /** Эффективный MCP-скоуп сессии (включая отключённые серверы с причиной). */
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

  app.get('/:id/mcp', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      try {
        const remote = await remoteClient.getSessionMcp(toLocalId(id));
        return c.json(remote as Record<string, unknown>);
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
    return c.json(await buildSessionMcpPayload(session));
  });

  app.put('/:id/mcp', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      try {
        const remote = await remoteClient.updateSessionMcp(toLocalId(id), body);
        return c.json(remote as Record<string, unknown>);
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

    // Тоггл/список — метаданные сессии: точечная правка под локом порта
    // (история и очередь не перезаписываются). `updatedAt` двигается — паритет
    // с прежним `updateSession` (вкладка MCP меняет состояние хода).
    const scoped = await sessionManager.mutateMeta(id, (meta) => {
      if (name !== undefined) {
        // Точечный toggle: enabled → session.enabled; disabled → opt-out.
        const enabledList = new Set(meta.settings.mcpServers ?? []);
        const disabledList = new Set(meta.settings.mcpDisabledServers ?? []);
        if (enabled === false) {
          enabledList.delete(name);
          disabledList.add(name);
        } else {
          enabledList.add(name);
          disabledList.delete(name);
        }
        meta.settings.mcpServers = [...enabledList];
        meta.settings.mcpDisabledServers = [...disabledList];
      } else {
        if (mcpServers !== undefined) meta.settings.mcpServers = mcpServers;
        if (mcpDisabledServers !== undefined) meta.settings.mcpDisabledServers = mcpDisabledServers;
      }
      return meta.settings;
    });
    if (!scoped.found) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    // Свежий снимок — для события и ответа (запись могла пройти после чтения).
    const updatedSession = (await sessionManager.getSession(id)) ?? session;
    eventBus.publish(updatedSession.id, 'session.updated', serializeSession(updatedSession, { agentRegistry, ...SUMMARY_SERIALIZE_OPTS }));
    return c.json(await buildSessionMcpPayload(updatedSession));
  });

  // ===== ADR-036: карта обфускации сессии (вкладка «Безопасность») =====
  //
  // Managed backend регистрирует собственный `/:id/secrets` раньше core-фабрики
  // (`requirePermission('ADMIN','AUDITOR')`) и сохраняет прежнюю политику.
  // Core-версия обслуживает standalone/гибрид: право — `resolveCanRevealSecrets`
  // (владелец сессии; backend передаёт владелец|ADMIN|AUDITOR). Нет права → 403.
  app.get('/:id/secrets', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      try {
        const remote = (await remoteClient.getSessionSecrets(toLocalId(id))) as Record<string, unknown>;
        // `sessionId` — ссылка на сущность удалённого мира.
        return c.json({ ...remote, sessionId: toRemoteRef(toLocalId(id)) });
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
    const allowed = await resolveCanRevealSecrets(c, session);
    if (!allowed) {
      return c.json({ error: { code: 'FORBIDDEN', message: messages.forbidden(c) } }, 403);
    }
    return c.json({ sessionId: session.id, secrets: session.obfuscationMap ?? {} });
  });

  // ===== Sticky Notes (заметки сессии) =====
  //
  // Лимиты — instance-wide (`context.stickyNotes`): `maxCount` — максимум
  // заметок на сессию (409 `LIMIT_EXCEEDED` при создании), `maxChars` —
  // максимум символов в заметке (400 `VALIDATION_ERROR`). Резолвер читается
  // при каждой операции (runtime-настройка применяется без рестарта);
  // существующие заметки не удаляются и не обрезаются.
  // Доступ — у prefix-guard ресурса (инвариант 16): в обработчиках проверок нет.

  // GET /api/v2/sessions/:id/notes — список заметок
  app.get('/:id/notes', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    // Гибрид: заметки живут в сессии своего мира.
    const forwarded = await forwardRemoteSession(c, id, (client, localId) => client.getSessionNotes(localId));
    if (forwarded) return forwarded;
    const session = await sessionManager.getSession(id);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    return c.json({ notes: session.stickyNotes });
  });

  // POST /api/v2/sessions/:id/notes — создать заметку
  app.post('/:id/notes', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    // Гибрид: лимиты и запись — на стороне сессии.
    const forwarded = await forwardRemoteSession(
      c, id, (client, localId) => client.createSessionNote(localId, body), undefined, 201,
    );
    if (forwarded) return forwarded;

    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.contentRequired(c) } }, 400);
    }

    const limits = getStickyNoteLimits();
    if (content.length > limits.maxChars) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.noteTooLong(c, limits.maxChars) } }, 400);
    }
    // Заметки живут в child-наборе сессии (`stickyNotes`), который пишется
    // вместе с документом, поэтому правка — `mutateHistory` на **свежем**
    // документе под локом порта: проверка лимита и запись в одной критической
    // секции (две параллельные заметки не превысят `maxCount`), параллельная
    // дозапись сообщений не теряется. `updatedAt` не двигается — паритет с
    // прежним `saveSession` (заметка не «оживляет» сессию в списках).
    // Лимит достигнут — записи нет (`shouldWrite`), 409 ниже.
    const now = nowISO();
    const note = {
      id: generateStreamId(),
      content,
      createdAt: now,
      updatedAt: now,
      disabled: false,
    };

    const added = await sessionManager.mutateHistory(id, (s) => {
      if (s.stickyNotes.length >= limits.maxCount) return false;
      s.stickyNotes.push(note);
      return true;
    }, { touchUpdatedAt: false, shouldWrite: (written) => written });

    if (!added.ok) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    if (!added.value) {
      return c.json({ error: { code: 'LIMIT_EXCEEDED', message: messages.noteLimitReached(c, limits.maxCount) } }, 409);
    }

    const updated = await sessionManager.getSession(id);
    eventBus.publish(id, 'context.sticky_note_added', { note_id: note.id });
    return c.json({ note, notes: updated!.stickyNotes }, 201);
  });

  // PATCH /api/v2/sessions/:id/notes/:noteId — обновить заметку
  app.patch('/:id/notes/:noteId', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const noteId = c.req.param('noteId');
    // Гибрид: id заметки адресуется внутри удалённого мира.
    const forwarded = await forwardRemoteSession(
      c, id, (client, localId) => client.updateSessionNote(localId, noteId, body),
    );
    if (forwarded) return forwarded;

    const limits = getStickyNoteLimits();
    if (typeof body.content === 'string' && body.content.length > limits.maxChars) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.noteTooLong(c, limits.maxChars) } }, 400);
    }

    // Правка заметки — `mutateHistory` на свежем документе под локом порта
    // (child-набор `stickyNotes` пишется вместе с ним). `updatedAt` сессии не
    // двигается (паритет с `saveSession`); заметки нет — записи нет, 404.
    const updatedNote = await sessionManager.mutateHistory(id, (s) => {
      const note = s.stickyNotes.find((n) => n.id === noteId);
      if (!note) return false;

      if (body.content !== undefined) note.content = body.content;
      if (body.disabled !== undefined) note.disabled = body.disabled;
      note.updatedAt = nowISO();
      return true;
    }, { touchUpdatedAt: false, shouldWrite: (written) => written });

    if (!updatedNote.ok) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    if (!updatedNote.value) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.noteNotFound(c) } }, 404);
    }

    const updated = await sessionManager.getSession(id);
    eventBus.publish(id, 'context.sticky_note_updated', { note_id: noteId });
    return c.json({ notes: updated!.stickyNotes });
  });

  // DELETE /api/v2/sessions/:id/notes/:noteId — удалить заметку
  app.delete('/:id/notes/:noteId', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    const noteId = c.req.param('noteId');
    // Гибрид: удаление — на стороне сессии.
    const forwarded = await forwardRemoteSession(
      c, id, (client, localId) => client.deleteSessionNote(localId, noteId),
    );
    if (forwarded) return forwarded;

    // Удаление — `mutateHistory` на свежем документе под локом порта;
    // `updatedAt` не двигается (паритет с `saveSession`). Заметки не было —
    // записи нет (`shouldWrite`), событие прежнее.
    const removed = await sessionManager.mutateHistory(id, (s) => {
      const next = s.stickyNotes.filter((n) => n.id !== noteId);
      if (next.length === s.stickyNotes.length) return false;
      s.stickyNotes = next;
      return true;
    }, { touchUpdatedAt: false, shouldWrite: (deleted) => deleted });

    if (!removed.ok) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }

    const updated = await sessionManager.getSession(id);
    eventBus.publish(id, 'context.sticky_note_deleted', { note_id: noteId });
    return c.json({ notes: updated!.stickyNotes });
  });

  // GET /api/v2/sessions/:id/stats — статистика по агентам/пользователям
  // (ADR-070 §2.6): usage сообщений + рекурсивный usage саб-агентов (tool `task`).
  app.get('/:id/stats', auth.requireAuth, scoped('sessions:read'), async (c) => {
    const id = c.req.param('id');
    // Гибрид: usage считается по истории сессии на её стороне.
    const forwarded = await forwardRemoteSession(c, id, (client, localId) => client.getSessionStats(localId));
    if (forwarded) return forwarded;
    const session = await sessionManager.getSession(id);
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

    // Гибрид: удалённая сессия исполняется backend. ADR-118 §3: проксируем
    // **только** подтверждение приёма (`202 {messageId, mode, position}`) —
    // поток хода больше не проксируется (наблюдение — по шине событий,
    // ADR-024/ADR-118).
    if (hasRemoteGetter && isRemoteRef(sessionId)) {
      const remoteClient = resolveClient();
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      const body = await c.req.json().catch(() => ({}));
      // ADR-104 (этап 3): режим отправки доезжает до удалённой стороны (тело
      // пробрасывается как есть).
      const mode = isSteerMode(body.mode) ? body.mode : DEFAULT_STEER_MODE;
      // Идентификатор принятого сообщения: `body.messageId` (строка) либо
      // сгенерированный (существующий механизм `generateStreamId`).
      const requestedMessageId = normalizeClientMessageId(body.messageId) || generateStreamId();
      try {
        const response = await remoteClient.promptSession(toLocalId(sessionId), body, {
          signal: c.req.raw.signal,
          // Гибрид: 4xx (например `400 PROVIDER_DISABLED`/`MODEL_DISABLED`) нужно
          // вернуть клиенту как есть — с `code`/`details` тела, а не `HTTP_400`.
          allowHttpError: true,
        });
        // Удалённая сторона ответила новым контрактом — проксируем `202`.
        if (response.status === 202) {
          const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          return c.json({
            messageId: typeof payload.messageId === 'string' ? payload.messageId : requestedMessageId,
            mode: payload.mode === 'steer' || payload.mode === 'interrupt' ? payload.mode : mode,
            position: typeof payload.position === 'number' ? payload.position : null,
          }, 202);
        }
        // Ответ удалённого сервера 4xx (напр. `400 PROVIDER_DISABLED`/
        // `MODEL_DISABLED`) прокидываем **как есть**: клиент должен увидеть
        // причину отказа и `details`, а не «сообщение принято». Мягкая
        // деградация ниже остаётся только для старого сервера (не-4xx не-202).
        if (response.status >= 400 && response.status < 500) {
          const payload = await response.json().catch(() => ({
            error: { code: `HTTP_${response.status}`, message: `HTTP ${response.status}` },
          }));
          return c.json(payload as Record<string, unknown>, response.status as 400);
        }
        // Старая версия сервера (не-202): сообщение принято обычной очередью —
        // мягкая деградация, поток НЕ проксируем.
        await response.body?.cancel().catch(() => {});
        return c.json({ messageId: requestedMessageId, mode: 'queue', position: null }, 202);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    const body = await c.req.json().catch(() => ({}));
    const rawContent = body.content?.trim();

    if (!rawContent) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.contentRequired(c) } }, 400);
    }

    // ADR-104: режим отправки. Неизвестное значение — как `queue` (обратная
    // совместимость: поле необязательное).
    const mode = isSteerMode(body.mode) ? body.mode : DEFAULT_STEER_MODE;

    let session = await sessionManager.getSession(sessionId);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const promptDenied = serviceProjectProjection(c, session.projectId);
    if (promptDenied) return promptDenied;

    // Отключённые провайдер/модель не должны доходить до очереди: запрос
    // отклоняется **до** вложений и постановки (иначе ход падал бы в движке,
    // а сообщение уже стояло бы в очереди). Проверка — по эффективной паре
    // (тело запроса перекрывает настройки сессии). Нет записи в каталоге —
    // не блокируем (каталог может быть неполным/удалённым).
    const effectiveProviderName = (body.provider as string | undefined) || session.settings.provider;
    const effectiveModelName = (body.model as string | undefined) || session.settings.model;
    const llmAvailability = deps.llmAvailability;
    if (effectiveProviderName && llmAvailability?.isProviderEnabled
      && llmAvailability.isProviderEnabled(effectiveProviderName) === false) {
      return c.json({
        error: {
          code: 'PROVIDER_DISABLED',
          message: messages.providerDisabled(c, effectiveProviderName),
          details: { provider: effectiveProviderName },
        },
      }, 400);
    }
    if (effectiveProviderName && effectiveModelName && llmAvailability?.isModelEnabled
      && llmAvailability.isModelEnabled(effectiveProviderName, effectiveModelName) === false) {
      return c.json({
        error: {
          code: 'MODEL_DISABLED',
          message: messages.modelDisabled(c, effectiveProviderName, effectiveModelName),
          details: { provider: effectiveProviderName, model: effectiveModelName },
        },
      }, 400);
    }
    // Доступ — у prefix-guard (единая точка истины): он учитывает владельца,
    // участника проекта и сквозной обзор ADMIN/LEAD. Здесь остаётся только
    // специфика тела запроса (проверка контента выше).

    // PROP-132: контекст терминала — необязательный блок вывода терминала,
    // который клиент присылает **вместе с вопросом** (`context`). Разбирается
    // здесь — до любой записи в историю/очередь: невалидный контекст = 400
    // без частичной доставки (ни контекста, ни вопроса).
    const rawContext = (body as { context?: unknown }).context;
    let contextMessage: Message | undefined;
    if (rawContext !== undefined && rawContext !== null) {
      const parsedContext = parseTerminalContext(rawContext);
      if (!parsedContext.ok) {
        return c.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: messages.terminalContextInvalid?.(c, parsedContext.message)
              ?? parsedContext.message,
          },
        }, 400);
      }
      contextMessage = buildTerminalContextMessage(parsedContext.value);
    }
    // ADR-104: контекст нельзя вклинить перед interrupt-сообщением —
    // `orderSteerInjections` ставит класс `interrupt` первым, и контекст
    // оказался бы ПОСЛЕ вопроса (контракт — «контекст раньше вопроса»).
    if (contextMessage && mode === 'interrupt') {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: messages.terminalContextWithInterrupt?.(c)
            ?? 'Контекст терминала нельзя отправлять вместе с mode=interrupt',
        },
      }, 400);
    }

    // ADR-126 §2: `@user` — граница «агенту / пользователю». Первое
    // упоминание пользователя (среди доступных участников сессии/проекта) делит
    // сообщение: часть **до** него — агенту (обычная очередь, ход), часть
    // **от** него — пользователю (сообщение в историю + уведомление, ход **не**
    // запускается).
    const mentionSplit = await resolveSessionUserMentions(session, rawContent, body, deps);
    if (mentionSplit.malformed) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: messages.invalidMentions?.(c) ?? 'Некорректное поле mentions',
          },
        },
        400,
      );
    }
    if (mentionSplit.invalidUserIds.length > 0) {
      // Недоступный/неизвестный пользователь — 400 **до** отправки, без
      // частичной доставки (ADR-126 §2 п. 4).
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: messages.unknownMentionUsers?.(c, mentionSplit.invalidUserIds)
              ?? `Недоступные пользователи: ${mentionSplit.invalidUserIds.join(', ')}`,
            details: { user_ids: mentionSplit.invalidUserIds },
          },
        },
        400,
      );
    }
    // Агентская часть сообщения (до первого `@user`); пусто — агент не
    // запускается вовсе (ADR-126 §2 п. 1).
    let content = mentionSplit.agentText;
    // Пользовательский хвост (от первого `@user` до конца) — `undefined`, если
    // упоминания пользователя в сообщении нет.
    const userDirectedText = mentionSplit.userText;

    // ADR-126 §2: `@file` — только в агентской части. Файл читается внутри
    // workspace сессии; бинарь/вне периметра/слишком большой — 400, без
    // частичной доставки. Блок добавляется **после** сниппетов, чтобы тело
    // файла не было повторно разобрано как `#`-сниппет.
    const originalAgentText = content;
    let fileMentions: string[] | undefined;
    let fileBlocks = '';
    if (content && !content.trimStart().startsWith('/')) {
      const fileWorkspace = await resolveSessionWorkspace(session);
      const fileResult = await resolveFileMentions(content, fileWorkspace);
      if (fileResult.invalid.length > 0) {
        const paths = fileResult.invalid.map((item) => item.path);
        const reasons = fileResult.invalid.map((item) => item.reason);
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: messages.invalidFileMentions?.(c, paths, reasons)
                ?? `Не удалось прочитать файлы: ${paths.join(', ')}`,
              details: { files: fileResult.invalid },
            },
          },
          400,
        );
      }
      fileMentions = fileResult.files.length > 0 ? fileResult.files : undefined;
      fileBlocks = fileResult.text.slice(originalAgentText.length);
    }

    // ADR-126 §4: раскрытие `#`-сниппетов — на входе промпта, до очереди и до
    // LLM (один и тот же путь для CLI/гибрида/шлюзов). Раскрывается **только
    // пользовательский текст**: `/`-команда не разворачивается (иначе сниппет
    // стал бы скрытым каналом инъекции в шаблоны команд). Исходный текст в
    // историю не уходит — в `content`/`parts` идёт уже раскрытый (обфускация
    // ADR-036 применится к нему в `enqueueUserMessage`).
    //
    // ADR-126 §2: сниппеты раскрываются **только в агентской части**: в
    // user-directed хвосте `#`/`$` — обычный текст (хвост не должен случайно
    // раскрыть сниппет или вызвать скилл).
    let snippetExpansions: string[] | undefined;
    if (deps.snippetService && content && !content.trimStart().startsWith('/')) {
      const snippetUserId = (await resolveUserId(c)) || undefined;
      // Проектные сниппеты — всегда project.workspace (не worktree сессии):
      // уровень проекта, а не ветки; тот же каталог, что у редактора в панели.
      const projectWorkspace = await resolveProjectWorkspaceOnly(session);
      const expanded = await deps.snippetService.expandText(content, {
        ...(snippetUserId ? { userId: snippetUserId } : {}),
        ...(projectWorkspace ? { projectWorkspace } : {}),
      });
      if (expanded.text !== content && expanded.text.trim()) {
        content = expanded.text;
        snippetExpansions = expanded.applied;
      }
      // Диагностика — в лог, не клиенту: только код и имя сниппета (без
      // содержимого и без путей — ADR-126 §4 «Содержимое не логируется»).
      for (const diagnostic of expanded.diagnostics) {
        warning('ROUTES', `SNIPPET ${diagnostic.code}: ${diagnostic.snippet ?? '-'}`);
      }
    }
    if (fileBlocks) {
      content = `${content}${fileBlocks}`;
    }

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
    const attachmentConfig = deps.attachments ? resolveAttachmentConfig() : undefined;
    if (attachmentPaths && attachmentPaths.length > 0) {
      if (!attachmentService || !attachmentConfig) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: messages.attachmentsUnavailable(c) } },
          400,
        );
      }
      if (!attachmentConfig.enabled) {
        return c.json(
          { error: { code: 'attachments_disabled', message: messages.attachmentsDisabled(c) } },
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

    // Текст сообщения: агентская часть и пользовательский хвост — **разные**
    // сообщения (ADR-126 §2). Вложения принадлежат агентской части, если она
    // есть; сообщение, начинающееся с `@user`, получает вложения само.
    const agentParts: Part[] = content ? [{ id: generateStreamId(), type: 'text', data: content }] : [];
    const userDirectedParts: Part[] = userDirectedText
      ? [{ id: generateStreamId(), type: 'text', data: userDirectedText }]
      : [];
    const attachmentParts = content ? agentParts : userDirectedParts;
    if (attachmentPaths && attachmentPaths.length > 0 && attachmentService) {
      const broken: string[] = [];
      let addedBytes = 0;
      for (const blobPath of attachmentPaths) {
        const media = await attachmentService.buildMediaPart(blobPath);
        if (!media) {
          broken.push(blobPath);
          continue;
        }
        // ADR-115: семейство MIME могло быть выключено после загрузки
        // (runtime-настройка) — тогда вложение не уходит провайдеру.
        const modality = attachmentModalityOf(media.data.mime);
        if (modality && attachmentConfig?.modalities?.[modality] === false) {
          return c.json(
            {
              error: {
                code: 'UNSUPPORTED_MEDIA_TYPE',
                message: messages.attachmentsModalityDisabled(c, media.data.mime),
              },
            },
            415,
          );
        }
        attachmentParts.push(makeMediaPart(media.type, media.data));
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
    const messageParts = agentParts;
    const messageContent = content
      ? appendMediaPlaceholders(content, agentParts)
      : '';
    const userDirectedContent = userDirectedText
      ? appendMediaPlaceholders(userDirectedText, userDirectedParts)
      : '';

    // ADR-118 §3: клиентский id нормализуется общей точкой (`normalizeClientMessageId`):
    // не строка, пустая строка или одни пробелы → серверный id (иначе сообщение
    // сохранилось бы с id `'   '` и разошлось с историей/событиями).
    const requestedMessageId = normalizeClientMessageId(body.messageId);
    const streamId = requestedMessageId || generateStreamId();
    const author = await resolveAuthor(c);
    // ADR-118 §4: отправитель (`userId` запроса) — адресат адресного события
    // `message.accepted`. Пустой — событие уходит в канал сессии (broadcast).
    const senderUserId = (await resolveUserId(c)) || '';
    // ADR-106 Ф4: принципал ввода фиксируется **при приёме ввода** (здесь —
    // на постановке в очередь). Не аутентифицирован → не задан → fallback
    // на владельца сессии (совместимость).
    // ADR-140 Ф2: вместе с принципалом фиксируется снимок групп пользователя
    // (гранты по группам применяются к этому снимку).
    const turnPrincipal = resolveUserPrincipal(await resolveUserId(c), [], resolveUserGroups(c));

    // ADR-104: идёт ли сейчас ход сессии — от этого зависит способ доставки
    // контекста терминала (вмешательство в ход или обычная очередь).
    //
    // PROP-142 §1: у дочерней сессии саб-агента нет процессора очереди —
    // активность прогона помечает `currentStream`. Без этого признака
    // `steer`/`interrupt` не нашли бы идущий ход ребёнка и ушли бы в обычную
    // очередь сессии («скрытая третья семантика»).
    const isSubagentChild = !!session.parentId && session.sessionOrigin === 'subagent';
    const sessionTurnActive = isTurnActive(session, queueManager)
      || (isSubagentChild && !!session.currentStream);
    const turnActive = !!content && mode !== 'queue' && sessionTurnActive;

    // ADR-111 §detach: пользователь вмешивается в **занятую** сессию — сначала
    // переводим блокирующие прогоны (`execute_shell` foreground / `task`) в фон,
    // иначе steer ждал бы завершения команды/саб-агента. Условие — активный ход
    // и режим вмешательства (`steer`/`interrupt`); текст не требуется —
    // прерывание без сообщения тоже вмешательство. Пустой реестр — no-op,
    // ошибка перевода сообщение не блокирует (мастер-выключатель —
    // `background.enabled`, живой геттер оркестратора).
    const detachBeforeHandle = sessionTurnActive && mode !== 'queue';
    if (detachBeforeHandle) await detachBlockingRuns(sessionId);
    // Сообщение в очередь занятой сессии ждёт завершения хода — detach делается
    // **после** успешной постановки (см. ветку `queue` ниже).
    const detachAfterQueue = sessionTurnActive && mode === 'queue';

    // PROP-132: контекст терминала доставляется **до** вопроса — он должен
    // попасть в историю раньше вопроса (`ord` контекста < `ord` вопроса),
    // поэтому материализуется до расчёта `baseOrd` (ADR-118 §2).
    let contextInSteer = false;
    if (contextMessage) {
      if (turnActive) {
        // Вмешательство в активный ход: контекст — **первым** в `steerInbox`
        // (вопрос встанет следом — порядок «контекст → вопрос»).
        const contextSteer = await enqueueSteerMessage(
          sessionManager, eventBus, sessionId, contextMessage, MAX_STEER_INJECTIONS_PER_TURN,
          (sid, msg) => orchestrator.obfuscateUserMessageForHistory(sid, msg),
          { messageId: contextMessage.id },
        );
        if (!contextSteer.accepted) {
          return c.json({
            error: {
              code: STEERING_ERROR_CODES.limitExceeded,
              message: messages.steerLimitExceeded(c, MAX_STEER_INJECTIONS_PER_TURN),
            },
          }, 429);
        }
        contextInSteer = true;
      } else {
        const updated = await sessionManager.addMessage(sessionId, contextMessage);
        if (!updated) {
          return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
        }
        session = updated;
        // UI должен увидеть контекст сразу (инвариант 27): `message.added` +
        // `session.updated` — тот же путь, что у fallback-уведомления фонового
        // прогона (`engine/background/notify-parent.ts`).
        const contextIndex = updated.messages.length - 1;
        eventBus.publish(sessionId, 'message.added', {
          message: serializeMessage(updated.messages[contextIndex]!, contextIndex),
          index: contextIndex,
        });
        eventBus.publish(sessionId, 'session.updated', serializeSession(updated));
      }
    }

    // ADR-118 §2: `ord` — монотонный порядок записи в историю. Резервируем его
    // для агентской части **до** постановки в очередь: user-directed хвост
    // записывается в историю сразу и должен быть **новее** триггера — тогда он
    // исключается из LLM-контекста текущего хода и попадает в следующий
    // (ADR-126 §2 п. 6).
    const baseOrd = nextOrd(session.messages);

    const message: Message = {
      // ADR-118 §3: id сохранённого сообщения = id принятого (`streamId`:
      // клиентский `body.messageId` либо выданный сервером) — иначе `202`/события
      // и история разошлись бы, и клиент нарисовал бы вторую реплику.
      id: streamId,
      role: MessageRole.USER,
      seq: session.messages.length + 1,
      // ADR-118 §2: монотонный порядок записи (резервируется заранее — см. выше).
      ord: baseOrd,
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
      metadata: {
        ...(body.metadata || {}),
        stream_id: streamId,
        // ADR-126 §4: какие сниппеты раскрылись (аддитивно, для диагностики).
        ...(snippetExpansions ? { snippetExpansions } : {}),
        // ADR-126 §2: какие `@file` прочитаны (аддитивно).
        ...(fileMentions ? { fileMentions } : {}),
      },
    };

    // ADR-118 §3: идентификатор принятого сообщения — единый источник истины
    // (`message.id`). Тот же id уходит в HTTP-ответ `202`, в события
    // `message.accepted`/`message.enqueued` и в историю.
    const acceptedMessageId = message.id;

    // ADR-126 §2: user-directed хвост («@alice проверь») — сообщение
    // **человеку**, а не агенту. Оно попадает в историю сразу, публикует
    // `message.delivered` (ADR-118) и `message.mentioned` (ADR-126 §2 п. 7),
    // но **не** ставится в очередь, **не** попадает в `steerInbox` и **не**
    // запускает ход (ADR-126 §2 п. 5).
    const userMessageId = content ? generateStreamId() : acceptedMessageId;

    const persistUserDirected = async (): Promise<void> => {
      if (!userDirectedText) return;
      const userMessage: Message = {
        id: userMessageId,
        role: MessageRole.USER,
        // Порядковый номер — следующий за агентской частью (в истории сообщение
        // одно на запрос; seq у agent-части уже занят).
        seq: session.messages.length + 2,
        // ADR-126 §2 п. 6: хвост **новее** триггера (агентской части).
        ord: baseOrd + 1,
        origin: 'local',
        parts: userDirectedParts,
        content: userDirectedContent,
        createdAt: nowISO(),
        disabled: false,
        pinned: false,
        hidden: false,
        author,
        ...(turnPrincipal ? { principal: turnPrincipal } : {}),
        agentRole: body.agent || session.settings.agentRole,
        provider: body.provider || session.settings.provider,
        model: body.model || session.settings.model,
        // ADR-126 §2: упоминания пользователей (span'ы — в тексте хвоста).
        mentions: mentionSplit.mentions,
        metadata: {
          ...(body.metadata || {}),
          stream_id: userMessageId,
          // ADR-126 §2: признак user-directed сообщения (аддитивно).
          userDirected: true,
        },
      };
      await sessionManager.addMessage(sessionId, userMessage);
      // ADR-118 §4: сообщение материализовано в истории — `message.delivered`
      // (канал сессии): id, `ord`, роль, автор и принципал.
      eventBus.publish(sessionId, 'message.delivered', {
        messageId: userMessage.id,
        ord: userMessage.ord ?? 0,
        role: userMessage.role,
        ...(userMessage.author ? { author: userMessage.author } : {}),
        ...(userMessage.principal ? { principal: userMessage.principal } : {}),
      });
      // ADR-126 §2 п. 7: уведомление и бейдж. Self-mention допускается,
      // но уведомление себе не отправляется (п. 4).
      const notifiedUserIds = mentionSplit.mentions
        .map((mention) => mention.id)
        .filter((userId) => userId !== senderUserId);
      eventBus.publish(sessionId, 'message.mentioned', {
        message_id: userMessage.id,
        user_ids: [...new Set(notifiedUserIds)],
        session_id: sessionId,
      });
    };

    // ADR-104: `steer` — вмешательство в активный ход (без прерывания
    // генерации), `interrupt` — прерывание текущей генерации с продолжением
    // хода. Если активного хода нет — ведём себя как обычная очередь
    // (сообщение начнёт новый ход).
    if (turnActive) {
      const interruptMode = mode === 'interrupt';
      const steerResult = await enqueueSteerMessage(
        sessionManager, eventBus, sessionId, message, MAX_STEER_INJECTIONS_PER_TURN,
        (sid, msg) => orchestrator.obfuscateUserMessageForHistory(sid, msg),
        {
          interrupt: interruptMode,
          ...(turnPrincipal ? { principal: turnPrincipal } : {}),
          messageId: acceptedMessageId,
          ...(senderUserId ? { recipient: senderUserId } : {}),
        },
      );
      if (!steerResult.accepted) {
        // Вопрос не принят (лимит инъекций на ход) — контекст терминала из
        // `steerInbox` снимаем: без вопроса он остался бы в ходе один
        // (контракт — «контекст раньше вопроса»).
        if (contextInSteer && contextMessage) {
          await dropTerminalContextFromSteer(sessionManager, eventBus, sessionId, contextMessage);
        }
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
      // ADR-126 §2: user-directed хвост не участвует во вмешательстве.
      await persistUserDirected();
      if (interruptMode) {
        // Прерываем текущую генерацию: ход НЕ завершается («Стоп» — отдельный
        // механизм, ADR-005) — обрывается только стрим, а сообщение
        // вплетается на ближайшей границе шага. Порядок важен: сообщение уже
        // в очереди инъекций, поэтому инъекция гарантированно попадёт в ход.
        const liveStreamId = session.currentStream?.streamId;
        if (liveStreamId) orchestrator.interrupt(liveStreamId);
      }
      // ADR-118 §3: контракт приёма — `202 {messageId, mode, position}`.
      // Вмешательство не занимает позицию в очереди (свой счётчик `steerCount`),
      // поэтому `position` — `null`.
      return c.json({
        messageId: acceptedMessageId,
        mode,
        position: null,
      }, 202);
    }

    // ─── PROP-142 §1: дочерняя сессия саб-агента — без «скрытой третьей
    // семантики» (обычный процессор очереди сессии). Продолжение ведёт цикл
    // саб-агента: свободный ребёнок — продолжение с текстом указаний
    // (`startSubagentResume`), занятый — сообщение в его очередь
    // (`pendingMessages`), которую разберёт цикл ребёнка.
    if (content && isSubagentChild) {
      // Вложения в продолжении ребёнка не поддержаны (ADR-115: медиа-части
      // требуют контура очереди обычной сессии) — отказ до приёма.
      if (attachmentPaths && attachmentPaths.length > 0) {
        return c.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: messages.attachmentsToSubagentChild?.(c)
              ?? 'Вложения в дочернюю сессию саб-агента не поддерживаются',
          },
        }, 400);
      }
      if (!sessionTurnActive) {
        // Ребёнок свободен — продолжение с текстом: сообщение в его историю
        // пишет сам resume-путь (`appendContinuationMessage`) — второй раз не
        // добавляем.
        try {
          const started = await orchestrator.startSubagentResume(sessionId, { prompt: content });
          // ADR-126 §2: user-directed хвост («@alice …») — в историю сразу
          // (ход ребёнка его не ждёт).
          await persistUserDirected();
          return c.json({
            status: 'resumed',
            stream_id: started.stream_id,
            child_session_id: started.child_session_id,
          }, 202);
        } catch (err) {
          if (err instanceof SubagentResumeError) {
            return c.json({ error: { code: err.code, message: err.message } }, err.httpStatus as 400 | 404 | 409);
          }
          return c.json({ error: { code: 'INTERNAL_ERROR', message: String(err) } }, 500);
        }
      }
      if (mode === 'queue') {
        // Ребёнок занят — сообщение ждёт в его очереди (`pendingMessages`).
        // Автозапуска нет: цикл ребёнка разберёт очередь сам (PROP-142 §1).
        const queued = await requeueMessages({
          sessionManager,
          eventBus,
          sessionId,
          messages: [await orchestrator.obfuscateUserMessageForHistory(sessionId, message)],
        });
        if (queued.dropped > 0) {
          // Очередь ребёнка переполнена — сообщение не принято.
          return c.json({
            error: { code: 'QUEUE_FULL', message: messages.queueFull(c, 5) },
          }, 429);
        }
        // ADR-111 §detach: сообщение принято в очередь занятого ребёнка — его
        // блокирующие прогоны держат цикл саб-агента, поэтому переводим их в
        // фон (мастер-выключатель — общий, `background.enabled`).
        if (detachAfterQueue) await detachBlockingRuns(sessionId);
        // ADR-126 §2: user-directed хвост — в историю сразу.
        await persistUserDirected();
        const fresh = await sessionManager.getSession(sessionId);
        return c.json({
          messageId: acceptedMessageId,
          mode: 'queue',
          position: fresh?.pendingMessages.length ?? 1,
        }, 202);
      }
      // `steer`/`interrupt` при активном ходе — существующая ветка выше.
    }

    if (content) {
      const result = await enqueueUserMessage(
        sessionManager, eventBus, sessionId, message, queueManager, processMessage,
        (sid, msg) => orchestrator.obfuscateUserMessageForHistory(sid, msg),
        {
          ...(turnPrincipal ? { principal: turnPrincipal } : {}),
          messageId: acceptedMessageId,
          ...(senderUserId ? { recipient: senderUserId } : {}),
        },
      );

      if (!result) {
        // Очередь полна — вопрос не принят: контекст терминала откатываем
        // (в истории остался бы вывод терминала без вопроса, к которому он
        // относится).
        if (contextMessage) {
          await dropTerminalContextFromHistory(sessionManager, eventBus, sessionId, contextMessage);
        }
        return c.json({
          error: { code: 'QUEUE_FULL', message: messages.queueFull(c, 5) },
        }, 429);
      }

      // ADR-111 §detach: сообщение принято в очередь занятой сессии — ход всё
      // равно ждал бы завершения блокирующего прогона, поэтому переводим его в
      // фон. На отказе (`429 QUEUE_FULL`) ничего не трогаем.
      if (detachAfterQueue) await detachBlockingRuns(sessionId);

      // ADR-115: сообщение принято — фиксируем ссылки на объекты вложений.
      await registerAttachmentRefs(deps.attachments?.blobRefs, message.id, messageParts);

      // ADR-126 §2: user-directed хвост — в историю сразу (ход не ждёт его).
      await persistUserDirected();

      // ADR-118 §3: контракт приёма — **всегда** `202 {messageId, mode, position}`.
      // `text/event-stream` больше не возвращается: контракт приёма и контракт
      // наблюдения разведены (наблюдение за ходом — по шине событий, ADR-024).
      // Отмена соединения клиентом больше не рвёт наблюдение за ходом.
      return c.json({
        messageId: acceptedMessageId,
        mode: 'queue',
        position: result.pendingMessages.length,
      }, 202);
    }

    // ADR-126 §2 п. 1: сообщение начинается с `@user` — агент не запускается
    // вовсе, создаётся только пользовательское сообщение. Ответ — тот же
    // контракт приёма (`202`), но без позиции в очереди.
    await registerAttachmentRefs(deps.attachments?.blobRefs, userMessageId, userDirectedParts);
    await persistUserDirected();
    return c.json({
      messageId: acceptedMessageId,
      mode: 'queue',
      position: null,
    }, 202);
  });

  app.get('/:id/messages', auth.requireAuth, scoped('sessions:read'), async (c) => {
    const id = c.req.param('id');
    // Пагинация истории: `limit` (по умолчанию 200, максимум 500) и `before` —
    // исключающий **непрозрачный** курсор из `next_before` (сообщения строго
    // старше указанного; это значение ключа, не обязательно `seq`).
    const limit = parseBoundedInt(c.req.query('limit'), DEFAULT_MESSAGES_LIMIT, MAX_MESSAGES_LIMIT);
    if (limit === null) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'limit должен быть целым числом' } }, 400);
    }
    const beforeRaw = c.req.query('before');
    let before: number | undefined;
    if (beforeRaw !== undefined && beforeRaw.trim() !== '') {
      const parsed = Number(beforeRaw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'before должен быть целым неотрицательным числом' } }, 400);
      }
      before = parsed;
    }
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      try {
        // Параметры пагинации пробрасываются в удалённый мир. Ограничение:
        // старый удалённый сервер их игнорирует и отдаёт **всю** историю —
        // тогда нарезка по `seq`/`before`/`limit` делается локально (см.
        // `sliceRemoteMessages`), иначе клиент получил бы всю историю целиком.
        const remotePage = await remoteClient.getSessionMessages(toLocalId(id), { limit, before });
        const { page, hasMore, nextBefore } = sliceRemoteMessages(
          remotePage.messages,
          limit,
          before,
          remotePage.has_more,
          remotePage.next_before,
        );
        // session_id в ответе — ссылка на сущность: приводим к remote-ref.
        const sessionId = typeof remotePage.session_id === 'string'
          ? toRemoteRef(remotePage.session_id)
          : toRemoteRef(toLocalId(id));
        return c.json({
          messages: page,
          session_id: sessionId,
          has_more: hasMore,
          next_before: nextBefore,
        });
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    let session = await sessionManager.getSession(id);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const messagesDenied = serviceProjectProjection(c, session.projectId);
    if (messagesDenied) return messagesDenied;
    // История могла остаться с незафинализированным шагом (`status: 'streaming'`):
    // UI принимает такое сообщение за живой ход (индикатор «идёт», «Стоп»,
    // запись «прилипает» к концу ленты). Ремонт — только при отсутствии активного
    // стрима, идемпотентно; сбой не должен ломать чтение.
    if (!session.currentStream && session.messages.some(
      (m) => m.role === MessageRole.ASSISTANT && (m.status === 'streaming' || m.metadata?.streaming === true),
    )) {
      try {
        const repaired = await sessionManager.repairStaleStreamingMessages(session.id);
        if (repaired.session) session = repaired.session;
      } catch { /* best-effort */ }
    }
    // ADR-036: тот же носитель секретов, что и в `GET /:id` — право раскрытия
    // то же (решается в одной точке — `resolveCanRevealSecrets`).
    const canReveal = await resolveCanRevealSecrets(c, session);
    const { page, hasMore, nextBefore, startIndex } = selectMessagePage(session.messages, limit, before);
    return c.json({
      // `index` — позиция в **полной** истории (не в странице): клиент
      // склеивает страницы по нему.
      messages: page.map((m, i) => serializeMessage(m, startIndex + i, { redactSecrets: !canReveal })),
      session_id: session.id,
      has_more: hasMore,
      next_before: nextBefore,
    });
  });

  // GET /:id/messages/:messageId — одно сообщение истории (целевая загрузка).
  app.get('/:id/messages/:messageId', auth.requireAuth, scoped('sessions:read'), async (c) => {
    const id = c.req.param('id');
    const messageId = c.req.param('messageId');
    // Гибрид: сообщение ищется в истории своей сессии; его id не префиксуется.
    const forwarded = await forwardRemoteSession(
      c, id, (client, localId) => client.getSessionMessage(localId, messageId),
    );
    if (forwarded) return forwarded;
    const session = await sessionManager.getSession(id);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const messagesDenied = serviceProjectProjection(c, session.projectId);
    if (messagesDenied) return messagesDenied;
    const index = session.messages.findIndex((m) => m.id === messageId);
    if (index < 0) {
      return c.json(
        { error: { code: 'MESSAGE_NOT_FOUND', message: messages.messageNotFound(c) } },
        404,
      );
    }
    // ADR-036: то же право раскрытия секретов, что у списка (одна точка —
    // `resolveCanRevealSecrets`), DTO — как у элемента `GET /:id/messages`.
    const canReveal = await resolveCanRevealSecrets(c, session);
    return c.json(serializeMessage(session.messages[index]!, index, { redactSecrets: !canReveal }));
  });

  app.post('/:id/clear', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    // Гибрид: очистка истории — операция сессии её мира; ответ — её DTO.
    const cleared = await forwardRemoteSession(
      c, id, (client, localId) => client.clearSession(localId),
      (result) => toRemote(result as Record<string, unknown>),
    );
    if (cleared) return cleared;
    const existing = await sessionManager.getSession(id);
    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    // Правка — точечная (`mutateHistory`): свежий документ читается под локом
    // порта, поэтому конкурентная правка/дозапись сообщений не затирается
    // снимком clear (lost update). `updatedAt` двигается (паритет с
    // `withLock`+`updateSession`).
    const clearedResult = await sessionManager.mutateHistory(id, (s) => {
      s.messages = s.messages.filter((m) => m.pinned);
      s.pendingMessages = [];
      s.inputTokens = 0;
      s.outputTokens = 0;
      s.totalTokens = 0;
      s.inputCost = 0;
      s.outputCost = 0;
      s.cacheReadCost = 0;
      s.cacheWriteCost = 0;
    });
    if (!clearedResult.ok) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    // Точечный ответ — сводка **после** мутации (история уже очищена).
    const session = (await sessionManager.getSession(id)) ?? existing;
    // ADR-118 §4: история очищена (кроме закреплённых) — другие клиенты
    // перечитывают ленту; очередь сброшена (`pendingMessages = []`).
    eventBus.publish(id, 'session.messages.cleared', { session_id: id });
    publishQueueState(eventBus, id, { pendingCount: 0, steerCount: 0 });
    // ADR-119: `context_usage` — занятость контекста «прямо сейчас».
    return c.json(
      serializeSession(session, {
        agentRegistry,
        ...SUMMARY_SERIALIZE_OPTS,
        contextOptimizer: deps.contextOptimizer,
      }),
    );
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
    // когда `orchestrator.cancel` — no-op. Пишем **точечно** под локом порта,
    // чтобы не потерять конкурентную запись процессора (полный снимок затирал
    // параллельную дозапись сообщений); сбрасывает флаг сам процессор.
    // `updatedAt` не двигаем — паритет с прежним `saveSession`.
    await sessionManager.mutateMeta(id, (meta) => {
      meta.status.cancelRequested = true;
      meta.status.cancelRequestedAt = nowISO();
    }, { touchUpdatedAt: false });

    // Graceful-отмена активного стрима: оркестратор публикует stream.cancelled
    // и сохраняет частичный ответ (если токен ещё жив).
    if (session.currentStream) {
      orchestrator.cancel(session.currentStream.streamId);
    }

    // Прерываем backoff/активный LLM-вызов и цикл процессора немедленно.
    // Снятие blocked/currentStream/флага выполняет сам QueueProcessor; **очередь
    // сохраняется целиком** («Стоп» останавливает только активный ход —
    // решение владельца 2026-11-01), её продолжит `/queue/:sessionId/resume`
    // или новая постановка сообщения. НЕ вызываем queueManager.stop() —
    // иначе сессия остаётся «зависшей» (stalled). Если процессора нет — снимаем
    // флаг, иначе следующий запуск ложно отменится.
    if (!queueManager.requestStop(id)) {
      // Снятие флага/остановка — метаданные: та же точечная правка под локом
      // порта (`updatedAt` не двигаем — паритет с прежним `saveSession`).
      const reset = await sessionManager.mutateMeta(id, (meta) => {
        meta.status.cancelRequested = undefined;
        meta.status.cancelRequestedAt = undefined;
        // Осознанный «Стоп» при непустой очереди: после рестарта такую сессию
        // не автозапускаем, UI показывает баннер «Обработка остановлена».
        if (meta.pendingMessages.length > 0) {
          meta.status.queueStopped = true;
          meta.status.queueStoppedAt = nowISO();
        }
        return meta.pendingMessages.length;
      }, { touchUpdatedAt: false });
      const pendingCount = reset.found ? reset.value : 0;
      if (pendingCount > 0) {
        deps.eventBus.publish(id, 'queue.stalled', { pending_count: pendingCount });
      }
    }

    // ADR-104 (решение 2026-10-28): «Стоп» снимает неприменённые инъекции —
    // границы шага больше не будет, иначе сообщение применилось бы в начале
    // следующего хода. Best-effort: сбой хранилища/шины не должен превращать
    // «сессия уже отменена» в ошибку ответа (ответ остаётся 200 aborted).
    try {
      await dropSteerInjections({
        sessionManager,
        sessionId: id,
        reason: 'aborted',
        streamId: session.currentStream?.streamId,
        publishDropped: (event) => deps.eventBus.publish(id, 'steer.dropped', event),
        // ADR-104 × ADR-111/ADR-113: ни ввод пользователя, ни уведомления
        // фоновых прогонов не теряем — весь остаток возвращается в очередь.
        // Автостарта нет: ход остановил пользователь, сообщение ждёт его
        // решения (видно в панели очереди).
        requeue: async (messages) => {
          return requeueMessages({ sessionManager, eventBus: deps.eventBus, sessionId: id, messages });
        },
      });
    } catch (err) {
      console.warn(
        `[sessions] снятие очереди инъекций сессии ${id} не удалось: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Фоновые прогоны (фоновые саб-агенты и фоновые процессы) «Стоп» **не**
    // останавливает: как в opencode, «Стоп» прерывает только активный ход
    // (решение 2026-10-31, взамен 2026-10-28). Блокирующий саб-агент
    // останавливается сам — abort сигнала тула `task` → `run-cycle` видит
    // `isAborted` → `finishAborted`. Фоновые прогоны останавливаются явно:
    // `POST /api/v2/processes/:id/stop` либо «Стоп» их собственной сессии.
    // ADR-102: мера `activity.aborts` — на осях `user`/`project` сессии.
    void analytics?.recordActivity('aborts', sessionAxes(session));
    return c.json({ status: 'aborted' });
  });

  // POST /api/v2/sessions/:id/permissions/:approvalId — ответ на запрос
  // подтверждения **по HTTP** (ADR-029/ADR-106 Ф3).
  //
  // Зачем: WS-кадр `permission_reply` существует только в WS-транспорте. Клиент
  // на SSE/HTTP (фоллбек после падения WS) не мог ответить вовсе — запрос висел
  // до ask-таймаута. Семантика та же, что у WS: `allow|deny` проходят через
  // реестр подтверждений (ответ принимает носитель покрывающего гранта), `hold`
  // («остановить таймер») реестр не трогает.
  //
  // Тело: `{action: 'allow'|'deny'|'hold', once?: boolean, turn_id?: string,
  // digest?: string}`. Доступ — граничный prefix-guard (`/:id/*`, вид доступа
  // `write` из метода); в обработчике проверок нет (инвариант 16).
  app.post('/:id/permissions/:approvalId', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    const approvalId = (c.req.param('approvalId') ?? '').trim();
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const rawAction = body?.action;
    const action = rawAction === 'allow' || rawAction === 'deny' || rawAction === 'hold'
      ? rawAction
      : undefined;
    if (!approvalId || !action) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: messages.permissionInvalid(c) } },
        400,
      );
    }

    // Гибрид: ожидающий ask живёт на удалённом backend (`remote:<id>`) —
    // пересылаем решение туда (включая `hold`). Локальный `permission.replied`
    // не публикуется: событие/`session.updated` придёт по мосту.
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      const once = typeof body?.once === 'boolean' ? body.once : undefined;
      const turnId = typeof body?.turn_id === 'string' && body.turn_id.trim() !== ''
        ? body.turn_id
        : undefined;
      try {
        const res = await remoteClient.permissionReply(toLocalId(id), approvalId, {
          action,
          ...(once !== undefined ? { once } : {}),
          ...(turnId ? { turn_id: turnId } : {}),
          ...(typeof body?.digest === 'string' ? { digest: body.digest } : {}),
        });
        if (res.status >= 400) {
          return c.json(
            res.body ?? { error: { code: 'REMOTE_ERROR', message: 'Ошибка удалённого сервера' } },
            res.status as 400 | 401 | 403 | 404 | 409 | 500 | 502,
          );
        }
        return c.json(res.body ?? { status: 'ok', action });
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

    // ADR-029: вид ожидания — живое / уже закрытое в этом процессе /
    // восстановленное после рестарта инстанса (снимок из **хранилища
    // ожиданий**, а не из документа сессии).
    const resolution = orchestrator.resolvePendingApproval?.(session, approvalId);

    // Восстановленное ожидание: живого waiter'а нет (процесс, который его
    // ждал, умер) — разбудить прежний вызов нечем. Поэтому ответ применяется
    // как **грант в сессии** (тот же механизм, что «Разрешить в сессии»):
    // продолженный ход, задавший тот же вопрос, будет одобрен без нового
    // вопроса. «Запретить» — просто снимает ожидание.
    if (resolution?.kind === 'restored') {
      // «Остановить таймер» здесь бессмысленно: таймера нет (процесс, который
      // его поставил, умер) — останавливать нечего.
      if (action === 'hold') {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: messages.permissionInvalid(c) } },
          400,
        );
      }
      const approved = action === 'allow';
      if (approved) {
        // ADR-029: грант восстановленного ожидания считается по **той же**
        // схеме, что и живая ветка («Разрешить в сессии»): структурная причина
        // ask'а («виновник») берётся из снимка ожидания (`record.trigger`) —
        // только `params`/`askKind`, без служебных полей.
        //
        // У старых записей (снимок без trigger'а) виновник неизвестен → для
        // `execute_shell` грант **не выдаётся** (fail-closed в оркестраторе:
        // паттерн «на всю команду» шире одобренного — для `rm -rf /srv/data`
        // это вечный `rm *`). Одобрение снимает вопрос, правило в сессию не
        // пишется. Для не-shell тулов поведение прежнее (грант по путям).
        const record = resolution.record;
        const trigger = record.trigger
          ? { params: record.trigger.params, askKind: record.trigger.askKind }
          : undefined;
        await orchestrator.grantSessionToolAllow(
          session,
          record.toolName,
          record.arguments ?? {},
          trigger,
        );
      }
      // Снятие ожидания (реестр + хранилище ожиданий; счётчик DTO → 0).
      await orchestrator.clearPendingApproval?.(id, approvalId);
      eventBus.publish(id, 'permission.replied', {
        approval_id: approvalId,
        session_id: id,
        approved,
        action,
        restored: true,
      });
      return c.json({ status: 'ok', action });
    }

    // «Остановить таймер»: авто-отклонение по таймауту снимается, запрос ждёт
    // ответа. Реестр не трогаем — привязка ещё нужна для ответа.
    if (action === 'hold') {
      eventBus.publish(id, 'permission.hold', { approval_id: approvalId, session_id: id });
      return c.json({ status: 'ok', action: 'hold' });
    }

    const approved = action === 'allow';
    const once = typeof body?.once === 'boolean' ? body.once : undefined;
    const turnId = typeof body?.turn_id === 'string' && body.turn_id.trim() !== ''
      ? body.turn_id
      : undefined;

    // Реестр не задан (слой Authority выключен/в shadow) — поведение прежнее:
    // ответ принимается по факту доступа к сессии.
    const registry = deps.approvalRegistry;
    if (!registry) {
      eventBus.publish(id, 'permission.replied', {
        approval_id: approvalId,
        session_id: id,
        approved,
        action,
        ...(once !== undefined ? { once } : {}),
        ...(turnId ? { turn_id: turnId } : {}),
      });
      return c.json({ status: 'ok', action });
    }

    // Принципал-отвечающий — **аутентифицированный** (клиенту не доверяем).
    const responder = await (opts.resolvePermissionResponder ?? defaultPermissionResponder)(c);
    const claim = await registry.claim(approvalId, id, responder, {
      ...(turnId ? { turnId } : {}),
      ...(typeof body?.digest === 'string' && body.digest !== '' ? { digest: body.digest } : {}),
    });
    if (!claim.ok) {
      // Отказ (нет гранта / повторный ответ / чужой ход): подтверждение не
      // принимается, действие не выполняется.
      eventBus.publish(id, 'permission.replied', {
        approval_id: approvalId,
        session_id: id,
        approved: false,
        action: 'deny',
        reason: claim.reason,
      });
      return c.json({
        error: {
          code: 'APPROVAL_DENIED',
          message: messages.permissionDenied(c, claim.reason),
          details: { reason: claim.reason },
        },
      }, 403);
    }
    eventBus.publish(id, 'permission.replied', {
      approval_id: approvalId,
      session_id: id,
      approved,
      action,
      ...(once !== undefined ? { once } : {}),
      // Привязка — из реестра (серверный источник истины).
      principal: responder,
      turn_id: claim.binding?.turnId,
      digest: claim.binding?.digest,
    });
    return c.json({ status: 'ok', action });
  });

  // GET /api/v2/sessions/:id/permissions — ожидающие ответа подтверждения
  // сессии (ADR-029).
  //
  // Зачем: запрос подтверждения (`permission.asked`) существует только как
  // live-событие — после перезагрузки страницы (или протухшей аутентификации)
  // клиент ничего не знает: карточка подтверждения пропадает, а инструмент
  // висит до ask-таймаута. Этот эндпоинт — источник истины для восстановления
  // карточки: тот же снимок запроса, что уходил в событии.
  //
  // Формат ответа — snake_case, как payload события `permission.asked`
  // (`approval_id`/`tool`/`arguments`/`reason`/`ask_timeout_ms`), чтобы клиент
  // переиспользовал разбор. Дополнительно `asked_at` (ISO-8601 — от него
  // клиент считает остаток таймера) и `held` (пользователь нажал «Остановить
  // таймер» — запрос живёт до ответа, таймер не ставится).
  //
  // Доступ — граничный prefix-guard (`/:id/*`, вид доступа `read` из метода);
  // в обработчике проверок нет (инвариант 16).
  app.get('/:id/permissions', auth.requireAuth, scoped('sessions:read'), async (c) => {
    const id = c.req.param('id');
    // Гибрид: ожидание живёт на стороне сессии — форвард на удалённый backend
    // (права/валидация — на удалённой стороне, как у прочих форвардов).
    const forwarded = await forwardRemoteSession(
      c,
      id,
      (client, localId) => client.listSessionPermissions(localId),
      (result) => {
        const dto = (result ?? {}) as Record<string, unknown>;
        return { ...dto, permissions: Array.isArray(dto.permissions) ? dto.permissions : [] };
      },
    );
    if (forwarded) return forwarded;
    // ADR-029: живые ожидания (реестр в памяти процесса) + восстановленные
    // после рестарта инстанса (снимок из хранилища ожиданий; `restored: true`).
    const pending = orchestrator.listPendingApprovals(id);
    return c.json({ permissions: pending.map(toPendingPermissionDto) });
  });

  // POST /api/v2/sessions/:id/background — перевести идущие **блокирующие**
  // прогоны сессии в фон (ADR-111 §detach).
  //
  // Перевод односторонний: прогон продолжается уже как фоновый (свой
  // `AbortController`/`streamId`, публикация в родительский стрим отключена), а
  // блокирующее ожидание тула возвращает модели «переведено в фон». Доступ
  // проверяет граничный prefix-guard (`/:id/*`, вид доступа `write` из метода) —
  // в обработчике проверок нет (инвариант 16).
  app.post('/:id/background', auth.requireAuth, scoped('sessions:prompt'), async (c) => {
    const id = c.req.param('id');
    // Гибрид: detach требует ЖИВОЙ хэндл прогона в этом процессе. Удалённая
    // сессия его не даёт (и маршрута у remote-клиента нет) — fail-closed, без
    // «тихого» ответа: иначе пользователь считал бы прогон переведённым.
    if (hasRemoteGetter && isRemoteRef(id)) {
      return c.json({
        error: {
          code: 'DETACH_UNSUPPORTED',
          message: (messages.detachUnsupported ?? DEFAULT_MESSAGES.detachUnsupported!)(c),
        },
      }, 400);
    }
    const session = await sessionManager.getSession(id);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }

    // Тело необязательно: `{type?: 'subagent'|'process'}`; нет тела/поля — все
    // блокирующие прогоны сессии.
    let type: ActiveRunKind | undefined;
    const raw = await c.req.text().catch(() => '');
    if (raw.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return c.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: (messages.detachInvalidType ?? DEFAULT_MESSAGES.detachInvalidType!)(c),
          },
        }, 400);
      }
      if (parsed !== null && typeof parsed === 'object' && 'type' in parsed) {
        const value = (parsed as { type?: unknown }).type;
        if (value !== undefined && value !== null) {
          if (value !== 'subagent' && value !== 'process') {
            return c.json({
              error: {
                code: 'VALIDATION_ERROR',
                message: (messages.detachInvalidType ?? DEFAULT_MESSAGES.detachInvalidType!)(c),
              },
            }, 400);
          }
          type = value;
        }
      }
    }

    const result = await orchestrator.activeRuns.detachAll(id, type ? { type } : {});
    // Пустой `detached` — штатный исход (нечего переводить), не ошибка.
    // `failed` не включаем пустым массивом, чтобы не менять контракт ответа.
    return c.json({
      sessionId: id,
      detached: result.detached,
      ...(result.failed.length > 0 ? { failed: result.failed } : {}),
    });
  });

  // POST /api/v2/sessions/:id/resume-subagent — возобновить прерванную/ошибочную
  // дочернюю сессию саб-агента (B2). Валидация + блокировка синхронно, прогон —
  // в фоне; итог resume пишется в родительскую сессию.
  //
  // PROP-142 §2: тело необязательное — `{prompt?, model?, provider?}`: новые
  // указания (текст) и (необязательно) новая пара прогона ребёнка.
  app.post('/:id/resume-subagent', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    // Тело: пустое — «никаких указаний» (прежнее поведение).
    const rawBody = await c.req.text().catch(() => '');
    let resumeBody: SubagentResumeBody | null = {};
    if (rawBody.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: 'Некорректное тело запроса' },
        }, 400);
      }
      resumeBody = parseSubagentResumeBody(parsed);
      if (!resumeBody) {
        return c.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Поля prompt, model и provider должны быть строками',
          },
        }, 400);
      }
    }
    // Гибрид: прогон дочерней сессии живёт в процессе своего backend. Тело
    // уезжает как есть (старый сервер его игнорирует — совместимо); указаний
    // нет — запрос без тела (как раньше).
    const hasResumeBody = Object.keys(resumeBody).length > 0;
    const forwarded = await forwardRemoteSession(
      c,
      id,
      (client, localId) => (hasResumeBody
        ? client.resumeSubagent(localId, resumeBody)
        : client.resumeSubagent(localId)),
      undefined,
      202,
    );
    if (forwarded) return forwarded;
    try {
      const result = await orchestrator.startSubagentResume(id, resumeBody);
      return c.json(result, 202);
    } catch (err) {
      if (err instanceof SubagentResumeError) {
        return c.json({ error: { code: err.code, message: err.message } }, err.httpStatus as 400 | 404 | 409);
      }
      return c.json({ error: { code: 'INTERNAL_ERROR', message: String(err) } }, 500);
    }
  });

  // POST /api/v2/sessions/:id/recovery/retry — ручной повтор восстановления
  // после терминализации (PROP-142 §3.7): сбрасывает бюджет попыток и
  // запускает восстановление заново.
  //
  // Идемпотентность: сессия занята (идёт ход) → 409 `LOCKED`; восстанавливать
  // нечего → 200 `{status:'nothing_to_resume'}`. Дочерняя сессия саб-агента
  // возобновляется циклом саб-агента (`startSubagentResume`), основная —
  // продолжением незавершённого in-flight хода или запуском процессора очереди.
  //
  // Доступ — граничный prefix-guard (вид `write` из HTTP-метода); проверок
  // доступа в обработчике нет (инвариант 16).
  app.post('/:id/recovery/retry', auth.requireAuth, scoped('sessions:prompt'), async (c) => {
    const id = c.req.param('id');
    // Гибрид: восстановление живёт на стороне владельца данных — форвард.
    const forwarded = await forwardRemoteSession(
      c, id, (client, localId) => client.retrySessionRecovery(localId), undefined, 202,
    );
    if (forwarded) return forwarded;
    const session = await sessionManager.getSession(id);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    // Занята — повтор невозможен (ход идёт; сброс счётчика ждал бы его конца).
    if (session.currentStream || session.status?.blocked || isTurnActive(session, queueManager)) {
      return c.json({
        error: {
          code: 'LOCKED',
          message: messages.recoveryLocked?.(c) ?? 'Сессия занята — повтор восстановления невозможен',
        },
      }, 409);
    }
    // Сброс бюджета автовосстановления (PROP-142 §3): состояние «попыток не
    // было» снова достижимо.
    try {
      await resetRecoveryState(sessionManager, id);
    } catch {
      // Сессия могла исчезнуть между чтением и сбросом — решение ниже по
      // фактическому состоянию (ошибка не должна ронять ручной повтор).
    }
    // Дочерняя сессия саб-агента — продолжение ведёт цикл саб-агента.
    if (session.parentId && session.sessionOrigin === 'subagent') {
      try {
        const started = await orchestrator.startSubagentResume(id);
        return c.json({
          status: 'started',
          child_session_id: started.child_session_id,
          stream_id: started.stream_id,
        }, 202);
      } catch (err) {
        if (err instanceof SubagentResumeError) {
          return c.json({ error: { code: err.code, message: err.message } }, err.httpStatus as 400 | 404 | 409);
        }
        return c.json({ error: { code: 'INTERNAL_ERROR', message: String(err) } }, 500);
      }
    }
    // Основная сессия: незавершённый in-flight ход (сообщение уже в истории) —
    // продолжаем его как resume, иначе сообщение материализуется повторно.
    const resume = await sessionManager.takePendingInFlight(id);
    if (resume) {
      queueManager.createProcessor(id, sessionManager, eventBus, processMessage, { resumeMessage: resume });
      return c.json({
        status: 'resumed',
        stream_id: (resume.metadata?.stream_id as string | undefined) ?? null,
      }, 202);
    }
    // Очередь без активного хода — обычный запуск процессора (осознанно
    // остановленная очередь `queueStopped` не трогаем).
    if (session.pendingMessages.length > 0 && !session.status?.queueStopped) {
      queueManager.createProcessor(id, sessionManager, eventBus, processMessage);
      return c.json({ status: 'queued' }, 202);
    }
    return c.json({ status: 'nothing_to_resume' }, 200);
  });

  app.post('/:id/summarize', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    // ADR-119: профиль сжатия (`summarization` — итоги беседы, `compaction` —
    // рабочее состояние по коду/проекту). Тело или query; по умолчанию —
    // `summarization` (значение по умолчанию).
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const rawMode = typeof body.mode === 'string' && body.mode !== ''
      ? body.mode
      : (c.req.query('mode') ?? '');
    let mode: CompressionMode = 'summarization';
    if (rawMode !== '') {
      if (rawMode !== 'summarization' && rawMode !== 'compaction') {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'mode должен быть "summarization" или "compaction"' } }, 400);
      }
      mode = rawMode;
    }
    if (hasRemoteGetter && isRemoteRef(id)) {
      const remoteClient = resolveClient();
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      try {
        const result = await remoteClient.summarizeSession(toLocalId(id), mode);
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
    // Профиль задан явно — проверка по нему, а не по эффективному режиму
    // сессии: ручной запуск работает независимо от авто-стратегии (ADR-119).
    const canCompress = typeof deps.contextOptimizer.canCompress === 'function'
      ? deps.contextOptimizer.canCompress(session, mode)
      : deps.contextOptimizer.canSummarize(session);
    if (!canCompress) {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'No messages to compress (need at least one full turn before the tail)' } }, 400);
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
      metadata: { type: 'summarization_request', reason: 'manual', mode, stream_id: streamId },
    };

    // ADR-106 Ф4: принципал инициатора (ручная суммаризация — ввод от
    // пользователя, а не системный ход).
    // ADR-140 Ф2: снимок групп пользователя — вместе с принципалом.
    const summarizerPrincipal = resolveUserPrincipal(await resolveUserId(c), [], resolveUserGroups(c));
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

  app.get('/:id/children', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    // Гибрид: дети — сущности своего мира, id возвращаются с `remote:`.
    const forwarded = await forwardRemoteSession(
      c, id, (client, localId) => client.getSessionChildren(localId),
      (result) => (Array.isArray(result) ? result : []).map((child) => toRemote(child as Record<string, unknown>)),
    );
    if (forwarded) return forwarded;
    const children = await sessionManager.getChildren(id);
    // ADR-036: у детей своя привилегия раскрытия (владелец — свой).
    return c.json(await Promise.all(children.map((s) => serializeForReader(c, s))));
  });

  app.get('/:id/tree', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    // Гибрид: дерево — сырые сессии удалённого мира. `toRemote` переписывает
    // `id`, а `projectId`/`parentId` (camelCase сырой сессии) — отдельно.
    const forwarded = await forwardRemoteSession(
      c, id, (client, localId) => client.getSessionTree(localId),
      (result) => {
        const mapNode = (node: unknown): unknown => {
          if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
          const record = { ...(node as Record<string, unknown>) };
          const raw = record.session;
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const session = toRemote(raw as Record<string, unknown>) as Record<string, unknown>;
            if (typeof session.projectId === 'string') session.projectId = toRemoteRef(session.projectId);
            if (typeof session.parentId === 'string') session.parentId = toRemoteRef(session.parentId);
            record.session = session;
          }
          if (Array.isArray(record.children)) record.children = record.children.map(mapNode);
          return record;
        };
        return mapNode(result);
      },
    );
    if (forwarded) return forwarded;
    const tree = await sessionManager.getSessionTree(id);
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
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    // Гибрид: форк — копия истории удалённого мира; ответ получает `remote:`.
    const forkedRemote = await forwardRemoteSession(
      c, id, (client, localId) => client.forkSession(localId, body as Record<string, unknown>),
      (result) => toRemote(result as Record<string, unknown>), 201,
    );
    if (forkedRemote) return forkedRemote;
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
    const fork = await sessionManager.forkSession(id, forkOptions);
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
    // Точечный ответ — сводка без истории.
    // ADR-119: `context_usage` — занятость контекста «прямо сейчас».
    return c.json(
      serializeSession(fork, {
        agentRegistry,
        ...SUMMARY_SERIALIZE_OPTS,
        contextOptimizer: deps.contextOptimizer,
      }),
      201,
    );
  });

  /** Ссылка удалённой сессии: `sessionId`/`session_id` переписываются в `remote:`. */
  const toRemoteReference = (ref: unknown): unknown => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return ref;
    const out = { ...(ref as Record<string, unknown>) };
    if (typeof out.sessionId === 'string') out.sessionId = toRemoteRef(out.sessionId);
    if (typeof out.session_id === 'string') out.session_id = toRemoteRef(out.session_id);
    return out;
  };

  // GET /api/v2/sessions/:id/references — список ссылок
  app.get('/:id/references', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    // Гибрид: ссылки — сущности своего мира; id сессий-источников → `remote:`.
    const forwarded = await forwardRemoteSession(
      c, id, (client, localId) => client.getSessionReferences(localId),
      (result) => {
        const dto = (result ?? {}) as Record<string, unknown>;
        return {
          ...dto,
          references: Array.isArray(dto.references) ? dto.references.map(toRemoteReference) : [],
        };
      },
    );
    if (forwarded) return forwarded;
    const session = await sessionManager.getSession(id);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const refs = await sessionManager.getReferences(id);
    return c.json({ references: refs });
  });

  // POST /api/v2/sessions/:id/references — добавить ссылку
  app.post('/:id/references', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    // Гибрид: `remote:`-сессия-источник уходит на её backend без префикса.
    const forwarded = await forwardRemoteSession(
      c, id, (client, localId) => {
        const outgoing = { ...(body as Record<string, unknown>) };
        if (typeof outgoing.source_session_id === 'string') outgoing.source_session_id = toLocalId(outgoing.source_session_id);
        if (typeof outgoing.sourceSessionId === 'string') outgoing.sourceSessionId = toLocalId(outgoing.sourceSessionId);
        return client.addSessionReference(localId, outgoing);
      },
      (result) => {
        const dto = (result ?? {}) as Record<string, unknown>;
        return { ...dto, ...(dto.reference ? { reference: toRemoteReference(dto.reference) } : {}) };
      },
      201,
    );
    if (forwarded) return forwarded;
    const sourceSessionId = body.source_session_id || body.sourceSessionId;
    if (!sourceSessionId) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'source_session_id is required' } }, 400);
    }
    const ref = await sessionManager.addReference(id, sourceSessionId, {
      label: body.label,
      messageRange: body.message_range || body.messageRange,
      autoSummarize: body.auto_summarize ?? body.autoSummarize ?? false,
      position: body.position,
    });
    eventBus.publish(id, 'session.reference.added', { reference: ref });
    return c.json({ reference: ref }, 201);
  });

  // DELETE /api/v2/sessions/:id/references/:refSid — удалить ссылку
  app.delete('/:id/references/:refSid', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    const refSid = c.req.param('refSid');
    // Гибрид: id сессии-источника — удалённый, префикс снимается.
    const forwarded = await forwardRemoteSession(
      c, id, (client, localId) => client.removeSessionReference(localId, toLocalId(refSid)),
      undefined,
      204,
    );
    if (forwarded) return forwarded;
    await sessionManager.removeReference(id, refSid);
    eventBus.publish(id, 'session.reference.removed', { session_id: refSid });
    return c.body(null, 204);
  });

  // POST /api/v2/sessions/:id/messages/merge — копировать сообщения из другой сессии
  app.post('/:id/messages/merge', chainMiddleware([auth.requireAuth, ...mergeMiddleware]), async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    // Гибрид: копирование идёт внутри мира целевой сессии; `remote:`-источник
    // передаётся без префикса.
    const forwarded = await forwardRemoteSession(
      c, id, (client, localId) => {
        const outgoing = { ...(body as Record<string, unknown>) };
        if (typeof outgoing.source_session_id === 'string') outgoing.source_session_id = toLocalId(outgoing.source_session_id);
        if (typeof outgoing.sourceSessionId === 'string') outgoing.sourceSessionId = toLocalId(outgoing.sourceSessionId);
        return client.mergeSessionMessages(localId, outgoing);
      },
      undefined,
      201,
    );
    if (forwarded) return forwarded;
    const sourceSessionId = body.source_session_id || body.sourceSessionId;
    const sourceRange = body.source_range || body.sourceRange;
    const position = body.position || 'after';
    const anchorMessageId = body.anchor_message_id || body.anchorMessageId;
    const summarize = body.summarize || false;

    if (!sourceSessionId || !sourceRange || !Array.isArray(sourceRange) || sourceRange.length !== 2) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'source_session_id and source_range are required' } }, 400);
    }

    const merged = await sessionManager.mergeMessages(id, sourceSessionId, {
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

    eventBus.publish(id, 'session.messages.merged', {
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

  /** Вопрос удалённой сессии: `sessionId`/`session_id` → `remote:` (id вопроса — как есть). */
  const toRemoteQuestion = (question: unknown): unknown => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) return question;
    const out = { ...(question as Record<string, unknown>) };
    if (typeof out.sessionId === 'string') out.sessionId = toRemoteRef(out.sessionId);
    if (typeof out.session_id === 'string') out.session_id = toRemoteRef(out.session_id);
    return out;
  };

  // GET /api/v2/sessions/:id/questions — вопросы сессии.
  app.get('/:id/questions', auth.requireAuth, scoped('sessions:read'), async (c) => {
    const id = c.req.param('id');
    const status = c.req.query('status');
    const limitRaw = c.req.query('limit');
    // Гибрид: вопросы и их ожидание живут на стороне сессии; query — как есть
    // (валидацию делает удалённая сторона, локальная проверка ниже не меняется).
    const forwarded = await forwardRemoteSession(
      c, id, (client, localId) => client.listSessionQuestions(localId, {
        ...(status !== undefined ? { status } : {}),
        ...(limitRaw !== undefined ? { limit: limitRaw } : {}),
      }),
      (result) => {
        const dto = (result ?? {}) as Record<string, unknown>;
        return {
          ...dto,
          questions: Array.isArray(dto.questions) ? dto.questions.map(toRemoteQuestion) : [],
        };
      },
    );
    if (forwarded) return forwarded;
    const questionService = deps.questionService;
    if (!questionService) return questionsUnavailable(c);

    if (status !== undefined && !QUESTION_STATUSES.includes(status as QuestionStatus)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: `Недопустимый status: ${status}` },
      }, 400);
    }
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
      sessionId: id,
      ...(status ? { status: status as QuestionStatus } : {}),
      limit,
    });
    return c.json({ questions });
  });

  // POST /api/v2/sessions/:id/questions/:qid/answer — ответ пользователя.
  app.post('/:id/questions/:qid/answer', auth.requireAuth, scoped('sessions:prompt'), async (c) => {
    const sessionId = c.req.param('id');
    const questionId = c.req.param('qid');
    const body = await c.req.json().catch(() => null);
    // Гибрид: ответ принимает сторона, где ждёт вопрос (до проверки сервиса —
    // иначе удалённая сессия получила бы 503).
    const forwarded = await forwardRemoteSession(
      c, sessionId,
      (client, localId) => client.answerSessionQuestion(localId, questionId, (body ?? {}) as Record<string, unknown>),
      (result) => {
        const dto = (result ?? {}) as Record<string, unknown>;
        return { ...dto, ...(dto.question ? { question: toRemoteQuestion(dto.question) } : {}) };
      },
    );
    if (forwarded) return forwarded;
    const questionService = deps.questionService;
    if (!questionService) return questionsUnavailable(c);

    const parsed = questionAnswerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'answers должен быть массивом массивов строк' },
      }, 400);
    }

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
    const sessionId = c.req.param('id');
    const questionId = c.req.param('qid');
    const body = await c.req.json().catch(() => ({}));
    // Гибрид: отмена — на стороне сессии (до проверки сервиса).
    const forwarded = await forwardRemoteSession(
      c, sessionId,
      (client, localId) => client.cancelSessionQuestion(localId, questionId, body as Record<string, unknown>),
      (result) => {
        const dto = (result ?? {}) as Record<string, unknown>;
        return { ...dto, ...(dto.question ? { question: toRemoteQuestion(dto.question) } : {}) };
      },
    );
    if (forwarded) return forwarded;
    const questionService = deps.questionService;
    if (!questionService) return questionsUnavailable(c);

    const parsed = questionCancelSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'reason должен быть строкой' },
      }, 400);
    }

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
