import { createServer, IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { ProviderConfig, ModelConfig, AgentDefinition } from '@synth/shared';
import {
  FileStore, SessionManager, EventBus, QueueProcessorManager,
  ContextConfig, ContextBuilder, ContextOptimizer, ChatOrchestrator, FileProfileStore,
  enqueueUserMessage,
} from '@synth/core';
import type { SummarizationConfig } from '@synth/shared';
import { nowISO, ensureDataDir, MessageRole, generateStreamId } from '@synth/shared';
import type { BusEvent } from '@synth/shared';
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
import { createGitRoutes } from './routes/git.js';
import { t, getTranslations } from './lib/i18n.js';
import { ProjectStore } from './storage/project-store.js';
import { JsonStore } from './storage/json-store.js';
import { EventHub } from './events/hub.js';
import type { EventClient } from './events/hub.js';

const app = new Hono();

app.use(logger());
// CORS настраивается после загрузки конфига

// Health (без auth)
app.get('/health', (c) => c.json({ status: 'healthy', version: '0.1.0', time: nowISO() }));
app.get('/api/v2/health', (c) => c.json({ status: 'healthy', version: '0.1.0', time: nowISO() }));

// Конфигурация
const backendConfig = await loadBackendConfig();

app.use(cors({
  origin: backendConfig.synth.server.corsOrigin || 'http://localhost:5002',
  credentials: true,
}));

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
app.route('/auth', createAuthRoutes(auth, backendConfig.auth, profilesStore, dataDir));

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

// Кеш моделей (заполняется при старте)
const modelCache = new Map<string, ModelConfig>();
(await modelStore.list()).forEach((m) => {
  modelCache.set(m.id, m);
});

// ContextOptimizer
const summarizationConfig: SummarizationConfig = backendConfig.synth.summarization;
const contextOptimizer = new ContextOptimizer(contextConfig, providerLoader, summarizationConfig);

// Set ContextOptimizer on QueueProcessorManager
queueManager.setContextOptimizer(contextOptimizer);

// Model price loader
const modelPriceLoader = (modelName: string) => {
  // Поиск по имени модели в кэше (сначала по полному ID, потом по name)
  for (const m of modelCache.values()) {
    if (m.name === modelName || m.id === modelName) {
      return {
        inputPrice: m.inputPrice,
        outputPrice: m.outputPrice,
        cacheReadPrice: m.cacheReadPrice,
        cacheWritePrice: m.cacheWritePrice,
      };
    }
  }
  return null;
};

// Orchestrator
const orchestrator = new ChatOrchestrator({
  sessionManager,
  eventBus,
  contextBuilder,
  providerLoader,
  contextOptimizer,
  modelPriceLoader,
  dataDir,
});

const processMessage = orchestrator.createProcessMessage();

// EventHub — центральный диспетчер подписок
const eventHub = new EventHub(eventBus, sessionManager);

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
app.route('/api/v2/projects', createProjectRoutes(auth, projectStore, sessionManager, backendConfig.workspacesRoot));

// Sessions routes
app.route('/api/v2/sessions', createSessionRoutes(auth, sessionManager, eventBus, queueManager, processMessage, orchestrator, eventHub, contextOptimizer));

// Messages routes
app.route('/api/v2/messages', createMessageRoutes(auth, sessionManager, contextOptimizer, eventBus));

// Queue routes
app.route('/api/v2/queue', createQueueRoutes(auth, sessionManager, queueManager, eventBus, processMessage));

// FS routes
app.route('/api/v2/fs', createFsRoutes(auth, projectStore, backendConfig.workspacesRoot));

// Providers routes
app.route('/api/v2/providers', createProviderRoutes(auth, providerStore));

// Models routes
app.route('/api/v2/models', createModelRoutes(auth, modelStore, providerStore));

// Agents routes
app.route('/api/v2/agents', createAgentRoutes(auth, agentStore, sessionManager));

// Context routes
app.route('/api/v2/context', createContextRoutes(auth, contextConfig));

// User admin routes
app.route('/api/v2/users', createUserRoutes(auth, profilesStore));

// Git routes
app.route('/api/v2/git', createGitRoutes(auth, projectStore, backendConfig.workspacesRoot));

// Глобальный SSE-хаб для всех сессий пользователя
app.get('/api/v2/events', auth.requireAuth, async (c) => {
  const user = auth.getCurrentUser(c)!;
  const signal = c.req.raw.signal;

  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const sseClient: EventClient = {
          userId: user.id,
          username: user.username,
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
          console.log(`[SSE /api/v2/events] Connected: user=${user.username}`);
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

// Admin routes
app.get('/admin/sessions/blocked', auth.requireAdmin, (c) => c.json({ sessions: [], count: 0 }));
app.route('/api/v2/admin/debug', createDebugRoutes(auth));

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Shutdown] Получен сигнал ${signal}, начинаю graceful shutdown...`);

  server.close((err) => {
    if (err) console.error('[Shutdown] Server close error:', err);
  });
  console.log('[Shutdown] HTTP сервер больше не принимает соединения');

  eventHub.shutdown();

  wss.close((err) => {
    if (err) console.error('[Shutdown] WSS close error:', err);
  });
  console.log('[Shutdown] WebSocket-сервер остановлен');

  queueManager.stopAll();
  console.log('[Shutdown] Очередь остановлена');

  const drainTimeout = 10_000;
  const activeSessions = await sessionManager.listActiveSessions();
  if (activeSessions.length > 0) {
    console.log(`[Shutdown] Ожидание завершения ${activeSessions.length} активных стримов...`);
    await Promise.race([
      waitForStreamsDrain(),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          console.log(`[Shutdown] Таймаут ${drainTimeout}ms истёк, завершаю принудительно`);
          resolve();
        }, drainTimeout);
      }),
    ]);
  }

  console.log('[Shutdown] Завершено. Выход.');
  process.exit(0);
}

async function waitForStreamsDrain(): Promise<void> {
  while (true) {
    const active = await sessionManager.listActiveSessions();
    if (active.length === 0) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Graceful shutdown — POST /admin/shutdown (только ADMIN)
app.post('/admin/shutdown', auth.requireAdmin, async (c) => {
  void gracefulShutdown('API');
  return c.json({ status: 'shutting_down' });
});

process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });

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

  // Глобальный event-хаб для всех сессий пользователя
  if (url.pathname === '/ws/events') {
    const user = auth.getCurrentUser(reqAdapter(request));
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const clientId = `ws-events-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const client: EventClient = {
        userId: user.id,
        username: user.username,
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
          engine: 'synth',
        }));
      }).catch(() => {
        ws.send(JSON.stringify({
          type: 'error',
          data: { error: 'Failed to register client' },
          timestamp: nowISO(),
        }));
      });

      ws.on('message', (raw) => {
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

              const message = {
                role: MessageRole.USER,
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

              const result = await enqueueUserMessage(
                sessionManager, eventBus, sid, message, queueManager, processMessage,
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
          }
        } catch {
          // ignore parse errors
        }
      });

      ws.on('close', () => {
        console.log(`[WS /ws/events] Disconnected: client=${clientId}`);
        eventHub.unregisterClient(client);
      });

      ws.on('error', () => {
        eventHub.unregisterClient(client);
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
