// Монтирование HTTP-роутов API v2 standalone-core.
// Порядок `app.route`/`app.get` сохраняется 1:1 — он определяет приоритеты
// маршрутов (в т.ч. относительно прокси-middleware в `app.ts`).
// Вынесено из `server/app.ts` (ADR-095, шаг 4a) — «вынос по швам», без изменения поведения.
import { join, isAbsolute, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { SecurityConfig, WorkspaceOutsideRootPolicy, ProviderConfig, ModelConfig } from '@itphx/synth-shared';
import { DEFAULT_LLM_GATEWAY_RATE_LIMIT, SYNTH_VERSION } from '@itphx/synth-shared';
import {
  KeyRateLimiter, DEFAULT_AGENT_ID,
  createSessionRoutes, createProjectRoutes,
  createProviderRoutes, createModelRoutes, createAgentRoutes, createFsRoutes,
  createGitRoutes, createSshKeyRoutes, createAgentSshKeyRoutes,
  createQueueRoutes, createMessageRoutes, createSettingsRoutes,
  createDictionaryRoutes, createMcpRoutes, createEventRoutes, createSchedulerRoutes,
  createOAuthRoutes, bindCredentialToConnector,
  createAuditRoutes,
  createServiceKeyRoutes, createWebhookRoutes, createSkillRoutes, createCommandRoutes,
  createSkillBundleRoutes, createSessionSkillScopeRoutes, createProjectSkillScopeRoutes,
  createSkillSettingsRoutes, createIdentityRoutes, createContextRoutes,
  createMaintenanceRoutes, createProjectPortableRoutes,
  createAnalyticsRoutes, AnalyticsService,
  createStorageContextAsync,
  createMetricsSettingsRoutes,
  createPacksRoutes, createPipelinesRoutes,
  createPipelineProjectRoutes,
  createPluginsRoutes, createPluginSettingsRoutes,
  createMemoryRoutes, MEMORY_PLUGIN_NAME,
} from '../../index.js';
import type { StorageContext } from '../../index.js';
import type { MetricsRegistry } from '../../metrics/registry.js';
import type { MetricsReadiness } from '../routes/metrics-settings.js';
import { createProjectTransferRoutes } from '../routes/project-transfer.js';
import { createUpdateRoutes } from '../routes/updates.js';
import { ProjectInstructionsResolver, createInstructionsInfoResolver } from '../../engine/context/instructions.js';
import { executeToolDef } from '../../engine/tools/tool-execution.js';
import { MemoryProviderUnavailableError } from '../routes/memory.js';
import { resolvePluginServerPolicy } from '../../engine/plugins/hybrid-policy.js';
import { resolveProjectSkillSeed } from '../../engine/skills/seed.js';
import { mergeLlmGatewayConfig, mergeSecurityConfig, mergePluginsConfig } from '../../storage/runtime-settings.js';
import type { DefaultModelPair } from '../../storage/runtime-settings.js';
import { resolveProjectWorkspace } from '../fs-workspace.js';
import type { StandaloneConfig } from '../app.js';
import type { StandaloneDeps } from './deps.js';
import type { LocalAuthKit } from '../../auth/local.js';
import type { RemoteBackendClient } from '../../remote/client.js';

/** ADR-094: live-состояние метрик для админ-раздела «Наблюдаемость». */
export interface StandaloneMetricsContext {
  /** Фактический флаг старта процесса (`metricsEnabled`). */
  runningEnabled: boolean;
  /** Реестр метрик процесса (нет — экспорт выключен). */
  getRegistry: () => MetricsRegistry | undefined;
  /** Live-readiness (`GET /ready`). */
  getReadiness: () => MetricsReadiness;
  /** Физический backend хранения (`file`|`memory`|`postgres`). */
  storageBackend: string;
  /** Uptime процесса в секундах. */
  getUptimeSec: () => number;
}

/** Ленивый доступ к состоянию гибрида (`createHybridRemoteState`). */
export interface StandaloneRoutesRemote {
  /** Runtime-клиент удалённого backend или `null` (не подключено). */
  getClient: () => RemoteBackendClient | null;
  /** Виртуальные модели активных remote-зеркал (роут `/api/v2/models`). */
  getActiveRemoteModels: () => ModelConfig[];
  /** Имена активных remote-зеркал провайдеров. */
  getActiveRemoteProviderNames: () => Set<string>;
  /** Политика «все LLM — через сервер» (гибрид + `remoteLlm !== 'local'`). */
  isBlockLocalProviders: () => boolean;
}

export interface StandaloneRoutesContext {
  config: StandaloneConfig;
  deps: StandaloneDeps;
  /**
   * ADR-094: live-состояние подсистемы метрик для админ-раздела
   * «Наблюдаемость» (`/api/v2/settings/metrics*`).
   */
  metrics: StandaloneMetricsContext;
  remote: StandaloneRoutesRemote;
  /**
   * ADR-089: паритет с managed `EventHub.subscribeToSession` — подписка
   * WS-клиентов владельца на сессию. Нужен для materialization-путей `fork`
   * (и `import`), которые идут мимо funnel'а (`onSessionMaterialized` их не
   * покрывает), — иначе `session.fork.created` теряется для клиента,
   * подключённого до форка. Роуты вызывают колбэк до `eventBus.publish`.
   */
  subscribeWsSession?: (userId: string, sessionId: string) => void;
}

/**
 * Смонтировать все `/api/v2/*`-роуты и статический stub `/api/config/themes`
 * в порядке, идентичном прежнему `createStandaloneApp`.
 */
export function mountStandaloneRoutes(
  app: Hono,
  auth: LocalAuthKit,
  ctx: StandaloneRoutesContext,
): void {
  const { config, deps } = ctx;
  const {
    sessionManager, eventBus, queueManager, processMessage, orchestrator, contextOptimizer,
    projectStore, profilesStore, requestSessionService, getDefaultAgentId, skillService,
    settingsStore, toolRegistry, mcpManager, protectedPathsStore, sshKeyStore, providerStore,
    providerCache, modelStore, modelCache, agentStore, agentRegistry, webhookStore, webhookDeliveryStore,
    webhookService, webhooksConfig, eventIngress, eventBindingStore, eventJournal, routeRuleStore,
    eventApiKeyStore, resolveAgentTemplate, schedulerService, scheduleStore, jobStore,
    identityClaimStore, modelWindowLoader, eventRouter, dataDir, defaultWorkingDir,
    commandService, bundleStore, dictionaries, maintenanceAudit,
    egressResolver, securityAudit, egressRequests, analyticsRollups,
    analytics, pipelines, packs,
  } = deps;
  const serviceApiKeyStore = deps.serviceApiKeyStore;
  const {
    getClient, getActiveRemoteModels, getActiveRemoteProviderNames, isBlockLocalProviders,
  } = ctx.remote;
  /** ADR-075: эффективная политика workspace вне root — live-изменяется `onWorkspacePolicyChange`. */
  let effectiveWorkspaceOutsideRootPolicy: WorkspaceOutsideRootPolicy = deps.workspaceOutsideRootPolicy;
  /**
   * Fallback-пара «модель по умолчанию» из config.yaml
   * (`llm.defaultProvider` + `llm.defaultModel`) — только если заданы оба.
   */
  const configDefaultModel = (): DefaultModelPair | null =>
    config.llmDefaults?.provider && config.llmDefaults?.model
      ? { provider: config.llmDefaults.provider, model: config.llmDefaults.model }
      : null;
  const getEventsSettings = deps.getEventsSettings;
  const setEventsSettings = deps.setEventsSettings;
  // API-заглушки для UI
  app.get('/api/config/themes', (c) => c.json({ themes: [] }));

  // Sessions
  app.route('/api/v2/sessions', createSessionRoutes(
    auth,
    {
      sessionManager,
      eventBus,
      queueManager,
      processMessage,
      orchestrator,
      contextOptimizer,
      projectStore,
      profilesStore,
      getRemoteClient: () => getClient(),
      requestSessionService,
      analytics,
      // ADR-107: вкладка «Память» — агрегаты памяти сессии.
      ...(deps.storageContext
        ? {
            memory: {
              facts: deps.storageContext.memoryFacts,
              indexes: deps.storageContext.memoryIndexes,
              isPluginActive: () => deps.pluginRuntime.host.isActive(MEMORY_PLUGIN_NAME),
            },
          }
        : {}),
    },
    {
      resolveDefaultAgent: getDefaultAgentId,
      // ADR-089 (standalone): нормализация legacy-владельца (UUID профиля `local`)
      // при чтении — список сессий и доступ по id.
      localOwnerResolver: deps.localOwnerResolver,
      // ADR-089: подписка WS-клиентов владельца на созданную/форкнутую сессию
      // (паритет с managed `EventHub.subscribeToSession`). Покрывает fork/import
      // (materialization мимо funnel'а) и fallback-создание без funnel'а.
      onSessionCreated: (userId, sessionId) => { ctx.subscribeWsSession?.(userId, sessionId); },
      onSessionForked: (userId, sessionId) => { ctx.subscribeWsSession?.(userId, sessionId); },
    },
  ));

  // Projects
  app.route('/api/v2/projects', createProjectRoutes(auth, projectStore, () => getClient(), {
    // ADR-075: автосоздание/нормализация workspace локальных проектов.
    getWorkspacesRoot: () => config.workspacesRoot ?? join(dataDir, 'workspaces'),
    getOutsideRootPolicy: () => effectiveWorkspaceOutsideRootPolicy,
    // ADR-071 §2.4 / ADR-046 §4.5: сид скоупа нового проекта (снимок дефолтов).
    getProjectSeeds: async () => {
      const defaultMcpServers = Object.entries(config.mcpServers ?? {})
        .filter(([, cfg]) => cfg.enabledByDefault === true)
        .map(([name]) => name);
      return {
        mcp: { enabled: [...defaultMcpServers], defaultOn: [...defaultMcpServers] },
        skills: await resolveProjectSkillSeed(
          skillService,
          await settingsStore.getSkillsDisabledForNewProjects(),
        ),
      };
    },
  }));

  // Перенос проектов между мирами (гибрид, UI publish/fork): те же пути, что у
  // project-роутов (:id/publish, :id/fork-local — без конфликта с :id). Работает
  // in-process через remote/transfer.ts, требует runtime-подключения к backend.
  app.route('/api/v2/projects', createProjectTransferRoutes(
    auth,
    projectStore,
    sessionManager,
    config.workspacesRoot ?? join(dataDir, 'workspaces'),
    defaultWorkingDir,
    () => getClient(),
    eventBus,
  ));

  // ADR-091 (этап 2) / ADR-096: портативный экспорт/импорт проекта (скачать и
  // загрузить архив). Standalone — дефолтные guard'ы (`requireAuth`); доступ к
  // проекту одного пользователя отдельно не ограничиваем. `onSessionCreated` —
  // ускоритель подписки WS-хаба владельца (`local`) на импортированные сессии.
  // `canExportSecrets` — standalone: единственный локальный пользователь владеет
  // всеми локальными сущностями, поэтому привилегированный opt-in
  // `?withSecrets=true` разрешён ему (security-фикс 0.11.3).
  app.route('/api/v2/projects', createProjectPortableRoutes(
    auth,
    {
      dataDir,
      // ADR-096: экспорт/импорт проекта работают через контекст хранения
      // инстанса (иначе — свой файловый контекст, а на `backend=postgres`
      // проект не найден бы).
      storage: deps.storageContext,
      getProject: (id) => projectStore.load(id),
      canExportSecrets: () => true,
      audit: maintenanceAudit,
      maxUploadBytes: config.maxUploadBytes,
      onSessionCreated: (sessionId, ownerId) => { ctx.subscribeWsSession?.(ownerId, sessionId); },
    },
  ));

  // Providers
  app.route('/api/v2/providers', createProviderRoutes(auth, providerStore, providerCache, {
    testEnabled: true,
    // Дефолтный провайдер — из явной пары provider+model (runtime, fallback — config).
    getDefaultModel: async () => (await settingsStore.getDefaultModel()) ?? configDefaultModel(),
  }));

  // Models: remote-модели/провайдер читаются на каждый запрос (runtime-подключение).
  app.route('/api/v2/models', createModelRoutes(auth, modelStore, providerStore, modelCache, {
    extraModels: () => [...getActiveRemoteModels()],
    extraProviders: () => {
      const out: ProviderConfig[] = [];
      for (const name of getActiveRemoteProviderNames()) {
        const p = providerCache.get(name);
        if (p) out.push(p);
      }
      return out;
    },
    onlyRemoteModels: () => isBlockLocalProviders() && getActiveRemoteProviderNames().size > 0,
    // Модель по умолчанию — явная пара provider+model (runtime приоритетнее config).
    supportSetAsDefault: true,
    providerCache,
    getDefaultModel: async () => (await settingsStore.getDefaultModel()) ?? configDefaultModel(),
    setDefaultModel: (pair) => settingsStore.setDefaultModel(pair),
  }));

  // Agents
  // ADR-046/ADR-089: ролевой промпт агента (`role_prompt` в теле POST)
  // пишется портом файлов контекста — `{dataDir}/context/roles/<contextFile>`.
  app.route('/api/v2/agents', createAgentRoutes(auth, agentStore, agentRegistry, getDefaultAgentId, {
    roleFiles: deps.contextFiles,
  }));

  // FS (ADR-075: гарантированный корень workspace + мягкая политика путей вне root)
  // project-aware: с `project_id` база — workspace проекта (fallback на root/default).
  app.route('/api/v2/fs', createFsRoutes(
    auth,
    config.workspacesRoot ?? join(dataDir, 'workspaces'),
    () => getClient(),
    {
      getOutsideRootPolicy: () => effectiveWorkspaceOutsideRootPolicy,
      getProtectedPathsPolicy: () => protectedPathsStore.getPolicy(),
      // Лимит загрузки: config/env (resolveMaxUploadBytes), иначе дефолт фабрики.
      maxUploadBytes: config.maxUploadBytes,
      getProjectWorkspace: (projectId) => resolveProjectWorkspace(projectId, {
        workspacesRoot: config.workspacesRoot ?? join(dataDir, 'workspaces'),
        getProject: (id) => projectStore.load(id),
        outsideRootPolicy: () => effectiveWorkspaceOutsideRootPolicy,
        strict: false,
      }),
    },
  ));

  // Git (ADR-076): реестр репозиториев, clone/init/fetch/remove, SSH-ключи.
  // Core — локальный single-user режим: writeGuard не задаём (по умолчанию requireAuth).
  app.route('/api/v2/git', createGitRoutes(
    auth,
    projectStore,
    config.workspacesRoot ?? join(dataDir, 'workspaces'),
    { sshKeyStore },
  ));

  // SSH-ключи агентов (ADR-076 §T5): flat CRUD + nested-роуты агента.
  // Core — локальный single-user режим: guards не задаём (дефолт requireAuth).
  app.route('/api/v2/ssh-keys', createSshKeyRoutes(auth, sshKeyStore));
  app.route('/api/v2/agents/:agentId/ssh-keys', createAgentSshKeyRoutes(auth, sshKeyStore));

  // Queue
  app.route('/api/v2/queue', createQueueRoutes(
    auth, sessionManager, queueManager, eventBus, processMessage, () => getClient(),
    { localOwnerResolver: deps.localOwnerResolver },
  ));

  // Updates
  app.route('/api/v2/updates', createUpdateRoutes(auth, dataDir));

  // ADR-091/ADR-092: обслуживание инстанса (backup/restore/doctor/migrate).
  // Standalone — дефолтные guard'ы (`requireAuth`); managed backend передаст RBAC (ADMIN).
  // ADR-097: при backend=postgres doctor/migrations ходят в БД через read-only
  // пробу (контекст собирается в режиме `skip` — миграции не применяются).
  const storageBackend = config.storageBackend ?? 'file';
  const withPostgresContext = storageBackend === 'postgres'
    ? async <T>(fn: (ctx: StorageContext) => Promise<T>): Promise<T> => {
        const ctx = await createStorageContextAsync('postgres', {
          dataDir,
          secretKey: config.secretKey,
          env: process.env,
          postgres: config.postgresConfig,
          postgresPassword: config.postgresPassword,
          postgresSchemaMode: 'skip',
        });
        try {
          return await fn(ctx);
        } finally {
          await ctx.close?.();
        }
      }
    : undefined;
  app.route('/api/v2/maintenance', createMaintenanceRoutes(
    auth,
    {
      dataDir,
      secretKey: config.secretKey,
      env: process.env,
      audit: maintenanceAudit,
      storageBackend,
      ...(withPostgresContext
        ? {
            dbHealth: () =>
              withPostgresContext(
                (ctx) => (ctx.health ? ctx.health() : Promise.resolve({ ok: false, error: 'нет health()' })),
              ),
            schemaMigrations: (o?: { dryRun?: boolean }) =>
              withPostgresContext((ctx) =>
                ctx.schemaMigrations ? ctx.schemaMigrations(o) : Promise.reject(new Error('нет schemaMigrations()')),
              ),
          }
        : {}),
    },
    { maxUploadBytes: config.maxUploadBytes },
  ));

  // Журналы безопасности: аудит изменений политик + внешние запросы (egress).
  app.route('/api/v2/audit', createAuditRoutes(auth, { securityAudit, egressRequests }));

  // ADR-102 (волна 1): отчёты аналитики — только чтение. В standalone-режиме
  // единственный ключ → ADMIN, поэтому `resolveElevated` по умолчанию true (сквозной обзор).
  app.route('/api/v2/analytics', createAnalyticsRoutes(auth, {
    service: new AnalyticsService({ repo: analyticsRollups }),
  }));

  // Messages (batch operations)
  app.route('/api/v2/messages', createMessageRoutes(
    auth, sessionManager, () => getClient(),
    { localOwnerResolver: deps.localOwnerResolver },
  ));

  // Settings (runtime-настройки для UI, раздел «Проекты»)
  app.route('/api/v2/settings', createSettingsRoutes(auth, {
    settingsStore,
    fallbackWorkspace: defaultWorkingDir,
    // ADR-075: дефолт политики workspace вне root (config/env) для GET/DELETE-сброса.
    fallbackWorkspaceOutsideRootPolicy: config.workspaceOutsideRootPolicy ?? 'confirm',
    /** ADR-075: live-применение политики без рестарта (роуты проектов читают её на каждом запросе). */
    onWorkspacePolicyChange: (policy) => { effectiveWorkspaceOutsideRootPolicy = policy; },
    // Агент по умолчанию при первом развёртывании (config.yaml не задаёт — DEFAULT_AGENT_ID).
    fallbackDefaultAgent: DEFAULT_AGENT_ID,
    // Модель по умолчанию: fallback из config.yaml (пара — только если заданы оба
    // поля); runtime-значение приоритетнее. Валидация — фактическое наличие
    // провайдера в каталоге и модели `provider/model`.
    fallbackDefaultModel: configDefaultModel(),
    validateDefaultModel: async (pair) => {
      const provider = await providerStore.load(pair.provider);
      if (!provider) return `провайдер "${pair.provider}" не найден`;
      const model = await modelStore.load(`${pair.provider}/${pair.model}`);
      if (!model) return `модель "${pair.provider}/${pair.model}" не найдена`;
      return true;
    },
    // ADR-072 Ф2: дефолты из config.yaml (без runtime) — для GET/DELETE-сброса к умолчанию.
    fallbackLlmGateway: config.gatewayConfig ? {
      enabled: config.gatewayConfig.enabled,
      inputMode: config.gatewayConfig.inputMode,
      logPayloads: config.gatewayConfig.logPayloads,
      rateLimit: {
        userPerMinute: config.gatewayConfig.rateLimit?.userPerMinute ?? DEFAULT_LLM_GATEWAY_RATE_LIMIT.userPerMinute,
        providerPerMinute: config.gatewayConfig.rateLimit?.providerPerMinute ?? DEFAULT_LLM_GATEWAY_RATE_LIMIT.providerPerMinute,
      },
    } : undefined,
    fallbackSecurity: {
      protectedPaths: { enabled: config.securityConfig?.protectedPaths?.enabled ?? true },
      askTimeoutMs: (config.securityConfig as (SecurityConfig & { askTimeoutMs?: number }) | undefined)?.askTimeoutMs,
    },
    // ADR-036: live-применение тумблера LLM Gateway из UI — без рестарта сервера.
    onLlmGatewayChange: async (runtime) => {
      const merged = mergeLlmGatewayConfig(config.gatewayConfig, runtime);
      orchestrator.setGatewayConfig(merged);
    },
    // Live-применение тумблера защищённых путей + таймаута подтверждения из UI —
    // без рестарта сервера.
    onSecurityChange: async (runtime) => {
      const merged = mergeSecurityConfig(config.securityConfig, runtime);
      orchestrator.setSecurityConfig(merged);
      if (merged?.askTimeoutMs !== undefined) {
        orchestrator.setDefaultPermissionTimeout(merged.askTimeoutMs);
      }
    },
    // ADR-071 §2.3: live-применение политики встроенных инструментов из админки.
    fallbackToolsPolicy: config.toolsPolicy ?? 'auto',
    onToolsPolicyChange: async (policy) => {
      orchestrator.setToolsPolicy(policy);
    },
    // ADR-071 §2.3: live-применение политики MCP-инструментов из админки.
    fallbackMcpPolicy: config.mcpPolicy ?? 'auto',
    onMcpPolicyChange: async (policy) => {
      orchestrator.setMcpPolicy(policy);
    },
    // ADR-071 §2.6: live-применение instance-wide отключения инструментов.
    fallbackToolsDisabled: config.toolsDisabled ?? { capabilities: [], tools: [] },
    onToolsDisabledChange: async (disabled) => {
      orchestrator.setToolsDisabled(disabled);
    },
    knownTools: () => toolRegistry.list().map((tool) => ({
      name: tool.name,
      capabilities: [...tool.capabilities],
    })),
    // ADR-071 §2.3.1: дефолт config.yaml для GET/DELETE-сброса политики.
    fallbackMcpNetworkPolicy: config.mcpNetworkPolicy,
    // ADR-071 §2.3.1: отдельный колбэк не нужен — `McpManager` резолвит политику
    // из стора при каждом connect/probe (live, без стартового снимка).
    // Egress: дефолты config.yaml для GET/DELETE-сброса + аудит изменений.
    fallbackEgressTools: config.egressConfig?.tools,
    fallbackEgressWebhooks: config.egressConfig?.webhooks,
    // ADR-099: прокси — config-уровень, runtime-override и файл пароля.
    fallbackProxy: config.proxyConfig,
    // ADR-099: TLS/CA — config-уровень (read-only в UI; runtime — bootstrap).
    fallbackTls: config.securityConfig?.tls,
    dataDir,
    env: process.env,
    securityAudit,
    onEgressChange: () => {
      // Live: резолвер/web_fetch/web_search/skills/instructions читают стор на
      // каждую операцию — отдельная переконфигурация не нужна.
    },
    // ADR-089: дефолт config.yaml для GET/DELETE-сброса раздела «События».
    fallbackEvents: config.eventsConfig,
    // ADR-089: live-применение runtime-настроек «События» — Router/funnel/pruner
    // переконфигурируются без рестарта.
    onEventsChange: (effective) => {
      setEventsSettings(effective);
      eventRouter.updateConfig({
        allowedSources: effective.allowedSources,
        defaultMode: effective.defaultMode,
        defaultEphemeralTtl: effective.ephemeralTtl,
        autoBind: effective.autoBind,
        autoBindAgentTemplate: effective.autoBindAgentTemplate,
      });
      requestSessionService.updateConfig({
        defaultEphemeralTtl: effective.ephemeralTtl,
        unknownAgentTemplate: effective.unknownAgentTemplate,
        identityMap: effective.identityMap,
      });
    },
    // ADR-084: дефолт config.yaml для GET/DELETE-сброса decision-слоя.
    fallbackDecision: config.decisionConfig,
    // ADR-084: live-применение runtime-настроек decision-слоя — микро-каскад и
    // роутер читают конфиг геттером оркестратора; события — геттером выше.
    onDecisionChange: (effective) => {
      deps.setDecisionSettings(effective);
      orchestrator.setDecisionConfig(effective);
    },
    protectedPathsStore,
  }));

  // ADR-094: админ-раздел «Наблюдаемость» — runtime-настройки `metrics.enabled`
  // (применяются рестартом), live-статус и bearer-токен `/metrics` (write-only,
  // применяется сразу). Core: чтение/мутации — `requireAuth` (single-user).
  app.route('/api/v2/settings', createMetricsSettingsRoutes(
    { requireAuth: auth.requireAuth },
    {
      settingsStore,
      dataDir,
      configEnabled: config.metricsConfig?.enabled ?? false,
      runningEnabled: ctx.metrics.runningEnabled,
      getRegistry: ctx.metrics.getRegistry,
      getReadiness: ctx.metrics.getReadiness,
      getStorageBackend: () => ctx.metrics.storageBackend,
      getUptimeSec: ctx.metrics.getUptimeSec,
      version: SYNTH_VERSION,
    },
  ));

  // ADR-090 (Ф5б-2): runtime-настройки слоя плагинов
  // (`/api/v2/settings/plugins`). `restartRequired` — всегда true: рантайм
  // плагинов и хост собираются при старте (инвариант 24). Core — `requireAuth`.
  app.route('/api/v2/settings', createPluginSettingsRoutes(
    { requireAuth: auth.requireAuth },
    {
      config: mergePluginsConfig(config.pluginsConfig, {}),
      settings: settingsStore,
      running: deps.pluginRuntime.config,
      // Долги Д3: бюджеты применяются живьём, остальные ключи — рестартом.
      onPluginsChange: (effective) => {
        deps.orchestrator.setPromptBlockMaxChars(effective.promptBlockMaxChars);
        deps.orchestrator.setLlmFilterTimeoutMs(effective.llmFilterTimeoutMs);
      },
    },
  ));

  // Словари классификации: чтение — все аутентифицированные, запись/сброс —
  // аутентификация (в standalone достаточно --api-key, локальный режим).
  // Модуль общий с backend, отличается только writeGuard. Порт — из контекста хранения.
  app.route('/api/v2/dictionaries', createDictionaryRoutes(auth, dictionaries));

  // MCP (probe подключения к серверу)
  app.route('/api/v2/mcp', createMcpRoutes(auth, { mcpManager }));

  // ADR-105 (Ф4): HTTP-контур слоя внешних доступов. Standalone: единственный
  // владелец — локальный пользователь (`owner.kind='local'`, инвариант 19),
  // он же ADMIN — правило изменения записи реестра MCP не сужается.
  app.route('/api/v2/oauth', createOAuthRoutes(
    { requireAuth: auth.requireAuth },
    {
      credentials: deps.storageContext.externalCredentials,
      service: deps.oauthCredentialService,
      providers: deps.oauthProviders,
      // ADR-105 (Ф4): журнал операций со слоем доступов (привязка к коннектору).
      audit: deps.storageContext.credentialAudit,
      ownerKind: 'local',
      resolveActor: (c) => {
        const user = c.get('user') as { id?: string; roles?: string[] } | undefined;
        return { userId: user?.id ?? 'local', roles: user?.roles ?? ['ADMIN'] };
      },
      bindConnector: async ({ connectorId, credentialId }) => {
        await bindCredentialToConnector({
          registry: deps.mcpRegistryStore,
          connectorId,
          credentialId,
          canModify: () => true,
        });
        // Синхронизации с менеджером MCP здесь нет: в standalone конфиг
        // серверов приходит из `config.mcpServers`, а реестр — источник истины
        // только в managed-инстансе (ADR-071 §2.5). Перезапись менеджера из
        // реестра стёрла бы серверы из конфига.
      },
    },
  ));

  // ADR-089: приём внешних событий (ingress), биндинги и журнал. `GET /` не
  // определяется — SSE-хаб на `/api/v2/events` регистрируется ниже.
  app.route('/api/v2/events', createEventRoutes(
    auth,
    {
      ingress: eventIngress,
      bindingStore: eventBindingStore,
      journal: eventJournal,
      routeRuleStore,
      apiKeyStore: eventApiKeyStore,
    },
    {
      resolveAgentTemplate,
      sessionExists: async (id) => (await sessionManager.getSession(id)) !== null,
      // ADR-089/ADR-052: per-key rate limit и мастер-выключатель приёма (live).
      getKeyRateLimitPerMinute: () => getEventsSettings().keyRateLimitPerMinute,
      isEnabled: () => getEventsSettings().enabled,
      // ADR-089/ADR-052: приём события по API-ключу привязки.
      resolveApiKeySecret: async (raw) => {
        const resolved = await eventApiKeyStore.resolveBySecret(raw);
        if (!resolved) return null;
        const binding = await eventBindingStore.get(resolved.credential.bindingId);
        if (!binding) return null;
        return { binding, credential: resolved.credential };
      },
      touchApiKey: (id) => eventApiKeyStore.touch(id),
    },
  ));

  // ADR-051 (срез) / ADR-089: CRUD расписаний и принудительный запуск.
  // ADR-052: `resolveSessionProject` — проектная проекция `bound`/`queue`-целей.
  app.route('/api/v2/schedules', createSchedulerRoutes(
    auth,
    { scheduleStore, scheduler: schedulerService, jobStore },
    {
      resolveSessionProject: async (id) => (await sessionManager.getSession(id))?.projectId,
    },
  ));

  // ADR-051/ADR-100: API пайплайнов — определения (ставит установщик пакета),
  // экземпляры и ручной запуск. Standalone — дефолтные guard'ы (`requireAuth`).
  app.route('/api/v2/pipelines', createPipelinesRoutes(auth, { pipelines }));

  // ADR-101 (Э6): пайплайны проекта (черновик/публикация), прогоны и журнал,
  // HITL-действия и шаблоны инстанса (инстанцирование в проект).
  // Standalone — дефолтные guard'ы (`requireAuth`); права на проект в
  // standalone не разграничиваются (единственный пользователь инстанса).
  app.route('/api/v2', createPipelineProjectRoutes(
    auth,
    {
      pipelines: deps.storageContext.projectPipelines,
      runs: deps.storageContext.pipelineRuns,
      engine: deps.pipelineEngine,
      projects: projectStore,
      templates: pipelines,
    },
  ));

  // ADR-086 §5: установка пакетов расширений (скиллы/MCP/агенты/пайплайны) и
  // реестр установок. Standalone — `requireAuth` (single-user) + scope-гейт
  // `automation:install` для service-key (ADR-052).
  app.route('/api/v2/packs', createPacksRoutes(
    auth,
    {
      packs,
      pipelines,
      skills: skillService,
      mcpRegistry: deps.mcpRegistryStore,
      agents: agentStore,
      roleFiles: deps.contextFiles,
      routes: routeRuleStore,
      // ADR-106 Ф5: контент полномочий пакета активируется в политике
      // инстанса при одобрении и снимается при снятии установки.
      authorityPolicy: deps.storageContext.authorityPolicy,
      registerAgent: (agent) => agentRegistry.register(agent),
      unregisterAgent: (id) => agentRegistry.unregister(id),
    },
  ));

  // ADR-090 (Ф5б-2): управление плагинами — список/деталь,
  // установка из источника (standalone: `localInstall: true` — каталог/архив/
  // npm/url), подтверждение карантина, активация/деактивация и снятие.
  // Standalone — дефолтные guard'ы (`requireAuth`; единственный пользователь
  // инстанса — владелец, ADR-079). `update` — 501 (долги Д2).
  app.route('/api/v2/plugins', createPluginsRoutes(
    auth,
    {
      runtime: deps.pluginRuntime,
      config: mergePluginsConfig(config.pluginsConfig, {}),
      settings: settingsStore,
      localInstall: true,
      // Ф7 (ADR-090): реестр service-key — для выдачи server-scoped токена
      // плагину (`POST /api/v2/plugins/token`).
      serviceKeys: deps.storageContext.serviceKeys,
      // Ф7: серверная политика (allow-list) из работающего рантайма.
      serverPolicy: () => resolvePluginServerPolicy(deps.pluginRuntime.config),
    },
  ));

  // ADR-107 / PROP-047 §2.1: портал памяти в ядре — чтение фактов и индексов
  // через доменные порты памяти (namespace плагина памяти подставляет сервер).
  // Standalone — дефолтный guard (`requireAuth`; единственный пользователь
  // инстанса — владелец, ADR-079); managed backend передаст RBAC (ADMIN).
  // Проектная авторизация (`opts.authorizeProject`) в standalone **не задана**:
  // пользователь инстанса один, проектная проекция не разграничивается (так же,
  // как у FS- и git-роутов выше); managed backend передаёт проверку прав.
  app.route('/api/v2/memory', createMemoryRoutes(
    { requireAuth: auth.requireAuth },
    {
      memory: {
        facts: deps.storageContext.memoryFacts,
        indexes: deps.storageContext.memoryIndexes,
      },
      // Активен ли плагин памяти в процессе — реестр активаций хоста (ADR-090).
      isPluginActive: () => deps.pluginRuntime.host.isActive(MEMORY_PLUGIN_NAME),
      // М2: мутации индексов — через админ-тул плагина памяти (реестр тулов).
      // Контекст вызова (sessionId/messageId) создаёт вызывающая сторона:
      // сессии у портала нет — это служебный вызов инстанса.
      invokeTool: async ({ tool, params, projectId, workingDir }) => {
        const def = toolRegistry.get(tool);
        if (!def) throw new MemoryProviderUnavailableError(tool);
        return executeToolDef(
          def,
          params,
          {
            sessionId: `system:memory-portal:${randomUUID()}`,
            messageId: `system:memory-portal:${randomUUID()}`,
            workingDir,
            ...(projectId ? { projectId } : {}),
          },
          tool,
        );
      },
      // Проект и его workspace (ADR-075): относительный workspace резолвится
      // от `workspacesRoot`, абсолютный — как есть.
      resolveProject: async (projectId) => {
        const project = await deps.storageContext.projects.load(projectId);
        if (!project) return null;
        if (!project.workspace) return { id: project.id };
        const root = config.workspacesRoot ?? join(dataDir, 'workspaces');
        const workspace = isAbsolute(project.workspace)
          ? normalize(project.workspace)
          : resolve(root, project.workspace);
        return { id: project.id, workspace };
      },
      // Каталог данных — рабочий каталог для источника `facts` (нет workspace).
      dataDir,
    },
  ));

  // ADR-052 (этап I): CRUD service-key (`synth_svc_…`) — scoped-ключи инстанса.
  // Standalone — дефолтные guard'ы (`requireAuth`); managed backend передаст RBAC (ADMIN).
  app.route('/api/v2/service-keys', createServiceKeyRoutes(auth, { store: serviceApiKeyStore }));
  // ADR-052 (этап II): подписки на исходящие webhooks (CRUD + журнал + тест).
  // Standalone — дефолтные guard'ы (`requireAuth`); managed backend передаст RBAC (ADMIN).
  app.route('/api/v2/webhooks', createWebhookRoutes(
    auth,
    { store: webhookStore, deliveryStore: webhookDeliveryStore, service: webhookService },
    {
      isEnabled: () => webhooksConfig.enabled,
      // Отдельный экземпляр политики (live; граница доверия не смешивается с tools).
      resolvePolicy: () => egressResolver.resolveWebhooks(),
    },
  ));

  // Скиллы (ADR-046 §9.1): реестр + instance CRUD + supporting-файлы + reload.
  app.route('/api/v2/skills', createSkillRoutes(auth, {
    skillService,
    resolveProjectWorkspace: async (projectId) => {
      const project = await projectStore.load(projectId);
      if (!project?.workspace) return undefined;
      const root = config.workspacesRoot ?? join(dataDir, 'workspaces');
      return isAbsolute(project.workspace) ? normalize(project.workspace) : resolve(root, project.workspace);
    },
  }));

  // ADR-046 §9.1: список команд (встроенные + шаблонные + скиллы + bundles).
  app.route('/api/v2/commands', createCommandRoutes(auth, {
    commandService,
    resolveProjectWorkspace: async (projectId) => {
      const project = await projectStore.load(projectId);
      if (!project?.workspace) return undefined;
      const root = config.workspacesRoot ?? join(dataDir, 'workspaces');
      return isAbsolute(project.workspace) ? normalize(project.workspace) : resolve(root, project.workspace);
    },
  }));

  // ADR-046 §9.1: bundles (instance-хранилище YAML-групп скиллов).
  app.route('/api/v2/skill-bundles', createSkillBundleRoutes(auth, {
    bundleStore,
    validateSkills: async (names) => {
      const missing: string[] = [];
      for (const name of names) {
        if (!(await skillService.get(name))) missing.push(name);
      }
      return missing;
    },
  }));

  // ADR-046 §4.5: scope-API скиллов (сессии/проекты/настройки, аналог MCP).
  const resolveSkillWorkspace = async (projectId: string): Promise<string | undefined> => {
    const project = await projectStore.load(projectId);
    if (!project?.workspace) return undefined;
    const root = config.workspacesRoot ?? join(dataDir, 'workspaces');
    return isAbsolute(project.workspace) ? normalize(project.workspace) : resolve(root, project.workspace);
  };
  app.route('/api/v2/sessions', createSessionSkillScopeRoutes(auth, {
    sessionManager, skillService, settingsStore, projectStore,
    permissionConfig: config.permissionConfig,
    resolveProjectWorkspace: resolveSkillWorkspace,
  }, {
    localOwnerResolver: deps.localOwnerResolver,
  }));
  app.route('/api/v2/projects', createProjectSkillScopeRoutes(auth, {
    sessionManager, skillService, settingsStore, projectStore,
    permissionConfig: config.permissionConfig,
    resolveProjectWorkspace: resolveSkillWorkspace,
  }));
  app.route('/api/v2/settings', createSkillSettingsRoutes(auth, { settingsStore }, {
    onSkillsDisabledChange: (disabled) => orchestrator.setSkillsDisabled(disabled),
  }));

  // ADR-089: идентичности текущего пользователя (`GET/DELETE /api/v2/me/identities`).
  // Standalone — профиль `local` (id генерируется стором, не литерал `local`);
  // линковка только через claim-flow (`POST /api/v2/me/identities/claim`).
  // Анти-брутфорс одноразового кода — per-user fixed window 60 c (ключ — токен).
  const identityClaimRateLimiter = new KeyRateLimiter(60_000);
  const identityClaimRateLimitGuard = createMiddleware(async (c, next) => {
    const key = c.req.header('Authorization') || 'anonymous';
    if (!identityClaimRateLimiter.check(key, 10)) {
      return c.json(
        { error: { code: 'RATE_LIMITED', message: 'Превышен лимит запросов' } },
        429,
      );
    }
    await next();
  });
  app.route('/api/v2/me', createIdentityRoutes(auth, profilesStore, {
    resolveProfileId: async () => (await profilesStore.getOrCreateProfile({ username: 'local' })).id,
    claimStore: identityClaimStore,
    rateLimitGuard: identityClaimRateLimitGuard,
  }));

  // ADR-069 §9.3: read-only прозрачность проектных инструкций (session/project scope).
  // Резолвер — тот же core-модуль, что у оркестратора (Фаза 1/2a); доступ —
  // владелец|ADMIN по сессии, owner/LEAD/ADMIN по проекту.
  if (config.instructionsConfig) {
    const instructionsInfoResolver = createInstructionsInfoResolver(
      new ProjectInstructionsResolver({
        config: config.instructionsConfig,
        dictionaryStore: dictionaries,
        dataDir,
        trustedProjectDirs: config.skillsConfig?.trustedProjectDirs,
        // ADR-069 R3: авто-trust workspace внутри workspacesRoot (как в оркестраторе).
        workspacesRoot: config.workspacesRoot ?? join(dataDir, 'workspaces'),
        // ADR-077: `git rev-parse` — через порт исполнения (тот же, что у тулов).
        execution: deps.executionPort,
      }),
      config.instructionsConfig,
    );
    app.route('/api/v2/context', createContextRoutes(auth, {
      resolveInstructions: instructionsInfoResolver,
      sessionManager,
      projectStore,
      resolveProjectWorkspace: resolveSkillWorkspace,
      localOwnerResolver: deps.localOwnerResolver,
      resolveContextWindow: (session) => {
        const model = session?.settings.model;
        return model ? modelWindowLoader(model) || undefined : undefined;
      },
    }));
  }
}
