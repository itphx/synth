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
  /** Локальный API-ключ (`serve --api-key`/`SYNTH_API_KEY`/`core.apiKey`). */
  apiKey: string;
  /** Локальная аутентификация: cookie-сессия v2 для браузера (WS не ставит Authorization). */
  auth: LocalAuthKit;
  /** Runtime-подключение к удалённому backend (гибрид). */
  connection: RemoteConnection;
  eventBus: EventBus;
  sessionManager: SessionManager;
  queueManager: QueueProcessorManager;
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>;
  orchestrator: ChatOrchestrator;
}

/**
 * Подключить обработчик `upgrade` для `/ws/events` (прочие пути → 404).
 * Возвращает `WebSocketServer` (поле `wss` хэндла приложения).
 */
export function attachEventWebSocket(deps: EventWebSocketDeps): WebSocketServer {
  const { server, apiKey, auth, connection, eventBus, sessionManager, queueManager, processMessage, orchestrator } = deps;
  // WebSocket /ws/events
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    if (url.pathname === '/ws/events') {
      const authHeader = request.headers['authorization'] || request.headers['Authorization'];
      const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;

      // Аутентификация: либо валидный Bearer API-ключ (CLI/API-клиенты), либо
      // cookie-сессия v2 (server-identity/local) — браузер не может ставить
      // Authorization-заголовок на WebSocket, поэтому UI полагается на cookie.
      let authorized = token === apiKey;
      if (!authorized) {
        const cookieContext = {
          req: {
            header: (name: string): string | undefined => {
              const v = request.headers[name.toLowerCase()];
              return Array.isArray(v) ? v[0] : v;
            },
          },
        };
        authorized = auth.getCurrentUser(cookieContext) !== null;
      }

      if (!authorized) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, async (ws: WebSocket) => {
        const clientId = `ws-events-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const unsubs: Array<() => void> = [];

        const handler = (event: { type: string; data: Record<string, unknown> }) => {
          try {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify(event));
            }
          } catch { /* ignore */ }
        };

        if (connection.connected) {
          // Гибрид: события удалённых сессий (remote:<id>) публикует мост —
          // подписываемся на все события (без дублей для локальных).
          unsubs.push(eventBus.subscribeAll(handler));
        } else {
          const allSessions = await sessionManager.listSessions({ userId: 'local' });
          for (const s of allSessions) {
            unsubs.push(eventBus.subscribe(s.id, handler));
          }
        }

        ws.send(JSON.stringify({
          type: 'connected',
          client_id: clientId,
          engine: 'synth',
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

        ws.on('close', () => {
          for (const unsub of unsubs) unsub();
        });

        ws.on('error', () => {
          for (const unsub of unsubs) unsub();
        });
      });
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });
  return wss;
}
