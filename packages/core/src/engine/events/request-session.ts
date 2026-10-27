import type {
  EventAttachmentRef,
  EventBinding,
  EventIdentity,
  EventType,
  Message,
  Part,
  RouteDecision,
  Session,
  SessionRequest,
  SessionSettings,
  SynthEvent,
} from '@itphx/synth-shared';
import {
  MessageRole,
  appendMediaPlaceholders,
  generateId,
  makeMediaPart,
  makeTextPart,
  mediaTypeOfMime,
  nowISO,
} from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import { parseTtl } from '../../sessions/ephemeral.js';
import type { BlobRefRepository } from '../../storage/ports/blob-ref-repository.js';
import type { EventBindingRepository } from '../../storage/ports/event-binding-repository.js';
import type { HookBus } from '../hooks/hook-bus.js';
import type { EventRouter } from './event-router.js';
import type { PipelineTracker } from './pipeline-tracker.js';
import type { EventDelivery, EventDeliveryContext } from './types.js';
import { resolveEffectiveRoles } from './identity-roles.js';

/** ADR-089: runtime-контекст явного создания сессии (не поля события). */
export interface RequestSessionOptions {
  userId?: string;
  ownerId?: string;
}

/**
 * ADR-089: дефолтные `provider`/`model` инстанса для сессий, материализуемых
 * funnel'ом. Источник задаёт потребитель (`deps.resolveLlmDefaults`): standalone
 * core — `llm.defaultProvider`/`llm.defaultModel`; managed backend — свой.
 * Пустые поля трактуются как «не задано».
 */
export interface LlmDefaults {
  provider?: string;
  model?: string;
}

/**
 * ADR-089 (claim-flow): короткий одноразовый код подтверждения владения внешней
 * идентичностью. Возвращается ingest'ом наверх (`POST /api/v2/events` →
 * `identityHint`) и доставляется отправителю чата.
 */
export interface IdentityClaimHint {
  /** Человековводимый код `XXX-XXX`. */
  code: string;
  /** ISO-8601 — срок действия кода. */
  expiresAt: string;
}

