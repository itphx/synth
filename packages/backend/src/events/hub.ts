import { extractChildSessionId, INSTANCE_EVENT_CHANNEL } from '@itphx/synth-core';
import type { EventBus, ProjectRepository } from '@itphx/synth-core';
import type { BusEvent } from '@itphx/synth-shared';
import type { SessionManager } from '@itphx/synth-core';
import { isUserFacingInstanceEvent } from './instance-events.js';
import { listVisibleSessions } from './visible-session-ids.js';

export interface EventClient {
  userId: string
  username: string
  /**
   * Watch-all: клиент получает события ВСЕХ сессий через глобальный поток
   * `eventBus.subscribeAll`, а не только сессии владельца `userId`.
   * Используется машинными watcher'ами (service-key, ADR-052 этап IV) и ролями
   * сквозного обзора ADMIN/LEAD (ADR-089) — паритет со standalone-core SSE.
   */
  allSessions?: boolean
  /**
   * PROP-133: группы пользователя (гранты по группам; Ф2). Нет — групп нет.
   */
  groups?: readonly string[]
  send(event: BusEvent): void
}

/** Служебный ключ глобальной подписки all-клиента в `clientSubs`. */
const ALL_SESSIONS_KEY = '*';

/**
 * EventHub — центральный диспетчер подписок на события сессий.
 * Управляет active-клиентами пользователя (WS и SSE),
 * автоматически подписывает их на события всех сессий.
 */
export class EventHub {
  private clients = new Map<string, EventClient[]>();
  private clientSubs = new WeakMap<EventClient, Map<string, () => void>>();
  /**
   * Подписка клиента на инстансный канал (`INSTANCE_EVENT_CHANNEL`) — отдельно
   * от per-session подписок: у канала нет сессии, поэтому он не участвует ни
   * в пересчёте подписок (`resyncClient`), ни в догоне (`replayForClient`).
   */
  private instanceSubs = new WeakMap<EventClient, () => void>();

  constructor(
    private eventBus: EventBus,
    private sessionManager: SessionManager,
    /**
     * PROP-133 §6: проекты пользователя — чтобы подписка клиента покрывала
     * сессии **всех видимых** проектов (не только свои). Не задан — подписка
     * остаётся «только свои сессии» (прежнее поведение).
     */
    private projectStore?: ProjectRepository,
  ) {}

  async registerClient(client: EventClient): Promise<void> {
    const arr = this.clients.get(client.userId) || [];
    arr.push(client);
    this.clients.set(client.userId, arr);
    this.clientSubs.set(client, new Map());

    // Watch-all (service-key watcher / ADMIN/LEAD): глобальная подписка на все
    // события шины. Per-session подписок нет — владельца сессий у машинного
    // аккаунта нет, а обзорные роли видят чужие сессии; дубли не нужны.
    // Инстансный канал такому клиенту тоже не нужен отдельной подпиской: он
    // приходит тем же `subscribeAll` целиком (включая административные типы).
    if (client.allSessions) {
      this._subscribeClientToAll(client);
      console.log(`[EventHub] Register client (all sessions): user=${client.username} clients=${arr.length}`);
      return;
    }

    // Обычный пользователь: инстансный канал — только «пользовательские» типы
    // (реестры UI и прогоны пайплайнов), см. `instance-events.ts`.
    this._subscribeClientToInstance(client);

    // Нужны id сессий, видимых пользователю: свои + сессии всех проектов, где
    // у него есть роль (PROP-133 §6, инвариант 18). Лёгкая выборка (без истории
    // сообщений). Тот же шов, что у списка сессий (`resolveMemberProjectIds`).
    const sessions = await listVisibleSessions(this.sessionManager, this.projectStore, {
      userId: client.userId,
      ...(client.groups ? { groups: client.groups } : {}),
    });
    console.log(`[EventHub] Register client: user=${client.username} clients=${arr.length} sessions=${sessions.length}`);

    for (const s of sessions) {
      this._subscribeClientToSession(client, s.id);
    }
  }

  unregisterClient(client: EventClient): void {
    const arr = this.clients.get(client.userId);
    if (!arr) return;
    const idx = arr.indexOf(client);
    if (idx >= 0) arr.splice(idx, 1);
    if (arr.length === 0) this.clients.delete(client.userId);

    this._unsubscribeClientFromAll(client);
    this._unsubscribeClientFromInstance(client);
    const remaining = arr.length;
    console.log(`[EventHub] Unregister client: user=${client.username} remaining=${remaining}`);
  }

