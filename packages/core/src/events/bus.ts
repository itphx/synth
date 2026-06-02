import type { BusEvent, EventType } from '@synth/shared';
import { nowISO } from '@synth/shared';

type EventHandler = (event: BusEvent) => void;

/**
 * SessionEventBus — async pub/sub для событий сессии (AD-009).
 * Каждый подписчик получает все события сессии через callback.
 */
export class EventBus {
  private _subscribers = new Map<string, Set<EventHandler>>();

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
    if (!handlers) {
      if (type.startsWith('stream.')) {
        console.warn(`[EventBus] publish ${type} for ${sessionId}: 0 subscribers — EVENT LOST`);
      }
      return;
    }

    if (type.startsWith('stream.')) {
      console.debug(`[EventBus] publish ${type} for ${sessionId}: ${handlers.size} subscriber(s)`);
    }

    for (const handler of handlers) {
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