export interface RequestSessionServiceDeps {
  sessionManager: SessionManager;
  eventRouter: EventRouter;
  /**
   * ADR-089 (auto-bind): реестр привязок — материализация решения `kind: 'bind'`
   * создаёт/переиспользует `EventBinding` (`mode='bound'`).
   */
  bindingStore: EventBindingRepository;
  hooks?: HookBus;
  config: { defaultEphemeralTtl: string; unknownAgentTemplate?: 'drop' | 'default-agent' };
  deliver: EventDelivery;
  /**
   * ADR-089: резолвер `agentTemplate` → id существующего enabled-агента
   * (`AgentRegistry`). Возвращает `null`, если шаблон неизвестен. Отсутствие
   * резолвера — шаблон принимается как есть (прежнее поведение).
   */
  resolveAgentTemplate?: (template: string) => string | null;
  /**
   * ADR-089: публикация UI-события после успешной материализации внешнего
   * события. Вызывается только при наличии сессии; `app.ts` прокидывает
   * `eventBus.publish`.
   */
  publish?: (type: EventType, sessionId: string, data: Record<string, unknown>) => void;
  /**
   * ADR-089: резолвер владельца сессий, материализуемых внешним событием
   * (`ephemeral`/`bind`). Нужен, чтобы такие сессии не выпадали из
   * `listSessions({ userId })` и UI-списка. Standalone core передаёт `local`
   * (паритет с `POST /api/v2/sessions`); managed backend — не задаёт, владелец
   * приходит per-event (`opts.ownerId`) либо через внешний резолвер/`identityMap`.
   * Не задан — прежнее поведение (сессия без владельца).
   */
  resolveOwnerId?: () => string | Promise<string | undefined>;
  /**
   * ADR-089: резолвер дефолтных `provider`/`model` инстанса для сессий,
   * материализуемых funnel'ом (explicit/`ephemeral`/`bind`). Нужен, чтобы
   * сессия из внешнего события (напр. Telegram-шлюз) получала те же дефолты,
   * что и сессия без явной модели, и агент мог ответить. Явно заданные в
   * `settings` значения приоритетнее; не задан резолвер либо пустые значения —
   * прежнее поведение (поля остаются незаданными). Standalone core передаёт
   * `llm.defaultProvider`/`llm.defaultModel`; managed backend — свой источник.
   */
  resolveLlmDefaults?: () => LlmDefaults | Promise<LlmDefaults>;
  /**
   * ADR-089: резолвер агента по умолчанию инстанса (`DEFAULT_AGENT_ID` либо
   * runtime-настройка «Агенты»). Применяется при материализации сессий
   * `ephemeral`/`bind`, когда шаблон события (`decision.agentTemplate`) пуст или
   * не резолвится. Без этого сессия из внешнего события создавалась без
   * `settings.agentRole` — оркестратор не писал `agent` в assistant-сообщение и
   * UI не рисовал бейдж агента (фактически отвечает дефолтный агент, но нигде не
   * зафиксирован). Явно заданный/резолвленный шаблон приоритетнее; неизвестный
   * шаблон при `unknownAgentTemplate: drop` по-прежнему исключение (дефолт его не
   * маскирует). Не задан — прежнее поведение (`agentRole` не проставляется).
   */
  resolveDefaultAgent?: () => string | Promise<string>;
  /**
   * ADR-089: резолвинг внешнего отправителя (`identity.principalId`) в пользователя
   * инстанса (id + отображаемое имя). Источник: профиль (`identities`) →
   * override `identityMap`. Применяется при материализации сессий
   * `ephemeral`/`bind`; приоритет выше `identityMap` и per-event владельца —
   * **человек, а не чат** определяет владельца. Чат-fallback — внутри резолвера.
   * `null`/не задан — прежняя логика. Может быть асинхронным (профиль читается с
   * диска) — funnel дожидается результата.
   */
  resolveExternalIdentity?: (
    identity: EventIdentity,
  ) => { userId: string; displayName?: string; roles?: string[] } | null | Promise<{ userId: string; displayName?: string; roles?: string[] } | null>;
  /**
   * ADR-089: маппинг идентичности внешнего отправителя (`identity.principalId` или
   * `identity.chatKey`) на владельца синт-сессии (id пользователя
   * инстанса). Применяется при материализации сессий `ephemeral`/`bind`;
   * приоритет выше per-event владельца. Не задан/пусто — прежняя логика.
   */
  identityMap?: Record<string, string>;
  /**
   * ADR-089: колбэк после создания/материализации сессии (explicit/`ephemeral`/
   * `bind`), но **до** доставки события в неё. Backend связывает его с
   * `EventHub.subscribeToSession(ownerId, sessionId)`, чтобы клиенты владельца,
   * подключённые до создания сессии, получали её события (иначе сессии,
   * созданные funnel'ом, терялись — `0 subscribers`).
   */
  onSessionMaterialized?: (session: Session) => void | Promise<void>;
  /**
   * ADR-089 (claim-flow): выпуск одноразового claim-кода, когда отправитель
   * события не сопознан с пользователем инстанса (`resolveExternalIdentity`
   * вернул `null`) и у него задан `identity.principalId`. Инъекция: стор
   * (`IdentityClaimStore`) передаётся потребителем (app.ts), funnel жёстко его не
   * держит. `null` — код не выпускается (резолвер дал результат, нет
   * `principalId`, `principalId` не парсится в `provider:externalId`).
   * Вызывается в `handleEvent`; результат уходит в ответ ingest'а.
   */
  issueIdentityClaim?: (event: SynthEvent) => Promise<IdentityClaimHint | null>;
  /**
   * ADR-089/ADR-051: учёт экземпляров пайплайна (ADR-100). Решение Router'а
   * с `pipeline: {id, step}` означает «событие `waitsFor` продвинуло автомат
   * пайплайна `id` к шагу `step`» — трекер ведёт экземпляр (создание либо
   * продвижение) в ядре, а add-on отдаёт артефакт по id.
   *
   * Учёт — **best-effort** (как `onSessionMaterialized`): ошибка записи
   * экземпляра не ломает доставку события. Не задан — состояние пайплайнов
   * не ведётся (прежнее поведение).
   */
  pipelineTracker?: PipelineTracker;
}

/**
 * ADR-089: извлекает текст сообщения из нормализованного события. Если `payload` —
 * объект с непустым строковым `text`, возвращает его.
 *
 * ADR-115 × ADR-089: у **медиа-события** (голосовое/фото из шлюза) текста нет,
 * но есть вложения — возвращается пустая строка. Служебный `payload`
 * (`{chatId, attachment: {kind: 'voice', …}}`) в диалог и модель не уходит:
 * `content` соберётся из плейсхолдеров вложений (`appendMediaPlaceholders`).
 * JSON-сериализация payload остаётся только для событий **без** вложений
 * (ci/webhook и прочие служебные события — там это единственный осмысленный
 * текст). Экспортируется для тестов и инъектируемого `deliver`.
 */
export function eventToMessageText(event: SynthEvent): string {
  const payload = event.payload;
  if (payload && typeof payload === 'object') {
    const text = (payload as { text?: unknown }).text;
    if (typeof text === 'string' && text.length > 0) return text;
  }
  if ((event.attachments?.length ?? 0) > 0) return '';
  const serialized = JSON.stringify(payload);
  return typeof serialized === 'string' ? serialized : '';
}

/**
 * ADR-089: ссылка на шаг пайплайна из решения Router'а. Поле есть только у
 * решений `ephemeral`/`bind` (там, где решение порождает сессию); в
 * `bound`/`queue` его нет (его отвергает схема цели) — поэтому проверяем
 * наличие поля, а не обращаемся к нему напрямую.
 */
function pipelineRefOf(decision: RouteDecision): { id: string; step: string } | undefined {
  return 'pipeline' in decision ? decision.pipeline : undefined;
}

/**
 * ADR-089: человекочитаемое имя отправителя внешнего события из `payload.from`
 * (без обращения к профилю): `username` → `@username`; иначе `firstName lastName`;
 * иначе `undefined`. Используется для атрибуции автора (owner — отдельно,
 * `resolveExternalIdentity`/`identityMap`).
 */
