import type { BusEvent, EventType } from '@itphx/synth-shared';
import { nowISO } from '@itphx/synth-shared';

type EventHandler = (event: BusEvent) => void;

/**
 * SessionEventBus — async pub/sub для событий сессии (AD-009).
 * Каждый подписчик получает все события сессии через callback.
 */
export class EventBus {
  private _subscribers = new Map<string, Set<EventHandler>>();
  private _globalSubscribers = new Set<EventHandler>();

  subscribe(sessionId: string, handler: EventHandler): () => void {
    if (!this._subscribers.has(sessionId)) {
      this._subscribers.set(sessionId, new Set());
    }
    this._subscribers.get(sessionId)!.add(handler);
    console.debug(`[EventBus] subscribe session=${sessionId}, handlers=${this._subscribers.get(sessionId)!.size}`);

    return () => {
      this.unsubscribe(sessionId, handler);
    };
  }

  /**
   * Подписка на ВСЕ события (без привязки к sessionId). Используется
   * гибридным режимом: RemoteEventBridge публикует события удалённых сессий
   * под `remote:<id>`, и локальный /api/v2/events должен доставлять их UI.
   */
  subscribeAll(handler: EventHandler): () => void {
    this._globalSubscribers.add(handler);
    console.debug(`[EventBus] subscribeAll, globalHandlers=${this._globalSubscribers.size}`);

    return () => {
      this._globalSubscribers.delete(handler);
    };
  }

  unsubscribe(sessionId: string, handler: EventHandler): void {
    this._subscribers.get(sessionId)?.delete(handler);
    if (this._subscribers.get(sessionId)?.size === 0) {
      this._subscribers.delete(sessionId);
    }
  }

  publish(sessionId: string, type: EventType, data: Record<string, unknown> = {}): void {
    const event: BusEvent = {
      type,
      sessionId,
      data,
      timestamp: nowISO(),
    };

    const handlers = this._subscribers.get(sessionId);
    const hasGlobal = this._globalSubscribers.size > 0;
    if (!handlers && !hasGlobal) {
      console.warn(`[EventBus] publish ${type} for ${sessionId.slice(0, 8)}: 0 subscribers — EVENT LOST`);
      return;
    }

    if (type.startsWith('stream.')) {
      const count = (handlers?.size ?? 0) + this._globalSubscribers.size;
      console.debug(`[EventBus] publish ${type} for ${sessionId.slice(0, 8)}: ${count} subscriber(s)`);
    }

    for (const handler of handlers ?? []) {
      try {
        handler(event);
      } catch {
        // Упавший обработчик не должен ломать остальных
      }
    }

    for (const handler of this._globalSubscribers) {
      try {
        handler(event);
      } catch {
        // Упавший обработчик не должен ломать остальных
      }
    }
  }

  subscriberCount(sessionId: string): number {
    return this._subscribers.get(sessionId)?.size ?? 0;
  }

  activeSessions(): string[] {
    return [...this._subscribers.keys()];
  }
}

/**
 * SSE helper — async generator для подписки на события сессии.
 */
export async function* sseEventStream(
  bus: EventBus,
  sessionId: string,
  signal?: AbortSignal,
): AsyncGenerator<BusEvent> {
  const events: BusEvent[] = [];
  let resolve: ((event: BusEvent) => void) | null = null;

  const unsubscribe = bus.subscribe(sessionId, (event) => {
    if (resolve) {
      resolve(event);
      resolve = null;
    } else {
      events.push(event);
    }
  });

  signal?.addEventListener('abort', () => {
    if (resolve) {
      resolve(null as unknown as BusEvent);
      resolve = null;
    }
  }, { once: true });

  try {
    while (!signal?.aborted) {
      if (events.length > 0) {
        yield events.shift()!;
      } else {
        const event = await new Promise<BusEvent>((res) => { resolve = res; });
        if (!signal?.aborted) {
          yield event;
        }
      }
    }
  } finally {
    unsubscribe();
  }
}
