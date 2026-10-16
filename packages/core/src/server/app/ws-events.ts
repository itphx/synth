// WebSocket-канал событий `/ws/events` standalone-core (ADR-008/009/024):
// аутентификация (Bearer api-key или cookie-сессия), подписка на события сессий,
// приём `send_message`/`cancel`/`permission_reply`/`ping`.
// Вынесено из `server/app.ts` (ADR-095, шаг 4a) — «вынос по швам», без изменения поведения.
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { MessageRole, generateStreamId, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { BusEvent, Message } from '@itphx/synth-shared';
import { enqueueUserMessage } from '../../index.js';
import type { EventBus, SessionManager, QueueProcessorManager, ChatOrchestrator } from '../../index.js';
import type { RemoteConnection } from '../../remote/connection.js';
import type { LocalAuthKit } from '../../auth/local.js';
import { isRemoteRef, toLocalId } from '../../remote/aggregate.js';
import { extractChildSessionId, extractCreatedSession } from '../../events/child-session.js';
import { LOCAL_USER_ID } from '../local-owner.js';
import type { LocalOwnerResolver } from '../local-owner.js';

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
   * через `onSessionMaterialized`, роуты через `onSessionCreated`/`onSessionForked`
   * и сам хаб (по событиям `session.created`/`child.*`/`subagent.resume.*`)
   * подписывают клиентов владельца на сессии, созданные ПОСЛЕ их подключения
   * (паритет с managed `EventHub.subscribeToSession` + автоподписка на child).
   */
  subscriptions: EventWebSocketSubscriptions;
  /**
   * ADR-089 (standalone): нормализация legacy-владельца (UUID профиля `local`,
   * созданный до фикса резолвера внешней идентичности): при снимке подписок
   * `connect` legacy-сессии попадают в `listSessions` владельца `local`, а
   * авто-подписки нормализуют владельца из payload. Managed не задаёт.
   */
  localOwnerResolver?: LocalOwnerResolver;
}

/** Активный WS-клиент standalone в реестре подписок (ADR-089). */
export interface EventWsClient {
  /** Владелец клиента (в standalone — `local` либо серверная личность гибрида). */
  userId: string;
  /**
   * Подписать клиента на сессию (идемпотентно у клиента).
   * @returns `true` — подписка установлена впервые.
   */
  subscribe: (sessionId: string) => boolean;
  /** Отправить событие клиенту (WS-кадр; форвард полезной нагрузки авто-подписки). */
  send: (event: BusEvent) => void;
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
 *
 * Дополнительно (инвариант «путь, публикующий `session.created`, уведомляет
 * хаб»): дочерние сессии саб-агентов и импортированные сессии подписываются
 * автоматически — см. `subscribeToNewSession` и обработчик в `attachEventWebSocket`.
 */
export class EventWebSocketSubscriptions {
  private _clients = new Set<EventWsClient>();
  /**
   * ADR-089 (standalone): нормализация id владельца (legacy-UUID профиля `local`
   * → `local`). По умолчанию — тождество; задаётся `setOwnerNormalizer`.
   */
  private _normalizeOwner: (owner: string) => string = (owner) => owner;

  /** Задать нормализацию владельца (standalone: legacy-UUID профиля `local`). */
  setOwnerNormalizer(fn: (owner: string) => string): void {
    this._normalizeOwner = fn;
  }

  /** Зарегистрировать подписку клиента пользователя; возвращает снятие регистрации. */
  register(client: EventWsClient): () => void {
    this._clients.add(client);
    return () => { this._clients.delete(client); };
  }

  /** Подписать всех активных клиентов пользователя на сессию (идемпотентно у клиента). */
  subscribeToSession(userId: string, sessionId: string): void {
    const owner = this._normalizeOwner(userId);
    for (const client of this._clients) {
      if (client.userId === owner) client.subscribe(sessionId);
    }
  }

