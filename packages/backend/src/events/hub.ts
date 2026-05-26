import type { EventBus } from '@synth/core';
import type { BusEvent } from '@synth/shared';
import type { SessionManager } from '@synth/core';

export interface EventClient {
  userId: string
  username: string
  send(event: BusEvent): void
}

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
    console.log(`[EventHub] Unregister client: user=${client.username} remaining=${arr.length}`);
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

  private _subscribeClientToSession(client: EventClient, sessionId: string): void {
    const subs = this.clientSubs.get(client);
    if (!subs) return;
    if (subs.has(sessionId)) return;

    const unsub = this.eventBus.subscribe(sessionId, (event: BusEvent) => {
      try {
        client.send(event);
      } catch {
        // ignore send errors
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
