import { createServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Readable } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { ProviderConfig, ModelConfig, AgentDefinition, Message, PermissionConfig, PlanMode } from '@synth/shared';
import {
  FileStore, SessionManager, EventBus, QueueProcessorManager,
  ContextConfig, ContextBuilder, ContextOptimizer, ChatOrchestrator,
  enqueueUserMessage, createToolRegistry, createAgentRegistry,
} from '../index.js';
import type { SummarizationConfig } from '@synth/shared';
import { nowISO, ensureDataDir, MessageRole, generateStreamId, makeTextPart } from '@synth/shared';
import { createLocalAuth } from '../auth/local.js';
import { JsonStore } from '../storage/json-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { RuntimeSettingsStore } from '../storage/runtime-settings.js';
import { createHealthRoutes } from './routes/health.js';
import { createAuthRoutes } from './routes/auth.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createProjectRoutes } from './routes/projects.js';
import { createProviderRoutes } from './routes/providers.js';
import { createModelRoutes } from './routes/models.js';
import { createAgentRoutes } from './routes/agents.js';
import { createFsRoutes } from './routes/fs.js';
import { createQueueRoutes } from './routes/queue.js';
import { createI18nRoutes } from './routes/i18n.js';
import { createUpdateRoutes } from './routes/updates.js';
import { createMessageRoutes } from './routes/messages.js';
import { createSettingsRoutes } from './routes/settings.js';

export interface StandaloneConfig {
  port: number;
  dataDir: string;
  apiKey: string;
  workspacesRoot?: string;
  /** Рабочий каталог по умолчанию для сессий без проекта. Дефолт: {dataDir}/workspaces/default. */
  defaultWorkingDir?: string;
  uiDistPath?: string;
  systemPromptsDir?: string;
  /** Глобальная секция permission из config.yaml (AD-029). */
  permissionConfig?: PermissionConfig;
  /** Строгость цикла Plan→Build по умолчанию из config.yaml (AD-028). */
  defaultPlanMode?: PlanMode;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
};

function serveStatic(uiDistPath: string) {
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const fullPath = join(uiDistPath, filePath);

    if (!existsSync(fullPath) || !fullPath.startsWith(uiDistPath)) {
      filePath = '/index.html';
      const fallbackPath = join(uiDistPath, '/index.html');
      if (!existsSync(fallbackPath)) return null;
      const content = readFileSync(fallbackPath);
      const ext = '.html';
      return new Response(content, {
        status: 200,
        headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
      });
    }

    try {
      const content = readFileSync(fullPath);
      const ext = extname(fullPath).toLowerCase();
      return new Response(content, {
        status: 200,
        headers: {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
        },
      });
    } catch {
      return null;
    }
  };
}

async function syncProvidersFromEnv(
  providerStore: JsonStore<ProviderConfig>,
  modelStore: JsonStore<ModelConfig>,
): Promise<void> {
  const providerPattern = /^SYNTH_PROVIDER_([A-Z][A-Z0-9_]*?)_(API_KEY|URL|MODEL|TYPE)$/;
  const providers: Map<string, Partial<ProviderConfig> & { model?: string }> = new Map();

  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(providerPattern);
    if (!match || !value) continue;

    const [, rawName, field] = match;
    if (!rawName) continue;
    const name = rawName.toLowerCase().replace(/_/g, '-');

    if (!providers.has(name)) {
      providers.set(name, { name, type: 'openai' });
    }

    const p = providers.get(name)!;
    switch (field) {
      case 'API_KEY': p.apiKey = value; break;
      case 'URL': p.baseUrl = value; break;
      case 'MODEL': p.model = value; break;
      case 'TYPE': p.type = value; break;
    }
  }

  for (const [name, envConfig] of providers) {
    const existing = await providerStore.load(name);
    const provider: ProviderConfig = {
      name,
      type: envConfig.type || existing?.type || 'openai',
      baseUrl: envConfig.baseUrl || existing?.baseUrl,
      apiKey: envConfig.apiKey || existing?.apiKey,
      defaultModel: envConfig.model || existing?.defaultModel,
      timeout: existing?.timeout ?? 120,
      enabled: true,
      icon: existing?.icon ?? '',
    };
    await providerStore.save(name, provider);

    // Если указана модель — создаём её
    if (envConfig.model) {
      const modelId = `${name}/${envConfig.model}`;
      const existingModel = await modelStore.load(modelId);
      if (!existingModel) {
        await modelStore.save(modelId, {
          id: modelId,
          name: envConfig.model,
          provider: name,
          description: '',
          enabled: true,
          isDefault: true,
        });
      }
    }

    console.log(`  [env] провайдер: ${name} (${provider.type})${provider.baseUrl ? ` → ${provider.baseUrl}` : ''}`);
  }
}

