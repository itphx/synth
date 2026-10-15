// Глобальный SSE-хаб событий (`GET /api/v2/events`) standalone-core — фоллбек
// транспортного слоя UI (ADR-008/009/024) и канал внешних подписчиков (ADR-052).
// Вынесено из `server/app.ts` (ADR-095, шаг 4a) — «вынос по швам», без изменения поведения.
import type { Hono } from 'hono';
import type { EventBus } from '../../index.js';
import { requireScope } from '../service-scope.js';

/**
 * Зарегистрировать SSE-хаб. Подписка — на ВСЕ события шины (`subscribeAll`),
 * включая сессии, созданные позже (ADR-089 events-funnel). `events:watch` —
 * scope service-key (для интерактивных кред — no-op).
 */
export function registerEventsSse(app: Hono, eventBus: EventBus): void {
  // Глобальный SSE-хаб
  // ADR-052: `events:watch` — scope service-key для подписки на поток событий.
  app.get('/api/v2/events', requireScope('events:watch'), async (c) => {
    const signal = c.req.raw.signal;

    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();

          const unsubs: Array<() => void> = [];

          const handler = (event: { type: string; data: Record<string, unknown>; sessionId: string; timestamp: string }) => {
            try {
              const line = `data: ${JSON.stringify(event)}\n\n`;
              controller.enqueue(encoder.encode(line));
            } catch {
              // disconnected
            }
          };

          // ADR-089: подписка на ВСЕ события шины (`subscribeAll`) — и в гибриде,
          // и в standalone. Per-session `subscribe` покрывал лишь сессии,
          // существовавшие на момент подключения, поэтому события сессий,
          // созданных позже (events-funnel: auto-bind/ephemeral, add-on'ы),
          // терялись («0 subscribers — EVENT LOST»). В гибриде `remote:<id>`
          // публикует мост; локальные сессии обрабатывает оркестратор.
          unsubs.push(eventBus.subscribeAll(handler));

          const keepalive = setInterval(() => {
            try { controller.enqueue(encoder.encode(':keepalive\n\n')); } catch { clearInterval(keepalive); }
          }, 30_000);

          try {
            await new Promise<void>((resolve) => {
              if (signal.aborted) { resolve(); return; }
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          } finally {
            clearInterval(keepalive);
            for (const unsub of unsubs) unsub();
            try { controller.close(); } catch { /* already closed */ }
          }
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      },
    );
  });
}
