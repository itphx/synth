// Глобальный SSE-хаб событий (`GET /api/v2/events`) standalone-core — фоллбек
// транспортного слоя UI (ADR-008/009/024) и канал внешних подписчиков (ADR-052).
// Вынесено из `server/app.ts` (ADR-095, шаг 4a) — «вынос по швам», без изменения поведения.
import type { Hono } from 'hono';
import type { EventBus } from '../../index.js';
import type { BusEvent } from '@itphx/synth-shared';
import { requireScope } from '../service-scope.js';
import {
  MESSAGE_MODEL_QUERY_PARAM,
  MESSAGE_MODEL_UNSUPPORTED_REASON,
  isSupportedMessageModelParam,
  parseSinceParam,
} from '../../events/bus.js';

/**
 * Зарегистрировать SSE-хаб. Подписка — на ВСЕ события шины (`subscribeAll`),
 * включая сессии, созданные позже (ADR-089 events-funnel). `events:watch` —
 * scope service-key (для интерактивных кред — no-op).
 *
 * ADR-118 §6/§8: кадр несёт `id:` (номер события в пределах сессии) — по нему
 * работает догон (`Last-Event-ID` / `?since`); клиент обязан заявить модель
 * сообщений (`messageModel=2`) — иначе поток не устанавливается (fail-closed).
 */
export function registerEventsSse(app: Hono, eventBus: EventBus): void {
  // Глобальный SSE-хаб
  // ADR-052: `events:watch` — scope service-key для подписки на поток событий.
  app.get('/api/v2/events', requireScope('events:watch'), async (c) => {
    // ADR-118 §8: гейт минимальной версии клиента (fail-closed) — без
    // `messageModel=2` поток не открывается (426 Upgrade Required).
    if (!isSupportedMessageModelParam(c.req.query(MESSAGE_MODEL_QUERY_PARAM))) {
      return c.json(
        { error: { code: 'UPGRADE_REQUIRED', message: MESSAGE_MODEL_UNSUPPORTED_REASON } },
        426,
      );
    }

    // ADR-118 §6: догон — `Last-Event-ID` (заголовок) либо `?since=`.
    const sinceSeq = parseSinceParam(c.req.header('last-event-id') ?? c.req.query('since'));

    const signal = c.req.raw.signal;

    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();

          const unsubs: Array<() => void> = [];

          /**
           * ADR-118 §6: порядок «сначала журнал, потом живое». Пока идёт
           * воспроизведение журнала, живые события копятся в буфере; уже
           * отправленные номера (`sentSeq`) отсекают дубли.
           */
          let replaying = sinceSeq !== null;
          const pending: BusEvent[] = [];
          const sentSeq = new Map<string, number>();

          const write = (event: BusEvent): void => {
            const seq = event.eventSeq;
            if (typeof seq === 'number') {
              const last = sentSeq.get(event.sessionId) ?? 0;
              if (seq <= last) return;
              sentSeq.set(event.sessionId, seq);
            }
            try {
              // `id:` — номер события в пределах сессии (ADR-118 §6): по нему
              // клиент продолжает ленту после переподключения (`Last-Event-ID`).
              const id = typeof event.eventSeq === 'number' ? `id: ${event.eventSeq}\n` : '';
              const line = `${id}data: ${JSON.stringify(event)}\n\n`;
              controller.enqueue(encoder.encode(line));
            } catch {
              // disconnected
            }
          };

          const handler = (event: BusEvent) => {
            if (replaying) {
              pending.push(event);
              return;
            }
            write(event);
          };

          // ADR-089: подписка на ВСЕ события шины (`subscribeAll`) — и в гибриде,
          // и в standalone. Per-session `subscribe` покрывал лишь сессии,
          // существовавшие на момент подключения, поэтому события сессий,
          // созданных позже (events-funnel: auto-bind/ephemeral, add-on'ы),
          // терялись («0 subscribers — EVENT LOST»). В гибриде `remote:<id>`
          // публикует мост; локальные сессии обрабатывает оркестратор.
          unsubs.push(eventBus.subscribeAll(handler));

          // ADR-118 §6: журнал событий — строго после `since` (глобальный хаб
          // подписан на все сессии; номер события монотонен в пределах сессии).
          if (sinceSeq !== null) {
            for (const event of eventBus.journalSince(sinceSeq)) write(event);
          }
          replaying = false;
          for (const event of pending) write(event);
          pending.length = 0;

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