  /**
   * PROP-133 Ф2 / ADR-140 Ф2: пересчитать подписки клиента — доступ к
   * проектам мог измениться (появился/снят участник, изменился режим
   * «всем пользователям»).
   *
   * Список подписок = список **видимых** сессий (`listVisibleSessions` — тот
   * же шов, что у списка сессий), поэтому пересчёт совпадает с видимостью
   * проектов и не расходится с ней.
   *
   * Watch-all клиент (`allSessions`) не пересчитывается: его подписка
   * глобальная и от проектов не зависит.
   */
  async resyncClient(client: EventClient): Promise<void> {
    if (client.allSessions) return;
    const subs = this.clientSubs.get(client);
    if (!subs) return;

    // Снимаем прежние per-session подписки (глобальная — не трогаем).
    for (const [key, unsub] of [...subs]) {
      if (key === ALL_SESSIONS_KEY) continue;
      unsub();
      subs.delete(key);
    }

    const sessions = await listVisibleSessions(this.sessionManager, this.projectStore, {
      userId: client.userId,
      ...(client.groups ? { groups: client.groups } : {}),
    });
    for (const s of sessions) {
      this._subscribeClientToSession(client, s.id);
    }
  }

  /**
   * PROP-133 Ф2 / ADR-140 Ф2: пересчитать подписки **всем** подключённым
   * клиентам (редкое admin-действие — смена состояния доступа к проекту).
   */
  async resyncAllClients(): Promise<void> {
    const clients: EventClient[] = [];
    for (const arr of this.clients.values()) clients.push(...arr);
    await Promise.all(clients.map((c) => this.resyncClient(c)));
    // Сводка без спама по каждой сессии.
    console.log(`[EventHub] Resync clients: ${clients.length}`);
  }

  shutdown(): void {
    console.log(`[EventHub] Shutting down: ${this.clients.size} users...`);
    for (const clients of this.clients.values()) {
      for (const client of clients) {
        this._unsubscribeClientFromAll(client);
        this._unsubscribeClientFromInstance(client);
      }
    }
    this.clients.clear();
    console.log('[EventHub] All clients unregistered');
  }

  async subscribeToSession(userId: string, sessionId: string): Promise<void> {
    const arr = this.clients.get(userId);
    if (!arr || arr.length === 0) {
      console.debug(`[EventHub] subscribeToSession: no clients for user=${userId}`);
      return;
    }

    console.log(`[EventHub] Subscribe session: session=${sessionId} clients=${arr.length}`);
    for (const client of arr) {
      this._subscribeClientToSession(client, sessionId);
    }
  }

  unsubscribeFromSession(userId: string, sessionId: string): void {
    const arr = this.clients.get(userId);
    if (!arr) return;

    for (const client of arr) {
      const subs = this.clientSubs.get(client);
      if (!subs) continue;
      const unsub = subs.get(sessionId);
      if (unsub) {
        unsub();
        subs.delete(sessionId);
      }
    }
    console.debug(`[EventHub] Unsubscribe session: session=${sessionId}`);
  }

  /** Глобальная подписка all-клиента: события всех сессий без привязки к владельцу. */
  private _subscribeClientToAll(client: EventClient): void {
    const subs = this.clientSubs.get(client);
    if (!subs || subs.has(ALL_SESSIONS_KEY)) return;

    // `userFacing`: клиент (WS/SSE) обслуживает пользователя и может ответить
    // на `permission.asked`. Без флага подтверждение считалось бы «некому
    // показать»: у watch-all клиентов per-session подписок нет.
    const unsub = this.eventBus.subscribeAll((event: BusEvent) => {
      this._deliver(client, event);
    }, { userFacing: true });
    subs.set(ALL_SESSIONS_KEY, unsub);
  }

  /**
   * ADR-101/ADR-118: подписка обычного клиента на инстансный канал шины
   * (`INSTANCE_EVENT_CHANNEL`, не сессионный).
   *
   * Доставляются только «пользовательские» типы (`USER_FACING_INSTANCE_EVENTS`,
   * `instance-events.ts`): реестры агентов/MCP/скиллов/моделей и прогоны
   * пайплайнов — то, что пользователь видит в UI. Административные инстансные
   * события (аудит, обслуживание инстанса) ему не уходят — их видят watch-all
   * клиенты (`ADMIN`/`LEAD`/service-key) через `subscribeAll`.
   *
   * Права на **сессии** это не меняет: владельческая изоляция остаётся в
   * per-session подписках, инстансный канал сессий не содержит.
   */
  private _subscribeClientToInstance(client: EventClient): void {
    // Watch-all клиент покрыт глобальной подпиской — вторая дала бы дубли.
    if (client.allSessions) return;
    if (this.instanceSubs.has(client)) return;

    // `userId` — чтобы адресное инстансное событие (если появится) ушло
    // только своему получателю: без него шина отбросила бы его как «чужое».
    const unsub = this.eventBus.subscribe(
      INSTANCE_EVENT_CHANNEL,
      (event: BusEvent) => {
        if (!isUserFacingInstanceEvent(event.type)) return;
        this._deliver(client, event);
      },
      { userId: client.userId },
    );
    this.instanceSubs.set(client, unsub);
  }

