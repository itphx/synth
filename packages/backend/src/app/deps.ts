// Сборка зависимостей backend: хранилища, менеджеры, оркестратор, событийное
// ядро (ADR-089), планировщик (ADR-051), webhooks (ADR-052), скиллы/команды
// (ADR-046), runtime-настройки (ADR-005/023).
// Вынесено из `app.ts` (ADR-095, шаг 4b) — «вынос по швам», без изменения поведения.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ProviderConfig, ModelConfig, ToolsDisabledConfig, WebhooksConfig,
  SummarizationConfig, DecisionConfig,
} from '@itphx/synth-shared';
import {
  ensureDataDir, parsePrincipalId, resolveDefaultWorkspace, resolveSecretKey, resolveStorageBackend,
  resolvePostgresConfig, resolvePostgresPassword, resolveDegradedMode, resolveStorageFallbackDir,
} from '@itphx/synth-shared';
import {
  SessionManager, EventBus, QueueProcessorManager,
  ContextBuilder, ContextOptimizer, ChatOrchestrator,
  enqueueUserMessage,
  createToolRegistry, createAgentRegistry, McpManager,
  DEFAULT_AGENT_ID,
  AuditLogger, mergeLlmGatewayConfig, mergeSecurityConfig,
  mergeEventsConfig, mergeDecisionConfig,
  createEgressPolicyResolver, createEgressLogSink,
  configureEgressRuntime, startEgressLogPruner,
  SkillService, resolveProjectSkillSeed,
  CommandService,
  detectRuntimeDeps, syncProvidersFromEnv,
  HookBus,
  startEphemeralSweeper,
  assertInstanceDataNotTooNew,
  applyStartupMigrations,
  applyPendingRestore,
  EventRouter, RequestSessionService, EventIngress, eventToMessage,
  ProjectRuleProvider, DecisionRuleProvider,
  SchedulerRuleProvider, SchedulerService, AlwaysLeader, FileLeader,
  createExternalIdentityResolver,
  startEventJournalPruner,
  WebhookService, startWebhookDeliveryPruner,
  createStorageContextAsync,
  initTlsTrust,
} from '@itphx/synth-core';
import type { DecisionAgentCandidate, EventsRuntimeSettings, StorageContext } from '@itphx/synth-core';
import type { BackendConfig } from '../lib/app-config.js';
import { EventHub } from '../events/hub.js';
import { seedDebugTestUsers } from './bootstrap.js';

/**
 * PROP-032 (W2.4): единая точка сборки слоя хранения backend — `app.ts` строит
 * её до `auth` (реестр `serviceKeys` нужен резолверу ключа, `mcpRegistry` —
 * сидированию instance-серверов), а `createBackendDeps` переиспользует инстанс.
 */
export async function createBackendStorage(config: BackendConfig): Promise<StorageContext> {
  // ADR-099: единый механизм доверия TLS/CA — применяем **до** первого исходящего
  // запроса (сборка хранилища/PG, дискавери OIDC, сид провайдеров из env ниже).
  // Вызывается в начале `createBackendApp` (env-оверрайды уже выставлены).
  // Fail-closed: битый/отсутствующий CA останавливает старт (не тихий фоллбэк).
  await initTlsTrust(
    { security: config.synth.security, proxy: config.synth.proxy },
    process.env,
    { dataDir: config.dataDir },
  );
  const kind = resolveStorageBackend(config.synth, process.env);
  if (kind === 'memory') {
    console.warn('storage.backend=memory: данные не сохраняются на диск');
  }
  return createStorageContextAsync(kind, {
    dataDir: config.dataDir,
    secretKey: resolveSecretKey(config.synth),
    env: process.env,
    postgres: resolvePostgresConfig(config.synth, process.env),
    postgresPassword: resolvePostgresPassword({ dataDir: config.dataDir }, process.env),
    degradedMode: resolveDegradedMode(config.synth),
    fallbackDir: resolveStorageFallbackDir(config.synth, process.env),
    dedupStore: config.synth.events.dedupStore,
    scheduleCrossProcess: config.synth.scheduler.crossProcessLocks,
    bundlesPath: config.synth.commands.bundlesPath,
  });
}