  /**
   * Авто-подписка владельца на новую сессию, о которой хаб узнал из события,
   * опубликованного в **её собственный** канал (`session.created` /
   * `session.fork.created`; так публикуют `remote/transfer.ts` и роуты).
   * Событие-триггер форвардится клиентам, подписанным впервые, — иначе первый
   * кадр `session.created` потерялся бы у клиента, не подписанного заранее
   * (роуты/снимок подписывают клиента до publish — тогда форварда нет: `subscribe`
   * возвращает `false`, дублей не возникает).
   *
   * Видимость не расширяется: подписываются только клиенты, чей `userId` совпал
   * с владельцем из payload (`owner_id`/`user_id`).
   */
  subscribeToNewSession(userId: string, sessionId: string, event: BusEvent): void {
    const owner = this._normalizeOwner(userId);
    for (const client of this._clients) {
      if (client.userId !== owner) continue;
      if (client.subscribe(sessionId)) client.send(event);
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
  const { server, auth, connection, eventBus, sessionManager, queueManager, processMessage, orchestrator, subscriptions, localOwnerResolver } = deps;
  // ADR-089 (standalone): нормализация владельца для авто-подписок (legacy-UUID
  // профиля `local` → `local`). Использует уже разрешённый набор id (sync-кэш,
  // наполняется снимком `connect`/`onSessionMaterialized`); до первого разрешения
  // — тождество (fail-safe, видимость не расширяется).
  if (localOwnerResolver) {
    subscriptions.setOwnerNormalizer((owner) =>
      localOwnerResolver.isLocalOwnerCached(owner) ? LOCAL_USER_ID : owner,
    );
  }
  // WebSocket /ws/events
  const wss = new WebSocketServer({ noServer: true });

  // ADR-089 (инвариант): новая сессия, о которой хаб узнаёт из
  // `session.created`/`session.fork.created` в **её собственном** канале
  // (импорт `remote/transfer.ts`, роуты), автоматически подписывает клиентов
  // владельца — без переподключения. Роуты и снимок подписывают клиента ДО
  // publish → форварда нет, дублей не возникает. Записи, опубликованные в канал
  // родителя (тул `task`), обрабатывает per-client `handler` выше.
  const unsubCreatedSession = eventBus.subscribeAll((event) => {
    const created = extractCreatedSession(event);
    if (!created || created.id !== event.sessionId) return;
    subscriptions.subscribeToNewSession(created.owner, created.id, event);
  });
  wss.on('close', () => unsubCreatedSession());

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

        const send = (event: BusEvent): void => {
          try {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify(event));
            }
          } catch { /* ignore */ }
        };

        /**
         * Обработчик событий подписанных сессий: доставка + авто-подписка на
         * дочернюю сессию саб-агента (паритет с managed `EventHub`). Тул `task`
         * публикует `session.created`/`child.message.added`/`subagent.resume.*` в
         * канал родителя — клиент на них уже подписан, а на ребёнка — нет.
         */
        const handler = (event: BusEvent): void => {
          send(event);
          const childId = extractChildSessionId(event);
          if (childId && childId !== event.sessionId) {
            // Владелец ребёнка — владелец родителя (fork.ts наследует userId/ownerId),
            // поэтому подписываем клиентов того же пользователя, что получил событие:
            // это не расширяет видимость (клиент уже видел родителя).
            subscriptions.subscribeToSession(user.id, childId);
          }
        };

        /** Точечная подписка клиента на сессию (idempotent); true — подписка новая. */
        const subscribe = (sessionId: string): boolean => {
          if (subscribed.has(sessionId)) return false;
          subscribed.add(sessionId);
          unsubs.push(eventBus.subscribe(sessionId, handler));
          return true;
        };

        // Снятие регистрации в реестре подписок (ADR-089) — на close/error.
        let unregister: (() => void) | null = null;

        if (connection.connected) {
          // Гибрид: события удалённых сессий (remote:<id>) публикует мост —
          // подписываемся на все события (без дублей для локальных).
          unsubs.push(eventBus.subscribeAll(handler));
        } else {
          // ADR-089 (standalone): legacy-владелец (UUID профиля `local`) входит в
          // снимок подписок — иначе такие сессии остаются без подписчиков.
          const ownerIds = localOwnerResolver
            ? [...(await localOwnerResolver.resolveLocalOwnerIds())]
            : undefined;
          // Нужны только id сессий владельца — лёгкая выборка (без истории).
          const allSessions = await sessionManager.listSessions({ userId: 'local', ownerIds }, { light: true });
          for (const s of allSessions) {
            subscribe(s.id);
          }
          // ADR-089: сессии, материализованные funnel'ом (`RequestSessionService`)
          // ПОСЛЕ этого снимка, доставляются точечной подпиской владельца —
          // `onSessionMaterialized` → `subscribeToSession`.
          unregister = subscriptions.register({ userId: user.id, subscribe, send });
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
                  const streamId = session.currentStream.streamId;
                  // read-modify-write сессии — только под `SessionManager.withLock`:
                  // иначе снятие/запись `cancelled` затёрло бы конкурентную запись
                  // (частичный ответ процессора). `currentStream` перечитывается под
                  // локом: если стрим уже завершён — ничего не пишем.
                  const cancelled = await sessionManager.withLock(sid, async (s) => {
                    if (!s.currentStream) return false;
                    s.currentStream.cancelled = true;
                    await sessionManager.updateSession(s);
                    return true;
                  });
                  if (cancelled) orchestrator.cancel(streamId);
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
