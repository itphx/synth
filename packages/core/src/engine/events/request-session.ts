import type {
  EventBinding,
  EventType,
  Message,
  RouteDecision,
  Session,
  SessionRequest,
  SessionSettings,
  SynthEvent,
} from '@itphx/synth-shared';
import { MessageRole, generateId, nowISO } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import { parseTtl } from '../../sessions/ephemeral.js';
import type { EventBindingStore } from '../../storage/event-binding-store.js';
import type { HookBus } from '../hooks/hook-bus.js';
import type { EventRouter } from './event-router.js';
import type { EventDelivery } from './types.js';

/** AD-089: runtime-контекст явного создания сессии (не поля события). */
export interface RequestSessionOptions {
  userId?: string;
  ownerId?: string;
}

/**
 * AD-089: дефолтные `provider`/`model` инстанса для сессий, материализуемых
 * funnel'ом. Источник задаёт потребитель (`deps.resolveLlmDefaults`): standalone
 * core — `llm.defaultProvider`/`llm.defaultModel`; managed backend — свой.
 * Пустые поля трактуются как «не задано».
 */
export interface LlmDefaults {
  provider?: string;
  model?: string;
}

export interface RequestSessionServiceDeps {
  sessionManager: SessionManager;
  eventRouter: EventRouter;
  /**
   * AD-089 (auto-bind): реестр привязок — материализация решения `kind: 'bind'`
   * создаёт/переиспользует `EventBinding` (`mode='bound'`).
   */
  bindingStore: EventBindingStore;
  hooks?: HookBus;
  config: { defaultEphemeralTtl: string; unknownAgentTemplate?: 'drop' | 'default-agent' };
  deliver: EventDelivery;
  /**
   * AD-089: резолвер `agentTemplate` → id существующего enabled-агента
   * (`AgentRegistry`). Возвращает `null`, если шаблон неизвестен. Отсутствие
   * резолвера — шаблон принимается как есть (прежнее поведение).
   */
  resolveAgentTemplate?: (template: string) => string | null;
  /**
   * AD-089: публикация UI-события после успешной материализации внешнего
   * события. Вызывается только при наличии сессии; `app.ts` прокидывает
   * `eventBus.publish`.
   */
  publish?: (type: EventType, sessionId: string, data: Record<string, unknown>) => void;
  /**
   * AD-089: резолвер владельца сессий, материализуемых внешним событием
   * (`ephemeral`/`bind`). Нужен, чтобы такие сессии не выпадали из
   * `listSessions({ userId })` и UI-списка. Standalone core передаёт `local`
   * (паритет с `POST /api/v2/sessions`); managed backend — не задаёт, владелец
   * приходит per-event (`opts.ownerId`) либо из `identity.principalId`. Не задан —
   * прежнее поведение (сессия без владельца).
   */
  resolveOwnerId?: () => string | Promise<string | undefined>;
  /**
   * AD-089: резолвер дефолтных `provider`/`model` инстанса для сессий,
   * материализуемых funnel'ом (explicit/`ephemeral`/`bind`). Нужен, чтобы
   * сессия из внешнего события (напр. Telegram-шлюз) получала те же дефолты,
   * что и сессия без явной модели, и агент мог ответить. Явно заданные в
   * `settings` значения приоритетнее; не задан резолвер либо пустые значения —
   * прежнее поведение (поля остаются незаданными). Standalone core передаёт
   * `llm.defaultProvider`/`llm.defaultModel`; managed backend — свой источник.
   */
  resolveLlmDefaults?: () => LlmDefaults | Promise<LlmDefaults>;
  /**
   * AD-089: маппинг идентичности внешнего отправителя (`identity.chatKey` или
   * `identity.principalId`) на владельца синт-сессии (id пользователя
   * инстанса). Применяется при материализации сессий `ephemeral`/`bind`;
   * приоритет выше per-event владельца. Не задан/пусто — прежняя логика.
   */
  identityMap?: Record<string, string>;
  /**
   * AD-089: колбэк после создания/материализации сессии (explicit/`ephemeral`/
   * `bind`), но **до** доставки события в неё. Backend связывает его с
   * `EventHub.subscribeToSession(ownerId, sessionId)`, чтобы клиенты владельца,
   * подключённые до создания сессии, получали её события (иначе сессии,
   * созданные funnel'ом, терялись — `0 subscribers`).
   */
  onSessionMaterialized?: (session: Session) => void | Promise<void>;
}

