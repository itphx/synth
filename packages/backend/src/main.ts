import { createServer, IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { ProviderConfig, ModelConfig, AgentDefinition } from '@synth/shared';
import {
  FileStore, SessionManager, EventBus, QueueProcessorManager,
  ContextConfig, FileProfileStore,
} from '@synth/core';
import { nowISO } from '@synth/shared';
import { loadAuthConfig } from './auth/config.js';
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

// Auth system
const config = loadAuthConfig();
const auth = createAuthMiddleware(config);

// Прикрепляем пользователя ко всем запросам
app.use('*', auth.attachUser);

// Хранилища
const dataDir = process.env.SYNTH_DATA_DIR || 'data';
const fileStore = new FileStore({ dataDir });
const sessionManager = new SessionManager(fileStore);
const projectStore = new ProjectStore({ dataDir });
const providerStore = new JsonStore<ProviderConfig>({ dataDir, subdir: 'providers' });
const modelStore = new JsonStore<ModelConfig>({ dataDir, subdir: 'models' });
const agentStore = new JsonStore<AgentDefinition>({ dataDir, subdir: 'agents' });
const contextConfig = new ContextConfig({ userDataDir: `${dataDir}/context` });
const profilesStore = new FileProfileStore({ dataDir });

// Auth routes (после profilesStore)
app.route('/auth', createAuthRoutes(auth, config, profilesStore));

// Сидирование тестовых пользователей (debug mode)
if (config.debugMode && config.testUsers) {
  for (const tu of config.testUsers) {
    profilesStore.getOrCreateProfile({
      username: tu.username,
      roles: tu.roles,
    }).catch((e: unknown) => console.warn('seed: failed to create profile for', tu.username, e));
  }
}

const eventBus = new EventBus();
const queueManager = new QueueProcessorManager();

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
app.route('/api/v2/sessions', createSessionRoutes(auth, sessionManager));

// Messages routes
app.route('/api/v2/messages', createMessageRoutes(auth, sessionManager));

// Queue routes
app.route('/api/v2/queue', createQueueRoutes(auth, sessionManager));

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

const port = parseInt(process.env.PORT || '5000', 10);

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

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);

  if (url.pathname === '/ws/chat') {
    const sessionId = url.searchParams.get('session_id');
    if (!sessionId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const clientId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      ws.send(JSON.stringify({
        type: 'connected',
        session_id: sessionId,
        client_id: clientId,
        engine: 'synth',
      }));

      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          } else if (msg.type === 'send_message') {
            // Заглушка обработки через SSE-паттерн
            ws.send(JSON.stringify({
              type: 'message.queued',
              stream_id: msg.stream_id || `ws-${Date.now()}`,
              pending_count: 0,
              message: msg.content,
            }));
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid message format' }));
        }
      });

      ws.on('close', () => {
        // unsubscribe
      });

      ws.on('error', () => {
        // ignore
      });
    });
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

console.log(`synth-backend starting on http://localhost:${port}`);
console.log(`  debug mode: ${config.debugMode}`);
if (config.debugMode) {
  console.log('  test users:');
  config.testUsers?.forEach((u) => {
    console.log(`    ${u.username} [${u.roles.join(', ')}] → key: ${u.apiKey.slice(0, 8)}...`);
  });
}

server.listen(port);
