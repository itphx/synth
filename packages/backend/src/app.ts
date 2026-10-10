// Фабрика backend-приложения (гибридный режим, Часть 11).
// Строит Hono-app (конфиг → auth → stores → orchestrator → routes) без
// прослушивания порта. main.ts — тонкий entrypoint: вызывает фабрику, слушает
// порт и обрабатывает graceful shutdown. Поведение процесса при запуске
// main.ts не меняется: те же CORS, auth, роуты, WebSocket /ws/events.
//
// Фабрика переопределяет конфигурацию через process.env (SYNTH_DATA_DIR,
// SYNTH_AUTH_DEBUG, SYNTH_API_KEY, SYNTH_PORT, SYNTH_PROVIDER_*) на время
// построения приложения и восстанавливает окружение после — это позволяет
// тестам поднимать изолированный backend in-process с debug auth и
// фейковыми провайдерами без OIDC.

import { createServer, IncomingMessage } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join, isAbsolute, normalize, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { ProviderConfig, ModelConfig, AgentDefinition, ToolsDisabledConfig } from '@itphx/synth-shared';
import {
  FileStore, SessionManager, EventBus, QueueProcessorManager,
  ContextConfig, ContextBuilder, ContextOptimizer, ChatOrchestrator, FileProfileStore,
  enqueueUserMessage, createToolRegistry, createAgentRegistry, McpManager,
  McpRegistryStore,
  RuntimeSettingsStore, createSettingsRoutes, AuditLogger, mergeLlmGatewayConfig,
  mergeSecurityConfig, mergeMcpNetworkPolicy, mergeEventsConfig, ProtectedPathsStore,
  SecretPatternStore,
  RateLimiter,
  DictionaryStore, createDictionaryRoutes,
  SkillService, createSkillRoutes,
  resolveProjectSkillSeed, migrateSessionScopeSnapshots,
  CommandService, createCommandRoutes, createSkillBundleRoutes, SkillBundleStore,
  createSessionSkillScopeRoutes, createProjectSkillScopeRoutes, createSkillSettingsRoutes,
  ProjectInstructionsResolver, createInstructionsInfoResolver,
  createContextRoutes as createCoreContextRoutes,
  DEFAULT_AGENT_ID,
  SSHKeyStore, createGitRoutes,
  createSshKeyRoutes, createAgentSshKeyRoutes,
  createFsRoutes, resolveProjectWorkspace,
  detectRuntimeDeps,
  syncProvidersFromEnv,
  HookBus,
  startEphemeralSweeper,
  EventBindingStore, EventApiKeyStore, EventJournalStore, EventRouter, RequestSessionService, EventIngress, eventToMessage,
  RouteRuleStore, ProjectRuleProvider, DecisionRuleProvider,
  ScheduleStore, SchedulerRuleProvider, SchedulerService, JobStore,
  MemoryDedupStore, FileDedupStore, AlwaysLeader, FileLeader,
  createEventRoutes, createSchedulerRoutes,
  startEventJournalPruner,
} from '@itphx/synth-core';
import type { AuthKit as CoreAuthKit } from '@itphx/synth-core';
import type { DecisionAgentCandidate } from '@itphx/synth-core';
import type { SummarizationConfig } from '@itphx/synth-shared';
import { nowISO, ensureDataDir, MessageRole, generateStreamId, SYNTH_VERSION, DEFAULT_LLM_GATEWAY_RATE_LIMIT, ProjectRole, resolveDefaultWorkspace, resolveSecretKey } from '@itphx/synth-shared';
import type { BusEvent } from '@itphx/synth-shared';
import { loadBackendConfig } from './lib/app-config.js';
import type { BackendConfig } from './lib/app-config.js';
import { createAuthMiddleware } from './auth/middleware.js';
import type { AuthKit } from './auth/middleware.js';
import { createAuthRoutes } from './routes/auth.js';
import { createProjectRoutes, createProjectAccess } from './routes/projects.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createMessageRoutes } from './routes/messages.js';
import { createQueueRoutes } from './routes/queue.js';
import { createProviderRoutes } from './routes/providers.js';
import { createModelRoutes } from './routes/models.js';
import { createAgentRoutes } from './routes/agents.js';
import { createContextRoutes as createContextFileRoutes } from './routes/context.js';
import { createDebugRoutes } from './routes/debug.js';
import { createUserRoutes } from './routes/users.js';
import { createMcpRoutes } from './routes/mcp.js';
import { createAuditRoutes } from './routes/audit.js';
import { createLogsRoutes, resolveLogDir } from './routes/logs.js';
import { createGatewayPatternsRoutes } from './routes/gateway-patterns.js';
import { createLlmRoutes } from './routes/llm.js';
import { createRateLimiter } from './middleware/rate-limiter.js';
import { DefaultsStore } from './lib/defaults-store.js';
import { t, getTranslations } from './lib/i18n.js';
import { ProjectStore } from '@itphx/synth-core';
import { JsonStore } from '@itphx/synth-core';
import { EventHub } from './events/hub.js';
import type { EventClient } from './events/hub.js';

export interface CreateBackendAppOptions {
  /** Путь к config.yaml (по умолчанию — каскадный поиск, как в main.ts). */
  configPath?: string;
  /** Каталог данных: переопределяет SYNTH_DATA_DIR на время построения. */
  dataDir?: string;
  /** Debug auth: переопределяет SYNTH_AUTH_DEBUG (тестовые ключи admin-key-123 и т.п.). */
  authDebug?: boolean;
  /** Единый API-ключ (роль ADMIN): переопределяет SYNTH_API_KEY. */
  apiKey?: string;
  /** Порт: переопределяет SYNTH_PORT. 0 — эфемерный (для тестов). */
  port?: number;
  /** Дополнительные env-переменные (например SYNTH_PROVIDER_* для провайдеров). */
  env?: Record<string, string>;
}

