// WebSocket-канал событий `/ws/events` standalone-core (ADR-008/009/024):
// аутентификация (Bearer api-key или cookie-сессия), подписка на события сессий,
// приём `send_message`/`cancel`/`permission_reply`/`ping`.
// Вынесено из `server/app.ts` (ADR-095, шаг 4a) — «вынос по швам», без изменения поведения.
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { MessageRole, generateStreamId, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';
import { enqueueUserMessage } from '../../index.js';
import type { EventBus, SessionManager, QueueProcessorManager, ChatOrchestrator } from '../../index.js';
import type { RemoteConnection } from '../../remote/connection.js';
import type { LocalAuthKit } from '../../auth/local.js';
import { isRemoteRef, toLocalId } from '../../remote/aggregate.js';

export interface EventWebSocketDeps {
  /** HTTP-сервер, на `upgrade` которого вешается обработчик. */
  server: Server;
  /** Локальная аутентификация: cookie-сессия v2 для браузера (WS не ставит Authorization). */
  auth: LocalAuthKit;
  /** Runtime-подключение к удалённому backend (гибрид). */
  connection: RemoteConnection;
  eventBus: EventBus;
  sessionManager: SessionManager;
  queueManager: QueueProcessorManager;
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>;
  orchestrator: ChatOrchestrator;
  /**
   * ADR-089: реестр подписок активных клиентов. Funnel (`RequestSessionService`)
   * через `onSessionMaterialized` подписывает клиентов владельца на сессии,
   * созданные ПОСЛЕ их подключения (паритет с managed `EventHub.subscribeToSession`).
   */
  subscriptions: EventWebSocketSubscriptions;
}

/**
 * Реестр подписок WS-клиентов standalone (`/ws/events`), ADR-089.
 *
 * Паритет с managed `EventHub`: подписка на сессию ставится персонально клиенту
 * владельца (`subscribeToSession`), когда funnel материализует сессию после
 * подключения. Раньше подписка бралась **снимком** `listSessions` на момент
 * `connect`, поэтому сессии, созданные позже (events-funnel `ephemeral`/`bind`,
 * явный `POST /api/v2/sessions`, тул `task`), оставались без подписчиков —
 * `event.routed`/`session.created`/стрим ответа терялись («0 subscribers —
 * EVENT LOST»), и дерево сессий в UI обновлялось только после перезагрузки.
 */
export class EventWebSocketSubscriptions {
  private _clients = new Set<{ userId: string; subscribe: (sessionId: string) => void }>();

  /** Зарегистрировать подписку клиента пользователя; возвращает снятие регистрации. */
  register(userId: string, subscribe: (sessionId: string) => void): () => void {
    const client = { userId, subscribe };
    this._clients.add(client);
    return () => { this._clients.delete(client); };
  }

  /** Подписать всех активных клиентов пользователя на сессию (идемпотентно у клиента). */
  subscribeToSession(userId: string, sessionId: string): void {
    for (const client of this._clients) {
      if (client.userId === userId) client.subscribe(sessionId);
    }
  }

  /** Число активных клиентов (диагностика/тесты). */
  get clientCount(): number {
    return this._clients.size;
  }
}

/**
 * Подключить обработчик `upgrade` для `/ws/events` (прочие пути → 404).
 * Возвращает `WebSocketServer` (поле `wss` хэндла приложения).
 */
export function attachEventWebSocket(deps: EventWebSocketDeps): WebSocketServer {
  const { server, auth, connection, eventBus, sessionManager, queueManager, processMessage, orchestrator, subscriptions } = deps;
  // WebSocket /ws/events
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    if (url.pathname === '/ws/events') {
      // Аутентификация: либо валидный Bearer API-ключ (CLI/API-клиенты), либо
      // cookie-сессия v2 (server-identity/local) — браузер не может ставить
      // Authorization-заголовок на WebSocket, поэтому UI полагается на cookie.
      const cookieContext = {
        req: {
          header: (name: string): string | undefined => {
            const v = request.headers[name.toLowerCase()];
            return Array.isArray(v) ? v[0] : v;
          },
        },
      };
      const user = auth.getCurrentUser(cookieContext);

      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, async (ws: WebSocket) => {
        const clientId = `ws-events-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const unsubs: Array<() => void> = [];
        /** Уже подписанные сессии клиента (идемпотентность точечной подписки). */
        const subscribed = new Set<string>();

        const handler = (event: { type: string; data: Record<string, unknown> }) => {
          try {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify(event));
            }
          } catch { /* ignore */ }
        };

        /** Точечная подписка клиента на сессию (idempotent). */
        const subscribe = (sessionId: string): void => {
          if (subscribed.has(sessionId)) return;
          subscribed.add(sessionId);
          unsubs.push(eventBus.subscribe(sessionId, handler));
        };

        // Снятие регистрации в реестре подписок (ADR-089) — на close/error.
        let unregister: (() => void) | null = null;

        if (connection.connected) {
          // Гибрид: события удалённых сессий (remote:<id>) публикует мост —
          // подписываемся на все события (без дублей для локальных).
          unsubs.push(eventBus.subscribeAll(handler));
        } else {
          const allSessions = await sessionManager.listSessions({ userId: 'local' });
          for (const s of allSessions) {
            subscribe(s.id);
          }
          // ADR-089: сессии, материализованные funnel'ом (`RequestSessionService`)
          // ПОСЛЕ этого снимка, доставляются точечной подпиской владельца —
          // `onSessionMaterialized` → `subscribeToSession`.
          unregister = subscriptions.register(user.id, subscribe);
        }

        ws.send(JSON.stringify({
          type: 'connected',
          client_id: clientId,
        }));

        ws.on('message', (raw: Buffer) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'ping') {
              ws.send(JSON.stringify({ type: 'pong' }));
            } else if (msg.type === 'send_message') {
              const sid = msg.session_id;
              if (!sid || !msg.content?.trim()) return;

              const streamId = msg.stream_id || generateStreamId();

              ws.send(JSON.stringify({
                type: 'queued',
                session_id: sid,
                stream_id: streamId,
                timestamp: nowISO(),
              }));

              (async () => {
                // Гибрид: remote-сессия (`remote:<id>`) — промпт уходит на удалённый
                // backend (raw Response, тело не читаем), события возвращаются через
                // RemoteEventBridge. Локальный оркестратор не запускается.
                if (isRemoteRef(sid)) {
                  const remote = connection.client;
                  if (!remote) {
                    ws.send(JSON.stringify({
                      type: 'error',
                      session_id: sid,
                      data: { error: 'Удалённый сервер не подключён' },
                      timestamp: nowISO(),
                    }));
                    return;
                  }
                  try {
                    await remote.promptSession(toLocalId(sid), {
                      content: msg.content.trim(),
                      messageId: streamId,
                      ...(msg.agent_role ? { agent: msg.agent_role } : {}),
                      ...(msg.provider ? { provider: msg.provider } : {}),
                      ...(msg.model ? { model: msg.model } : {}),
                    });
                  } catch (err) {
                    ws.send(JSON.stringify({
                      type: 'error',
                      session_id: sid,
                      data: { error: err instanceof Error ? err.message : String(err) },
                      timestamp: nowISO(),
                    }));
                  }
                  return;
                }

                const session = await sessionManager.getSession(sid);
                if (!session) {
                  ws.send(JSON.stringify({
                    type: 'error',
                    session_id: sid,
                    data: { error: 'Session not found' },
                    timestamp: nowISO(),
                  }));
                  return;
                }

                const message: Message = {
                  id: streamId,
                  role: MessageRole.USER,
                  seq: session.messages.length + 1,
                  origin: 'local',
                  parts: [makeTextPart(msg.content.trim())],
                  content: msg.content.trim(),
                  createdAt: nowISO(),
                  disabled: false,
                  pinned: false,
                  hidden: false,
                  author: 'local',
                  agentRole: msg.agent_role || session.settings.agentRole,
                  provider: msg.provider || session.settings.provider,
                  model: msg.model || session.settings.model,
                  metadata: { stream_id: streamId },
                };

                const result = await enqueueUserMessage(
                  sessionManager, eventBus, sid, message, queueManager, processMessage,
                  (msgSid, msg) => orchestrator.obfuscateUserMessageForHistory(msgSid, msg),
                );

                if (!result) {
                  ws.send(JSON.stringify({
                    type: 'queue.stalled',
                    session_id: sid,
                    data: { pending_count: session.pendingMessages.length },
                    timestamp: nowISO(),
                  }));
                }
              })().catch(() => {});
            } else if (msg.type === 'cancel') {
              const sid = msg.session_id;
              if (!sid) return;

              (async () => {
                const session = await sessionManager.getSession(sid);
                if (session?.currentStream) {
                  orchestrator.cancel(session.currentStream.streamId);
                  session.currentStream.cancelled = true;
                  await sessionManager.updateSession(session);
                }
                queueManager.stop(sid);
              })().catch(() => {});
            } else if (msg.type === 'permission_reply') {
              const sid = msg.session_id;
              const approvalId = msg.approval_id;
              if (!sid || !approvalId) return;

              // Новый формат: { action: 'allow'|'deny', once?: boolean }.
              // Старый формат { approved: boolean } остаётся совместимым.
              const action = msg.action === 'allow' || msg.action === 'deny' ? msg.action : undefined;
              eventBus.publish(sid, 'permission.replied', {
                approval_id: approvalId,
                session_id: sid,
                approved: action !== undefined ? action === 'allow' : msg.approved === true,
                ...(action ? { action } : {}),
                ...(typeof msg.once === 'boolean' ? { once: msg.once } : {}),
              });
            }
          } catch { /* ignore parse errors */ }
        });

        const cleanup = (): void => {
          unregister?.();
          unregister = null;
          for (const unsub of unsubs) unsub();
          unsubs.length = 0;
        };

        ws.on('close', cleanup);

        ws.on('error', cleanup);
      });
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });
  return wss;
}
