// Глобальный SSE-хаб backend (`GET /api/v2/events`) — SSE-фоллбек транспортного
// слоя UI (ADR-008/009/024) и канал внешних подписчиков (ADR-052/ADR-089).
// Вынесено из `app.ts` (ADR-095, шаг 4b) — «вынос по швам», без изменения поведения.
import type { Hono } from 'hono';
import { getServiceCredential } from '@itphx/synth-core';
import type { ScopeGuardFactory } from '@itphx/synth-core';
import type { BusEvent } from '@itphx/synth-shared';
import type { AuthKit } from '../auth/middleware.js';
import type { EventClient, EventHub } from '../events/hub.js';

export interface EventsSseDeps {
  auth: AuthKit;
  eventHub: EventHub;
  /** ADR-052: `events:watch` — scope-гейт service-key (для интерактивных кред — no-op). */
  scopeGuard: ScopeGuardFactory;
}

/**
 * Зарегистрировать SSE-хаб (`GET /api/v2/events`): подписка на события сессий
 * пользователя (watch-all — для service-key и ADMIN/LEAD, ADR-052 этап IV).
 */
export function registerEventsSse(app: Hono, deps: EventsSseDeps): void {
  const { auth, eventHub, scopeGuard } = deps;

  // Глобальный SSE-хаб для всех сессий пользователя.
  // ADR-052: `events:watch` — scope service-key для подписки на поток событий.
  app.get('/api/v2/events', auth.requireAuth, scopeGuard('events:watch'), async (c) => {
    const user = (await auth.getCurrentUser(c))!;
    const signal = c.req.raw.signal;
    // ADR-052 (этап IV) / ADR-089: машинный watcher (service-key со scope
    // `events:watch`) и роли сквозного обзора ADMIN/LEAD получают события ВСЕХ
    // сессий (паритет со standalone-core `subscribeAll`), обычный пользователь —
    // только своих. Без этого синтетический `service:<keyId>` шлюза не владеет
    // сессиями → подписок 0 → ответы агента не доходят до Telegram.
    const allSessions = Boolean(getServiceCredential(c)) || auth.hasRole(c as never, 'ADMIN', 'LEAD');

    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const sseClient: EventClient = {
            userId: user.id,
            username: user.username,
            allSessions,
            send(event: BusEvent) {
              try {
                const line = `data: ${JSON.stringify(event)}\n\n`;
                controller.enqueue(encoder.encode(line));
              } catch {
                // client disconnected
              }
            },
          };

          try {
            console.log(`[SSE /api/v2/events] Connected: user=${user.username} allSessions=${allSessions}`);
            await eventHub.registerClient(sseClient);

            // Keepalive: раз в 30 секунд отправляем комментарий для предотвращения разрыва
            const keepalive = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(':keepalive\n\n'));
              } catch {
                clearInterval(keepalive);
              }
            }, 30_000);

            // Keep connection alive until abort or disconnect
            try {
              await new Promise<void>((resolve) => {
                if (signal.aborted) { resolve(); return; }
                signal.addEventListener('abort', () => resolve(), { once: true });
              });
            } finally {
              clearInterval(keepalive);
            }
          } catch (err) {
            console.error('[SSE /api/v2/events] Error:', err);
          } finally {
            eventHub.unregisterClient(sseClient);
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