export async function createStandaloneApp(config: StandaloneConfig) {
  const app = new Hono();
  const auth = createLocalAuth({ apiKey: config.apiKey });

  app.use(logger());
  app.use(cors({
    origin: (_origin) => _origin || '*',
    credentials: true,
  }));

  // Health — без auth
  const healthRoutes = createHealthRoutes();
  app.route('/', healthRoutes);

  // Auth routes — без auth (только spa-login проверяет ключ сам)
  app.route('/auth', createAuthRoutes(auth));

  // i18n — без auth
  app.route('/api/v2/i18n', createI18nRoutes());

  // Всё остальное требует аутентификации
  app.use('/api/*', auth.requireAuth);
  app.use('/ws/*', auth.requireAuth);

  const dataDir = config.dataDir;
  await ensureDataDir(dataDir);

  // Runtime-настройки (AD-005): workspace из {dataDir}/settings.json приоритетнее config/env
  const settingsStore = new RuntimeSettingsStore({ dataDir });
  const runtimeWorkspace = await settingsStore.getWorkspace();
  const defaultWorkingDir = runtimeWorkspace ?? config.defaultWorkingDir ?? join(dataDir, 'workspaces', 'default');
  await mkdir(defaultWorkingDir, { recursive: true });

  const fileStore = new FileStore({ dataDir });
  const sessionManager = new SessionManager(fileStore);
  const projectStore = new ProjectStore({ dataDir });
  const providerStore = new JsonStore<ProviderConfig>({ dataDir, subdir: 'providers' });
  const modelStore = new JsonStore<ModelConfig>({ dataDir, subdir: 'models' });
  const agentStore = new JsonStore<AgentDefinition>({ dataDir, subdir: 'agents' });
  const contextConfig = new ContextConfig({
    userDataDir: `${dataDir}/context`,
    systemPromptsDir: config.systemPromptsDir,
  });

  // Парсим провайдеров из переменных окружения
  await syncProvidersFromEnv(providerStore, modelStore);

  const eventBus = new EventBus();
  const queueManager = new QueueProcessorManager();

  const contextBuilder = new ContextBuilder(contextConfig, {
    projectDataDir: `${dataDir}/projects`,
    defaultLanguage: 'ru',
  });

  const providerLoader = (name: string): ProviderConfig | null => {
    return providerCache.get(name) ?? null;
  };

  const providerCache = new Map<string, ProviderConfig>();
  (await providerStore.list()).forEach((p) => {
    providerCache.set(p.name, p);
  });

  const modelCache = new Map<string, ModelConfig>();
  (await modelStore.list()).forEach((m) => {
    modelCache.set(m.id, m);
  });

  const summarizationConfig: SummarizationConfig = {
    provider: '',
    model: '',
    temperature: 0.3,
    promptFile: 'SUMMARIZER',
  };
  const contextOptimizer = new ContextOptimizer(contextConfig, providerLoader, summarizationConfig);
  queueManager.setContextOptimizer(contextOptimizer);

  const modelPriceLoader = (modelName: string) => {
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

  const toolRegistry = createToolRegistry();
  const agentRegistry = createAgentRegistry(toolRegistry, join(dataDir, 'agents'));

  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder,
    providerLoader,
    contextOptimizer,
    modelPriceLoader,
    dataDir,
    toolRegistry,
    agentRegistry,
    projectStore,
    defaultWorkingDir,
    permissionConfig: config.permissionConfig,
    defaultPlanMode: config.defaultPlanMode,
  });

  const processMessage = orchestrator.createProcessMessage();

  // API-заглушки для UI
  app.get('/api/config/themes', (c) => c.json({ themes: [] }));

  // Sessions
  app.route('/api/v2/sessions', createSessionRoutes(
    auth, sessionManager, eventBus, queueManager, processMessage, orchestrator, contextOptimizer,
  ));

  // Projects
  app.route('/api/v2/projects', createProjectRoutes(auth, projectStore));

  // Providers
  app.route('/api/v2/providers', createProviderRoutes(auth, providerStore, true));

  // Models
  app.route('/api/v2/models', createModelRoutes(auth, modelStore, providerStore));

  // Agents
  app.route('/api/v2/agents', createAgentRoutes(auth, agentStore, agentRegistry));

  // FS
  app.route('/api/v2/fs', createFsRoutes(auth, config.workspacesRoot));

  // Queue
  app.route('/api/v2/queue', createQueueRoutes(auth, sessionManager, queueManager, eventBus, processMessage));

  // Updates
  app.route('/api/v2/updates', createUpdateRoutes(auth, dataDir));

  // Messages (batch operations)
  app.route('/api/v2/messages', createMessageRoutes(auth, sessionManager));

  // Settings (runtime-настройки для UI, раздел «Проекты»)
  app.route('/api/v2/settings', createSettingsRoutes(auth, {
    settingsStore,
    fallbackWorkspace: defaultWorkingDir,
  }));

  // Глобальный SSE-хаб
  app.get('/api/v2/events', async (c) => {
    const signal = c.req.raw.signal;

    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();

          const allSessions = await sessionManager.listSessions({ userId: 'local' });
          const unsubs: Array<() => void> = [];

          const handler = (event: { type: string; data: Record<string, unknown>; sessionId: string; timestamp: string }) => {
            try {
              const line = `data: ${JSON.stringify(event)}\n\n`;
              controller.enqueue(encoder.encode(line));
            } catch {
              // disconnected
            }
          };

          for (const s of allSessions) {
            unsubs.push(eventBus.subscribe(s.id, handler));
          }

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

  // 404
  app.notFound((c) => {
    return c.json({
      error: {
        code: 'NOT_FOUND',
        message: `Маршрут не найден: ${c.req.method} ${c.req.path}`,
      },
    }, 404);
  });

  // Создаём HTTP сервер
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

  const staticHandler = config.uiDistPath && existsSync(config.uiDistPath)
    ? serveStatic(config.uiDistPath)
    : null;

  const server = createServer(async (req, res) => {
    try {
      const webReq = toWebRequest(req);
      const url = new URL(webReq.url);

      // Статика UI для GET-запросов без префиксов API
      if (staticHandler && webReq.method === 'GET'
        && !url.pathname.startsWith('/api/')
        && !url.pathname.startsWith('/auth/')
        && !url.pathname.startsWith('/admin/')
        && !url.pathname.startsWith('/ws')
        && !url.pathname.startsWith('/health')) {
        const staticResp = await staticHandler(webReq);
        if (staticResp) {
          const headers = Object.fromEntries(staticResp.headers.entries());
          res.writeHead(staticResp.status, headers);
          if (staticResp.body) {
            const reader = staticResp.body.getReader();
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
          return;
        }
      }

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

  // WebSocket /ws/events
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    if (url.pathname === '/ws/events') {
      const authHeader = request.headers['authorization'] || request.headers['Authorization'];
      const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;

      if (token !== config.apiKey) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, async (ws: WebSocket) => {
        const clientId = `ws-events-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const allSessions = await sessionManager.listSessions({ userId: 'local' });
        const unsubs: Array<() => void> = [];

        const handler = (event: { type: string; data: Record<string, unknown> }) => {
          try {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify(event));
            }
          } catch { /* ignore */ }
        };

        for (const s of allSessions) {
          unsubs.push(eventBus.subscribe(s.id, handler));
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

  const port = config.port;

  console.log(`synth-core starting on http://localhost:${port}`);
  console.log(`  data dir: ${dataDir}`);
  console.log(`  api key: ${config.apiKey.slice(0, 8)}...`);
  if (config.uiDistPath && existsSync(config.uiDistPath)) {
    console.log(`  ui: serving from ${config.uiDistPath}`);
  }

  return { app, server, wss, port };
}