  private _unsubscribeClientFromInstance(client: EventClient): void {
    const unsub = this.instanceSubs.get(client);
    if (!unsub) return;
    unsub();
    this.instanceSubs.delete(client);
  }

  /**
   * ADR-118 §4: адресная доставка.
   *
   * Событие с `recipient` получает **только** клиент с совпадающим `userId`
   * (broadcast — без `recipient` — получают все подписчики сессии).
   */
  private _deliver(client: EventClient, event: BusEvent): void {
    if (event.recipient && event.recipient !== client.userId) return;
    try {
      client.send(event);
    } catch {
      // ignore send errors
    }
  }

  /**
   * ADR-118 §6: догон — события журнала строго после `afterSeq` для сессий,
   * на которые подписан клиент (`Last-Event-ID` / `?since`).
   *
   * Watch-all клиент (service-key / сквозной обзор) получает журнал всех
   * сессий; обычный клиент — только своих. Номер события глобальный и
   * монотонный в пределах инстанса, поэтому порядок между сессиями — точный
   * (по номеру).
   *
   * **Обычный клиент без видимых сессий получает пустой догон.** Раньше в
   * этом случае отдавался журнал **всех** сессий (`journalSince`): пользователь
   * без единой доступной сессии (новый аккаунт, снятый доступ) получал при
   * реконнекте чужие кадры — включая `part.delta` (текст ответа),
   * `message.enqueued` (снимок реплики) и `stream.error`. Право на полный журнал
   * есть только у watch-all подписки (`ALL_SESSIONS_KEY`) — она и является
   * признаком обзорного клиента. Матрица доставки — `events/instance-delivery.test.ts`,
   * `app/instance-events-transport.test.ts`.
   */
  replayForClient(client: EventClient, afterSeq: number): BusEvent[] {
    const subs = this.clientSubs.get(client);
    if (!subs) return [];
    // Полный журнал — только watch-all клиенту (обзорные роли/service-key).
    if (subs.has(ALL_SESSIONS_KEY)) {
      return this.eventBus.journalSince(afterSeq);
    }
    const out: BusEvent[] = [];
    for (const sessionId of subs.keys()) {
      out.push(...this.eventBus.since(sessionId, afterSeq));
    }
    out.sort((a, b) => (a.eventSeq ?? 0) - (b.eventSeq ?? 0));
    return out;
  }

  private _subscribeClientToSession(client: EventClient, sessionId: string): void {
    // all-клиент покрыт глобальной подпиской — per-session подписки не нужны
    // (иначе дубли доставки).
    if (client.allSessions) return;

    const subs = this.clientSubs.get(client);
    if (!subs) return;
    if (subs.has(sessionId)) return;

    const unsub = this.eventBus.subscribe(sessionId, (event: BusEvent) => {
      this._deliver(client, event);

      // Автоподписка на дочернюю сессию саб-агента. Раньше клиент получал
      // live-события (`stream.usage`/`stream.chunk`) только по сессиям из
      // `listSessions` и созданным/форкнутым через роуты; child-сессию тул
      // `task` создаёт напрямую, и её события терялись (0 subscribers).
      // Безопасно: id берётся только из событий уже авторизованной сессии
      // клиента, чужие сессии так не всплывают. `_subscribeClientToSession`
      // идемпотентна (guard `subs.has`).
      const childId = extractChildSessionId(event);
      if (childId && childId !== sessionId) {
        this._subscribeClientToSession(client, childId);
      }
      // ADR-118 §4: адресная доставка на уровне шины — подписчик сессии
      // получает событие с `recipient` только при совпадении `userId`.
    }, { userId: client.userId });
    subs.set(sessionId, unsub);
  }

  private _unsubscribeClientFromAll(client: EventClient): void {
    const subs = this.clientSubs.get(client);
    if (!subs) return;
    for (const unsub of subs.values()) {
      unsub();
    }
    subs.clear();
    this.clientSubs.delete(client);
  }
}
