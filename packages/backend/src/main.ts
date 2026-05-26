import { createServer, IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { ProviderConfig, ModelConfig, AgentDefinition } from '@synth/shared';
import {
  FileStore, SessionManager, EventBus, QueueProcessorManager,
  ContextConfig, ContextBuilder, ChatOrchestrator, FileProfileStore,
  enqueueUserMessage,
} from '@synth/core';
import { nowISO, ensureDataDir, MessageRole } from '@synth/shared';
import { loadBackendConfig } from './lib/app-config.js';
import { createAuthMiddleware } from './auth/middleware.js';
import { createAuthRoutes } from './routes/auth.js';
import { createProjectRoutes } from './routes/projects.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createMessageRoutes } from './routes/messages.js';
import { createQueueRoutes } from './routes/queue.js';
import { createFsRoutes } from './routes/fs.js';
import { createProviderRoutes } from './routes/providers.js';
import { createModelRoutes } from './routes/models.js';
import { createAgentRoutes } from './routes/agents.js';
import { createContextRoutes } from './routes/context.js';
import { createDebugRoutes } from './routes/debug.js';
import { createUserRoutes } from './routes/users.js';
import { t, getTranslations } from './lib/i18n.js';
import { ProjectStore } from './storage/project-store.js';
import { JsonStore } from './storage/json-store.js';

const app = new Hono();

app.use(logger());
app.use(cors({ origin: '*', credentials: true }));

// Health (без auth)
app.get('/health', (c) => c.json({ status: 'healthy', version: '0.1.0', time: nowISO() }));
app.get('/api/v2/health', (c) => c.json({ status: 'healthy', version: '0.1.0', time: nowISO() }));

// Конфигурация
const backendConfig = await loadBackendConfig();
const auth = createAuthMiddleware(backendConfig.auth);

// Прикрепляем пользователя ко всем запросам
app.use('*', auth.attachUser);

// Хранилища
const dataDir = backendConfig.dataDir;
await ensureDataDir(dataDir);
const fileStore = new FileStore({ dataDir });
const sessionManager = new SessionManager(fileStore);
const projectStore = new ProjectStore({ dataDir });
const providerStore = new JsonStore<ProviderConfig>({ dataDir, subdir: 'providers' });
const modelStore = new JsonStore<ModelConfig>({ dataDir, subdir: 'models' });
const agentStore = new JsonStore<AgentDefinition>({ dataDir, subdir: 'agents' });
const contextConfig = new ContextConfig({ userDataDir: `${dataDir}/context` });
const profilesStore = new FileProfileStore({ dataDir });

// Auth routes (после profilesStore)
app.route('/auth', createAuthRoutes(auth, backendConfig.auth, profilesStore));

// Сидирование тестовых пользователей (debug mode)
if (backendConfig.auth.debugMode && backendConfig.auth.testUsers) {
  for (const tu of backendConfig.auth.testUsers) {
    profilesStore.getOrCreateProfile({
      username: tu.username,
      roles: tu.roles,
    }).catch((e: unknown) => console.warn('seed: failed to create profile for', tu.username, e));
  }
}

const eventBus = new EventBus();
const queueManager = new QueueProcessorManager();

// Context builder
const contextBuilder = new ContextBuilder(contextConfig, {
  profilesStore,
  projectDataDir: `${dataDir}/projects`,
  defaultLanguage: 'ru',
});

// Provider loader
const providerLoader = (name: string): ProviderConfig | null => {
  // При старте загружаем все конфиги — JsonStore.list() не подходит для быстрого lookup
  // поэтому кешируем провайдеров в Map
  return providerCache.get(name) ?? null;
};

// Кеш провайдеров (заполняется при старте)
const providerCache = new Map<string, ProviderConfig>();
(await providerStore.list()).forEach((p) => {
  providerCache.set(p.name, p);
});

// Orchestrator
const orchestrator = new ChatOrchestrator({
  sessionManager,
  eventBus,
  contextBuilder,
  providerLoader,
  dataDir,
});

const processMessage = orchestrator.createProcessMessage();

// API-заглушки для UI
app.get('/api/config/themes', (c) => c.json({ themes: [] }));

// i18n endpoints
app.get('/api/v2/i18n/current', (c) => {
  const header = c.req.header('Accept-Language');
  const lang = header?.split(',')[0]?.trim()?.slice(0, 2) === 'en' ? 'en' : 'ru';
  return c.json({ language: lang, locale: lang });
});
app.get('/api/v2/i18n/translations/ru', (c) => c.json(getTranslations('ru')));
app.get('/api/v2/i18n/translations/en', (c) => c.json(getTranslations('en')));

// Projects routes
app.route('/api/v2/projects', createProjectRoutes(auth, projectStore));

// Sessions routes
app.route('/api/v2/sessions', createSessionRoutes(auth, sessionManager, eventBus, queueManager, processMessage, orchestrator));

// Messages routes
app.route('/api/v2/messages', createMessageRoutes(auth, sessionManager));

// Queue routes
app.route('/api/v2/queue', createQueueRoutes(auth, sessionManager, queueManager, eventBus, processMessage));

// FS routes
app.route('/api/v2/fs', createFsRoutes(auth));

// Providers routes
app.route('/api/v2/providers', createProviderRoutes(auth, providerStore));

// Models routes
app.route('/api/v2/models', createModelRoutes(auth, modelStore, providerStore));

// Agents routes
app.route('/api/v2/agents', createAgentRoutes(auth, agentStore));

// Context routes
app.route('/api/v2/context', createContextRoutes(auth, contextConfig));

// User admin routes
app.route('/api/v2/users', createUserRoutes(auth, profilesStore));

// Admin routes
app.get('/admin/sessions/blocked', auth.requireAdmin, (c) => c.json({ sessions: [], count: 0 }));
app.route('/api/v2/admin/debug', createDebugRoutes(auth));

// 404
app.notFound((c) => {
  return c.json({
    error: {
      code: 'NOT_FOUND',
      message: t('errors.notFound.route', { method: c.req.method, path: c.req.path }, c),
    },
  }, 404);
});

const port = backendConfig.port;

// Вспомогательная функция для конвертации Node Request в Web Request
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

// Адаптер для auth.getCurrentUser из сырого IncomingMessage
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

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);

  // Глобальная подписка на все сессии пользователя
  if (url.pathname === '/ws/user') {
    const user = auth.getCurrentUser(reqAdapter(request));
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const clientId = `ws-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const sessionUnsubs = new Map<string, () => void>();
      console.log(`[WS /ws/user] Connected: client=${clientId} user=${user.username}`);

      // Загружаем сессии пользователя и подписываемся на каждую
      (async () => {
        const userSessions = await sessionManager.listSessions({ userId: user.id });
        console.log(`[WS /ws/user] Initial subscribe: client=${clientId} sessions=${userSessions.length}`);

        for (const s of userSessions) {
          const unsub = eventBus.subscribe(s.id, (event) => {
            try {
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify(event));
              }
            } catch {
              // ignore send errors
            }
          });
          sessionUnsubs.set(s.id, unsub);
        }

        ws.send(JSON.stringify({
          type: 'connected',
          client_id: clientId,
          engine: 'synth',
          mode: 'global',
          subscribed_sessions: userSessions.map(s => s.id),
          session_count: userSessions.length,
        }));
      })().catch(() => {
        ws.send(JSON.stringify({
          type: 'error',
          data: { error: 'Failed to load sessions' },
          timestamp: nowISO(),
        }));
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          } else if (msg.type === 'subscribe') {
            const sid = (msg.session_id as string) || (msg.sessionId as string);
            if (sid && !sessionUnsubs.has(sid)) {
              const unsub = eventBus.subscribe(sid, (event) => {
                try {
                  if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify(event));
                  }
                } catch {
                  // ignore send errors
                }
              });
              sessionUnsubs.set(sid, unsub);
              console.log(`[WS /ws/user] Subscribed: client=${clientId} session=${sid} (total=${sessionUnsubs.size})`);
              ws.send(JSON.stringify({
                type: 'subscribed',
                session_id: sid,
                timestamp: nowISO(),
              }));
            }
          } else if (msg.type === 'unsubscribe') {
            const sid = (msg.session_id as string) || (msg.sessionId as string);
            if (sid) {
              const unsub = sessionUnsubs.get(sid);
              if (unsub) {
                unsub();
                sessionUnsubs.delete(sid);
                console.log(`[WS /ws/user] Unsubscribed: client=${clientId} session=${sid} (total=${sessionUnsubs.size})`);
              }
            }
          }
          // Клиент-сообщения (send_message, cancel) не обрабатываем —
          // для этого используется per-session /ws/chat
        } catch {
          // ignore parse errors
        }
      });

      ws.on('close', () => {
        console.log(`[WS /ws/user] Disconnected: client=${clientId} sessions=${sessionUnsubs.size}`);
        for (const unsub of sessionUnsubs.values()) {
          unsub();
        }
        sessionUnsubs.clear();
      });

      ws.on('error', () => {
        for (const unsub of sessionUnsubs.values()) {
          unsub();
        }
        sessionUnsubs.clear();
      });
    });
    return;
  }

  // Per-session чат
  if (url.pathname === '/ws/chat') {
    const sessionId = url.searchParams.get('session_id');
    const wantsEvents = url.searchParams.get('events') !== 'false';
    if (!sessionId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const clientId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Подписка на события сессии (опционально)
      let unsub: (() => void) | null = null;
      if (wantsEvents) {
        unsub = eventBus.subscribe(sessionId, (event) => {
          try {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify(event));
            }
          } catch {
            // ignore send errors
          }
        });
      }

      ws.send(JSON.stringify({
        type: 'connected',
        session_id: sessionId,
        client_id: clientId,
        engine: 'synth',
        events: wantsEvents,
      }));

      // Late subscriber: отдать буферизованные чанки активного стрима (только если events=true)
      if (wantsEvents) {
        (async () => {
          const session = await sessionManager.getSession(sessionId);
          if (session?.currentStream && !session.currentStream.cancelled) {
            const streamId = session.currentStream.streamId;
            const chunks = queueManager.getRingBuffer(streamId);
            if (chunks) {
              for (const chunk of chunks) {
                if (ws.readyState === ws.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'stream.chunk',
                    sessionId,
                    data: chunk,
                    timestamp: new Date().toISOString(),
                  }));
                }
              }
            }
          }
        })().catch(() => {});
      }

      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          } else if (msg.type === 'send_message') {
            if (!msg.content?.trim()) return;

            // Мгновенный ack — не ждём блокировок при enqueueUserMessage
            const streamId = msg.stream_id || `ws-${Date.now()}`;
            ws.send(JSON.stringify({
              type: 'queued',
              data: { stream_id: streamId },
              timestamp: nowISO(),
            }));

            const session = await sessionManager.getSession(sessionId);
            if (!session) {
              ws.send(JSON.stringify({ type: 'error', session_id: sessionId, data: { error: 'Session not found' }, timestamp: nowISO() }));
              return;
            }

            const message = {
              role: MessageRole.USER,
              content: msg.content.trim(),
              createdAt: nowISO(),
              disabled: false,
              pinned: false,
              hidden: false,
              author: msg.author || 'unknown',
              agentRole: msg.agent_role || session.settings.agentRole,
              provider: msg.provider || session.settings.provider,
              model: msg.model || session.settings.model,
              metadata: { stream_id: streamId },
            };

            const result = await enqueueUserMessage(
              sessionManager, eventBus, sessionId, message, queueManager, processMessage,
            );

            if (!result) {
              ws.send(JSON.stringify({
                type: 'queue.stalled',
                session_id: sessionId,
                data: { pending_count: session.pendingMessages.length },
                timestamp: nowISO(),
              }));
            }
          } else if (msg.type === 'cancel') {
            const session = await sessionManager.getSession(sessionId);
            if (session?.currentStream) {
              orchestrator.cancel(session.currentStream.streamId);
              session.currentStream.cancelled = true;
              await sessionManager.updateSession(session);
            }
            queueManager.stop(sessionId);
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid message format' }));
        }
      });

      ws.on('close', () => {
        unsub?.();
      });

      ws.on('error', () => {
        unsub?.();
      });
    });
    return;
  }

  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

console.log(`synth-backend starting on http://localhost:${port}`);
console.log(`  data dir: ${dataDir}`);
console.log(`  debug mode: ${backendConfig.auth.debugMode}`);
if (backendConfig.auth.debugMode) {
  console.log('  test users:');
  backendConfig.auth.testUsers?.forEach((u) => {
    console.log(`    ${u.username} [${u.roles.join(', ')}] → key: ${u.apiKey.slice(0, 8)}...`);
  });
}

server.listen(port);