export interface BackendAppHandle {
  app: Hono;
  dataDir: string;
  port: number;
  config: BackendConfig;
  auth: AuthKit;
  eventBus: EventBus;
  eventHub: EventHub;
  sessionManager: SessionManager;
  projectStore: ProjectStore;
  orchestrator: ChatOrchestrator;
  queueManager: QueueProcessorManager;
  settingsStore: RuntimeSettingsStore;
  // AD-089: ядро маршрутизации событий и единый funnel создания сессий.
  eventRouter: EventRouter;
  requestSessionService: RequestSessionService;
  eventBindingStore: EventBindingStore;
  eventJournal: EventJournalStore;
  /** AD-089: ingress-точка приёма внешних событий. */
  ingress: EventIngress;
  // AD-051 (срез) / AD-089: реестр расписаний и планировщик (cron/interval).
  scheduleStore: ScheduleStore;
  scheduler: SchedulerService;
  /** AD-051 (срез): остановка планировщика (на graceful shutdown). */
  stopScheduler: () => void;
  /** AD-089: остановка sweeper'а авто-архивации ephemeral-сессий. */
  stopEphemeralSweeper: () => void;
  /** AD-089: остановка периодической retention-очистки журнала событий. */
  stopEventJournalPruner: () => void;
  /**
   * Поднять HTTP-сервер (+ WebSocket /ws/events) на указанном порту.
   * Порт 0 → эфемерный; возвращает фактический порт.
   */
  listen: (port?: number, host?: string) => Promise<{
    server: ReturnType<typeof createServer>;
    wss: WebSocketServer;
    port: number;
  }>;
}

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

