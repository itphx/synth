import type { BusEvent, EventType } from '@itphx/synth-shared';
import { nowISO, supportsMessageModel } from '@itphx/synth-shared';

type EventHandler = (event: BusEvent) => void;

/**
 * ADR-101: канал **инстансных** событий — событий, которые не принадлежат
 * сессии (прогон пайплайна, фоновая задача инстанса).
 *
 * Публикуются в **ту же** шину, но в отдельный канал: их видят глобальные
 * подписчики (`subscribeAll` — SSE-хаб `GET /api/v2/events`, watch-all
 * клиенты managed-хаба `EventHub`, движок исходящих webhooks), а per-session
 * подписки их не касаются. Новый транспортный канал при этом не заводится
 * (ADR-024/ADR-089, инвариант 6).
 */
export const INSTANCE_EVENT_CHANNEL = 'instance';

/**
 * ADR-118 §6: размер кольцевого буфера журнала событий сессии (догон по
 * `Last-Event-ID` / `?since`). Журнал — в памяти процесса: он даёт
 * «хвост» ленты для переподключения, но не является хранилищем.
 */
export const EVENT_JOURNAL_SIZE = 200;

/**
 * ADR-118 §6: сколько сессий одновременно держат журнал (ограничение памяти).
 * Журнал самой старой (по времени последней записи) сессии вытесняется.
 */
export const MAX_JOURNAL_SESSIONS = 100;

/**
 * ADR-118 §4: опции публикации события.
 *
 * - `recipient` — адресат (идентификатор пользователя): адресная доставка,
 *   поле отсутствует → broadcast в канал сессии;
 * - `eventSeq` — явный номер события (проброс из удалённого источника —
 *   гибридный мост, ADR-118 «Гибрид и многопользовательский режим»);
 * - `forceBroadcast` — доставить всем локальным подписчикам **независимо**
 *   от `recipient`. Нужен гибриду: локальный пользователь один, поэтому
 *   удалённое адресное событие нельзя отбрасывать из-за чужого `recipient`
 *   (известное ограничение ADR-118).
 */
export interface PublishOptions {
  recipient?: string;
  eventSeq?: number;
  forceBroadcast?: boolean;
}

/**
 * ADR-118 §4: опции подписки.
 *
 * `userId` — идентификатор пользователя-получателя: адресное событие
 * доставляется только подписчику с совпадающим `userId`.
 */
export interface SubscribeOptions {
  userId?: string;
}

/** Подписка сессии: обработчик + идентичность получателя (ADR-118). */
interface BusSubscriber {
  handler: EventHandler;
  userId?: string;
}

/**
 * Опции глобальной подписки (`subscribeAll`).
 *
 * `userFacing` — подписчик обслуживает пользователя (UI: WS/SSE-хаб) и может
 * ответить на запрос подтверждения (`permission.asked`). Машинные глобальные
 * подписчики (исходящие webhooks, мост гибрида, пайплайны, коллекторы метрик)
 * флаг **не** ставят: на headless-инстансе подтверждение тогда не публикуется
 * вовсе и инструмент получает быстрый отказ, а не висит до `askTimeoutMs`.
 */
export interface SubscribeAllOptions {
  userFacing?: boolean;
}

/**
 * ADR-118 §8: имя параметра, которым клиент заявляет свою модель сообщений
 * (WS — query-параметр, SSE — query-параметр).
 */
export const MESSAGE_MODEL_QUERY_PARAM = 'messageModel';

/**
 * ADR-118 §8: код закрытия WS при несовпадении модели сообщений
 * (fail-closed: соединение не устанавливается).
 */
export const MESSAGE_MODEL_UNSUPPORTED_CLOSE_CODE = 1008;

/** ADR-118 §8: причина закрытия WS / тела отказа SSE. */
export const MESSAGE_MODEL_UNSUPPORTED_REASON = 'messageModel=2 required';

/**
 * ADR-118 §8: разобрать заявленную клиентом модель сообщений.
 * Нечисловое/пустое значение → `null` (считается отсутствующим).
 */
