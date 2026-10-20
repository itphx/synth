// Сборка зависимостей standalone-core: хранилища, менеджеры, оркестратор,
// событийное ядро (ADR-089), планировщик (ADR-051), webhooks (ADR-052),
// скиллы/команды (ADR-046), runtime-настройки (ADR-005/023).
// Вынесено из `server/app.ts` (ADR-095, шаг 4a) — «вынос по швам», без изменения поведения.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ProviderConfig, ModelConfig, ToolsPolicy, ToolsDisabledConfig,
  WorkspaceOutsideRootPolicy, WebhooksConfig, SummarizationConfig, Session,
} from '@itphx/synth-shared';
import { ensureDataDir, parsePrincipalId, readTlsRuntimeSettings } from '@itphx/synth-shared';
import {
  SessionManager, EventBus, QueueProcessorManager,
  ContextBuilder, ContextOptimizer, ChatOrchestrator,
  enqueueUserMessage, createToolRegistry, createAgentRegistry, McpManager,
  DEFAULT_AGENT_ID,
  detectRuntimeDeps, HookBus, startEphemeralSweeper,
  EventRouter, RequestSessionService, EventIngress, eventToMessage,
  ProjectRuleProvider, DecisionRuleProvider,
  type DecisionAgentCandidate,
  SchedulerRuleProvider, SchedulerService, AlwaysLeader, FileLeader,
  WebhookService,
  createExternalIdentityResolver,
  startEventJournalPruner,
  startWebhookDeliveryPruner,
  AnalyticsRecorder,
  attachAnalyticsActivityHooks,
  startAnalyticsRollupPruner,
  sessionAxes,
  createStorageContextAsync,
  attachBusMetrics,
  startSessionMetrics,
  startStorageMetrics,
  registerDecisionMetrics,
  createSchedulerMetrics,
  createWebhookMetrics,
  createEventMetrics,
  startEventJournalMetrics,
  createEgressPolicyResolver,
  createEgressLogSink,
  configureEgressRuntime,
  startEgressLogPruner,
  type StorageContext,
} from '../../index.js';
import { syncProvidersFromEnv } from '../../providers/sync-from-env.js';
import {
  mergeLlmGatewayConfig, mergeSecurityConfig,
  mergeEventsConfig, mergeDecisionConfig,
} from '../../storage/runtime-settings.js';
import { assertInstanceDataNotTooNew } from '../../storage/instance-meta.js';
import { applyStartupMigrations, applyPendingRestore } from '../../maintenance/startup.js';
import { SkillService } from '../../engine/skills/service.js';
import { resolveProjectSkillSeed } from '../../engine/skills/seed.js';
import { CommandService } from '../../engine/commands/service.js';
import { createLocalOwnerResolver, LOCAL_USER_ID } from '../local-owner.js';
import type { MetricsRegistry } from '../../metrics/registry.js';
import type { StandaloneConfig } from '../app.js';

/**
 * Ленивый доступ к зеркалам гибрида (`createHybridRemoteState`): сборка
 * зависимостей создаётся после фабрики гибридного состояния, поэтому значения
 * читаются геттерами в рантайме.
 */
export interface HybridMirrorAccessors {
  /** Имена активных remote-зеркал провайдеров (политика `providerLoader`). */
  getActiveRemoteProviderNames: () => Set<string>;
  /** Политика «все LLM — через сервер» (активна только при подключении). */
  isBlockLocalProviders: () => boolean;
}

/**
 * Швы сборки standalone-зависимостей: зеркала гибрида + ADR-089-подписка хаба.
 */
export interface StandaloneDepsAccessors extends HybridMirrorAccessors {
  /**
   * ADR-089: колбэк после материализации сессии funnel'ом
   * (`RequestSessionService.onSessionMaterialized`) и **до** доставки события в неё.
   * Получает **нормализованного** владельца (legacy-UUID профиля `local` → `local`,
   * см. `LocalOwnerResolver`) и id сессии; standalone подписывает на сессию уже
   * подключённых клиентов WS-хаба (`/ws/events`) — паритет с managed
   * `EventHub.subscribeToSession`. Не задан — поведение прежнее (только снимок
   * сессий при `connect`).
   */
  onSessionMaterialized?: (owner: string, sessionId: string) => void | Promise<void>;
}

/**
 * PROP-032 (W2.4): единая точка сборки слоя хранения standalone — `app.ts`
 * строит её до `auth` (реестр `serviceKeys` нужен резолверу ключа), а
 * `createStandaloneDeps` переиспользует тот же инстанс (один контекст, а не
 * россыпь конкретных классов по `main.ts`/`chat.ts`/`app.ts`).
 */
