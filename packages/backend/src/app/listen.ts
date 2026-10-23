// HTTP/WS-адаптер backend: Node HTTP-сервер, прокачка ответа Hono в Node-ответ
// (включая SSE/долгоживущие стримы) и WebSocket `/ws/events` (ADR-008/009/024/089).
// Вынесено из `app.ts` (ADR-095, шаг 4b) — «вынос по швам», без изменения поведения.
import { createServer, IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { Hono } from 'hono';
import { enqueueUserMessage, enqueueSteerMessage, isSessionVisible, parsePermissionPrincipal } from '@itphx/synth-core';
import type { EventBus, SessionManager, QueueProcessorManager, ChatOrchestrator, ProjectRepository, MetricsRegistry, ApprovalRegistry } from '@itphx/synth-core';
import { nowISO, MessageRole, generateStreamId, isSteerMode, DEFAULT_STEER_MODE, MAX_STEER_INJECTIONS_PER_TURN, STEERING_ERROR_CODES } from '@itphx/synth-shared';
import type { AuthorityPrincipal } from '@itphx/synth-shared';
import type { AuthKit } from '../auth/middleware.js';
import type { EventClient, EventHub } from '../events/hub.js';
import { t } from '../lib/i18n.js';

/**
 * Вспомогательная функция для конвертации Node Request в Web Request.
 */
function toWebRequest(req: IncomingMessage): Request {
  const protocol = 'http';
  const host = req.headers.host || 'localhost';
  const url = `${protocol}://${host}${req.url || '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const method = req.method || 'GET';
  const noBody = ['GET', 'HEAD'].includes(method) || !req.headers['content-length'];
  return new Request(url, {
    method,
    headers,
    body: noBody ? undefined : (Readable.toWeb(req) as ReadableStream),
    duplex: 'half',
  } as RequestInit);
}

/**
 * Адаптер для auth.getCurrentUser из сырого IncomingMessage (WS upgrade).
 */
function reqAdapter(req: IncomingMessage) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  return {
    req: {
      header(name: string): string | undefined {
        const h = req.headers[name.toLowerCase()];
        if (!h) return undefined;
        return Array.isArray(h) ? h[0] : h;
      },
      raw: { headers },
    },
  };
}

export interface BackendListenDeps {
  app: Hono;
  auth: AuthKit;
  eventHub: EventHub;
  sessionManager: SessionManager;
  projectStore: ProjectRepository;
  eventBus: EventBus;
  queueManager: QueueProcessorManager;
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>;
  orchestrator: ChatOrchestrator;
  /** Порт по умолчанию (`backendConfig.port`). */
  defaultPort: number;
  /**
   * PROP-108 Ф3: реестр подтверждений. Задан — ответ на `permission_reply`
   * принимает только **носитель покрывающего гранта** (не «кто видит сессию»).
   * Не задан — поведение прежнее (слой Authority выключен/в shadow).
   */
  approvalRegistry?: ApprovalRegistry;
  /**
   * ADR-094: реестр метрик (задан только при `metrics.enabled`). WS-апгрейд не
   * проходит через Hono-middleware — активные соединения учитываются здесь.
   */
  metrics?: MetricsRegistry;
}

/**
 * Создать функцию `listen` хэндла приложения.
 *
 * Поднять HTTP-сервер с WebSocket /ws/events на указанном порту
 * (порт 0 → эфемерный). Возвращает фактический порт.
 */
export function createBackendListen(deps: BackendListenDeps) {
  const { app, auth, eventHub, sessionManager, projectStore, eventBus, queueManager, processMessage, orchestrator } = deps;

  return async function listen(port: number = deps.defaultPort, host: string = '0.0.0.0') {
    // Создаем HTTP сервер с WebSocket
    const server = createServer(async (req, res) => {
      try {
        const webReq = toWebRequest(req);
        const response = await app.fetch(webReq, {});
        if (!response) {
          res.writeHead(500);
          res.end();
          return;
        }
        const headers = Object.fromEntries(response.headers.entries());
        res.writeHead(response.status, headers);
        // SSE/долгоживущие стримы: при chunked-кодировании Node не сбрасывает
        // заголовки в сокет до первого write()/end(). Для пустого начала стрима
        // (SSE до первого события/keepalive) клиент иначе не получит заголовки
        // вовсе — сбрасываем head принудительно.
        res.flushHeaders();
        if (response.body) {
          const reader = response.body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
            res.end();
          };
          pump().catch(() => res.end());
        } else {
          res.end();
        }
      } catch {
        res.writeHead(500);
        res.end();
      }
    });

    // WebSocket /ws/chat
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', async (request, socket, head) => {
      const url = new URL(request.url || '', `http://${request.headers.host}`);

      // Глобальный event-хаб для всех сессий пользователя
      if (url.pathname === '/ws/events') {
        const user = await auth.getCurrentUser(reqAdapter(request)).catch(() => null);
        if (!user) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        // ADR-052 (этап IV) / ADR-089: тот же watch-all, что у SSE. В WS-апгрейде
        // Hono-контекста нет, поэтому service-key распознаётся по синтетическому
        // id `service:<keyId>` (его ставит резолвер `getCurrentUser`); ADMIN/LEAD —
        // сквозной обзор. Обычный USER получает только свои сессии.
        const allSessions =
          user.id.startsWith('service:') || auth.hasRole({ get: () => user }, 'ADMIN', 'LEAD');

        wss.handleUpgrade(request, socket, head, (ws) => {
          const clientId = `ws-events-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          // ADR-094: активное WS-соединение — в streams_active (не в гистограмме).
          const streams = deps.metrics?.gauge(
            'synth_http_streams_active',
            'Number of active long-lived streams (SSE/WebSocket).',
          );
          streams?.inc();
          let streamReleased = false;
          const releaseStream = (): void => {
            if (streamReleased) return;
            streamReleased = true;
            streams?.dec();
          };

          const client: EventClient = {
            userId: user.id,
            username: user.username,
            allSessions,
            send(event) {
              try {
                if (ws.readyState === ws.OPEN) {
                  ws.send(JSON.stringify(event));
                }
              } catch {
                // ignore send errors
              }
            },
          };

          eventHub.registerClient(client).then(() => {
            console.log(`[WS /ws/events] Connected: client=${clientId} user=${user.username}`);
            ws.send(JSON.stringify({
              type: 'connected',
              client_id: clientId,
            }));
          }).catch(() => {
            ws.send(JSON.stringify({
              type: 'error',
              data: { error: 'Failed to register client' },
              timestamp: nowISO(),
            }));
          });

          /**
           * ADR-089 (P0): сессия, доступная текущему клиенту, либо `null`.
           * Единое правило видимости (`isSessionVisible`) — владелец/участник
           * проекта; ADMIN/LEAD и service-key (allSessions) видят всё.
           * Недоступная чужая сессия неотличима от несуществующей.
           */
          const loadVisibleSession = async (sid: string) => {
            const session = await sessionManager.getSession(sid);
            if (!session) return null;
            const visible = await isSessionVisible(session, projectStore, {
              userId: user.id,
              elevated: allSessions,
            });
            return visible ? session : null;
          };

          ws.on('message', (raw) => {
            try {
              const msg = JSON.parse(raw.toString());
              if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
              } else if (msg.type === 'send_message') {
                const sid = msg.session_id;
                if (!sid || !msg.content?.trim()) return;

                const streamId = msg.stream_id || generateStreamId();

                // PROP-098: режим отправки. `steer` — вмешательство в активный
                // ход, `interrupt` — прерывание текущей генерации (ход при этом
                // НЕ завершается).
                const mode = isSteerMode(msg.mode) ? msg.mode : DEFAULT_STEER_MODE;
                // Для `steer`/`interrupt` подтверждение уходит после приёма
                // сообщения (иначе «queued» означало бы принятое, но отброшенное).
                const steerMode = mode !== 'queue';

                (async () => {
                  const session = await loadVisibleSession(sid);
                  if (!session) {
                    ws.send(JSON.stringify({
                      type: 'error',
                      session_id: sid,
                      data: { error: 'Session not found' },
                      timestamp: nowISO(),
                    }));
                    return;
                  }

                  if (!steerMode) {
                    ws.send(JSON.stringify({
                      type: 'queued',
                      session_id: sid,
                      stream_id: streamId,
                      timestamp: nowISO(),
                    }));
                  }

                  const message: import('@itphx/synth-shared').Message = {
                    id: streamId,
                    role: MessageRole.USER,
                    seq: session.messages.length + 1,
                    origin: 'local',
                    parts: [{ id: generateStreamId(), type: 'text' as const, data: msg.content.trim() }],
                    content: msg.content.trim(),
                    createdAt: nowISO(),
                    disabled: false,
                    pinned: false,
                    hidden: false,
                    author: user.username,
                    agentRole: msg.agent_role || session.settings.agentRole,
                    provider: msg.provider || session.settings.provider,
                    model: msg.model || session.settings.model,
                    metadata: { stream_id: streamId },
                  };

                  // PROP-098: `steer` — вмешательство в активный ход, `interrupt` —
                  // прерывание текущей генерации (ход НЕ завершается). Если хода
                  // нет — обычная очередь (сообщение начнёт новый ход).
                  if (steerMode && (session.status?.blocked || queueManager.isRunning(sid))) {
                    const interruptMode = mode === 'interrupt';
                    const steerResult = await enqueueSteerMessage(
                      sessionManager, eventBus, sid, message, MAX_STEER_INJECTIONS_PER_TURN,
                      (msgSid, steerMsg) => orchestrator.obfuscateUserMessageForHistory(msgSid, steerMsg),
                      { interrupt: interruptMode },
                    );
                    if (!steerResult.accepted) {
                      ws.send(JSON.stringify({
                        type: 'error',
                        session_id: sid,
                        data: {
                          error: t('errors.chat.steerLimitExceeded', { max: MAX_STEER_INJECTIONS_PER_TURN }),
                          code: STEERING_ERROR_CODES.limitExceeded,
                        },
                        timestamp: nowISO(),
                      }));
                      return;
                    }
                    if (interruptMode) {
                      // Прерываем текущую генерацию (ход продолжается) — сообщение
                      // уже в очереди инъекций, поэтому инъекция гарантированно
                      // попадёт в ход на ближайшей границе шага.
                      const liveStreamId = session.currentStream?.streamId;
                      if (liveStreamId) orchestrator.interrupt(liveStreamId);
                    }
                    ws.send(JSON.stringify({
                      type: 'queued',
                      session_id: sid,
                      stream_id: streamId,
                      timestamp: nowISO(),
                    }));
                    return;
                  }

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
                  const session = await loadVisibleSession(sid);
                  if (session?.currentStream) {
                    orchestrator.cancel(session.currentStream.streamId);
                  }
                })().catch(() => {});
              } else if (msg.type === 'permission_reply') {
                const sid = msg.session_id;
                const approvalId = msg.approval_id;
                if (!sid || !approvalId) return;

                // Новый формат: { action: 'allow'|'deny', once?: boolean }.
                // Старый формат { approved: boolean } остаётся совместимым.
                const action = msg.action === 'allow' || msg.action === 'deny' ? msg.action : undefined;
                const approved = action !== undefined ? action === 'allow' : msg.approved === true;
                const once = typeof msg.once === 'boolean' ? msg.once : undefined;
                // PROP-108 Ф0: аддитивные поля `principal`/`turn_id`.
                const principal = parsePermissionPrincipal(msg.principal);
                const turnId = typeof msg.turn_id === 'string' && msg.turn_id.trim() !== '' ? msg.turn_id : undefined;

                (async () => {
                  // ADR-089 (P0): подтверждать права можно только в своей сессии.
                  const session = await loadVisibleSession(sid);
                  if (!session) return;

                  // PROP-108 Ф3: ответ принимает только **носитель покрывающего
                  // гранта**, а не «кто видит сессию» (дыра «`VIEWER`
                  // подтверждает мутирующий тул»). Реестр не задан — слой
                  // Authority выключен/в shadow, поведение прежнее.
                  const registry = deps.approvalRegistry;
                  if (!registry) {
                    eventBus.publish(sid, 'permission.replied', {
                      approval_id: approvalId,
                      session_id: sid,
                      approved,
                      ...(action ? { action } : {}),
                      ...(once !== undefined ? { once } : {}),
                      ...(principal ? { principal } : {}),
                      ...(turnId ? { turn_id: turnId } : {}),
                    });
                    return;
                  }

                  // Принципал-отвечающий — **аутентифицированный** (клиенту не
                  // доверяем): подтверждать может только носитель гранта.
                  const responder: AuthorityPrincipal = {
                    kind: 'user',
                    id: user.id,
                    roles: user.roles ?? [],
                  };
                  const claim = await registry.claim(approvalId, sid, responder, {
                    ...(turnId ? { turnId } : {}),
                    ...(typeof msg.digest === 'string' && msg.digest !== '' ? { digest: msg.digest } : {}),
                  });
                  if (!claim.ok) {
                    // Отказ: подтверждение не принимается (нет гранта / повторный
                    // ответ / чужой ход) — действие не выполняется.
                    eventBus.publish(sid, 'permission.replied', {
                      approval_id: approvalId,
                      session_id: sid,
                      approved: false,
                      action: 'deny',
                      reason: claim.reason,
                    });
                    ws.send(JSON.stringify({
                      type: 'error',
                      session_id: sid,
                      data: {
                        error: t('errors.chat.approvalDenied', { reason: claim.reason }),
                        code: 'APPROVAL_DENIED',
                      },
                      timestamp: nowISO(),
                    }));
                    return;
                  }
                  eventBus.publish(sid, 'permission.replied', {
                    approval_id: approvalId,
                    session_id: sid,
                    approved,
                    ...(action ? { action } : {}),
                    ...(once !== undefined ? { once } : {}),
                    // Привязка — из реестра (серверный источник истины).
                    principal: responder,
                    turn_id: claim.binding?.turnId,
                    digest: claim.binding?.digest,
                  });
                })().catch(() => {});
              } else if (msg.type === 'permission_hold') {
                const sid = msg.session_id;
                const approvalId = msg.approval_id;
                if (!sid || !approvalId) return;

                (async () => {
                  // «Остановить таймер»: publish permission.hold — оркестратор снимает
                  // авто-отклонение по таймауту, запрос ждёт ответа пользователя.
                  // ADR-089 (P0): только для своей сессии.
                  const session = await loadVisibleSession(sid);
                  if (!session) return;
                  eventBus.publish(sid, 'permission.hold', {
                    approval_id: approvalId,
                    session_id: sid,
                  });
                })().catch(() => {});
              }
            } catch {
              // ignore parse errors
            }
          });

          ws.on('close', () => {
            console.log(`[WS /ws/events] Disconnected: client=${clientId}`);
            releaseStream();
            eventHub.unregisterClient(client);
          });

          ws.on('error', () => {
            releaseStream();
            eventHub.unregisterClient(client);
          });
        });
        return;
      }

      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });

    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;

    return { server, wss, port: actualPort };
  };
}