export function parseMessageModelParam(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * ADR-118 §8: поддерживает ли клиент модель сообщений инстанса.
 * Fail-closed: параметр отсутствует или не равен текущей версии → `false`.
 */
export function isSupportedMessageModelParam(raw: string | null | undefined): boolean {
  const parsed = parseMessageModelParam(raw);
  if (parsed === null) return false;
  return supportsMessageModel({ messageModel: parsed });
}

/**
 * ADR-118 §6: разобрать номер события для догона (`since` / `Last-Event-ID`).
 * Нечисловое значение → `null` (догон не запрашивался).
 */
export function parseSinceParam(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * SessionEventBus — async pub/sub для событий сессии (ADR-009).
 * Каждый подписчик получает все события сессии через callback.
 *
 * ADR-118: адресная доставка (`recipient`), монотонная нумерация событий
 * в пределах инстанса (`eventSeq`) и журнал событий (кольцевой буфер) для
 * догона по `Last-Event-ID` / `?since`.
 */
export class EventBus {
  private _subscribers = new Map<string, Set<BusSubscriber>>();
  private _globalSubscribers = new Set<EventHandler>();
  /**
   * Подмножество глобальных подписчиков, обслуживающих пользователя (UI/WS/SSE).
   * Используется только для проверки «есть кому подтвердить» — доставка идёт
   * по полному набору `_globalSubscribers`.
   */
  private _userFacingGlobalSubscribers = new Set<EventHandler>();
  /** ADR-118: номер последнего события **сессии** (`latestEventSeq`). */
  private _seq = new Map<string, number>();
  /**
   * ADR-118 §6: глобальный счётчик событий инстанса — `eventSeq` монотонен
   * **в пределах инстанса** (по всем сессионным каналам), а не по сессии.
   *
   * Клиент на реконнекте передаёт в `since` максимум по всем сессиям, а
   * сервер отдаёт журнал по всем журналам: при per-session нумерации события
   * «хвостовой» сессии (номер ≤ глобального максимума) терялись — догон
   * молча пропускал `step.*`/`part.*`/`turn.*` другой сессии.
   */
  private _globalSeq = 0;
  /** ADR-118: журнал событий по сессиям (кольцевой буфер). */
  private _journal = new Map<string, BusEvent[]>();

  subscribe(sessionId: string, handler: EventHandler, opts: SubscribeOptions = {}): () => void {
    if (!this._subscribers.has(sessionId)) {
      this._subscribers.set(sessionId, new Set());
    }
    const set = this._subscribers.get(sessionId)!;
    // Тот же обработчик — одна подписка (идемпотентность, как у Set из
    // обработчиков в прежней реализации): повторная подписка не создаёт
    // второй доставки.
    const already = [...set].some((subscriber) => subscriber.handler === handler);
    if (!already) {
      const subscriber: BusSubscriber = opts.userId
        ? { handler, userId: opts.userId }
        : { handler };
      set.add(subscriber);
    }
    console.debug(`[EventBus] subscribe session=${sessionId}, handlers=${set.size}`);

    return () => {
      this.unsubscribe(sessionId, handler);
    };
  }

  /**
   * Подписка на ВСЕ события (без привязки к sessionId). Используется
   * гибридным режимом: RemoteEventBridge публикует события удалённых сессий
   * под `remote:<id>`, и локальный /api/v2/events должен доставлять их UI.
   *
   * ADR-118 §4: глобальные подписчики получают **все** события, включая
   * адресные (`recipient`). Для standalone/гибрида это осознанное известное
   * ограничение: локальный пользователь один, поэтому подтверждение приёма
   * (`message.accepted`) видно всем локальным клиентам. Разделение по
   * пользователям работает на управляемом backend'е (там у клиента есть
   * `userId`, и адресную доставку фильтрует `EventHub`).
   */
  subscribeAll(handler: EventHandler, opts: SubscribeAllOptions = {}): () => void {
    this._globalSubscribers.add(handler);
    // `userFacing` — подписчик от имени пользователя (UI/WS/SSE), т.е. может
    // ответить на `permission.asked`; без опции — машинная подписка.
    if (opts.userFacing) this._userFacingGlobalSubscribers.add(handler);
    console.debug(`[EventBus] subscribeAll, globalHandlers=${this._globalSubscribers.size}`);

    return () => {
      this._globalSubscribers.delete(handler);
      this._userFacingGlobalSubscribers.delete(handler);
    };
  }

  unsubscribe(sessionId: string, handler: EventHandler): void {
    const subscribers = this._subscribers.get(sessionId);
    if (!subscribers) return;
    for (const subscriber of subscribers) {
      if (subscriber.handler === handler) subscribers.delete(subscriber);
    }
    if (subscribers.size === 0) {
      this._subscribers.delete(sessionId);
    }
  }

  /**
   * Публикация события сессии.
   *
   * ADR-118 §4: `opts.recipient` — адресная доставка (подписчик с другим
   * `userId` событие не получает). ADR-118 §6: событие получает монотонный
   * `eventSeq` в пределах инстанса и попадает в журнал (догон).
   */
  publish(
    sessionId: string,
    type: EventType,
    data: Record<string, unknown> = {},
    opts: PublishOptions = {},
  ): void {
    this._publish(sessionId, type, data, true, opts);
  }

  /**
   * Публикация **инстансного** события (не сессионного) — ADR-101: прогон
   * пайплайна. Доставляется глобальным подписчикам (`subscribeAll`).
   *
   * Предупреждение «EVENT LOST» не печатается: у инстансных событий
   * per-session подписчиков нет по построению, отсутствие глобальных
   * подписчиков — нормальное состояние (никто не смотрит в UI).
   *
   * ADR-118: инстансные события **не** нумеруются и **не** попадают в
   * журнал сессий — `eventSeq` монотонен в пределах инстанса (только по
   * сессионным каналам).
   */
  publishInstance(type: EventType, data: Record<string, unknown> = {}): void {
    this._publish(INSTANCE_EVENT_CHANNEL, type, data, false);
  }

  /** Общая публикация события в шину (сессионный или инстансный канал). */
  private _publish(
    sessionId: string,
    type: EventType,
    data: Record<string, unknown>,
    warnIfNoSubscribers: boolean,
    opts: PublishOptions = {},
  ): void {
    const isInstanceChannel = sessionId === INSTANCE_EVENT_CHANNEL;
    const event: BusEvent = {
      type,
      sessionId,
      data,
      timestamp: nowISO(),
      ...(opts.recipient ? { recipient: opts.recipient } : {}),
    };

    // ADR-118 §6: нумерация события + журнал (догон). Номер **глобальный** для
    // инстанса (монотонен по всем сессионным каналам) — иначе клиентский
    // `since` (максимум по всем сессиям) отсекал события «хвостовой» сессии.
    // Инстансный канал в журнал сессий не попадает и номера не получает.
    if (!isInstanceChannel) {
      const explicit = typeof opts.eventSeq === 'number' && Number.isSafeInteger(opts.eventSeq) && opts.eventSeq > 0
        ? opts.eventSeq
        : undefined;
      // Явный номер (проброс из удалённого источника) не должен ломать
      // локальную монотонность — берём максимум из обоих; глобальный счётчик
      // двигается до выданного номера.
      const seq = explicit !== undefined ? Math.max(this._globalSeq + 1, explicit) : this._globalSeq + 1;
      this._globalSeq = seq;
      this._seq.set(sessionId, seq);
      event.eventSeq = seq;
      this._appendToJournal(sessionId, event);
    }

    const handlers = this._subscribers.get(sessionId);
    const hasGlobal = this._globalSubscribers.size > 0;
    if (!handlers && !hasGlobal) {
      if (warnIfNoSubscribers) {
        console.warn(`[EventBus] publish ${type} for ${sessionId.slice(0, 8)}: 0 subscribers — EVENT LOST`);
      }
      return;
    }

    if (type.startsWith('stream.')) {
      const count = (handlers?.size ?? 0) + this._globalSubscribers.size;
      console.debug(`[EventBus] publish ${type} for ${sessionId.slice(0, 8)}: ${count} subscriber(s)`);
    }

    for (const subscriber of handlers ?? []) {
      this._deliverToSubscriber(subscriber, event, opts.forceBroadcast === true);
    }

    for (const handler of this._globalSubscribers) {
      try {
        handler(event);
      } catch {
        // Упавший обработчик не должен ломать остальных
      }
    }
  }

  /**
   * ADR-118 §4: доставка подписчику сессии.
   * Broadcast (без `recipient`) — всем; адресное — только получателю.
   * `forceBroadcast` снимает фильтр (гибрид: локальный пользователь один).
   */
  private _deliverToSubscriber(subscriber: BusSubscriber, event: BusEvent, forceBroadcast: boolean): void {
    if (event.recipient && !forceBroadcast && subscriber.userId !== event.recipient) return;
    try {
      subscriber.handler(event);
    } catch {
      // Упавший обработчик не должен ломать остальных
    }
  }

  /** Записать событие в журнал сессии (кольцевой буфер, ADR-118 §6). */
  private _appendToJournal(sessionId: string, event: BusEvent): void {
    let journal = this._journal.get(sessionId);
    if (!journal) {
      journal = [];
      this._journal.set(sessionId, journal);
    } else {
      // LRU: активная сессия переносится в конец карты.
      this._journal.delete(sessionId);
      this._journal.set(sessionId, journal);
    }
    journal.push(event);
    if (journal.length > EVENT_JOURNAL_SIZE) {
      journal.splice(0, journal.length - EVENT_JOURNAL_SIZE);
    }
    // Ограничение памяти: вытесняем журнал самой давно не пополнявшейся сессии.
    while (this._journal.size > MAX_JOURNAL_SESSIONS) {
      const oldest = this._journal.keys().next();
      if (oldest.done) break;
      this._journal.delete(oldest.value);
    }
  }

  /**
   * ADR-118 §6: события сессии строго после `afterSeq` (догон по журналу).
   * Уже доставленные клиенту события (номер ≤ `afterSeq`) не возвращаются.
   */
  since(sessionId: string, afterSeq: number): BusEvent[] {
    const journal = this._journal.get(sessionId);
    if (!journal || journal.length === 0) return [];
    return journal.filter((event) => typeof event.eventSeq === 'number' && event.eventSeq > afterSeq);
  }

  /**
   * ADR-118 §6: события журнала **всех** сессий строго после `afterSeq`.
   * Для глобального SSE-хаба, где клиент подписан на все сессии: номер
   * события глобальный и монотонный в пределах инстанса, поэтому сортировка
   * по номеру даёт **точный** порядок между сессиями (а не приблизительный).
   */
  journalSince(afterSeq: number): BusEvent[] {
    const out: BusEvent[] = [];
    for (const journal of this._journal.values()) {
      for (const event of journal) {
        if (typeof event.eventSeq === 'number' && event.eventSeq > afterSeq) out.push(event);
      }
    }
    out.sort((a, b) => (a.eventSeq ?? 0) - (b.eventSeq ?? 0));
    return out;
  }

  /**
   * ADR-118 §6: номер последнего события **этой сессии** (0 — событий не
   * было). Номер глобальный (сквозной по инстансу), но хранится по сессии:
   * это последний номер, выданный событию данной сессии.
   */
  latestEventSeq(sessionId: string): number {
    return this._seq.get(sessionId) ?? 0;
  }

  subscriberCount(sessionId: string): number {
    return this._subscribers.get(sessionId)?.size ?? 0;
  }

  /**
   * «Есть кому подтвердить» (`permission.asked`): per-session подписчики **или**
   * глобальные подписчики, обслуживающие пользователя (UI/WS/SSE).
   *
   * `subscriberCount` не меняется: watch-all клиенты (`ADMIN`/`LEAD`,
   * service-key) подписаны через `subscribeAll` и per-session счётчика не
   * увеличивают. Машинные глобальные подписки (webhooks, пайплайны, мост
   * гибрида) сюда **не** входят — иначе на headless-инстансе подтверждение
   * публиковалось бы и инструмент висел до `askTimeoutMs`.
   */
  hasApprovalListeners(sessionId: string): boolean {
    if (this.subscriberCount(sessionId) > 0) return true;
    return this._userFacingGlobalSubscribers.size > 0;
  }

  activeSessions(): string[] {
    return [...this._subscribers.keys()];
  }
}
