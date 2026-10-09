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
import type { HookBus } from '../hooks/hook-bus.js';
import type { EventRouter } from './event-router.js';
import type { EventDelivery } from './types.js';

/** AD-089: runtime-контекст явного создания сессии (не поля события). */
export interface RequestSessionOptions {
  userId?: string;
  ownerId?: string;
}

export interface RequestSessionServiceDeps {
  sessionManager: SessionManager;
  eventRouter: EventRouter;
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
  private _hooks?: HookBus;
  private _config: { defaultEphemeralTtl: string; unknownAgentTemplate: 'drop' | 'default-agent' };
  private _deliver: EventDelivery;
  private _resolveAgentTemplate?: (template: string) => string | null;
  private _publish?: (type: EventType, sessionId: string, data: Record<string, unknown>) => void;

  constructor(deps: RequestSessionServiceDeps) {
    this._sessionManager = deps.sessionManager;
    this._eventRouter = deps.eventRouter;
    this._hooks = deps.hooks;
    this._config = {
      defaultEphemeralTtl: deps.config.defaultEphemeralTtl,
      unknownAgentTemplate: deps.config.unknownAgentTemplate ?? 'drop',
    };
    this._deliver = deps.deliver;
    this._resolveAgentTemplate = deps.resolveAgentTemplate;
    this._publish = deps.publish;
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

    return this._sessionManager.createSession({
      title: req.title,
      icon: req.icon,
      color: req.color,
      projectId: req.projectId,
      engine: req.engine,
      parentId: req.parentId,
      sessionOrigin: req.sessionOrigin,
      settings: this._agentSettings(agentRole, req.settings),
      userId: opts?.userId,
      ownerId: opts?.ownerId,
      expiresAt,
    });
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
   */
  async handleEvent(
    event: SynthEvent,
    opts?: { binding?: EventBinding; audit?: { keyId?: string; principalId?: string } },
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
      session = await this._materialize(decision, event);
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

  private async _materialize(decision: RouteDecision, event: SynthEvent): Promise<Session | null> {
    if (decision.kind === 'bound') {
      const session = await this._sessionManager.getSession(decision.sessionId);
      if (!session) return null;
      await this._deliver(session.id, event, 'run');
      return session;
    }

    if (decision.kind === 'ephemeral') {
      const agentRole = this._resolveAgent(decision.agentTemplate);
      const session = await this._sessionManager.createSession({
        title: eventTitle(event),
        projectId: decision.project,
        settings: this._agentSettings(agentRole, undefined),
        expiresAt: parseTtl(decision.ttl),
      });
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
}