export async function createBackendApp(opts: CreateBackendAppOptions = {}): Promise<BackendAppHandle> {
  // Временные env-переменные: применяются только на время построения приложения
  // (loadBackendConfig и syncProvidersFromEnv читают process.env).
  const envEntries: Array<[string, string]> = [];
  if (opts.dataDir !== undefined) envEntries.push(['SYNTH_DATA_DIR', opts.dataDir]);
  if (opts.authDebug !== undefined) envEntries.push(['SYNTH_AUTH_DEBUG', String(opts.authDebug)]);
  if (opts.apiKey !== undefined) envEntries.push(['SYNTH_API_KEY', opts.apiKey]);
  if (opts.port !== undefined) envEntries.push(['SYNTH_PORT', String(opts.port)]);
  for (const [k, v] of Object.entries(opts.env ?? {})) envEntries.push([k, v]);

  const savedEnv = new Map<string, string | undefined>();
  for (const [k, v] of envEntries) {
    savedEnv.set(k, process.env[k]);
    process.env[k] = v;
  }

  try {
    // Конфигурация
    const backendConfig = await loadBackendConfig({ configPath: opts.configPath });

    const app = new Hono();

    app.use(logger());
    // CORS настраивается после загрузки конфига

    // Health (без auth)
    app.get('/health', (c) => c.json({ status: 'healthy', version: SYNTH_VERSION, time: nowISO() }));
    app.get('/api/v2/health', (c) => c.json({ status: 'healthy', version: SYNTH_VERSION, time: nowISO() }));

    // Динамический CORS origin: если задан explicit ORIGIN через env var, использовать его;
    // если задан список allowedOrigins — проверять и эхо; если список пуст — разрешить все.
    const allowedOrigins: string[] = backendConfig.synth.server.allowedOrigins ?? [];
    const envCorsOrigin = process.env.SYNTH_CORS_ORIGIN;

    app.use(cors({
      origin: (origin) => {
        if (envCorsOrigin) return envCorsOrigin;
        if (!origin) return origin;
        if (allowedOrigins.length === 0) return origin;
        if (allowedOrigins.includes(origin)) return origin;
        return allowedOrigins[0];
      },
      credentials: true,
    }));

    const auth = createAuthMiddleware(backendConfig.auth);

    // Прикрепляем пользователя ко всем запросам
    app.use('*', auth.attachUser);

    // Хранилища
    const dataDir = backendConfig.dataDir;
    await ensureDataDir(dataDir);
    const fileStore = new FileStore({ dataDir });
    const projectStore = new ProjectStore({ dataDir });
    // AD-030: ядровая шина хуков — общий инстанс для SessionManager и оркестратора.
    const hooks = new HookBus();
    const sessionManager = new SessionManager(fileStore, {
      projectStore,
      hooks,
      // AD-071 §2.4 / AD-046 §4.5: системные дефолты для сессий без проекта.
      systemDefaultsProvider: async () => ({
        mcpDefaultOn: await mcpRegistryStore.toDefaultServers(),
        skillsDefaultOn: (await resolveProjectSkillSeed(
          skillService,
          await settingsStore.getSkillsDisabledForNewProjects(),
        )).enabled,
      }),
    });
    // AD-089: авто-архивация ephemeral-сессий по TTL (таймер `unref`).
    // Остановка — через хэндл `stopEphemeralSweeper` на graceful shutdown.
    const stopEphemeralSweeper = startEphemeralSweeper(sessionManager);
    // AD-076 §T4: SSH-ключи агентов — core-хранилище поверх общего dataDir.
    // Мастер-ключ: env `SYNTH_SECRET_KEY` > `config.security.secretKey` > файл dataDir.
    const sshKeyStore = new SSHKeyStore({
      dataDir,
      secretKey: resolveSecretKey(backendConfig.synth),
      env: process.env,
    });
    const providerStore = new JsonStore<ProviderConfig>({ dataDir, subdir: 'providers' });
    const modelStore = new JsonStore<ModelConfig>({ dataDir, subdir: 'models' });
    const agentStore = new JsonStore<AgentDefinition>({ dataDir, subdir: 'agents' });
    const contextConfig = new ContextConfig({ userDataDir: `${dataDir}/context` });
    const profilesStore = new FileProfileStore({ dataDir });

    // AD-036: хранилище кастомных regex-паттернов детекции секретов (override ?? дефолт)
    const patternStore = new SecretPatternStore({ dataDir });

    // Runtime-настройки (AD-005): workspace/mcp из {dataDir}/settings.json (переживают рестарт)
    const settingsStore = new RuntimeSettingsStore({ dataDir });
    // AD-075: дефолтный рабочий каталог — runtime-override `settings/workspace`
    // приоритетнее config/env (`resolveDefaultWorkspace`), каталог создаётся
    // заранее (как в core `server/app.ts`), чтобы инструменты не падали.
    const runtimeWorkspace = await settingsStore.getWorkspace();
    const defaultWorkingDir = runtimeWorkspace ?? resolveDefaultWorkspace(backendConfig.synth);
    await mkdir(defaultWorkingDir, { recursive: true });
    // Агент по умолчанию (админка «Агенты»): runtime-настройка поверх DEFAULT_AGENT_ID.
    const getDefaultAgentId = async (): Promise<string> =>
      (await settingsStore.getDefaultAgent()) ?? DEFAULT_AGENT_ID;

    // Умолчания оформления (AD-005): {dataDir}/defaults.json (переживают рестарт)
    const defaultsStore = new DefaultsStore({ dataDir });

    // MCP: единый источник истины — реестр `McpRegistryStore` (AD-071 §2.5).
    // Legacy `YamlMcpConfigStore` удалён: instance-серверы из config.mcp.servers
    // сидируются в реестр при старте (seed без дублирования по имени).
    const mcpManager = new McpManager();
    const mcpRegistryStore = new McpRegistryStore({ dataDir });
    await mcpRegistryStore.seedFromConfig(backendConfig.synth.mcp.servers);
    // Одно чтение реестра на все карты менеджера (вместо пяти).
    const mcpMaps = await mcpRegistryStore.toManagerMaps();
    mcpManager.setConfig(mcpMaps.servers);
    mcpManager.setServerOrigins(mcpMaps.origins);
    mcpManager.setServerTrusts(mcpMaps.trusts);
    mcpManager.setServerAuthors(mcpMaps.authors);
    mcpManager.setDefaultServers(mcpMaps.defaults);
    // AD-071 §2.4: системный мастер-флаг серверов (реестр `enabled`).
    mcpManager.setServerSystemEnabled(mcpMaps.systemEnabled);
    // AD-071 §2.3.1: политика сетевого доступа HTTP-серверов (SSRF/egress).
    // Runtime-настройка из админки (settings.json) приоритетнее config.yaml и
    // переживает рестарт; храним в изменяемой переменной, чтобы registry-роуты
    // видели свежее значение без рестарта. Слияние — единым helper'ом
    // mergeMcpNetworkPolicy (тот же, что и в core).
    const runtimeMcpNetworkPolicy = await settingsStore.getMcpNetworkPolicy();
    let effectiveNetworkPolicy = mergeMcpNetworkPolicy(
      backendConfig.synth.mcp.networkPolicy,
      runtimeMcpNetworkPolicy,
    );
    mcpManager.setNetworkPolicy(effectiveNetworkPolicy);

    // Auth routes (после profilesStore)
    app.route('/auth', createAuthRoutes(auth, backendConfig.auth, profilesStore, dataDir, defaultsStore));

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

    // AD-038: синхронизация провайдеров/моделей из переменных окружения (общая
    // core-реализация). Вызывается ПОСЛЕ создания providerStore/modelStore, но ДО
    // заполнения кэшей, чтобы env-провайдеры попали в providerCache/modelCache.
    await syncProvidersFromEnv(providerStore, modelStore);

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

    // Загрузчик сохранённого контекстного окна модели (ModelConfig.contextWindow)
    const modelWindowLoader = (modelName: string): number => {
      for (const m of modelCache.values()) {
        if (m.name === modelName || m.id === modelName) {
          return m.contextWindow && m.contextWindow > 0 ? m.contextWindow : 0;
        }
      }
      return 0;
    };

    // Резолв модели по id или имени (для LLM Proxy — гибридный режим).
    const modelLoader = (model: string): ModelConfig | null => {
      const byId = modelCache.get(model);
      if (byId) return byId;
      for (const m of modelCache.values()) {
        if (m.name === model) return m;
      }
      return null;
    };

    // ContextOptimizer
    const summarizationConfig: SummarizationConfig = backendConfig.synth.summarization;
    const contextOptimizer = new ContextOptimizer(contextConfig, providerLoader, summarizationConfig, modelWindowLoader);

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
            // Валюта: модель → провайдер → USD (обратная совместимость).
            currency: m.currency ?? providerCache.get(m.provider)?.currency ?? 'USD',
          };
        }
      }
      return null;
    };

    // LLM Gateway: общий AuditLogger создаётся снаружи, чтобы эндпоинт
    // GET /api/v2/audit и оркестратор писали/читали один и тот же JSONL-файл.
    const gatewayAuditLogger = new AuditLogger(
      backendConfig.synth.llmGateway.audit.logPath || join(dataDir, 'audit', 'llm-gateway.jsonl'),
    );

    // Полный лог запросов/ответов LLM (после обфускации) — один JSONL-файл для
    // записи (оркестратор) и чтения (GET /api/v2/logs/llm).
    const gatewayPayloadLogPath = backendConfig.synth.llmGateway.payloadLogPath
      || join(dataDir, 'audit', 'llm-payloads.jsonl');

    // AD-036: runtime-настройка LLM Gateway (тумблер из UI, {dataDir}/settings.json)
    // приоритетнее config.yaml — мёржим при старте, чтобы шлюз применялся к оркестратору.
    const runtimeGateway = await settingsStore.getLlmGatewaySettings();
    const gatewayConfig = mergeLlmGatewayConfig(backendConfig.synth.llmGateway, runtimeGateway);

    // AD-040: runtime-настройка защищённых путей (тумблер из UI, {dataDir}/settings.json)
    // приоритетнее config.yaml — мёржим при старте, чтобы защита применялась к оркестратору.
    const runtimeSecurity = await settingsStore.getSecuritySettings();
    const securityConfig = mergeSecurityConfig(backendConfig.synth.security, runtimeSecurity);
    // AD-071 §2.3: runtime-политика встроенных инструментов (админка) приоритетнее config.yaml
    const runtimeToolsPolicy = await settingsStore.getToolsPolicy();
    const toolsPolicy = runtimeToolsPolicy ?? backendConfig.synth.tools.policy;
    // AD-071 §2.3: runtime-политика MCP-инструментов (админка) приоритетнее config.yaml
    const runtimeMcpPolicy = await settingsStore.getMcpPolicy();
    const mcpPolicy = runtimeMcpPolicy ?? backendConfig.synth.mcp.policy;
    // AD-071 §2.6: runtime-отключение инструментов (админка) приоритетнее config.yaml
    const runtimeToolsDisabled = await settingsStore.getToolsDisabled();
    const toolsDisabled: ToolsDisabledConfig =
      runtimeToolsDisabled ?? backendConfig.synth.tools.disabled ?? { capabilities: [], tools: [] };
    // AD-046 §4.5: runtime-отключение скиллов (админка) — hard-gate системного уровня.
    const skillsDisabled = (await settingsStore.getSkillsDisabled())
      ?? { categories: [], groups: [], skills: [] };
    const protectedPathsStore = new ProtectedPathsStore({ dataDir });

    // Orchestrator
    const toolRegistry = createToolRegistry();
    const agentRegistry = createAgentRegistry(toolRegistry, join(dataDir, 'agents'));

    // AD-046: сервис скиллов (discovery + instance-запись + каталог промпта).
    const skillService = new SkillService({
      dataDir,
      configPaths: backendConfig.synth.skills.paths,
      urls: backendConfig.synth.skills.urls,
      trustedProjectDirs: backendConfig.synth.skills.trustedProjectDirs,
      toolsets: backendConfig.synth.skills.toolsets,
    });

    // AD-046 §7: slash-команды и bundles (mirror core).
    const bundleStore = new SkillBundleStore({
      dataDir,
      bundlesPath: backendConfig.synth.commands.bundlesPath,
    });
    const commandService = new CommandService({
      config: {
        dataDir,
        commandsPaths: backendConfig.synth.commands.paths,
        bundlesPath: backendConfig.synth.commands.bundlesPath,
        conflict: backendConfig.synth.commands.conflict,
        maxArgumentsLength: backendConfig.synth.commands.maxArgumentsLength,
        maxRenderedBytes: backendConfig.synth.commands.maxRenderedBytes,
        toolsets: backendConfig.synth.skills.toolsets,
        trustedProjectDirs: backendConfig.synth.skills.trustedProjectDirs,
        inlineShell: backendConfig.synth.skills.inlineShell ?? false,
      },
      skillRuntime: skillService,
      skillSource: skillService,
      bundleStore,
    });

    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      hooks,
      contextBuilder,
      contextConfig,
      providerLoader,
      contextOptimizer,
      modelPriceLoader,
      dataDir,
      toolRegistry,
      agentRegistry,
      mcpManager,
      projectStore,
      // Онбординг: тул `profile_update` сохраняет ответы интервью в профиль.
      profilesStore,
      // AD-076 §T6: тот же store, что у git/ssh-роутов — без дублей инстансов.
      sshKeyStore,
      workspacesRoot: backendConfig.workspacesRoot,
      // AD-075: backend — managed-режим, workspace вне workspacesRoot запрещён.
      workspaceManaged: true,
      // AD-075: без defaultWorkingDir сессия без проекта получала бы
      // {dataDir}/workspaces/default мимо runtime-override settings/workspace.
      defaultWorkingDir,
      routerConfig: backendConfig.synth.router,
      // AD-084: decision-слой микро-каскада (config.decision).
      decisionConfig: backendConfig.synth.decision,
      permissionConfig: backendConfig.synth.permission,
      defaultPlanMode: backendConfig.synth.session.planMode,
      securityConfig,
      gatewayConfig,
      gatewayAuditLogger,
      gatewayPayloadLogPath,
      gatewayPatternStore: patternStore,
      cachePolicy: backendConfig.synth.llm.cache,
      toolsPolicy,
      mcpPolicy,
      toolsDisabled,
      // AD-046 §4.5: системный hard-gate скиллов (runtime-настройка).
      skillsDisabled,
      // AD-070 §2.9.1: зависимости окружения (git/rg/sh) — детекция при старте.
      runtimeDeps: await detectRuntimeDeps(),
      // AD-071 §2.6: калибровка chars-per-token по модели (runtime-настройки).
      tokenRatioLoader: (model) => settingsStore.getTokenRatio(model),
      onTokenRatioCalibrated: (model, ratio) => settingsStore.setTokenRatio(model, ratio),
      // AD-046 §5: каталог скиллов в промпт + тул `skill`.
      skillRuntime: skillService,
      // AD-046 §7: резолвинг `/`-команд до LLM.
      commandRuntime: commandService,
      // AD-069 Фаза 1: проектные инструкции (merged chain AGENTS.md).
      instructionsConfig: backendConfig.synth.instructions,
      // AD-069 Фаза 2a: project-trust гейт инструкций (config.skills.trustedProjectDirs).
      instructionsTrustedProjectDirs: backendConfig.synth.skills.trustedProjectDirs,
      // AD-089: late-bound funnel создания сессий для тула `task` (саб-агент).
      // Сервис создаётся ниже (после оркестратора) — геттер читает его в рантайме.
      getRequestSessionService: () => requestSessionService,
      // AD-051: late-bound резолвер активности расписания в сессии (ScheduleStore
      // создаётся ниже) — включает статический блок `Scheduler` в промпт.
      isSchedulerActive: (sid) => scheduleStore.hasEnabledTargetFor(sid),
    });

    const processMessage = orchestrator.createProcessMessage();

    // AD-089: ядро маршрутизации внешних событий и единый funnel создания сессий.
    // Funnel подключён к `POST /sessions` и тулу `task` (Этап 5); приём внешних
    // событий — на следующих этапах.
    const eventBindingStore = new EventBindingStore({ dataDir });
    // AD-089/AD-052: API-ключи привязок для аутентификации приёма событий.
    const eventApiKeyStore = new EventApiKeyStore({ dataDir });
    const eventJournal = new EventJournalStore({ dataDir });
    // AD-089: реестр правил маршрутизации (проектные/инстанс-правила).
    const routeRuleStore = new RouteRuleStore({ dataDir });
    // AD-089 (Блок 3): runtime-настройки «События» (админка) поверх config.yaml.
    const runtimeEvents = await settingsStore.getEvents();
    const effectiveEvents = mergeEventsConfig(backendConfig.synth.events, runtimeEvents);
    let effectiveEventsSettings = effectiveEvents;
    // AD-051/AD-089: источник дедупа — in-process (default) или файловый
    // межпроцессный (`events.dedupStore: file`).
    const dedupStore = backendConfig.synth.events.dedupStore === 'file'
      ? new FileDedupStore({ dataDir })
      : new MemoryDedupStore();
    const eventRouter = new EventRouter({
      bindingStore: eventBindingStore,
      journal: eventJournal,
      hooks,
      dedupStore,
      config: {
        allowedSources: effectiveEvents.allowedSources,
        defaultMode: effectiveEvents.defaultMode,
        defaultEphemeralTtl: effectiveEvents.ephemeralTtl,
      },
    });
    // AD-089 (Блок 2): retention-очистка журнала событий (сразу + каждые 6 ч).
    const stopEventJournalPruner = startEventJournalPruner(eventJournal, {
      getRetentionDays: () => effectiveEventsSettings.journalRetentionDays,
    });
    // AD-051 (срез) / AD-089: правило маршрутизации cron-событий по расписанию
    // (паритет с core `server/app.ts`; store без дублей).
    const scheduleStore = new ScheduleStore({
      dataDir,
      crossProcess: backendConfig.synth.scheduler.crossProcessLocks,
    });
    const jobStore = new JobStore({ dataDir });
    eventRouter.registerRuleProvider(
      new SchedulerRuleProvider(scheduleStore, effectiveEvents.ephemeralTtl),
    );
    // AD-089: правила маршрутизации по матчу события (после scheduler).
    eventRouter.registerRuleProvider(
      new ProjectRuleProvider(routeRuleStore, effectiveEvents.ephemeralTtl),
    );
    // AD-084 × AD-089: decision-маршрутизация при промахе декларативных правил
    // (opt-in `events.decisionRouting`). Паритет с core `server/app.ts`.
    eventRouter.registerRuleProvider(
      new DecisionRuleProvider({
        resolver: {
          getDecisionProvider: (name, model) => orchestrator.getDecisionProvider(name, model),
        },
        getEventsConfig: () => ({
          decisionRouting: effectiveEventsSettings.decisionRouting,
          defaultEphemeralTtl: effectiveEventsSettings.ephemeralTtl,
        }),
        getDecisionConfig: () => backendConfig.synth.decision,
        getAgentCandidates: (): DecisionAgentCandidate[] =>
          agentRegistry.list().map((agent) => ({
            id: agent.id,
            displayName: agent.displayName,
            description: agent.description,
          })),
      }),
    );
    // AD-089: резолвинг `agentTemplate` (события/правила) через `AgentRegistry`:
    // неизвестный или отключённый агент → `null`.
    const resolveAgentTemplate = (template: string): string | null => {
      const agent = agentRegistry.get(template);
      return agent && agent.enabled ? agent.id : null;
    };
    const requestSessionService = new RequestSessionService({
      sessionManager,
      eventRouter,
      hooks,
      config: {
        defaultEphemeralTtl: effectiveEvents.ephemeralTtl,
        unknownAgentTemplate: effectiveEvents.unknownAgentTemplate,
      },
      resolveAgentTemplate,
      // AD-089: UI-событие после материализации внешнего события.
      publish: (type, sessionId, data) => eventBus.publish(sessionId, type, data),
      deliver: async (sessionId, event, mode) => {
        // AD-051: cron-сообщение — от системного пользователя `Scheduler`, текст
        // задания — чистый контент сообщения (описание Scheduler — в system-блоке).
        let message = eventToMessage(event);
        if (mode === 'run') {
          // AD-036: обфускация user-сообщения ДО сохранения в историю (паритет с
          // prompt-путём — core routes/sessions.ts).
          await enqueueUserMessage(
            sessionManager, eventBus, sessionId, message, queueManager, processMessage,
            (sid, msg) => orchestrator.obfuscateUserMessageForHistory(sid, msg),
          );
        } else {
          // AD-036: `defer` тоже кладёт сообщение в историю — обфусцируем до
          // постановки. Старт процессора не выполняем (только очередь владельца).
          message = await orchestrator.obfuscateUserMessageForHistory(sessionId, message);
          await sessionManager.addPendingMessage(sessionId, message);
        }
      },
    });

    // AD-089: ingress-точка приёма внешних событий (Этап 6).
    const eventIngress = new EventIngress({ requestSessionService });

    // AD-051 (срез) / AD-089: планировщик публикует cron-события через ingress.
    // `start()` гейтится конфигом (`scheduler.enabled: false` — тикер не стартует),
    // ошибки старта логируются и не роняют процесс; остановка — `stopScheduler`.
    const schedulerTickMs = backendConfig.synth.scheduler.tickSec * 1000;
    const schedulerService = new SchedulerService({
      scheduleStore,
      ingress: eventIngress,
      jobStore,
      tickMs: schedulerTickMs,
      defaultEphemeralTtl: effectiveEvents.ephemeralTtl,
      catchUp: backendConfig.synth.scheduler.catchUp,
      jobRetentionDays: backendConfig.synth.scheduler.jobRetentionDays,
      // AD-051/AD-089: тикер стартует только у лидера (default — AlwaysLeader).
      leader: backendConfig.synth.scheduler.leaderElection === 'file'
        ? new FileLeader({ dataDir, tickMs: schedulerTickMs })
        : new AlwaysLeader(),
    });
    if (backendConfig.synth.scheduler.enabled !== false) {
      void schedulerService.start().catch((err) => {
        console.warn(`[scheduler] не удалось запустить: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    // AD-071 §2.4 / AD-046 §4.5: разовая миграция снапшотов скоупа существующих сессий.
    await migrateSessionScopeSnapshots({
      sessionManager,
      projectStore,
      settingsStore,
      resolveSystemDefaults: async () => ({
        mcpDefaultOn: await mcpRegistryStore.toDefaultServers(),
        skillsDefaultOn: (await resolveProjectSkillSeed(
          skillService,
          await settingsStore.getSkillsDisabledForNewProjects(),
        )).enabled,
      }),
    }).catch(() => 0);

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
    app.route('/api/v2/projects', createProjectRoutes(auth, projectStore, sessionManager, backendConfig.workspacesRoot, mcpManager, skillService, settingsStore, mcpRegistryStore));

    // Sessions routes
    app.route('/api/v2/sessions', createSessionRoutes(auth, sessionManager, eventBus, queueManager, processMessage, orchestrator, eventHub, contextOptimizer, projectStore, profilesStore, getDefaultAgentId, requestSessionService));

    // Messages routes
    app.route('/api/v2/messages', createMessageRoutes(auth, sessionManager, contextOptimizer, eventBus));

    // Queue routes
    app.route('/api/v2/queue', createQueueRoutes(auth, sessionManager, queueManager, eventBus, processMessage));

    // FS routes (AD-075): core-фабрика, managed поверх workspace проекта.
    app.route('/api/v2/fs', createFsRoutes(auth, backendConfig.workspacesRoot, undefined, {
      requireProjectId: true,
      getOutsideRootPolicy: () => 'deny',
      getProtectedPathsPolicy: () => protectedPathsStore.getPolicy(),
      getProjectWorkspace: (projectId) => resolveProjectWorkspace(projectId, {
        workspacesRoot: backendConfig.workspacesRoot,
        getProject: (id) => projectStore.load(id),
        outsideRootPolicy: () => 'deny',
        strict: true,
      }),
    }));

    // Providers routes
    app.route('/api/v2/providers', createProviderRoutes(auth, providerStore, providerCache));

    // Models routes
    app.route('/api/v2/models', createModelRoutes(auth, modelStore, providerStore, modelCache, providerCache));

    // Agents routes
    app.route('/api/v2/agents', createAgentRoutes(auth, agentStore, agentRegistry, getDefaultAgentId));

    // Context routes (глобальные identity-файлы; админ-мутации)
    app.route('/api/v2/context', createContextFileRoutes(auth, contextConfig));

    // User admin routes
    app.route('/api/v2/users', createUserRoutes(auth, profilesStore));

    // Git routes (AD-076 §T4): core-фабрика + managed RBAC. Write-эндпоинты
    // (init/clone/register/remove/fetch) требуют прав на изменение контента
    // проекта (owner/EDITOR/LEAD/ADMIN); read-only (scan/log/commit) — requireAuth.
    const projectAccess = createProjectAccess(auth);
    app.route('/api/v2/git', createGitRoutes(auth, projectStore, backendConfig.workspacesRoot, {
      sshKeyStore,
      authorizeProject: async (c, projectId) => {
        const user = await auth.getCurrentUser(c);
        if (!user) return false;
        const project = await projectStore.load(projectId);
        if (!project) return false;
        return projectAccess.canEditProjectContent(c, project, user.id);
      },
    }));

    // SSH-ключи агентов (AD-076 §T5): core-фабрика + managed RBAC.
    // Ключи — секреты: чтение — requireAuth (глобально), запись — только ADMIN.
    app.route('/api/v2/ssh-keys', createSshKeyRoutes(auth, sshKeyStore, {
      writeGuard: auth.requireAdmin,
    }));
    app.route('/api/v2/agents/:agentId/ssh-keys', createAgentSshKeyRoutes(auth, sshKeyStore, {
      writeGuard: auth.requireAdmin,
    }));

    // AD-089: приём внешних событий (ingress), биндинги и журнал. Ingress —
    // requireAuth + rate limit (внешние сервисы до AD-052 используют общий ключ);
    // чтение биндингов/журнала — requireAuth; мутации биндингов — ADMIN.
    // `GET /` не переопределяем — на этом пути SSE-хаб ниже.
    app.route('/api/v2/events', createEventRoutes(
      { requireAuth: auth.requireAuth },
      { ingress: eventIngress, bindingStore: eventBindingStore, journal: eventJournal, routeRuleStore, apiKeyStore: eventApiKeyStore },
      {
        // Rate limit — до решения о способе аутентификации; fallback-креды —
        // requireAuth (приём по API-ключу привязки креды пользователя не требует).
        ingestPreGuard: createRateLimiter(120, 60_000),
        ingestGuard: auth.requireAuth,
        // AD-089/AD-052: мутации bindings/routes/keys — LEAD и ADMIN; чтение
        // ключей привязки — тоже LEAD и ADMIN (чувствительные метаданные).
        writeGuard: auth.requirePermission('ADMIN', 'LEAD'),
        keyReadGuard: auth.requirePermission('ADMIN', 'LEAD'),
        // AD-089/AD-052: per-key rate limit и мастер-выключатель приёма (live).
        getKeyRateLimitPerMinute: () => effectiveEventsSettings.keyRateLimitPerMinute,
        isEnabled: () => effectiveEventsSettings.enabled,
        resolveAgentTemplate,
        sessionExists: async (id) => (await sessionManager.getSession(id)) !== null,
        resolveApiKeySecret: async (raw) => {
          const resolved = await eventApiKeyStore.resolveBySecret(raw);
          if (!resolved) return null;
          const binding = await eventBindingStore.get(resolved.credential.bindingId);
          if (!binding) return null;
          return { binding, credential: resolved.credential };
        },
        touchApiKey: (id) => eventApiKeyStore.touch(id),
        messages: {
          invalidEvent: (c) => t('errors.validation.invalidEvent', undefined, c),
          invalidBinding: (c) => t('errors.validation.invalidBinding', undefined, c),
          bindingNotFound: (c) => t('errors.notFound.binding', undefined, c),
          invalidRule: (c) => t('errors.validation.invalidRule', undefined, c),
          ruleNotFound: (c) => t('errors.notFound.rule', undefined, c),
          unknownAgent: (c) => t('errors.validation.unknownAgent', undefined, c),
          invalidKey: (c) => t('errors.validation.invalidEventKey', undefined, c),
          keyNotFound: (c) => t('errors.notFound.eventKey', undefined, c),
          invalidKeyUpdate: (c) => t('errors.validation.invalidEventKeyUpdate', undefined, c),
          keyLabelConflict: (c) => t('errors.conflict.eventKeyLabel', undefined, c),
          rateLimitedKey: (c) => t('errors.rateLimited.eventKey', undefined, c),
          eventsDisabled: (c) => t('errors.unavailable.eventsDisabled', undefined, c),
        },
      },
    ));

    // AD-051 / AD-089: CRUD расписаний, принудительный запуск и Job-история.
    // Чтение — requireAuth (дефолт core-фабрики), мутации — ADMIN. `run` —
    // ADMIN + rate limit (образец — ingest внешних событий): 10 запусков / 60 c
    // на ключ, т.к. каждый запуск ингестит событие в Router.
    app.route('/api/v2/schedules', createSchedulerRoutes(
      auth,
      { scheduleStore, scheduler: schedulerService, jobStore },
      {
        writeGuard: auth.requireAdmin,
        runGuard: auth.requireAdmin,
        runMiddleware: [createRateLimiter(10, 60_000)],
      },
    ));

    // MCP routes (единый реестр; legacy /servers — адаптеры над ним)
    app.route('/api/v2/mcp', createMcpRoutes(auth, mcpManager, sessionManager, {
      registry: mcpRegistryStore,
      networkPolicy: effectiveNetworkPolicy,
      getNetworkPolicy: () => effectiveNetworkPolicy,
    }));

    // Скиллы (AD-046 §9.1/§9.2): core-фабрика + RBAC ADMIN на запись.
    app.route('/api/v2/skills', createSkillRoutes(auth as unknown as CoreAuthKit, {
      skillService,
      resolveProjectWorkspace: async (projectId) => {
        const project = await projectStore.load(projectId);
        if (!project?.workspace) return undefined;
        return isAbsolute(project.workspace)
          ? normalize(project.workspace)
          : resolve(backendConfig.workspacesRoot, project.workspace);
      },
    }, { writeGuard: auth.requireAdmin }));

    // AD-046 §7/§9.1: команды и bundles (mirror core, мутации — ADMIN).
    app.route('/api/v2/commands', createCommandRoutes(auth as unknown as CoreAuthKit, {
      commandService,
      resolveProjectWorkspace: async (projectId) => {
        const project = await projectStore.load(projectId);
        if (!project?.workspace) return undefined;
        return isAbsolute(project.workspace)
          ? normalize(project.workspace)
          : resolve(backendConfig.workspacesRoot, project.workspace);
      },
    }));
    app.route('/api/v2/skill-bundles', createSkillBundleRoutes(auth as unknown as CoreAuthKit, {
      bundleStore,
      validateSkills: async (names) => {
        const missing: string[] = [];
        for (const name of names) {
          if (!(await skillService.get(name))) missing.push(name);
        }
        return missing;
      },
    }, { writeGuard: auth.requireAdmin }));

    // AD-046 §4.5: scope-API скиллов. Доступ к сессии — владелец|ADMIN
    // (canAccess, как в session-роутах); проект — owner/LEAD/ADMIN.
    const resolveSkillWorkspace = async (projectId: string): Promise<string | undefined> => {
      const project = await projectStore.load(projectId);
      if (!project?.workspace) return undefined;
      return isAbsolute(project.workspace)
        ? normalize(project.workspace)
        : resolve(backendConfig.workspacesRoot, project.workspace);
    };
    app.route('/api/v2/sessions', createSessionSkillScopeRoutes(auth as unknown as CoreAuthKit, {
      sessionManager, skillService, settingsStore, projectStore,
      permissionConfig: backendConfig.synth.permission,
      resolveProjectWorkspace: resolveSkillWorkspace,
    }, {
      writeGuard: auth.requireAuth,
      resolveUserId: async (c) => (await auth.getCurrentUser(c as never))?.id ?? '',
      canAccess: (session, c, userId) =>
        (session.ownerId ?? session.userId) === userId
        || auth.isAdmin(c as never),
    }));
    app.route('/api/v2/projects', createProjectSkillScopeRoutes(auth as unknown as CoreAuthKit, {
      sessionManager, skillService, settingsStore, projectStore,
      permissionConfig: backendConfig.synth.permission,
      resolveProjectWorkspace: resolveSkillWorkspace,
    }, {
      // AD-046 §4.5: проектным уровнем управляют owner/LEAD/ADMIN — как в
      // project-MCP (`canManageProjectMcp`), поэтому writeGuard не requireAdmin;
      // владение проверяет canAccessProject (403 не-членам, 404 — нет проекта).
      writeGuard: auth.requireAuth,
      resolveUserId: async (c) => (await auth.getCurrentUser(c as never))?.id ?? '',
      canAccessProject: (project, c, userId) =>
        auth.isAdmin(c as never)
        || auth.hasRole(c as never, 'LEAD')
        || project.ownerId === userId
        || project.members?.[userId] === ProjectRole.OWNER,
    }));
    app.route('/api/v2/settings', createSkillSettingsRoutes(auth as unknown as CoreAuthKit, { settingsStore }, {
      writeGuard: auth.requireAdmin,
      onSkillsDisabledChange: (disabled) => orchestrator.setSkillsDisabled(disabled),
    }));

    // LLM Gateway audit routes (AD-036) — GET только ADMIN/AUDITOR, POST /revealed — все авторизованные
    app.route('/api/v2/audit', createAuditRoutes(auth, {
      auditLogPath: gatewayAuditLogger.logPath,
      sessionExists: async (sessionId: string) => {
        const session = await sessionManager.getSession(sessionId);
        return session !== null;
      },
      logger: gatewayAuditLogger,
    }));

    // Логи сервисов (core/ui/backend) + полный лог запросов/ответов LLM — чтение, только ADMIN/AUDITOR
    app.route('/api/v2/logs', createLogsRoutes(auth, {
      logDir: resolveLogDir(),
      payloadLogPath: gatewayPayloadLogPath,
    }));

    // LLM Gateway patterns routes (AD-036) — управление regex-паттернами детекции секретов, только ADMIN
    app.route('/api/v2/gateway', createGatewayPatternsRoutes(auth, patternStore));

    // LLM Proxy (гибридный режим, Часть 5) — OpenAI-совместимый POST /api/v2/llm/chat/completions.
    // Локальный core гоняет LLM-запросы централизованно через LLM Gateway (AD-036):
    // обфускация/блокировка секретов, rate limit, аудит, полный payload-лог.
    app.route('/api/v2/llm', createLlmRoutes(auth, {
      providerLoader,
      modelLoader,
      // mergeLlmGatewayConfig может вернуть undefined, если ни base, ни runtime не заданы —
      // но schema с default({}) гарантирует base, поэтому подставляем его.
      gatewayConfig: gatewayConfig ?? backendConfig.synth.llmGateway,
      gatewayAuditLogger,
      gatewayRateLimiter: new RateLimiter(
        (gatewayConfig ?? backendConfig.synth.llmGateway).rateLimit.userPerMinute,
        (gatewayConfig ?? backendConfig.synth.llmGateway).rateLimit.providerPerMinute,
      ),
      gatewayPayloadLogPath,
      patternStore,
      rateLimiter: createRateLimiter(120, 60_000),
    }));

    // Settings routes (runtime-настройки для UI: workspace + mcp; переиспользуем core-реализацию)
    app.route('/api/v2/settings', createSettingsRoutes(auth as unknown as CoreAuthKit, {
      settingsStore,
      fallbackWorkspace: defaultWorkingDir,
      // AD-075: managed-развёртывание — политика вне `workspacesRoot` всегда `deny`
      // (enforcement — в `routes/projects.ts`); строго read-only: GET отдаёт
      // fallback + readOnly, PUT/DELETE → 403 WORKSPACE_POLICY_READ_ONLY.
      fallbackWorkspaceOutsideRootPolicy: 'deny',
      workspacePolicyReadOnly: true,
      // Агент по умолчанию при первом развёртывании (config.yaml не задаёт — DEFAULT_AGENT_ID).
      fallbackDefaultAgent: DEFAULT_AGENT_ID,
      // AD-072 Ф2: дефолты из config.yaml (без runtime) — для GET/DELETE-сброса к умолчанию.
      fallbackLlmGateway: {
        enabled: backendConfig.synth.llmGateway.enabled,
        inputMode: backendConfig.synth.llmGateway.inputMode,
        logPayloads: backendConfig.synth.llmGateway.logPayloads,
        rateLimit: {
          userPerMinute: backendConfig.synth.llmGateway.rateLimit?.userPerMinute ?? DEFAULT_LLM_GATEWAY_RATE_LIMIT.userPerMinute,
          providerPerMinute: backendConfig.synth.llmGateway.rateLimit?.providerPerMinute ?? DEFAULT_LLM_GATEWAY_RATE_LIMIT.providerPerMinute,
        },
      },
      fallbackSecurity: {
        protectedPaths: { enabled: backendConfig.synth.security.protectedPaths?.enabled ?? true },
        // AD-029: askTimeoutMs живёт в permission-секции конфига (не в security).
        askTimeoutMs: backendConfig.synth.permission?.askTimeoutMs,
      },
      // AD-036: live-применение тумблера LLM Gateway из UI — без рестарта сервера.
      onLlmGatewayChange: async (runtime) => {
        const merged = mergeLlmGatewayConfig(backendConfig.synth.llmGateway, runtime);
        orchestrator.setGatewayConfig(merged);
      },
      // live-применение тумблера защищённых путей из UI — без рестарта сервера.
      onSecurityChange: async (runtime) => {
        const merged = mergeSecurityConfig(backendConfig.synth.security, runtime);
        orchestrator.setSecurityConfig(merged);
      },
      // AD-071 §2.3: live-применение политики встроенных инструментов из админки.
      fallbackToolsPolicy: backendConfig.synth.tools.policy,
      onToolsPolicyChange: async (policy) => {
        orchestrator.setToolsPolicy(policy);
      },
      // AD-071 §2.3: live-применение политики MCP-инструментов из админки.
      fallbackMcpPolicy: backendConfig.synth.mcp.policy,
      onMcpPolicyChange: async (policy) => {
        orchestrator.setMcpPolicy(policy);
      },
      // AD-071 §2.6: live-применение instance-wide отключения инструментов.
      fallbackToolsDisabled: backendConfig.synth.tools.disabled,
      onToolsDisabledChange: async (disabled) => {
        orchestrator.setToolsDisabled(disabled);
      },
      knownTools: () => toolRegistry.list().map((tool) => ({
        name: tool.name,
        capabilities: [...tool.capabilities],
      })),
      // AD-071 §2.3.1: live-применение политики сетевого доступа MCP из админки.
      fallbackMcpNetworkPolicy: backendConfig.synth.mcp.networkPolicy,
      onMcpNetworkPolicyChange: async (policy) => {
        effectiveNetworkPolicy = policy;
        mcpManager.setNetworkPolicy(policy);
      },
      // AD-089: дефолт config.yaml для GET/DELETE-сброса раздела «События».
      fallbackEvents: backendConfig.synth.events,
      // AD-089: live-применение runtime-настроек «События» — Router/funnel/pruner.
      onEventsChange: (effective) => {
        effectiveEventsSettings = effective;
        eventRouter.updateConfig({
          allowedSources: effective.allowedSources,
          defaultMode: effective.defaultMode,
          defaultEphemeralTtl: effective.ephemeralTtl,
        });
        requestSessionService.updateConfig({
          defaultEphemeralTtl: effective.ephemeralTtl,
          unknownAgentTemplate: effective.unknownAgentTemplate,
        });
      },
      protectedPathsStore,
    }, {
      // AD-089: мутации раздела «События» — только ADMIN (managed RBAC).
      eventsWriteGuard: auth.requirePermission('ADMIN'),
    }));

    // Словари классификации: чтение — все авторизованные, запись/сброс — ADMIN
    // (тот же guard, что у users.ts). Реализация общая с core.
    const dictionaryStore = new DictionaryStore(dataDir);
    app.route('/api/v2/dictionaries', createDictionaryRoutes(
      auth,
      dictionaryStore,
      { writeGuard: auth.requireAdmin },
    ));

    // AD-069 §9.3: прозрачность проектных инструкций — core-фабрика (резолвер не
    // дублируется). RBAC: сессия — владелец|ADMIN (canAccess, как в session-роутах);
    // проект — owner/LEAD/ADMIN (canAccessProject, как в project-скиллах).
    const instructionsInfoResolver = createInstructionsInfoResolver(
      new ProjectInstructionsResolver({
        config: backendConfig.synth.instructions,
        dictionaryStore,
        dataDir,
        trustedProjectDirs: backendConfig.synth.skills.trustedProjectDirs,
        // AD-069 R3: авто-trust workspace внутри workspacesRoot (managed-каталоги).
        workspacesRoot: backendConfig.workspacesRoot,
      }),
      backendConfig.synth.instructions,
    );
    app.route('/api/v2/context', createCoreContextRoutes(auth as unknown as CoreAuthKit, {
      resolveInstructions: instructionsInfoResolver,
      sessionManager,
      projectStore,
      resolveProjectWorkspace: resolveSkillWorkspace,
      resolveContextWindow: (session) => {
        const model = session?.settings.model;
        return model ? modelWindowLoader(model) || undefined : undefined;
      },
      resolveUserId: async (c) => (await auth.getCurrentUser(c as never))?.id ?? '',
      canAccess: (session, c, userId) =>
        (session.ownerId ?? session.userId) === userId
        || auth.isAdmin(c as never),
      canAccessProject: (project, c, userId) =>
        auth.isAdmin(c as never)
        || auth.hasRole(c as never, 'LEAD')
        || project.ownerId === userId
        || project.members?.[userId] === ProjectRole.OWNER,
    }));

    // Глобальный SSE-хаб для всех сессий пользователя
    app.get('/api/v2/events', auth.requireAuth, async (c) => {
      const user = (await auth.getCurrentUser(c))!;
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

    // Admin routes (кроме graceful shutdown — он живёт в main.ts, т.к. требует server)
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

    /**
     * Поднять HTTP-сервер с WebSocket /ws/events на указанном порту
     * (порт 0 → эфемерный). Возвращает фактический порт.
     */
    async function listen(port: number = backendConfig.port, host: string = '0.0.0.0') {
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
                    }
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
                } else if (msg.type === 'permission_hold') {
                  const sid = msg.session_id;
                  const approvalId = msg.approval_id;
                  if (!sid || !approvalId) return;

                  // «Остановить таймер»: publish permission.hold — оркестратор снимает
                  // авто-отклонение по таймауту, запрос ждёт ответа пользователя.
                  eventBus.publish(sid, 'permission.hold', {
                    approval_id: approvalId,
                    session_id: sid,
                  });
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

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      });

      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;

      return { server, wss, port: actualPort };
    }

    return {
      app,
      dataDir,
      port: backendConfig.port,
      config: backendConfig,
      auth,
      eventBus,
      eventHub,
      sessionManager,
      projectStore,
      orchestrator,
      queueManager,
      settingsStore,
      // AD-089: ядро событий (понадобится на этапах 5–6).
      eventRouter,
      requestSessionService,
      eventBindingStore,
      eventJournal,
      ingress: eventIngress,
      // AD-051 (срез) / AD-089: реестр расписаний и планировщик.
      scheduleStore,
      scheduler: schedulerService,
      stopScheduler: () => schedulerService.stop(),
      stopEphemeralSweeper,
      stopEventJournalPruner,
      listen,
    };
  } finally {
    // Восстанавливаем окружение: env-переменные нужны только на время построения.
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