/**
 * Собрать зависимости backend-приложения (хранилища/менеджеры/оркестратор/
 * событийное ядро/планировщик/webhooks). Роуты монтирует вызывающий
 * (`mountBackendRoutes`), поэтому здесь нет ни одного `app.*`-вызова.
 */
export async function createBackendDeps(
  config: BackendConfig,
  storage?: StorageContext,
) {
  // Хранилища
  const dataDir = config.dataDir;
  await ensureDataDir(dataDir);

  // ADR-091: отложенное восстановление из бэкапа (паритет со standalone-core) —
  // офлайн-операция при старте **до** миграций и до использования стораджей.
  // Fail-closed: невалидный запрос останавливает старт, запрос не удаляется.
  await applyPendingRestore({ dataDir });

  // ADR-092: guard совместимости схемы данных (паритет со standalone-core):
  // данные новее Synth → отказ старта (fail-fast); устаревшая схема → авто-миграции
  // с обязательной страховочной копией ниже (`applyStartupMigrations`).
  await assertInstanceDataNotTooNew(dataDir);

  // PROP-032 (W2.3/W2.4): единый контекст хранения — домен получает порты из
  // одного места. По умолчанию собирается `createBackendStorage`, готовый можно
  // передать (паритет с `app.ts`, где `serviceKeys`/`mcpRegistry` нужны до `auth`).
  const storageContext = storage ?? (await createBackendStorage(config));
  // PROP-032 (W5): деградированное хранилище (postgres недоступен → файловый
  // фоллбек, read-only). Фоновые писатели отключаются (split-brain): миграции,
  // провайдеры из env, шедулер, webhooks, sweeper/ephemeral, retention-прунеры.
  const storageDegraded = storageContext.degraded !== undefined;
  const {
    settings: settingsStore,
    defaults: defaultsStore,
    secretPatterns: patternStore,
    protectedPaths: protectedPathsStore,
    sessions: fileStore,
    projects: projectStore,
    profiles: profilesStore,
    sshKeys: sshKeyStore,
    contextFiles: contextConfig,
    providers: providerStore,
    models: modelStore,
    agents: agentStore,
    dictionaries: dictionaryStore,
    serviceKeys: serviceApiKeyStore,
    webhooks: webhookStore,
    securityAudit,
    egressRequests,
    webhookDeliveries: webhookDeliveryStore,
    eventBindings: eventBindingStore,
    eventApiKeys: eventApiKeyStore,
    eventJournal,
    eventRoutes: routeRuleStore,
    identityClaims: identityClaimStore,
    dedup: dedupStore,
    schedules: scheduleStore,
    jobs: jobStore,
    skillBundles: bundleStore,
    mcpRegistry: mcpRegistryStore,
  } = storageContext;

  // ADR-030: ядровая шина хуков — общий инстанс для SessionManager и оркестратора.
  const hooks = new HookBus();
  const sessionManager = new SessionManager(fileStore, {
    projectStore,
    hooks,
    // ADR-071 §2.4 / ADR-046 §4.5: системные дефолты для сессий без проекта.
    systemDefaultsProvider: async () => ({
      mcpDefaultOn: await mcpRegistryStore.toDefaultServers(),
      skillsDefaultOn: (await resolveProjectSkillSeed(
        skillService,
        await settingsStore.getSkillsDisabledForNewProjects(),
      )).enabled,
    }),
  });
  // ADR-089: авто-архивация ephemeral-сессий по TTL (таймер `unref`).
  // Остановка — через хэндл `stopEphemeralSweeper` на graceful shutdown.
  const stopEphemeralSweeper = storageDegraded ? () => {} : startEphemeralSweeper(sessionManager);

  // ADR-036/ADR-005: паттерны секретов и runtime-настройки («workspace/mcp»,
  // умолчания оформления) — из контекста хранения (собраны выше).
  // ADR-075: дефолтный рабочий каталог — runtime-override `settings/workspace`
  // приоритетнее config/env (`resolveDefaultWorkspace`), каталог создаётся
  // заранее (как в core `server/app.ts`), чтобы инструменты не падали.
  const runtimeWorkspace = await settingsStore.getWorkspace();
  const defaultWorkingDir = runtimeWorkspace ?? resolveDefaultWorkspace(config.synth);
  await mkdir(defaultWorkingDir, { recursive: true });
  // Агент по умолчанию (админка «Агенты»): runtime-настройка поверх DEFAULT_AGENT_ID.
  const getDefaultAgentId = async (): Promise<string> =>
    (await settingsStore.getDefaultAgent()) ?? DEFAULT_AGENT_ID;

  // MCP: единый источник истины — реестр `McpRegistryStore` (ADR-071 §2.5).
  // Legacy `YamlMcpConfigStore` удалён: instance-серверы из config.mcp.servers
  // сидируются в реестр при старте (seed без дублирования по имени).
  const mcpManager = new McpManager();
  await mcpRegistryStore.seedFromConfig(config.synth.mcp.servers);
  // Одно чтение реестра на все карты менеджера (вместо пяти).
  const mcpMaps = await mcpRegistryStore.toManagerMaps();
  mcpManager.setConfig(mcpMaps.servers);
  mcpManager.setServerOrigins(mcpMaps.origins);
  mcpManager.setServerTrusts(mcpMaps.trusts);
  mcpManager.setServerAuthors(mcpMaps.authors);
  mcpManager.setDefaultServers(mcpMaps.defaults);
  // ADR-071 §2.4: системный мастер-флаг серверов (реестр `enabled`).
  mcpManager.setServerSystemEnabled(mcpMaps.systemEnabled);
  // Egress: живой резолвер политики (settings.json → config.yaml → дефолт) и
  // журнал внешних запросов. Резолвер читает стор на каждый запрос (live).
  const egressResolver = createEgressPolicyResolver(settingsStore, {
    tools: config.synth.egress.tools,
    webhooks: config.synth.egress.webhooks,
    mcp: config.synth.mcp.networkPolicy,
  });
  const egressLogConfig = config.synth.egress.log;
  const egressLog = createEgressLogSink(egressRequests, { enabled: () => egressLogConfig.enabled });
  configureEgressRuntime({ resolver: egressResolver, log: egressLog });
  const stopEgressLogPruner = storageDegraded || !egressLogConfig.enabled
    ? () => {}
    : startEgressLogPruner(egressRequests, { getRetentionDays: () => egressLogConfig.retentionDays });

  // ADR-071 §2.3.1: политика сетевого доступа HTTP-серверов (SSRF/egress)
  // резолвится при каждом connect/probe (live; без стартового снимка).
  mcpManager.setNetworkPolicyResolver(() => egressResolver.resolveMcp());

  // Сидирование тестовых пользователей (debug mode) — до построения рантайма
  // (паритет с прежним `app.ts`: сид стоял между хранилищами и рантаймом).
  seedDebugTestUsers(profilesStore, config.auth);

  const eventBus = new EventBus();
  const queueManager = new QueueProcessorManager();

  // ADR-052 (этап II): исходящие webhooks — реестр подписок (signing-секрет
  // `whsec_…` шифруется at-rest мастер-ключом), append-only журнал доставок и
  // движок над той же шиной `EventBus`, что обслуживает сессии/SSE. Движок
  // подписывается на ВСЕ события шины (`subscribeAll`) — паритет с core
  // `server/app.ts`; `webhooks.enabled: false` (дефолт) глушит диспетчеризацию.
  const webhooksConfig: WebhooksConfig = config.synth.webhooks;
  const webhookService = new WebhookService({
    store: webhookStore,
    deliveryStore: webhookDeliveryStore,
    eventBus,
    config: {
      ...webhooksConfig,
      // Отдельный экземпляр политики (граница доверия не смешивается с tools).
      resolvePolicy: () => egressResolver.resolveWebhooks(),
    },
  });
  if (!storageDegraded) webhookService.start();
  // Retention-очистка журнала доставок: сразу при старте + каждые 6 ч (unref).
  const stopWebhookDeliveryPruner = storageDegraded
    ? () => {}
    : startWebhookDeliveryPruner(webhookDeliveryStore, {
        getRetentionDays: () => webhooksConfig.deliveryRetentionDays,
      });

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

  // ADR-038: синхронизация провайдеров/моделей из переменных окружения (общая
  // core-реализация). Вызывается ПОСЛЕ создания providerStore/modelStore, но ДО
  // заполнения кэшей, чтобы env-провайдеры попали в providerCache/modelCache.
  // PROP-032 (W5): в деградации не пишем в фоллбек.
  if (!storageDegraded) await syncProvidersFromEnv(providerStore, modelStore);

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
  const summarizationConfig: SummarizationConfig = config.synth.summarization;
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
    config.synth.llmGateway.audit.logPath || join(dataDir, 'audit', 'llm-gateway.jsonl'),
  );

  // Полный лог запросов/ответов LLM (после обфускации) — один JSONL-файл для
  // записи (оркестратор) и чтения (GET /api/v2/logs/llm).
  const gatewayPayloadLogPath = config.synth.llmGateway.payloadLogPath
    || join(dataDir, 'audit', 'llm-payloads.jsonl');

  // ADR-036: runtime-настройка LLM Gateway (тумблер из UI, {dataDir}/settings.json)
  // приоритетнее config.yaml — мёржим при старте, чтобы шлюз применялся к оркестратору.
  const runtimeGateway = await settingsStore.getLlmGatewaySettings();
  const gatewayConfig = mergeLlmGatewayConfig(config.synth.llmGateway, runtimeGateway);

  // ADR-040: runtime-настройка защищённых путей (тумблер из UI, {dataDir}/settings.json)
  // приоритетнее config.yaml — мёржим при старте, чтобы защита применялась к оркестратору.
  const runtimeSecurity = await settingsStore.getSecuritySettings();
  const securityConfig = mergeSecurityConfig(config.synth.security, runtimeSecurity);
  // ADR-071 §2.3: runtime-политика встроенных инструментов (админка) приоритетнее config.yaml
  const runtimeToolsPolicy = await settingsStore.getToolsPolicy();
  const toolsPolicy = runtimeToolsPolicy ?? config.synth.tools.policy;
  // ADR-071 §2.3: runtime-политика MCP-инструментов (админка) приоритетнее config.yaml
  const runtimeMcpPolicy = await settingsStore.getMcpPolicy();
  const mcpPolicy = runtimeMcpPolicy ?? config.synth.mcp.policy;
  // ADR-071 §2.6: runtime-отключение инструментов (админка) приоритетнее config.yaml
  const runtimeToolsDisabled = await settingsStore.getToolsDisabled();
  const toolsDisabled: ToolsDisabledConfig =
    runtimeToolsDisabled ?? config.synth.tools.disabled ?? { capabilities: [], tools: [] };
  // ADR-046 §4.5: runtime-отключение скиллов (админка) — hard-gate системного уровня.
  const skillsDisabled = (await settingsStore.getSkillsDisabled())
    ?? { categories: [], groups: [], skills: [] };
  // ADR-084: runtime/эффективный конфиг decision-слоя (админка) приоритетнее
  // config.yaml `decision`. Live-применяется ко всем трём потребителям
  // (микро-каскад, роутер, события ADR-089) через `live.setDecision`.
  const runtimeDecision = await settingsStore.getDecision();
  let effectiveDecisionSettings = mergeDecisionConfig(config.synth.decision, runtimeDecision);

  // Orchestrator
  const toolRegistry = createToolRegistry();
  const agentRegistry = createAgentRegistry(toolRegistry, join(dataDir, 'agents'));

  // ADR-046: сервис скиллов (discovery + instance-запись + каталог промпта).
  const skillService = new SkillService({
    dataDir,
    configPaths: config.synth.skills.paths,
    urls: config.synth.skills.urls,
    trustedProjectDirs: config.synth.skills.trustedProjectDirs,
    toolsets: config.synth.skills.toolsets,
  });

  // ADR-046 §7: slash-команды и bundles (mirror core).
  const commandService = new CommandService({
    config: {
      dataDir,
      commandsPaths: config.synth.commands.paths,
      bundlesPath: config.synth.commands.bundlesPath,
      conflict: config.synth.commands.conflict,
      maxArgumentsLength: config.synth.commands.maxArgumentsLength,
      maxRenderedBytes: config.synth.commands.maxRenderedBytes,
      toolsets: config.synth.skills.toolsets,
      trustedProjectDirs: config.synth.skills.trustedProjectDirs,
      inlineShell: config.synth.skills.inlineShell ?? false,
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
    // ADR-076 §T6: тот же store, что у git/ssh-роутов — без дублей инстансов.
    sshKeyStore,
    // PROP-032 (W2.4): словари классификации — порт из контекста хранения.
    dictionaryStore,
    workspacesRoot: config.workspacesRoot,
    // ADR-075: backend — managed-режим, workspace вне workspacesRoot запрещён.
    workspaceManaged: true,
    // ADR-075: без defaultWorkingDir сессия без проекта получала бы
    // {dataDir}/workspaces/default мимо runtime-override settings/workspace.
    defaultWorkingDir,
    routerConfig: config.synth.router,
    // ADR-084: decision-слой микро-каскада (config.decision).
    decisionConfig: effectiveDecisionSettings,
    permissionConfig: config.synth.permission,
    defaultPlanMode: config.synth.session.planMode,
    securityConfig,
    gatewayConfig,
    gatewayAuditLogger,
    gatewayPayloadLogPath,
    gatewayPatternStore: patternStore,
    cachePolicy: config.synth.llm.cache,
    toolsPolicy,
    mcpPolicy,
    toolsDisabled,
    // ADR-046 §4.5: системный hard-gate скиллов (runtime-настройка).
    skillsDisabled,
    // ADR-070 §2.9.1: зависимости окружения (git/rg/sh) — детекция при старте.
    runtimeDeps: await detectRuntimeDeps(),
    // ADR-071 §2.6: калибровка chars-per-token по модели (runtime-настройки).
    tokenRatioLoader: (model) => settingsStore.getTokenRatio(model),
    onTokenRatioCalibrated: (model, ratio) => settingsStore.setTokenRatio(model, ratio),
    // ADR-046 §5: каталог скиллов в промпт + тул `skill`.
    skillRuntime: skillService,
    // ADR-046 §7: резолвинг `/`-команд до LLM.
    commandRuntime: commandService,
    // ADR-069 Фаза 1: проектные инструкции (merged chain AGENTS.md).
    instructionsConfig: config.synth.instructions,
    // ADR-069 Фаза 2a: project-trust гейт инструкций (config.skills.trustedProjectDirs).
    instructionsTrustedProjectDirs: config.synth.skills.trustedProjectDirs,
    // ADR-089: late-bound funnel создания сессий для тула `task` (саб-агент).
    // Сервис создаётся ниже (после оркестратора) — геттер читает его в рантайме.
    getRequestSessionService: () => requestSessionService,
    // ADR-051: late-bound резолвер активности расписания в сессии (ScheduleStore
    // создаётся ниже) — включает статический блок `Scheduler` в промпт.
    isSchedulerActive: (sid) => scheduleStore.hasEnabledTargetFor(sid),
    // «Стоп»: персистентный флаг отмены сессии — прерывает длинный
    // многоитерационный Tool Use на границе итерации (backoff/гонка).
    isCancelRequested: async (sid) =>
      (await sessionManager.getSession(sid))?.status.cancelRequested === true,
  });

  const processMessage = orchestrator.createProcessMessage();

  // ADR-089: ядро маршрутизации внешних событий и единый funnel создания сессий.
  // Funnel подключён к `POST /sessions` и тулу `task` (Этап 5); приём внешних
  // событий — на следующих этапах. Сторы bindings/ключей/журнала/правил/claim,
  // дедуп и расписания/jobs — из единого контекста хранения (собраны выше).
  // ADR-089 (Блок 3): runtime-настройки «События» (админка) поверх config.yaml.
  const runtimeEvents = await settingsStore.getEvents();
  const effectiveEvents = mergeEventsConfig(config.synth.events, runtimeEvents);
  let effectiveEventsSettings = effectiveEvents;
  const eventRouter = new EventRouter({
    bindingStore: eventBindingStore,
    journal: eventJournal,
    hooks,
    dedupStore,
    config: {
      allowedSources: effectiveEvents.allowedSources,
      defaultMode: effectiveEvents.defaultMode,
      defaultEphemeralTtl: effectiveEvents.ephemeralTtl,
      autoBind: effectiveEvents.autoBind,
      autoBindAgentTemplate: effectiveEvents.autoBindAgentTemplate,
    },
  });
  // ADR-089 (Блок 2): retention-очистка журнала событий (сразу + каждые 6 ч).
  const stopEventJournalPruner = storageDegraded
    ? () => {}
    : startEventJournalPruner(eventJournal, {
        getRetentionDays: () => effectiveEventsSettings.journalRetentionDays,
      });
  // ADR-051 (срез) / ADR-089: правило маршрутизации cron-событий по расписанию
  // (паритет с core `server/app.ts`; store без дублей).
  eventRouter.registerRuleProvider(
    new SchedulerRuleProvider(scheduleStore, effectiveEvents.ephemeralTtl),
  );
  // ADR-089: правила маршрутизации по матчу события (после scheduler).
  eventRouter.registerRuleProvider(
    new ProjectRuleProvider(routeRuleStore, effectiveEvents.ephemeralTtl),
  );
  // ADR-084 × ADR-089: decision-маршрутизация при промахе декларативных правил
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
      getDecisionConfig: () => effectiveDecisionSettings,
      getAgentCandidates: (): DecisionAgentCandidate[] =>
        agentRegistry.list().map((agent) => ({
          id: agent.id,
          displayName: agent.displayName,
          description: agent.description,
        })),
    }),
  );
  // ADR-089: резолвинг `agentTemplate` (события/правила) через `AgentRegistry`:
  // неизвестный или отключённый агент → `null`.
  const resolveAgentTemplate = (template: string): string | null => {
    const agent = agentRegistry.get(template);
    return agent && agent.enabled ? agent.id : null;
  };
  // EventHub — центральный диспетчер подписок. Создаётся до funnel: колбэк
  // `onSessionMaterialized` подписывает клиентов владельца на сессии,
  // созданные после их подключения (`subscribeToSession`, ADR-089).
  const eventHub = new EventHub(eventBus, sessionManager);
  // ADR-089: резолвер внешнего отправителя (профиль `identities`, principalId) в
  // пользователя инстанса; override `identityMap` — приоритетнее профиля.
  // `getIdentityMap` читает актуальное значение — `onEventsChange` обновляет
  // runtime-настройку live. Вынесен в локальную константу: переиспользуется
  // в `deps` и в `deliver` (attribution: `displayName` приоритетнее `payload.from`).
  const resolveExternalIdentity = createExternalIdentityResolver({
    profiles: profilesStore,
    getIdentityMap: () => effectiveEventsSettings.identityMap,
  });
  const requestSessionService = new RequestSessionService({
    sessionManager,
    eventRouter,
    bindingStore: eventBindingStore,
    hooks,
    config: {
      defaultEphemeralTtl: effectiveEvents.ephemeralTtl,
      unknownAgentTemplate: effectiveEvents.unknownAgentTemplate,
    },
    resolveAgentTemplate,
    // ADR-089: маппинг идентичности внешнего отправителя на владельца сессии
    // (`events.identityMap`) — напр. Telegram-чат → человек.
    identityMap: effectiveEvents.identityMap,
    // ADR-089: резолвинг внешнего отправителя → владелец сессии.
    resolveExternalIdentity,
    // ADR-089 (claim-flow): неизвестному отправителю выдаём одноразовый код
    // подтверждения владения идентичностью (`provider`/`externalId` — из
    // серверного разбора `identity.principalId`).
    issueIdentityClaim: async (event) => {
      const principalId = event.identity?.principalId;
      if (!principalId) return null;
      const parsed = parsePrincipalId(principalId);
      if (!parsed) return null;
      const claim = await identityClaimStore.create({
        provider: parsed.provider,
        externalId: parsed.externalId,
        ...(event.identity?.chatKey ? { chatKey: event.identity.chatKey } : {}),
        principalId,
      });
      return { code: claim.code, expiresAt: claim.expiresAt };
    },
    // ADR-089: подписка хаба на сессию владельца сразу после материализации —
    // чтобы клиент, подключённый до создания сессии (events-funnel), получал
    // её события. `subscribeToSession` синхронно ставит подписки, поэтому
    // последующая доставка события не теряется.
    onSessionMaterialized: (session) => {
      const owner = session.ownerId || session.userId;
      if (!owner) return;
      void eventHub.subscribeToSession(owner, session.id).catch((e: unknown) =>
        console.warn('subscribeToSession failed:', e),
      );
    },
    // ADR-089: дефолтные provider/model инстанса (llm.defaultProvider/defaultModel)
    // — для сессий из внешних событий (materialize ephemeral/bind), чтобы агент
    // мог ответить без ручной простановки модели.
    resolveLlmDefaults: () => ({
      provider: config.synth.llm.defaultProvider,
      model: config.synth.llm.defaultModel,
    }),
    // ADR-089: агент по умолчанию инстанса — чтобы сессия из внешнего события
    // (auto-bind/bind/ephemeral) фиксировала `settings.agentRole` и UI рисовал
    // бейдж агента (паритет с `POST /api/v2/sessions`). Источник — админка
    // «Агенты» (`getDefaultAgentId`) поверх `DEFAULT_AGENT_ID`.
    resolveDefaultAgent: getDefaultAgentId,
    // ADR-089: UI-событие после материализации внешнего события.
    publish: (type, sessionId, data) => eventBus.publish(sessionId, type, data),
    deliver: async (sessionId, event, mode, context) => {
      // ADR-051: cron-сообщение — от системного пользователя `Scheduler`, текст
      // задания — чистый контент сообщения (описание Scheduler — в system-блоке).
      let message = eventToMessage(event);
      // ADR-089: для слинкованного человека `displayName` из резолвера приоритетнее
      // имени из `payload.from` (tg-имя). Cron (`Scheduler`) не переопределяем.
      if (event.source !== 'cron' && event.identity?.principalId) {
        try {
          const linked = await resolveExternalIdentity(event.identity);
          if (linked?.displayName) message.author = linked.displayName;
        } catch {
          // attribution не критична — оставляем автора из `eventToMessage`
        }
      }
      // ADR-089 (этап 5): эффективные роли отправителя — в metadata хода.
      if (context) {
        message.metadata = {
          ...(message.metadata ?? {}),
          effective_roles: context.roles,
          identity_linked: context.linked,
        };
      }
      if (mode === 'run') {
        // ADR-036: обфускация user-сообщения ДО сохранения в историю (паритет с
        // prompt-путём — core routes/sessions.ts).
        await enqueueUserMessage(
          sessionManager, eventBus, sessionId, message, queueManager, processMessage,
          (sid, msg) => orchestrator.obfuscateUserMessageForHistory(sid, msg),
        );
      } else {
        // ADR-036: `defer` тоже кладёт сообщение в историю — обфусцируем до
        // постановки. Старт процессора не выполняем (только очередь владельца).
        message = await orchestrator.obfuscateUserMessageForHistory(sessionId, message);
        await sessionManager.addPendingMessage(sessionId, message);
      }
    },
  });

  // ADR-089: ingress-точка приёма внешних событий (Этап 6).
  const eventIngress = new EventIngress({ requestSessionService });

  // ADR-051 (срез) / ADR-089: планировщик публикует cron-события через ingress.
  // `start()` гейтится конфигом (`scheduler.enabled: false` — тикер не стартует),
  // ошибки старта логируются и не роняют процесс; остановка — `stopScheduler`.
  const schedulerTickMs = config.synth.scheduler.tickSec * 1000;
  // PROP-032: `leaderElection=postgres` требует advisory-локов backend'а
  // (`storage.backend=postgres`); иначе — предупреждение и AlwaysLeader.
  if (config.synth.scheduler.leaderElection === 'postgres' && !storageContext.locks) {
    console.warn(
      '[scheduler] leaderElection=postgres, но backend не предоставляет advisory-локи ' +
        '(нужен storage.backend=postgres) — используется AlwaysLeader',
    );
  }
  const schedulerService = new SchedulerService({
    scheduleStore,
    ingress: eventIngress,
    jobStore,
    tickMs: schedulerTickMs,
    defaultEphemeralTtl: effectiveEvents.ephemeralTtl,
    catchUp: config.synth.scheduler.catchUp,
    jobRetentionDays: config.synth.scheduler.jobRetentionDays,
    // ADR-051/ADR-089/PROP-032: тикер стартует только у лидера (default —
    // AlwaysLeader). `file` — файловый лок на общем dataDir, `postgres` —
    // session-level advisory-lock драйвера (доступен только при PG-backend).
    leader:
      config.synth.scheduler.leaderElection === 'file'
        ? new FileLeader({ dataDir, tickMs: schedulerTickMs })
        : config.synth.scheduler.leaderElection === 'postgres' && storageContext.locks
          ? storageContext.locks.createLeader({ name: 'scheduler/leader', tickMs: schedulerTickMs })
          : new AlwaysLeader(),
  });
  if (config.synth.scheduler.enabled !== false && !storageDegraded) {
    void schedulerService.start().catch((err) => {
      console.warn(`[scheduler] не удалось запустить: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // ADR-092: авто-миграции схемы данных при старте (паритет со standalone-core) —
  // обязательная страховочная копия + межпроцессный лок. Миграция снапшотов скоупа —
  // зарегистрированная миграция реестра (`session-scope-snapshots-v1`), отдельный
  // прямой вызов больше не нужен. Fail-closed: ошибка не глушится.
  // PROP-032 (W5): в деградации миграции не применяем (фоллбек-каталог пуст —
  // страховочная копия/миграция были бы доменной записью в фоллбек).
  if (!storageDegraded) {
    await applyStartupMigrations({
      dataDir,
      settingsStore,
      sessionManager,
      projectStore,
      // PROP-032: под PG — advisory-лок драйвера вместо файлового `{dataDir}/migrate`.
      ...(storageContext.locks
        ? { mutex: storageContext.locks.createMutex({ name: 'startup-migrate' }) }
        : {}),
      resolveSystemDefaults: async () => ({
        mcpDefaultOn: await mcpRegistryStore.toDefaultServers(),
        skillsDefaultOn: (await resolveProjectSkillSeed(
          skillService,
          await settingsStore.getSkillsDisabledForNewProjects(),
        )).enabled,
      }),
    });
  }

  return {
    dataDir,
    projectStore,
    sessionManager,
    // ADR-089: остановка sweeper'а авто-архивации ephemeral-сессий.
    stopEphemeralSweeper,
    sshKeyStore,
    providerStore,
    modelStore,
    agentStore,
    // PROP-032 (W2.4): конфигурационные словари и реестр service-key — из контекста.
    dictionaries: dictionaryStore,
    serviceApiKeyStore,
    contextConfig,
    profilesStore,
    patternStore,
    settingsStore,
    defaultsStore,
    defaultWorkingDir,
    getDefaultAgentId,
    egressResolver,
    egressLogConfig,
    securityAudit,
    egressRequests,
    stopEgressLogPruner,
    mcpManager,
    mcpRegistryStore,
    eventBus,
    queueManager,
    webhookStore,
    webhookDeliveryStore,
    webhookService,
    stopWebhookDeliveryPruner,
    webhooksConfig,
    providerLoader,
    providerCache,
    modelCache,
    modelLoader,
    modelWindowLoader,
    contextOptimizer,
    gatewayAuditLogger,
    gatewayPayloadLogPath,
    gatewayConfig,
    protectedPathsStore,
    toolRegistry,
    agentRegistry,
    skillService,
    bundleStore,
    commandService,
    orchestrator,
    processMessage,
    eventBindingStore,
    eventApiKeyStore,
    eventJournal,
    routeRuleStore,
    identityClaimStore,
    eventRouter,
    stopEventJournalPruner,
    scheduleStore,
    jobStore,
    // ADR-092: аудит-журнал обслуживания — порт слоя хранения (ADR-096).
    maintenanceAudit: storageContext.maintenanceAudit,
    resolveAgentTemplate,
    eventHub,
    requestSessionService,
    eventIngress,
    schedulerService,
    /**
     * Живые (мутируемые) эффективные настройки — аксессоры, а не значения:
     * обновляются админкой в рантайме (`mountBackendRoutes`), читаются
     * потребителями через замыкания (ADR-071 §2.3.1 / ADR-084 / ADR-089).
     */
    live: {
      /** ADR-089: runtime-настройки «События» (`enabled`/per-key лимит — роуты). */
      getEvents: (): EventsRuntimeSettings => effectiveEventsSettings,
      /** ADR-089: live-применение runtime-настроек «События» — Router/funnel/pruner. */
      setEvents: (effective: EventsRuntimeSettings): void => {
        effectiveEventsSettings = effective;
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
      /** ADR-084: live-применение runtime-настроек decision-слоя (микро-каскад/роутер). */
      setDecision: (effective: DecisionConfig): void => {
        effectiveDecisionSettings = effective;
        orchestrator.setDecisionConfig(effective);
      },
    },
  };
}

/** Зависимости backend-приложения (то, что вернул `createBackendDeps`). */
export type BackendDeps = Awaited<ReturnType<typeof createBackendDeps>>;