function eventAuthorFromPayload(event: SynthEvent): string | undefined {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const from = (payload as { from?: unknown }).from;
  if (!from || typeof from !== 'object') return undefined;
  const { username, firstName, lastName } = from as {
    username?: unknown;
    firstName?: unknown;
    lastName?: unknown;
  };
  if (typeof username === 'string' && username.trim()) return `@${username.trim()}`;
  const name = [firstName, lastName]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim())
    .join(' ');
  return name || undefined;
}

/**
 * Собирает user-сообщение из события (единый формат для `deliver` core/backend).
 *
 * ADR-051: для `source === 'cron'` сообщение помечается автором `Scheduler`, а в
 * `metadata` добавляются `scheduler`/`schedule_id`/`schedule_name`; `content` —
 * чистый текст задания без описания (описание «кто такой Scheduler» — в
 * статическом system-блоке `scheduler` промпта).
 *
 * ADR-089 (attribution): для **всех** внешних источников в `metadata` попадают
 * `principal_id`/`chat_key`/`thread_key` (если заданы), а `author` выводится из
 * `payload.from` (username → `@username`; иначе `firstName lastName`; иначе
 * `principalId` — напр. `tg:123`); cron-ветка не меняется (`Scheduler`). Для
 * прочих источников (без `from`/`principalId`) `author` не задаётся — прежнее
 * поведение.
 */
export function eventToMessage(event: SynthEvent): Message {
  const text = eventToMessageText(event);
  const isCron = event.source === 'cron';
  const attachments = event.attachments ?? [];

  const metadata: Record<string, unknown> = {
    source: event.source,
    event_id: event.id,
    dedup_key: event.dedupKey,
    ...(event.identity?.principalId ? { principal_id: event.identity.principalId } : {}),
    ...(event.identity?.chatKey ? { chat_key: event.identity.chatKey } : {}),
    ...(event.identity?.threadKey ? { thread_key: event.identity.threadKey } : {}),
    // ADR-115 × ADR-089: счётчик вложений — для аудита/UI (байты — в blob).
    ...(attachments.length > 0 ? { attachments_count: attachments.length } : {}),
  };

  if (isCron) {
    const payload =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as { scheduleId?: unknown; name?: unknown })
        : {};
    metadata.scheduler = true;
    if (typeof payload.scheduleId === 'string' && payload.scheduleId) {
      metadata.schedule_id = payload.scheduleId;
    }
    if (typeof payload.name === 'string' && payload.name) {
      metadata.schedule_name = payload.name;
    }
  }

  // ADR-089: cron — системный автор; внешние события — из `payload.from` /
  // `principalId`; прочие — без автора (прежнее поведение).
  const author = isCron
    ? 'Scheduler'
    : eventAuthorFromPayload(event) ?? event.identity?.principalId;

  // ADR-115 × ADR-089: вложения события — медиа-части сообщения (текст первым,
  // порядок ссылок события сохраняется). `content` — текст + плейсхолдеры
  // `[image: name]`: без них факт вложения «испарился» бы в строковых
  // производных (экспорт, поиск, PG-маппинг `messages.content`). Медиа-событие
  // без текста даёт `content` **ровно из плейсхолдеров** — служебный payload
  // (`chatId`, `attachment`) в сообщение не попадает.
  const parts: Part[] = [makeTextPart(text)];
  for (const attachment of attachments) {
    parts.push(
      makeMediaPart(mediaTypeOfMime(attachment.mime), {
        blobPath: attachment.blobPath,
        sha256: attachment.sha256,
        mime: attachment.mime,
        size: attachment.size,
        ...(attachment.name ? { name: attachment.name } : {}),
      }),
    );
  }
  const content = attachments.length > 0 ? appendMediaPlaceholders(text, parts) : text;

  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts,
    content,
    ...(author ? { author } : {}),
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    metadata,
  };
}

/**
 * ADR-115 × ADR-089: привязать вложения события к сообщению (учёт `blob_refs`).
 *
 * Без ссылки GC (`attachments.gcDays`) удалил бы объект, хотя сообщение на него
 * ссылается. Вызывается **после** успешной постановки сообщения в очередь:
 * `ownerId` — id того же сообщения, которое попадёт в историю (`eventToMessage`
 * генерирует его до постановки, обфускация id сохраняет).
 *
 * Best-effort: ошибка учёта не отменяет доставку (ссылка — производная),
 * пишется в лог. Возвращает число учтённых ссылок (для тестов/диагностики).
 */