export async function createStandaloneStorage(config: StandaloneConfig): Promise<StorageContext> {
  const kind = config.storageBackend ?? 'file';
  if (kind === 'memory') {
    console.warn('storage.backend=memory: данные не сохраняются на диск');
  }
  return createStorageContextAsync(kind, {
    dataDir: config.dataDir,
    secretKey: config.secretKey,
    env: process.env,
    postgres: config.postgresConfig,
    postgresPassword: config.postgresPassword,
    ...(config.securityConfig?.tls ? { security: { tls: config.securityConfig.tls } } : {}),
    ...(() => {
      const runtime = readTlsRuntimeSettings(config.dataDir);
      return runtime ? { tlsRuntime: runtime } : {};
    })(),
    degradedMode: config.degradedMode ?? 'fallback-file',
    fallbackDir: config.fallbackDir ?? join(config.dataDir, 'fallback'),
    dedupStore: config.eventsConfig?.dedupStore,
    scheduleCrossProcess: config.schedulerConfig?.crossProcessLocks ?? false,
    systemPromptsDir: config.systemPromptsDir,
    bundlesPath: config.commandsConfig?.bundlesPath,
  });
}

export async function createStandaloneDeps(
  config: StandaloneConfig,
  accessors: StandaloneDepsAccessors,
  storage?: StorageContext,
  metrics?: MetricsRegistry,
) {
  const storageContext = storage ?? (await createStandaloneStorage(config));
  const dataDir = config.dataDir;
  // PROP-032 (W5): деградированное хранилище (postgres недоступен → файловый
  // фоллбек, read-only). Фоновые ПИСАТЕЛИ (миграции, провайдеры из env, шедулер,
  // webhooks, sweeper/ephemeral, retention-прунеры) отключаются, чтобы не
  // создавать доменные данные в фоллбеке (split-brain).
  const storageDegraded = storageContext.degraded !== undefined;
  await ensureDataDir(dataDir);

  // ADR-091: отложенное восстановление из бэкапа — офлайн-операция, применяется
  // при старте **до** миграций и до использования стораджей (меняет данные
  // каталога: возврат к снимку). Fail-closed: невалидный запрос останавливает
  // старт (запрос не удаляется — оператор исправляет или отменяет).
  await applyPendingRestore({ dataDir });

  // ADR-092: guard совместимости схемы данных — данные новее Synth → отказ старта
  // (дешёвая fail-fast проверка). Устаревшая схема → авто-миграции с обязательной
  // страховочной копией ниже (`applyStartupMigrations`), после сборки стораджей.
  await assertInstanceDataNotTooNew(dataDir);

  // PROP-032 (W2.3/W2.4): единый контекст хранения — домен получает порты из
  // одного места (по умолчанию собирается `createStandaloneStorage`, можно
  // передать готовый — паритет с `app.ts`, где `serviceKeys` нужен до `auth`).
  // `file` (дефолт) собирает те же реализации/аргументы, что были здесь раньше
  // (побайтовое поведение); `memory` — энергонезависимо (герметичные тесты).
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
    securityAudit,
    egressRequests,
    analyticsRollups,
  } = storageContext;

  // Egress: живой резолвер политики (settings.json → config.yaml → дефолт) и
  // журнал внешних запросов. Резолвер читает стор на каждый запрос — без
  // стартового снимка/кэша (live-применение без рестарта).
  // PROP-102: сборщик роллапов аналитики (write-path) — только через порт слоя
  // хранения; в деградации выключен (чтоб не писать домен в файловый фоллбек).
  const analytics = storageDegraded ? undefined : new AnalyticsRecorder({ repo: analyticsRollups });
  const egressResolver = createEgressPolicyResolver(settingsStore, {
    tools: config.egressConfig?.tools,
    webhooks: config.egressConfig?.webhooks,
    mcp: config.mcpNetworkPolicy,
  });
  const egressLogConfig = config.egressConfig?.log ?? { enabled: true, retentionDays: 7 };
  const egressLog = createEgressLogSink(egressRequests, {
    enabled: () => egressLogConfig.enabled,
  });
  configureEgressRuntime({ resolver: egressResolver, log: egressLog });
  const stopEgressLogPruner = storageDegraded || !egressLogConfig.enabled
    ? () => {}
    : startEgressLogPruner(egressRequests, {
        getRetentionDays: () => egressLogConfig.retentionDays,
      });

  // Runtime-настройки (ADR-005): workspace из {dataDir}/settings.json приоритетнее config/env
  // Агент по умолчанию (админка «Агенты»): runtime-настройка поверх DEFAULT_AGENT_ID.
  const getDefaultAgentId = async (): Promise<string> =>
    (await settingsStore.getDefaultAgent()) ?? DEFAULT_AGENT_ID;
  const runtimeWorkspace = await settingsStore.getWorkspace();
  const defaultWorkingDir = runtimeWorkspace ?? config.defaultWorkingDir ?? join(dataDir, 'workspaces', 'default');
  await mkdir(defaultWorkingDir, { recursive: true });

  // ADR-036: runtime-настройка LLM Gateway (тумблер из UI) приоритетнее config.yaml
  const runtimeGateway = await settingsStore.getLlmGatewaySettings();
  const gatewayConfig = mergeLlmGatewayConfig(config.gatewayConfig, runtimeGateway);

  // Защищённые пути: runtime-настройка protectedPaths.enabled (тумблер из UI) приоритетнее config.yaml
  const runtimeSecurity = await settingsStore.getSecuritySettings();
  const effectiveSecurityConfig = mergeSecurityConfig(config.securityConfig, runtimeSecurity);

  // ADR-071 §2.3: runtime-политика встроенных инструментов (админка) приоритетнее config.yaml tools.policy
  const runtimeToolsPolicy = await settingsStore.getToolsPolicy();
  const effectiveToolsPolicy: ToolsPolicy = runtimeToolsPolicy ?? config.toolsPolicy ?? 'auto';
  // ADR-071 §2.3: runtime-политика MCP-инструментов (админка) приоритетнее config.yaml mcp.policy
  const runtimeMcpPolicy = await settingsStore.getMcpPolicy();
  const effectiveMcpPolicy: ToolsPolicy = runtimeMcpPolicy ?? config.mcpPolicy ?? 'auto';
  // ADR-071 §2.6: runtime-отключение инструментов (админка) приоритетнее config.yaml tools.disabled
  const runtimeToolsDisabled = await settingsStore.getToolsDisabled();
  const effectiveToolsDisabled: ToolsDisabledConfig =
    runtimeToolsDisabled ?? config.toolsDisabled ?? { capabilities: [], tools: [] };
  // ADR-046 §4.5: runtime-отключение скиллов (админка) — hard-gate системного уровня.
  const effectiveSkillsDisabled = (await settingsStore.getSkillsDisabled())
    ?? { categories: [], groups: [], skills: [] };

  // ADR-075: политика workspace вне root. config/env — дефолт; runtime-override
  // (settings.json) применяется при старте и live через PUT /settings/workspace-policy
  // (live-состояние ведёт `app/mount-routes.ts`).
  const effectiveWorkspaceOutsideRootPolicy: WorkspaceOutsideRootPolicy =
    (await settingsStore.getWorkspacePolicy()) ?? config.workspaceOutsideRootPolicy ?? 'confirm';

  // ADR-084: runtime/эффективный конфиг decision-слоя (админка) приоритетнее
  // config.yaml `decision`. Live-применяется ко всем трём потребителям
  // (микро-каскад, роутер, события ADR-089) через `onDecisionChange`.
  const runtimeDecision = await settingsStore.getDecision();
  let effectiveDecisionSettings = mergeDecisionConfig(config.decisionConfig, runtimeDecision);

  // ADR-036: паттерны детекции секретов и ADR-075 защищённые пути — из контекста
  // хранения (собраны выше); ADR-030: ядровая шина хуков — общий инстанс для
  // SessionManager и оркестратора (эмиты жизненного цикла агента).
  const hooks = new HookBus();
  const sessionManager = new SessionManager(fileStore, {
    mcpSettingsProvider: () => settingsStore.getMcpSettings(),
    projectStore,
    hooks,
    // PROP-102: точка персиста сообщения инкрементирует `activity`
    // (`messages_assistant`/`messages_tool`); пользовательские — в процессоре.
    analytics,
    // ADR-071 §2.4 / ADR-046 §4.5: системные дефолты для сессий без проекта.
    systemDefaultsProvider: async () => ({
      mcpDefaultOn: Object.entries(config.mcpServers ?? {})
        .filter(([, cfg]) => cfg.enabledByDefault === true)
        .map(([name]) => name),
      skillsDefaultOn: (await resolveProjectSkillSeed(
        skillService,
        await settingsStore.getSkillsDisabledForNewProjects(),
      )).enabled,
    }),
  });
  // ADR-089: авто-архивация ephemeral-сессий по TTL. Таймер `unref`-ится
  // (тесты/короткоживущие процессы не держатся); остановка — на shutdown
  // через возвращаемый хэндл `stopEphemeralSweeper`.
  const stopEphemeralSweeper = storageDegraded ? () => {} : startEphemeralSweeper(sessionManager);
  // PROP-102: шов записи `activity` через hook-шину (ADR-030): жизненный цикл
  // сессии/инструментов/саб-агентов → инкременты роллапов. Оси `user`/`project`
  // берутся из контекста хука либо резолвятся по id сессии.
  const detachAnalyticsHooks = analytics
    ? attachAnalyticsActivityHooks(hooks, {
        recorder: analytics,
        resolveSessionAxes: async (sessionId) =>
          sessionAxes(await sessionManager.getSession(sessionId)),
      })
    : () => {};
  // PROP-102 §8: retention суточных роллапов (сразу + каждые 6 ч, `unref`).
  const stopAnalyticsRollupPruner =
    storageDegraded || !analytics
      ? () => {}
      : startAnalyticsRollupPruner(analyticsRollups, {
          getRetentionDays: () => config.analyticsConfig?.retentionDays ?? 400,
        });
  const mcpManager = new McpManager();
  mcpManager.setConfig(config.mcpServers ?? {});

  // ADR-071 §2.3.1: политика сетевого доступа MCP резолвится при каждом
  // подключении/probe (live; живые соединения остаются на политике коннекта).
  mcpManager.setNetworkPolicyResolver(() => egressResolver.resolveMcp());

  // Парсим провайдеров из переменных окружения (в деградации — не пишем в фоллбек).
  if (!storageDegraded) await syncProvidersFromEnv(providerStore, modelStore);

  const eventBus = new EventBus();
  const queueManager = new QueueProcessorManager();
  // PROP-102: процессор очереди персистит пользовательские сообщения — его
  // точка записи инкрементирует `activity.messages_user`.
  queueManager.setAnalytics(analytics);

  // ADR-094: доменные коллекторы. `metrics` приходит только при
  // `metrics.enabled=true` — иначе реестр остается пустым (`/metrics` → 404).
  // Фоновые таймеры `unref`-ятся; остановка — `stopMetricsCollectors` на
  // graceful shutdown (`app.ts` / `main.ts`).
  const stopMetricsCollectors: Array<() => void> = [];
  // ADR-094: доменные хуки (колбэки сервисов) — создаются только при включённых метриках.
  const schedulerJobMetrics = metrics ? createSchedulerMetrics(metrics) : undefined;
  const webhookDeliveryMetrics = metrics ? createWebhookMetrics(metrics) : undefined;
  const eventMetrics = metrics ? createEventMetrics(metrics) : undefined;
  if (metrics) {
    stopMetricsCollectors.push(attachBusMetrics(metrics, eventBus));
    stopMetricsCollectors.push(startSessionMetrics(metrics, sessionManager));
    stopMetricsCollectors.push(
      startStorageMetrics(metrics, {
        sessions: fileStore,
        projects: projectStore,
        providers: providerStore,
        models: modelStore,
        agents: agentStore,
        webhooks: webhookStore,
        schedules: scheduleStore,
        eventBindings: eventBindingStore,
        eventRoutes: routeRuleStore,
        dataDir,
        backend: storageContext.kind,
        degraded: () => Boolean(storageContext.degraded),
      }),
    );
    stopMetricsCollectors.push(registerDecisionMetrics(metrics));
    // ADR-094: размер журнала внешних событий (фон, раз в 5 минут).
    stopMetricsCollectors.push(startEventJournalMetrics(metrics, eventJournal));
  }

  // ADR-052 (этап II): исходящие webhooks — реестр подписок (signing-секрет
  // шифруется at-rest мастер-ключом), журнал доставок и движок над EventBus.
  const webhooksConfig: WebhooksConfig = {
    enabled: config.webhooksConfig?.enabled ?? false,
    maxAttempts: config.webhooksConfig?.maxAttempts ?? 5,
    timeoutMs: config.webhooksConfig?.timeoutMs ?? 10_000,
    deliveryRetentionDays: config.webhooksConfig?.deliveryRetentionDays ?? 30,
  };
  const webhookService = new WebhookService({
    store: webhookStore,
    deliveryStore: webhookDeliveryStore,
    eventBus,
    // ADR-094: исходящие доставки (ok/error/blocked + retries/duration).
    onDelivery: webhookDeliveryMetrics,
    config: {
      ...webhooksConfig,
      // Отдельный экземпляр политики (граница доверия не смешивается с tools).
      resolvePolicy: () => egressResolver.resolveWebhooks(),
    },
  });
  if (!storageDegraded) webhookService.start();
  const stopWebhookDeliveryPruner = storageDegraded
    ? () => {}
    : startWebhookDeliveryPruner(webhookDeliveryStore, {
        getRetentionDays: () => webhooksConfig.deliveryRetentionDays,
      });

  // ADR-089 (standalone): единая нормализация legacy-владельца при чтении — id
  // профиля `local` (UUID, созданный до фикса резолвера внешней идентичности)
  // трактуется как `local` (списки/доступ по id/WS-подписка). Read-only:
  // профиль не создаётся (`getProfileByUsername`), файлы сессий не перезаписываются.
  const localOwnerResolver = createLocalOwnerResolver({
    localUserId: LOCAL_USER_ID,
    resolveLocalProfileId: async () =>
      (await profilesStore.getProfileByUsername('local'))?.id ?? null,
  });
  const contextBuilder = new ContextBuilder(contextConfig, {
    profilesStore,
    projectDataDir: `${dataDir}/projects`,
    defaultLanguage: 'ru',
  });

  const providerCache = new Map<string, ProviderConfig>();
  (await providerStore.list()).forEach((p) => {
    providerCache.set(p.name, p);
  });

  const modelCache = new Map<string, ModelConfig>();
  (await modelStore.list()).forEach((m) => {
    modelCache.set(m.id, m);
  });

  // Гибрид: remote-провайдер/модели инъектируются в кэши в applyConnected()
  // (после успешного runtime-подключения), а не при создании приложения.

  // Загрузчик провайдеров для движка: при политике remoteLlm=server разрешены
  // ТОЛЬКО зеркала серверных провайдеров (blockLocalProviders ставится в
  // applyConnected); при remote.llm=local локальные провайдеры остаются доступны.
  const providerLoader = (name: string): ProviderConfig | null => {
    if (accessors.isBlockLocalProviders() && accessors.getActiveRemoteProviderNames().size > 0
      && !accessors.getActiveRemoteProviderNames().has(name)) return null;
    return providerCache.get(name) ?? null;
  };

  // Загрузчик сохранённого контекстного окна модели (ModelConfig.contextWindow)
  const modelWindowLoader = (modelName: string): number => {
    for (const m of modelCache.values()) {
      if (m.name === modelName || m.id === modelName) {
        return m.contextWindow && m.contextWindow > 0 ? m.contextWindow : 0;
      }
    }
    return 0;
  };

  const summarizationConfig: SummarizationConfig = {
    provider: '',
    model: '',
    temperature: 0.3,
    promptFile: 'SUMMARIZER',
  };
  const contextOptimizer = new ContextOptimizer(contextConfig, providerLoader, summarizationConfig, modelWindowLoader);
  queueManager.setContextOptimizer(contextOptimizer);

  const modelPriceLoader = (modelName: string) => {
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

  const toolRegistry = createToolRegistry();
  const agentRegistry = createAgentRegistry(toolRegistry, join(dataDir, 'agents'));

  // ADR-046: сервис скиллов — discovery (instance/project/config.paths) + запись
  // instance-дерева + каталог в промпт и тул `skill`.
  const skillService = new SkillService({
    dataDir,
    configPaths: config.skillsConfig?.paths,
    urls: config.skillsConfig?.urls,
    trustedProjectDirs: config.skillsConfig?.trustedProjectDirs,
    toolsets: config.skillsConfig?.toolsets,
  });

  // ADR-046 §4.2/§4.3: read-only индексация skills.urls — фоном, старт не блокируем.
  void skillService.refreshRemote().catch(() => {});

  // ADR-092: авто-миграции схемы данных при старте — с обязательной страховочной
  // копией и под межпроцессным локом. Миграция снапшотов скоупа — зарегистрированная
  // миграция реестра (`session-scope-snapshots-v1`, маркер внутри сохранён → no-op
  // при повторном запуске), отдельный прямой вызов больше не нужен.
  // Fail-closed: ошибка копии/миграции не глушится — старт прерывается.
  // PROP-032 (W5): в деградации миграции не применяем — фоллбек-каталог пуст,
  // а страховочная копия/миграция были бы доменной записью в фоллбек.
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
        mcpDefaultOn: Object.entries(config.mcpServers ?? {})
          .filter(([, cfg]) => cfg.enabledByDefault === true)
          .map(([name]) => name),
        skillsDefaultOn: (await resolveProjectSkillSeed(
          skillService,
          await settingsStore.getSkillsDisabledForNewProjects(),
        )).enabled,
      }),
    });
  }

  // ADR-046 §7: slash-команды и bundles — единый резолвинг в core (UI/CLI/гибрид).
  const commandService = new CommandService({
    config: {
      dataDir,
      commandsPaths: config.commandsConfig?.paths ?? [],
      bundlesPath: config.commandsConfig?.bundlesPath ?? 'skill-bundles',
      conflict: config.commandsConfig?.conflict ?? { mode: 'bundle-wins', namespacePrefix: false },
      maxArgumentsLength: config.commandsConfig?.maxArgumentsLength ?? 10_000,
      maxRenderedBytes: config.commandsConfig?.maxRenderedBytes ?? 200_000,
      toolsets: config.skillsConfig?.toolsets ?? {},
      trustedProjectDirs: config.skillsConfig?.trustedProjectDirs,
      inlineShell: config.skillsConfig?.inlineShell ?? false,
    },
    skillRuntime: skillService,
    skillSource: skillService,
    bundleStore,
  });

  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    hooks,
    // PROP-102: сборщик `usage`/`decision` роллапов (write-path).
    analytics,
    contextBuilder,
    contextConfig,
    providerLoader,
    contextOptimizer,
    modelPriceLoader,
    dataDir,
    toolRegistry,
    agentRegistry,
    projectStore,
    // Онбординг: тул `profile_update` сохраняет ответы интервью в профиль.
    profilesStore,
    // ADR-076 §T6: тот же store, что у git-роутов — без дублей инстансов.
    sshKeyStore,
    // PROP-032 (W2.4): словари классификации — порт из контекста хранения.
    dictionaryStore,
    defaultWorkingDir,
    workspacesRoot: config.workspacesRoot ?? join(dataDir, 'workspaces'),
    // ADR-075: тулы проекта (workspace) читают live-политику вне root.
    getWorkspaceOutsideRootPolicy: async () =>
      (await settingsStore.getWorkspacePolicy()) ?? config.workspaceOutsideRootPolicy ?? 'confirm',
    permissionConfig: config.permissionConfig,
    defaultPlanMode: config.defaultPlanMode,
    securityConfig: effectiveSecurityConfig,
    gatewayConfig,
    gatewayPatternStore: patternStore,
    // ADR-094: реестр метрик (только при `metrics.enabled`) — LLM-вызовы
    // сессий учитываются и при выключенном LLM Gateway.
    metrics,
    mcpManager,
    cachePolicy: config.llmCachePolicy,
    toolsPolicy: effectiveToolsPolicy,
    mcpPolicy: effectiveMcpPolicy,
    toolsDisabled: effectiveToolsDisabled,
    // ADR-046 §4.5: системный hard-gate скиллов (runtime-настройка).
    skillsDisabled: effectiveSkillsDisabled,
    // ADR-070 §2.9.1: зависимости окружения (git/rg/sh) — детекция при старте,
    // fail-open при ошибке. Пробинг идёт до сборки оркестратора, чтобы первый
    // же запрос видел корректную доступность.
    runtimeDeps: await detectRuntimeDeps(),
    // ADR-071 §2.6: калибровка chars-per-token по модели (runtime-настройки).
    tokenRatioLoader: (model) => settingsStore.getTokenRatio(model),
    onTokenRatioCalibrated: (model, ratio) => settingsStore.setTokenRatio(model, ratio),
    // ADR-046 §5: каталог скиллов в промпт + тул `skill`.
    skillRuntime: skillService,
    // ADR-046 §7: резолвинг `/`-команд до LLM.
    commandRuntime: commandService,
    // ADR-069 Фаза 1: проектные инструкции (merged chain AGENTS.md).
    instructionsConfig: config.instructionsConfig,
    // ADR-069 Фаза 2a: project-trust гейт инструкций (config.skills.trustedProjectDirs).
    instructionsTrustedProjectDirs: config.skillsConfig?.trustedProjectDirs,
    // ADR-084: decision-слой микро-каскада (config.decision). Runtime-обновление —
    // через `setDecisionConfig` (Ф5).
    decisionConfig: effectiveDecisionSettings,
    // ADR-089: late-bound funnel создания сессий для тула `task` (саб-агент).
    // Сам сервис создаётся ниже (после оркестратора) — геттер читает его в рантайме.
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
  // событий — на следующих этапах. Сторы bindings/ключей/журнала/правил/claim —
  // из единого контекста хранения (собраны выше).
  // ADR-089 (Блок 3): runtime-настройки «События» (админка) поверх config.yaml.
  // Эффективные значения — единый источник для Router/funnel/pruner/роутов;
  // live-изменяются через `onEventsChange` без рестарта.
  const runtimeEvents = await settingsStore.getEvents();
  const effectiveEvents = mergeEventsConfig(config.eventsConfig, runtimeEvents);
  let effectiveEventsSettings = effectiveEvents;
  const eventRouter = new EventRouter({
    bindingStore: eventBindingStore,
    journal: eventJournal,
    hooks,
    dedupStore,
    // ADR-094: решения Router (kind; `bind` → `bound`).
    metrics: eventMetrics,
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
  // ADR-051 (срез) / ADR-089: правило маршрутизации cron-событий по расписанию.
  eventRouter.registerRuleProvider(
    new SchedulerRuleProvider(scheduleStore, effectiveEvents.ephemeralTtl),
  );
  // ADR-089: правила маршрутизации по матчу события (после scheduler — приоритет
  // cron-правила при совпадении).
  eventRouter.registerRuleProvider(
    new ProjectRuleProvider(routeRuleStore, effectiveEvents.ephemeralTtl),
  );
  // ADR-084 × ADR-089: decision-маршрутизация при промахе декларативных правил
  // (opt-in `events.decisionRouting`). Провайдер fail-safe: ошибка/низкая
  // уверенность → `null`, Router идёт к фоллбеку. Конфиги и агенты читаются
  // геттерами — `/settings/events` подхватывается live без рестарта.
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
      // PROP-102: персистентные decision-метрики (ось provider/model).
      analytics,
    }),
  );
  // ADR-089: резолвинг `agentTemplate` (события/правила) через `AgentRegistry`:
  // неизвестный или отключённый агент → `null`.
  const resolveAgentTemplate = (template: string): string | null => {
    const agent = agentRegistry.get(template);
    return agent && agent.enabled ? agent.id : null;
  };
  // ADR-089: резолвер внешнего отправителя (профиль `identities`, principalId) в
  // пользователя инстанса; override `identityMap` — приоритетнее профиля.
  // `getIdentityMap` читает актуальное значение (live-обновление runtime-настройки).
  // Вынесен в локальную константу: переиспользуется в `deps` и в `deliver`
  // (attribution: `displayName` человека приоритетнее имени из `payload.from`).
  // ADR-089 (standalone): `localUserId: 'local'` — единственный человек-владелец
  // инстанса (паритет с `resolveUserId`/WS-подпиской `local`). Без этого
  // сопознанный отправитель становился владельцем-профильным UUID, и сессия
  // выпадала из `listSessions({ userId: 'local' })` (список/`GET /:id`/WS).
  const resolveExternalIdentity = createExternalIdentityResolver({
    profiles: profilesStore,
    getIdentityMap: () => effectiveEventsSettings.identityMap,
    localUserId: 'local',
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
    // подтверждения владения идентичностью. `provider`/`externalId` берутся из
    // `identity.principalId` (серверный разбор), стор — `IdentityClaimStore`.
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
    // ADR-089: владелец сессий, материализуемых внешним событием (ephemeral/bind) —
    // `local` (паритет с `POST /api/v2/sessions`, `resolveUserId` core). Без этого
    // такие сессии не имели владельца и выпадали из `listSessions({ userId })`.
    resolveOwnerId: () => 'local',
    // ADR-089: дефолтные provider/model инстанса — чтобы сессия из внешнего события
    // (напр. Telegram-шлюз) могла ответить без ручной проставки модели.
    // Приоритет: runtime-пара «Модели» (provider+model), затем config.yaml
    // (llm.defaultProvider/defaultModel). Явные значения сессии — выше (funnel).
    resolveLlmDefaults: async () => {
      const pair = await settingsStore.getDefaultModel();
      if (pair) return { provider: pair.provider, model: pair.model };
      return {
        provider: config.llmDefaults?.provider,
        model: config.llmDefaults?.model,
      };
    },
    // ADR-089: агент по умолчанию инстанса — чтобы сессия из внешнего события
    // (auto-bind/bind/ephemeral) фиксировала `settings.agentRole` и UI рисовал
    // бейдж агента (паритет с `POST /api/v2/sessions`). Источник — админка
    // «Агенты» (`getDefaultAgentId`) поверх `DEFAULT_AGENT_ID`.
    resolveDefaultAgent: getDefaultAgentId,
    // ADR-089: standalone-паритет с managed — уведомляем WS-хаб (`/ws/events`) о
    // материализованной сессии **до** доставки события, чтобы клиенты владельца,
    // подключённые раньше, получали её события (иначе подписка-снимок при
    // `connect` новые сессии не покрывала). Владелец нормализуется (legacy-UUID
    // профиля `local` → `local`) — тот же резолвер, что у списков/доступа.
    onSessionMaterialized: accessors.onSessionMaterialized
      ? async (session: Session) => {
          const owner = await localOwnerResolver.normalizeOwner(
            session.ownerId ?? session.userId,
          );
          if (owner) await accessors.onSessionMaterialized!(owner, session.id);
        }
      : undefined,
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
      // ADR-089 (этап 5): эффективные роли отправителя — в metadata хода
      // (permission-слой роль-оси пока не имеет; роли доступны для аудита/UI и
      // будущего enforcement, см. `engine/events/identity-roles.ts`).
      if (context) {
        message.metadata = {
          ...(message.metadata ?? {}),
          effective_roles: context.roles,
          identity_linked: context.linked,
        };
      }
      if (mode === 'run') {
        // Запускает процессор (постановка + старт) — как обычный user-промпт.
        // ADR-036: обфускация user-сообщения ДО сохранения в историю (паритет с
        // prompt-путём — routes/sessions.ts).
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
  const eventIngress = new EventIngress({ requestSessionService, metrics: eventMetrics });

  // ADR-051 (срез) / ADR-089: планировщик публикует cron-события через ingress.
  // `start()` гейтится конфигом; остановка — на shutdown (`stopScheduler`).
  const schedulerTickMs = (config.schedulerConfig?.tickSec ?? 60) * 1000;
  // PROP-032: `leaderElection=postgres` требует advisory-локов backend'а
  // (`storage.backend=postgres`); иначе — предупреждение и AlwaysLeader.
  if (config.schedulerConfig?.leaderElection === 'postgres' && !storageContext.locks) {
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
    catchUp: config.schedulerConfig?.catchUp ?? 'skip',
    jobRetentionDays: config.schedulerConfig?.jobRetentionDays ?? 30,
    // ADR-094: завершённые Job (outcome + дрейф cron).
    onJob: schedulerJobMetrics,
    // ADR-051/ADR-089/PROP-032: тикер стартует только у лидера (default —
    // AlwaysLeader). `file` — файловый лок на общем dataDir, `postgres` —
    // session-level advisory-lock драйвера (доступен только при PG-backend).
    leader:
      config.schedulerConfig?.leaderElection === 'file'
        ? new FileLeader({ dataDir, tickMs: schedulerTickMs })
        : config.schedulerConfig?.leaderElection === 'postgres' && storageContext.locks
          ? storageContext.locks.createLeader({ name: 'scheduler/leader', tickMs: schedulerTickMs })
          : new AlwaysLeader(),
  });
  if (config.schedulerConfig?.enabled !== false && !storageDegraded) {
    void schedulerService.start().catch((err) => {
      console.warn(`[scheduler] не удалось запустить: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return {
    dataDir,
    // PROP-032: контекст хранения инстанса — для операций, которым нужен
    // целиком (напр. портативный экспорт/импорт проекта, ADR-091).
    storageContext,
    // ADR-094: реестр метрик (доменные коллекторы подключены выше).
    metrics,
    // ADR-094: остановка фоновых коллекторов (graceful shutdown).
    stopMetricsCollectors,
    settingsStore,
    // PROP-032 (W2.3): умолчания оформления из контекста хранения (паритет с backend).
    defaultsStore,
    getDefaultAgentId,
    defaultWorkingDir,
    /** ADR-075: начальная политика workspace вне root (config/env + runtime-override). */
    workspaceOutsideRootPolicy: effectiveWorkspaceOutsideRootPolicy,
    protectedPathsStore,
    projectStore,
    sessionManager,
    stopEphemeralSweeper,
    // ADR-076: тот же store, что у git-роутов и оркестратора — без дублей инстансов.
    sshKeyStore,
    // PROP-032 (W2.4): конфигурационные словари и реестр service-key — из контекста.
    dictionaries: dictionaryStore,
    serviceApiKeyStore,
    providerStore,
    modelStore,
    agentStore,
    mcpManager,
    eventBus,
    queueManager,
    webhooksConfig,
    // Egress: живой резолвер политики + журналы безопасности.
    egressResolver,
    egressLogConfig,
    securityAudit,
    egressRequests,
    // PROP-102 (волна 1): порт пред-агрегированных роллапов аналитики — для роутов отчётов.
    analyticsRollups,
    // PROP-102: write-path — сборщик роллапов (+ остановка детачей hook-подписки и pruner'а).
    analytics,
    detachAnalyticsHooks,
    stopAnalyticsRollupPruner,
    stopEgressLogPruner,
    webhookStore,
    webhookDeliveryStore,
    webhookService,
    stopWebhookDeliveryPruner,
    profilesStore,
    // ADR-089 (standalone): резолвер локального владельца — нормализация
    // legacy-UUID профиля `local` (списки/доступ/WS-подписка).
    localOwnerResolver,
    providerCache,
    modelCache,
    modelWindowLoader,
    contextOptimizer,
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
    schedulerService,
    resolveAgentTemplate,
    requestSessionService,
    eventIngress,
    /** ADR-089: live-настройки раздела «События» (читают роуты, пишет `onEventsChange`). */
    getEventsSettings: () => effectiveEventsSettings,
    setEventsSettings: (value: typeof effectiveEventsSettings) => { effectiveEventsSettings = value; },
    /** ADR-084: live-настройки decision-слоя (пишет `onDecisionChange`). */
    setDecisionSettings: (value: typeof effectiveDecisionSettings) => { effectiveDecisionSettings = value; },
  };
}

/** Тип собранных зависимостей standalone-core. */
export type StandaloneDeps = Awaited<ReturnType<typeof createStandaloneDeps>>;