/**
 * AD-089: извлекает текст сообщения из нормализованного события. Если `payload` —
 * объект с непустым строковым `text`, возвращает его; иначе сериализует payload
 * (`JSON.stringify` с fallback на пустую строку). Экспортируется для тестов и
 * инъектируемого `deliver`.
 */
export function eventToMessageText(event: SynthEvent): string {
  const payload = event.payload;
  if (payload && typeof payload === 'object') {
    const text = (payload as { text?: unknown }).text;
    if (typeof text === 'string' && text.length > 0) return text;
  }
  const serialized = JSON.stringify(payload);
  return typeof serialized === 'string' ? serialized : '';
}

/**
 * Собирает user-сообщение из события (единый формат для `deliver` core/backend).
 *
 * AD-051: для `source === 'cron'` сообщение помечается автором `Scheduler`, а в
 * `metadata` добавляются `scheduler`/`schedule_id`/`schedule_name`; `content` —
 * чистый текст задания без описания (описание «кто такой Scheduler» — в
 * статическом system-блоке `scheduler` промпта). Для прочих источников
 * поведение прежнее (автор не задаётся).
 */
export function eventToMessage(event: SynthEvent): Message {
  const content = eventToMessageText(event);
  const isCron = event.source === 'cron';

  const metadata: Record<string, unknown> = {
    source: event.source,
    event_id: event.id,
    dedup_key: event.dedupKey,
    ...(event.identity?.chatKey ? { chat_key: event.identity.chatKey } : {}),
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

  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [{ id: generateId(), type: 'text', data: content }],
    content,
    ...(isCron ? { author: 'Scheduler' } : {}),
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    metadata,
  };
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
 * AD-089: единый funnel создания сессий.
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
  private _bindingStore: EventBindingStore;
  private _hooks?: HookBus;
  private _config: { defaultEphemeralTtl: string; unknownAgentTemplate: 'drop' | 'default-agent' };
  private _deliver: EventDelivery;
  private _resolveAgentTemplate?: (template: string) => string | null;
  private _publish?: (type: EventType, sessionId: string, data: Record<string, unknown>) => void;
  private _resolveOwnerId?: () => string | Promise<string | undefined>;
  private _resolveLlmDefaults?: () => LlmDefaults | Promise<LlmDefaults>;
  private _identityMap?: Record<string, string>;
  private _onSessionMaterialized?: (session: Session) => void | Promise<void>;

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
    this._identityMap = deps.identityMap;
    this._onSessionMaterialized = deps.onSessionMaterialized;
  }

  /**
   * AD-089: live-обновление конфигурации funnel (runtime-настройки из админки):
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
    // AD-089: резолвинг шаблона ДО хука/создания — неизвестный шаблон при `drop`
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
      engine: req.engine,
      parentId: req.parentId,
      sessionOrigin: req.sessionOrigin,
      settings: await this._sessionSettings(agentRole, req.settings),
      userId: opts?.userId,
      ownerId: opts?.ownerId,
      expiresAt,
    });
    // AD-089: уведомляем подписчика (EventHub) о новой сессии владельца —
    // до того, как в неё начнут поступать события.
    await this._onSessionMaterialized?.(session);
    return session;
  }

  /**
   * Приём внешнего события: hook `external_event` → решение Router →
   * материализация → запись в журнал. Возвращает решение и созданную/найденную
   * сессию (либо `null`).
   *
   * AD-089: `opts.binding` (аутентификация по API-ключу привязки) форсирует
   * привязку на шаге роутинга — поиск по source/ключам не выполняется.
   * AD-089/AD-052: `opts.audit` (id ключа/идентичность отправителя) мержится в
   * запись журнала во всех ветках — включая hook-blocked и ошибку материализации.
   * AD-089: `opts.ownerId` задаёт владельца материализуемой сессии (runtime-
   * контекст запроса: пользователь/владелец ключа привязки); при отсутствии —
   * используется `deps.resolveOwnerId`, затем `event.identity.principalId`.
   */
  async handleEvent(
    event: SynthEvent,
    opts?: {
      binding?: EventBinding;
      audit?: { keyId?: string; principalId?: string };
      ownerId?: string;
    },
  ): Promise<{ decision: RouteDecision; session: Session | null }> {
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

    let session: Session | null = null;
    let error: string | undefined;
    try {
      session = await this._materialize(decision, event, opts?.ownerId);
    } catch (err) {
      error = String(err);
      console.warn(`[RequestSessionService] материализация события не удалась: ${error}`);
    }

    await this._eventRouter.record(event, decision, error, audit);

    // AD-089: UI-событие после успешной материализации (есть сессия). Дроп и
    // ошибки материализации не публикуем — данных сессии нет.
    if (session) {
      this._publish?.('event.routed', session.id, {
        eventId: event.id,
        source: event.source,
        decisionKind: decision.kind,
      });
    }

    return { decision, session };
  }

  private async _materialize(
    decision: RouteDecision,
    event: SynthEvent,
    ownerId?: string,
  ): Promise<Session | null> {
    if (decision.kind === 'bound') {
      const session = await this._sessionManager.getSession(decision.sessionId);
      if (!session) return null;
      await this._deliver(session.id, event, 'run');
      return session;
    }

    if (decision.kind === 'ephemeral') {
      const agentRole = this._resolveAgent(decision.agentTemplate);
      const owner = await this._resolveSessionOwner(ownerId, event);
      const session = await this._sessionManager.createSession({
        title: eventTitle(event),
        projectId: decision.project,
        settings: await this._sessionSettings(agentRole, undefined),
        expiresAt: parseTtl(decision.ttl),
        ...(owner ? { userId: owner, ownerId: owner } : {}),
      });
      // AD-089: подписываем клиентов владельца на новую сессию до доставки.
      await this._onSessionMaterialized?.(session);
      await this._deliver(session.id, event, 'run');
      return session;
    }

    // AD-089 (auto-bind / цель `bind`): закрепить внешний адрес за сессией.
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
          await this._deliver(existingSession.id, event, 'run');
          return existingSession;
        }
      }

      const agentRole = this._resolveAgent(decision.agentTemplate);
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
      // AD-089: подписываем клиентов владельца на новую сессию до доставки.
      await this._onSessionMaterialized?.(session);
      await this._deliver(session.id, event, 'run');
      return session;
    }

    if (decision.kind === 'queue') {
      const session = await this._sessionManager.getSession(decision.owner);
      if (!session) return null;
      await this._deliver(session.id, event, 'defer');
      return session;
    }

    // drop
    return null;
  }

  /**
   * AD-089: резолвинг `agentTemplate` через `AgentRegistry` (резолвер deps).
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
   * AD-089: владелец материализуемой внешним событием сессии. Приоритет:
   * 1) `deps.identityMap` — совпадение `identity.chatKey`, затем
   *    `identity.principalId` (маппинг внешнего отправителя на владельца
   *    инстанса, напр. Telegram-чат → человек);
   * 2) per-event `ownerId` (запрос: пользователь либо владелец ключа привязки);
   * 3) `event.identity.principalId` (атрибуция источника, напр. владелец
   *    расписания `cron`);
   * 4) `deps.resolveOwnerId` (standalone core — `local`, паритет с
   *    `POST /api/v2/sessions`; покрывает и сессии планировщика без запроса).
   * Пустое значение → `undefined` (прежнее поведение — сессия без владельца).
   */
  private async _resolveSessionOwner(
    explicitOwnerId: string | undefined,
    event: SynthEvent,
  ): Promise<string | undefined> {
    const mapped = this._mapIdentityOwner(event);
    if (mapped) return mapped;

    const resolved = explicitOwnerId
      || event.identity?.principalId
      || (this._resolveOwnerId ? await this._resolveOwnerId() : undefined);
    return resolved || undefined;
  }

  /**
   * AD-089: владелец из `deps.identityMap` — сначала по `identity.chatKey`,
   * затем по `identity.principalId`. Пустая карта/нет совпадения → `undefined`.
   */
  private _mapIdentityOwner(event: SynthEvent): string | undefined {
    const map = this._identityMap;
    if (!map) return undefined;
    const chatKey = event.identity?.chatKey;
    if (chatKey && map[chatKey]) return map[chatKey];
    const principalId = event.identity?.principalId;
    if (principalId && map[principalId]) return map[principalId];
    return undefined;
  }

  /**
   * Минимальное разрешение `agentTemplate` в сессию: шаблон проставляется в
   * per-session `settings.agentRole` (задел — семантика шаблона агента/скилла
   * AD-046 будет уточнена на следующих этапах).
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
   * AD-089: `settings` материализуемой сессии с добором дефолтных `provider`/
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
