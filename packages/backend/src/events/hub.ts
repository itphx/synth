import type { EventBus } from '@itphx/synth-core';
import type { BusEvent } from '@itphx/synth-shared';
import type { SessionManager } from '@itphx/synth-core';

export interface EventClient {
  userId: string
  username: string
  send(event: BusEvent): void
}

/**
 * Извлечь id новой дочерней сессии из события, опубликованного в родительскую
 * сессию. Дочерние сессии саб-агентов создаются тулом `task` напрямую через
 * `SessionManager`, минуя роуты, поэтому клиент изначально на них не подписан.
 * Тул `task` публикует `session.created` (payload — serializeSession ребёнка) в
 * родителя ДО старта LLM-стрима ребёнка, так что автоподписка успевает.
 * `child.session.updated` несёт `session` (id внутри), `child.message.added` и
 * resume-события — `child_session_id`.
 */
function extractChildSessionId(event: BusEvent): string | undefined {
  const data = event.data as Record<string, unknown> | undefined;
  if (!data) return undefined;

  switch (event.type) {
    case 'session.created':
      return typeof data.id === 'string' ? data.id : undefined;
    case 'child.session.updated': {
      const session = data.session as Record<string, unknown> | undefined;
      if (session && typeof session.id === 'string') return session.id;
      return typeof data.child_session_id === 'string' ? data.child_session_id : undefined;
    }
    case 'child.message.added':
    case 'subagent.resume.started':
    case 'subagent.resume.finished':
      return typeof data.child_session_id === 'string' ? data.child_session_id : undefined;
    default:
      return undefined;
  }
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
