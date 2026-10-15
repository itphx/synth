import { extractChildSessionId } from '@itphx/synth-core';
import type { EventBus } from '@itphx/synth-core';
import type { BusEvent } from '@itphx/synth-shared';
import type { SessionManager } from '@itphx/synth-core';

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

  constructor(
    private eventBus: EventBus,
    private sessionManager: SessionManager,
  ) {}

  async registerClient(client: EventClient): Promise<void> {
    const arr = this.clients.get(client.userId) || [];
    arr.push(client);
    this.clients.set(client.userId, arr);
    this.clientSubs.set(client, new Map());

    // Watch-all (service-key watcher / ADMIN/LEAD): глобальная подписка на все
    // события шины. Per-session подписок нет — владельца сессий у машинного
    // аккаунта нет, а обзорные роли видят чужие сессии; дубли не нужны.
    if (client.allSessions) {
      this._subscribeClientToAll(client);
      console.log(`[EventHub] Register client (all sessions): user=${client.username} clients=${arr.length}`);
      return;
    }

    const sessions = await this.sessionManager.listSessions({ userId: client.userId });
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
    const remaining = arr.length;
    console.log(`[EventHub] Unregister client: user=${client.username} remaining=${remaining}`);
  }

  shutdown(): void {
    console.log(`[EventHub] Shutting down: ${this.clients.size} users...`);
    for (const clients of this.clients.values()) {
      for (const client of clients) {
        this._unsubscribeClientFromAll(client);
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

    const unsub = this.eventBus.subscribeAll((event: BusEvent) => {
      try {
        client.send(event);
      } catch {
        // ignore send errors
      }
    });
    subs.set(ALL_SESSIONS_KEY, unsub);
  }

  private _subscribeClientToSession(client: EventClient, sessionId: string): void {
    // all-клиент покрыт глобальной подпиской — per-session подписки не нужны
    // (иначе дубли доставки).
    if (client.allSessions) return;

    const subs = this.clientSubs.get(client);
    if (!subs) return;
    if (subs.has(sessionId)) return;

    const unsub = this.eventBus.subscribe(sessionId, (event: BusEvent) => {
      try {
        client.send(event);
      } catch {
        // ignore send errors
      }

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
    });
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