export async function addEventAttachmentRefs(
  blobRefs: BlobRefRepository | undefined,
  event: SynthEvent,
  messageId: string,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<number> {
  const attachments: EventAttachmentRef[] = event.attachments ?? [];
  if (!blobRefs || attachments.length === 0 || !messageId) return 0;
  let added = 0;
  for (const attachment of attachments) {
    try {
      await blobRefs.add({
        blobPath: attachment.blobPath,
        ownerKind: 'message',
        ownerId: messageId,
      });
      added += 1;
    } catch (err) {
      log(
        `[events] не удалось учесть ссылку на вложение ${attachment.blobPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return added;
}

/**
 * ADR-089 (claim-flow): «машинный» владелец сессии — синтетический пользователь
 * service-key/шлюза (`service:<keyId>`, ADR-052). Такие владельцы переустанавливаются
 * человеку-отправителю, когда тот сопознан (`_maybeReassignOwner`); «человеческие»
 * владельцы не трогаются.
 */
function isMachineOwnerId(ownerId: string | undefined): boolean {
  return typeof ownerId === 'string' && ownerId.startsWith('service:');
}

/** Заголовок ephemeral-сессии из события: первая строка текста либо `type`. */
function eventTitle(event: SynthEvent): string | undefined {
  const text = eventToMessageText(event).trim();
  if (text) {
    const firstLine = text.split('\n', 1)[0]?.trim();
    if (firstLine) return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
  }
  return event.type || undefined;
}

/**
 * Единый funnel создания сессий.
 *
 * - `request` — явное создание (UI/CLI/агент): эмит `session_requested`, создание
 *   сессии (при `mode='ephemeral'` — с `expiresAt`). Без приёма/доставки события.
 * - `handleEvent` — приём внешнего события: `external_event` → `decide` →
 *   материализация (`deliver`) → `record`. Ошибки материализации фиксируются в
 *   журнале и не пробрасываются наружу (Router не роняет вызывающего).
 */
export class RequestSessionService {
  private _sessionManager: SessionManager;
  private _eventRouter: EventRouter;
  private _bindingStore: EventBindingRepository;
  private _hooks?: HookBus;
  private _config: { defaultEphemeralTtl: string; unknownAgentTemplate: 'drop' | 'default-agent' };
  private _deliver: EventDelivery;
  private _resolveAgentTemplate?: (template: string) => string | null;
  private _publish?: (type: EventType, sessionId: string, data: Record<string, unknown>) => void;
  private _resolveOwnerId?: () => string | Promise<string | undefined>;
  private _resolveLlmDefaults?: () => LlmDefaults | Promise<LlmDefaults>;
  private _resolveDefaultAgent?: () => string | Promise<string>;
  private _resolveExternalIdentity?: (
    identity: EventIdentity,
  ) => { userId: string; displayName?: string; roles?: string[] } | null | Promise<{ userId: string; displayName?: string; roles?: string[] } | null>;
  private _identityMap?: Record<string, string>;
  private _onSessionMaterialized?: (session: Session) => void | Promise<void>;
  private _issueIdentityClaim?: (event: SynthEvent) => Promise<IdentityClaimHint | null>;
  private _pipelineTracker?: PipelineTracker;

  constructor(deps: RequestSessionServiceDeps) {
    this._sessionManager = deps.sessionManager;
    this._eventRouter = deps.eventRouter;
    this._bindingStore = deps.bindingStore;
    this._hooks = deps.hooks;
    this._config = {
      defaultEphemeralTtl: deps.config.defaultEphemeralTtl,
      unknownAgentTemplate: deps.config.unknownAgentTemplate ?? 'drop',
    };
    this._deliver = deps.deliver;
    this._resolveAgentTemplate = deps.resolveAgentTemplate;
    this._publish = deps.publish;
    this._resolveOwnerId = deps.resolveOwnerId;
    this._resolveLlmDefaults = deps.resolveLlmDefaults;
    this._resolveDefaultAgent = deps.resolveDefaultAgent;
    this._resolveExternalIdentity = deps.resolveExternalIdentity;
    this._identityMap = deps.identityMap;
    this._onSessionMaterialized = deps.onSessionMaterialized;
    this._issueIdentityClaim = deps.issueIdentityClaim;
    this._pipelineTracker = deps.pipelineTracker;
  }

  /**
   * ADR-089: live-обновление конфигурации funnel (runtime-настройки из админки):
   * TTL ephemeral по умолчанию, политика неизвестного `agentTemplate` и
   * маппинг идентичности (`identityMap`).
   */
  updateConfig(
    partial: Partial<{
      defaultEphemeralTtl: string;
      unknownAgentTemplate: 'drop' | 'default-agent';
      identityMap: Record<string, string>;
    }>,
  ): void {
    if (partial.defaultEphemeralTtl !== undefined) {
      this._config.defaultEphemeralTtl = partial.defaultEphemeralTtl;
    }
    if (partial.unknownAgentTemplate !== undefined) {
      this._config.unknownAgentTemplate = partial.unknownAgentTemplate;
    }
    if (partial.identityMap !== undefined) {
      this._identityMap = partial.identityMap;
    }
  }

  /**
   * Funnel явного создания сессии. `mode='ephemeral'` → сессия с `expiresAt`.
   * `userId`/`ownerId` приходят через `opts` (runtime-контекст, не часть события).
   */
  async request(req: SessionRequest, opts?: RequestSessionOptions): Promise<Session | null> {
    // ADR-089: резолвинг шаблона ДО хука/создания — неизвестный шаблон при `drop`
    // не создаёт сессию и не эмитит `session_requested`.
    const agentRole = this._resolveAgent(req.agentTemplate);

    this._hooks?.emitAsync('session_requested', {
      reason: 'explicit',
      agentTemplate: agentRole,
      project: req.projectId,
      initiator: req.initiator,
    });

    const expiresAt =
      req.mode === 'ephemeral'
        ? parseTtl(req.ttl ?? this._config.defaultEphemeralTtl)
        : undefined;

    const session = await this._sessionManager.createSession({
      title: req.title,
      icon: req.icon,
      color: req.color,
      projectId: req.projectId,
      parentId: req.parentId,
      sessionOrigin: req.sessionOrigin,
      settings: await this._sessionSettings(agentRole, req.settings),
      userId: opts?.userId,
      ownerId: opts?.ownerId,
      expiresAt,
    });
    // ADR-089: уведомляем подписчика (EventHub) о новой сессии владельца —
    // до того, как в неё начнут поступать события.
    await this._onSessionMaterialized?.(session);
    return session;
  }

  /**
   * Приём внешнего события: hook `external_event` → решение Router →
   * материализация → запись в журнал. Возвращает решение и созданную/найденную
   * сессию (либо `null`).
   *
   * ADR-089: `opts.binding` (аутентификация по API-ключу привязки) форсирует
   * привязку на шаге роутинга — поиск по source/ключам не выполняется.
   * ADR-089/ADR-052: `opts.audit` (id ключа/идентичность отправителя) мержится в
   * запись журнала во всех ветках — включая hook-blocked и ошибку материализации.
   * ADR-089: `opts.ownerId` задаёт владельца материализуемой сессии (runtime-
   * контекст запроса: пользователь/владелец ключа привязки); при отсутствии —
   * `deps.resolveExternalIdentity`/`deps.identityMap`, затем `deps.resolveOwnerId`.
   * ADR-089 (claim-flow): `identityHint` — одноразовый код подтверждения владения
   * внешней идентичностью; заполняется только когда отправитель **не сопознан**
   * (резолвер вернул `null`) и у события задан `identity.principalId`.
   */
  async handleEvent(
    event: SynthEvent,
    opts?: {
      binding?: EventBinding;
      audit?: { keyId?: string; principalId?: string };
      ownerId?: string;
    },
  ): Promise<{ decision: RouteDecision; session: Session | null; identityHint?: IdentityClaimHint }> {
    const audit = opts?.audit;
    const hookRes = this._hooks ? await this._hooks.emit('external_event', { event }) : undefined;
    if (hookRes?.blocked) {
      const decision: RouteDecision = {
        kind: 'drop',
        reason: hookRes.reason ?? 'blocked',
        audited: true,
      };
      await this._eventRouter.record(event, decision, undefined, audit);
      return { decision, session: null };
    }

    const decision = await this._eventRouter.decide(event, opts?.binding);

    // ADR-089 (этап 5): эффективные роли отправителя события — база из профиля
    // (резолвер внешней идентичности), сужение `identity.roles`. Владелец
    // (`ownerId`) при этом может определиться чатом/per-event — роли считаем
    // всегда от **самого отправителя** (`principalId`), а не от владельца.
    const deliveryContext = await this._resolveDeliveryContext(event);

    let session: Session | null = null;
    let error: string | undefined;
    try {
      session = await this._materialize(decision, event, opts?.ownerId, deliveryContext);
    } catch (err) {
      error = String(err);
      console.warn(`[RequestSessionService] материализация события не удалась: ${error}`);
    }

    await this._eventRouter.record(event, decision, error, audit);

    // ADR-089: UI-событие после успешной материализации (есть сессия). Дроп и
    // ошибки материализации не публикуем — данных сессии нет.
    if (session) {
      this._publish?.('event.routed', session.id, {
        eventId: event.id,
        source: event.source,
        decisionKind: decision.kind,
      });
    }

    // ADR-089 (claim-flow): неизвестному отправителю выдаём код подтверждения.
    const identityHint = await this._issueClaimForUnknown(event);

    return { decision, session, ...(identityHint ? { identityHint } : {}) };
  }

  /**
   * ADR-089 (claim-flow): выпуск claim-кода, если отправитель не сопознан.
   * Критерий: инъектирован `deps.issueIdentityClaim`, задан `identity.principalId`
   * и резолвер `resolveExternalIdentity` вернул `null` (человек не найден ни в
   * профиле, ни через `identityMap`). Владелец сессии при этом мог определиться
   * чатом/per-event — код всё равно нужен, т.к. **сам отправитель** не сопознан.
   * Разбор `principalId` и сам стор — на стороне инъекции.
   */
  private async _issueClaimForUnknown(event: SynthEvent): Promise<IdentityClaimHint | null> {
    if (!this._issueIdentityClaim) return null;
    if (!event.identity?.principalId) return null;
    if (this._resolveExternalIdentity) {
      const known = await this._resolveExternalIdentity(event.identity);
      if (known) return null;
    }
    return this._issueIdentityClaim(event);
  }

  private async _materialize(
    decision: RouteDecision,
    event: SynthEvent,
    ownerId?: string,
    context?: EventDeliveryContext,
  ): Promise<Session | null> {
    if (decision.kind === 'bound') {
      const session = await this._sessionManager.getSession(decision.sessionId);
      if (!session) return null;
      // ADR-089 (claim-flow): сессия живёт в привязке со своим владельцем; после
      // линковки идентичности отправителя владельца переустанавливаем (машинный
      // `service:<keyId>` или пустой → человек). «Чужую человеческую» не трогаем.
      await this._maybeReassignOwner(session, event);
      await this._trackPipeline(decision, event, session.id);
      await this._deliver(session.id, event, 'run', context);
      return session;
    }

    if (decision.kind === 'ephemeral') {
      const agentRole = await this._resolveSessionAgent(decision.agentTemplate);
      const owner = await this._resolveSessionOwner(ownerId, event);
      const session = await this._sessionManager.createSession({
        title: eventTitle(event),
        projectId: decision.project,
        settings: await this._sessionSettings(agentRole, undefined),
        expiresAt: parseTtl(decision.ttl),
        ...(owner ? { userId: owner, ownerId: owner } : {}),
      });
      // ADR-089: подписываем клиентов владельца на новую сессию до доставки.
      await this._onSessionMaterialized?.(session);
      // ADR-089/ADR-051: шаг пайплайна — учёт экземпляра (до доставки:
      // состояние автомата фиксируется до старта хода агента).
      await this._trackPipeline(decision, event, session.id);
      await this._deliver(session.id, event, 'run', context);
      return session;
    }

    // ADR-089 (auto-bind / цель `bind`): закрепить внешний адрес за сессией.
    // Сессия — постоянная (без `expiresAt`); создаётся `EventBinding mode='bound'`.
    if (decision.kind === 'bind') {
      // Гонка/повтор: привязка уже могла быть создана предыдущим событием —
      // переиспользуем её сессию, ничего не создавая.
      const existing = await this._bindingStore.findByKey({
        source: event.source,
        chatKey: event.identity?.chatKey,
        threadKey: event.identity?.threadKey,
      });
      if (existing?.sessionId) {
        const existingSession = await this._sessionManager.getSession(existing.sessionId);
        if (existingSession) {
          // ADR-089 (claim-flow): привязка уже создана предыдущим событием —
          // владельца переустанавливаем так же, как в `bound` (до доставки).
          await this._maybeReassignOwner(existingSession, event);
          await this._trackPipeline(decision, event, existingSession.id);
          await this._deliver(existingSession.id, event, 'run', context);
          return existingSession;
        }
      }

      const agentRole = await this._resolveSessionAgent(decision.agentTemplate);
      const owner = await this._resolveSessionOwner(ownerId, event);
      const session = await this._sessionManager.createSession({
        title: eventTitle(event),
        projectId: decision.project,
        settings: await this._sessionSettings(agentRole, undefined),
        ...(owner ? { userId: owner, ownerId: owner } : {}),
      });
      await this._bindingStore.upsert({
        source: event.source,
        ...(event.identity?.chatKey ? { chatKey: event.identity.chatKey } : {}),
        ...(event.identity?.threadKey ? { threadKey: event.identity.threadKey } : {}),
        sessionId: session.id,
        mode: 'bound',
        ...(decision.agentTemplate ? { agentTemplate: decision.agentTemplate } : {}),
        ...(decision.project ? { project: decision.project } : {}),
      });
      // ADR-089: подписываем клиентов владельца на новую сессию до доставки.
      await this._onSessionMaterialized?.(session);
      // ADR-089/ADR-051: шаг пайплайна — учёт экземпляра.
      await this._trackPipeline(decision, event, session.id);
      await this._deliver(session.id, event, 'run', context);
      return session;
    }

    if (decision.kind === 'queue') {
      const session = await this._sessionManager.getSession(decision.owner);
      if (!session) return null;
      await this._trackPipeline(decision, event, session.id);
      await this._deliver(session.id, event, 'defer', context);
      return session;
    }

    // drop
    return null;
  }

  /**
   * ADR-089/ADR-051: учёт экземпляра пайплайна для решения с
   * `pipeline: {id, step}` (ADR-101). Ссылка на шаг есть только у решений
   * `ephemeral`/`bind` — там, где решение порождает сессию; в `bound`/`queue`
   * поля нет (его отвергает схема цели).
   *
   * Best-effort (как `onSessionMaterialized`): ошибка учёта экземпляра
   * **не** ломает доставку события — логируется и продолжается.
   */
  private async _trackPipeline(
    decision: RouteDecision,
    event: SynthEvent,
    sessionId: string | undefined,
  ): Promise<void> {
    const tracker = this._pipelineTracker;
    if (!tracker || !sessionId) return;
    const ref = pipelineRefOf(decision);
    if (!ref) return;
    try {
      await tracker.track({ pipeline: ref, event, sessionId });
    } catch (err) {
      console.warn(
        `[RequestSessionService] учёт экземпляра пайплайна «${ref.id}» не удался: ${String(err)}`,
      );
    }
  }

  /**
   * ADR-089 (этап 5): эффективные роли внешнего отправителя события.
   *
   * База — роли профиля из `deps.resolveExternalIdentity` (при отсутствии
   * резолвера профиль неизвестен → `resolveEffectiveRoles(null, …)` =
   * fail-closed `[]`/`linked:false`). `identity.roles` — **потолок**: только
   * сужают базу, не повышают (см. `identity-roles.ts`). Возвращает контекст для
   * `deliver`; ошибка резолвера не роняет маршрутизацию — деградируем до
   * «нет ролей» (транспортное участие сохраняется).
   */
  private async _resolveDeliveryContext(event: SynthEvent): Promise<EventDeliveryContext> {
    // `profileRoles === null` — отправитель не сопознан (резолвера нет либо он
    // вернул `null`); `[]` — сопознан, но роли профиля неизвестны/пусты
    // (напр. override `identityMap`) — fail-closed по правам, `linked: true`.
    let profileRoles: string[] | null = null;
    if (this._resolveExternalIdentity) {
      try {
        const resolved = await this._resolveExternalIdentity(event.identity ?? {});
        if (resolved) profileRoles = resolved.roles ?? [];
      } catch {
        // Роли не критичны для маршрутизации: fail-closed — прав нет.
        profileRoles = null;
      }
    }
    return resolveEffectiveRoles(profileRoles, event.identity?.roles);
  }

  /**
   * ADR-089: резолвинг `agentTemplate` через `AgentRegistry` (резолвер deps).
   *
   * - шаблон пуст/`undefined` → `undefined`;
   * - резолвер не сконфигурирован → шаблон как есть (прежнее поведение);
   * - резолвер вернул id → id;
   * - резолвер вернул `null`: `default-agent` → `undefined` (сессия возьмёт
   *   агента по умолчанию); `drop` (default, fail-safe) → исключение
   *   `agent_not_found`, материализация не создаёт сессию.
   */
  private _resolveAgent(agentTemplate: string | undefined): string | undefined {
    const normalized = agentTemplate?.trim();
    if (!normalized) return undefined;

    if (!this._resolveAgentTemplate) return normalized;

    const resolved = this._resolveAgentTemplate(normalized);
    if (resolved) return resolved;
    if (this._config.unknownAgentTemplate === 'default-agent') return undefined;
    throw new Error(`agent_not_found: ${normalized}`);
  }

  /**
   * ADR-089: агент материализуемой сессии — резолвленный шаблон события либо,
   * если шаблон пуст/не резолвится (`default-agent`), агент по умолчанию
   * инстанса (`deps.resolveDefaultAgent`).
   *
   * Порядок: `_resolveAgent` (неизвестный шаблон при `drop` → исключение —
   * дефолт его не маскирует) → `resolveDefaultAgent`. Без резолвера дефолта —
   * прежнее поведение (`undefined`: `settings.agentRole` не проставляется).
   */
  private async _resolveSessionAgent(agentTemplate: string | undefined): Promise<string | undefined> {
    const resolved = this._resolveAgent(agentTemplate);
    if (resolved) return resolved;
    if (!this._resolveDefaultAgent) return resolved;
    const fallback = (await this._resolveDefaultAgent())?.trim();
    return fallback || undefined;
  }

  /**
   * ADR-089 (claim-flow): переустановка владельца **существующей** сессии при
   * доставке в неё внешнего события.
   *
   * Владелец фиксируется один раз — при материализации (`_materialize`), поэтому
   * сессия Telegram-чата, созданная до линковки идентичности (claim-flow),
   * оставалась за машинным аккаунтом шлюза (`service:<keyId>`, ADR-052) или без
   * владельца — и не была видна человеку в UI. Здесь владелец «подтягивается»
   * при каждом событии:
   *
   * - человек-отправитель резолвится тем же резолвером, что и при создании
   *   (`deps.resolveExternalIdentity`: профильные `identities` + override
   *   `identityMap`); `null`/без `userId`/ошибка резолвера → ничего не делаем
   *   (fail-safe, событие всё равно доставляется);
   * - владелец уже этот человек (`ownerId`/`userId`) → ничего не делаем;
   * - владелец задан и **не** машинный → «чужая человеческая» сессия (общий чат:
   *   автором мог быть другой человек) — не переустанавливаем (защита от угона);
   * - владелец пуст ИЛИ машинный (`service:*`) → переустанавливаем на человека,
   *   сохраняем сессию и уведомляем хаб (`deps.onSessionMaterialized`) — чтобы
   *   клиенты нового владельца подписались на сессию (иначе ответы не дойдут).
   */
  private async _maybeReassignOwner(session: Session, event: SynthEvent): Promise<void> {
    const resolver = this._resolveExternalIdentity;
    if (!resolver) return;

    let externalUserId: string | undefined;
    try {
      const resolved = await resolver(event.identity ?? {});
      externalUserId = resolved?.userId?.trim();
    } catch {
      // Резолвер не критичен для доставки: не нашли человека — владельца не трогаем.
      return;
    }
    if (!externalUserId) return;

    const currentOwner = session.ownerId || session.userId || '';
    // Уже владелец-человек-отправитель — ничего не меняем.
    if (currentOwner === externalUserId) return;
    // Чужая человеческая сессия — не угоняем (общий чат: пишет другой человек).
    if (currentOwner && !isMachineOwnerId(currentOwner)) return;

    // read-modify-write сессии — только под `SessionManager.withLock`: окно между
    // `getSession` выше и сохранением узкое, но конкурентная запись (процессор
    // очереди, HTTP-роут) в нём терялась бы. Под локом сессия перечитывается, а
    // решение «чужой человеческий владелец» принимается по актуальному состоянию.
    const reassigned = await this._sessionManager.withLock(session.id, async (s) => {
      const owner = s.ownerId || s.userId || '';
      if (owner === externalUserId) return false;
      if (owner && !isMachineOwnerId(owner)) return false;
      s.ownerId = externalUserId;
      s.userId = externalUserId;
      await this._sessionManager.updateSession(s);
      return true;
    });
    if (!reassigned) return;
    // Отражаем нового владельца в переданном объекте: он используется вызывающим
    // (`_deliver`/хаб ниже) и возвращается из `handleEvent`.
    session.ownerId = externalUserId;
    session.userId = externalUserId;
    // ADR-089: подписываем хаб на сессию уже от лица нового владельца — до доставки.
    await this._onSessionMaterialized?.(session);
  }

  /**
   * ADR-089: владелец материализуемой внешним событием сессии. Приоритет:
   * 1) `deps.resolveExternalIdentity(event.identity)` — внешний резолвер по
   *    `identity.principalId` (человек-отправитель → пользователь инстанса;
   *    чат-fallback — внутри резолвера; источник — профиль `identities`);
   * 2) `deps.identityMap` — совпадение `identity.principalId`, затем
   *    `identity.chatKey` (override-совместимость, чат — фоллбек);
   * 3) per-event `ownerId` (запрос: пользователь либо владелец ключа привязки);
   * 4) `deps.resolveOwnerId` (standalone core — `local`, паритет с
   *    `POST /api/v2/sessions`; покрывает и сессии планировщика без запроса).
   * `identity.principalId` **не** подставляется как id пользователя инстанса —
   * это внешний идентификатор (`tg:<id>`), владелец задаётся резолвером/картой.
   * Пустое значение → `undefined` (прежнее поведение — сессия без владельца).
   */
  private async _resolveSessionOwner(
    explicitOwnerId: string | undefined,
    event: SynthEvent,
  ): Promise<string | undefined> {
    const external = await this._resolveExternalIdentity?.(event.identity ?? {});
    if (external?.userId) return external.userId;

    const mapped = this._mapIdentityOwner(event);
    if (mapped) return mapped;

    const resolved = explicitOwnerId
      || (this._resolveOwnerId ? await this._resolveOwnerId() : undefined);
    return resolved || undefined;
  }

  /**
   * ADR-089: владелец из `deps.identityMap` — сначала по `identity.principalId`
   * (человек предпочтительнее чата), затем по `identity.chatKey` (фоллбек для
   * ЛС/чатового уровня). Пустая карта/нет совпадения → `undefined`.
   */
  private _mapIdentityOwner(event: SynthEvent): string | undefined {
    const map = this._identityMap;
    if (!map) return undefined;
    const principalId = event.identity?.principalId;
    if (principalId && map[principalId]) return map[principalId];
    const chatKey = event.identity?.chatKey;
    if (chatKey && map[chatKey]) return map[chatKey];
    return undefined;
  }

  /**
   * Минимальное разрешение `agentTemplate` в сессию: шаблон проставляется в
   * per-session `settings.agentRole` (задел — семантика шаблона агента/скилла
   * ADR-046 будет уточнена на следующих этапах).
   */
  private _agentSettings(
    agentRole: string | undefined,
    settings: Partial<SessionSettings> | undefined,
  ): Partial<SessionSettings> | undefined {
    if (!agentRole && !settings) return settings;
    return {
      ...settings,
      ...(agentRole ? { agentRole } : {}),
    };
  }

  /**
   * ADR-089: `settings` материализуемой сессии с добором дефолтных `provider`/
   * `model` инстанса (`deps.resolveLlmDefaults`). Явно заданные (непустые)
   * значения `settings` приоритетнее; поля добираются по отдельности (задан
   * только `provider` — `model` берётся из дефолта и наоборот). Дефолты не
   * заданы/пусты — прежнее поведение (поля остаются как есть).
   */
  private async _sessionSettings(
    agentRole: string | undefined,
    settings: Partial<SessionSettings> | undefined,
  ): Promise<Partial<SessionSettings> | undefined> {
    const base = this._agentSettings(agentRole, settings);
    const defaults = this._resolveLlmDefaults ? await this._resolveLlmDefaults() : undefined;
    if (!defaults) return base;

    const provider = base?.provider || defaults.provider;
    const model = base?.model || defaults.model;
    if (!provider && !model) return base;

    return {
      ...base,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    };
  }
}
