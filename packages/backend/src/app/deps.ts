// Сборка зависимостей backend: хранилища, менеджеры, оркестратор, событийное
// ядро (ADR-089), планировщик (ADR-051), webhooks (ADR-052), скиллы/команды
// (ADR-046), runtime-настройки (ADR-005/023).
// Вынесено из `app.ts` (ADR-095, шаг 4b) — «вынос по швам», без изменения поведения.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ProviderConfig, ModelConfig, ToolsDisabledConfig, WebhooksConfig,
  SummarizationConfig, DecisionConfig, Message,
} from '@itphx/synth-shared';
import {
  ensureDataDir, parsePrincipalId, resolveDefaultWorkspace, resolveSecretKey, resolveStorageBackend,
  resolvePostgresConfig, resolvePostgresPassword, resolveDegradedMode, resolveStorageFallbackDir,
  resolveExecutionConfig,
  readTlsRuntimeSettings,
  SYNTH_VERSION,
} from '@itphx/synth-shared';
import type { ResolvedExecutionConfig } from '@itphx/synth-shared';
import {
  SessionManager, EventBus, QueueProcessorManager,
  ContextBuilder, ContextOptimizer, ChatOrchestrator,
  enqueueUserMessage,
  createToolRegistry, createAgentRegistry, McpManager,
  DEFAULT_AGENT_ID, registerStoredAgents,
  AuditLogger, mergeLlmGatewayConfig, mergeSecurityConfig,
  mergeEventsConfig, mergeDecisionConfig, mergePluginsConfig,
  createEgressPolicyResolver, createEgressLogSink,
  configureEgressRuntime, startEgressLogPruner,
  // ADR-105 (Ф3): источник access-токена для MCP-коннекторов + OAuth-сервис.
  OAuthCredentialService, OAuthProviderRegistry, registerOAuthProvidersFromConfig,
  createRepositoryCredentialSource,
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
  PipelineTracker,
  SchedulerRuleProvider, SchedulerService, AlwaysLeader, FileLeader,
  createExternalIdentityResolver,
  startEventJournalPruner,
  // Этап 1 roadmap 0.13 (блок 3): сервис вопросов пользователю + retention.
  QuestionService,
  startQuestionPruner,
  // Этап 1 roadmap 0.13 (блок 4): реестр фоновых прогонов + retention.
  BackgroundRunService,
  startBackgroundRunPruner,
  createBackgroundParentNotifier,
  // PROP-097 (блок 5b): сервис фоновых шелл-процессов + retention логов.
  ProcessService,
  startProcessLogPruner,
  // ADR-114: сервис worktree'ов (per-session рабочий каталог) + публикация
  // `worktree.updated` в каналы сессий проекта.
  WorktreeService,
  publishWorktreeUpdated,
  WebhookService, startWebhookDeliveryPruner,
  AnalyticsRecorder, attachAnalyticsActivityHooks, startAnalyticsRollupPruner, sessionAxes,
  createStorageContextAsync,
  initTlsTrust,
  applyStartupProxyConfig,
  attachBusMetrics,
  startSessionMetrics,
  startStorageMetrics,
  // ADR-094/PROP-047: метрики памяти (`synth_memory_*`).
  startMemoryMetrics,
  // ADR-107: телеметрия контекста памяти и recall (`synth_memory_context_*`,
  // `synth_memory_recall_*`).
  createMemoryTelemetry,
  registerDecisionMetrics,
  createSchedulerMetrics,
  // ADR-094/ADR-077: метрики пула исполнителей (`synth_executor_*`).
  createExecutorMetricsCollector,
  createWebhookMetrics,
  createEventMetrics,
  // ADR-106 Ф1/Ф2: счётчик решений Authority-слоя (`synth_authority_decisions_total`)
  // и guard-слоя (решение считается; в enforced-режиме — применяется).
  createAuthorityMetrics,
  AuthorityGuard,
  // ADR-106 Ф3: реестр подтверждений + покрытие (носитель покрывающего гранта).
  ApprovalRegistry,
  buildApprovalResponderProfile,
  createApprovalCoverageResolver,
  startEventJournalMetrics,
  // ADR-101 (Э5): движок пайплайнов, исполнители шагов, обработчики выходов.
  PipelineEngine,
  // ADR-101: реестр активных прогонов (soft-lock + отмена) — общий экземпляр
  // для HTTP-роута пайплайнов и встроенных тулов агента.
  PipelineRunControl,
  createToolStepExecutor,
  createScriptStepExecutor,
  createHumanStepExecutor,
  createAgentStepExecutor,
  createPipelineExitHandler,
  createPipelineMetrics,
  ensureBuiltinPipelines,
  toCoreProviderConfig,
  ProviderFactory,
  // ADR-077: порт исполнения команд (inline/remote).
  createExecutionPortForConfig,
  // ADR-090 (Ф3а) / §5, §10 (Ф5б-1): общий реестр
  // блоков промпта (композер + фасад плагинов) и рантайм плагинов.
  PromptBlockRegistry,
  PluginRuntime,
  PluginProcessManager,
  PluginFacadeError,
  createInlinePluginLoader,
  createRemotePluginLoader,
  resolvePluginLayout,
} from '@itphx/synth-core';
import type {
  DecisionAgentCandidate,
  EventsRuntimeSettings,
  MetricsRegistry,
  StorageContext,
  AutomationRuntime,
  BaseProvider,
  PipelinePermissionDeps,
  PipelineRunRecord,
  PluginEmbedFn,
} from '@itphx/synth-core';
import type { BackendConfig } from '../lib/app-config.js';
import { EventHub } from '../events/hub.js';
import { seedDebugTestUsers } from './bootstrap.js';

/**
 * ADR-096 (W2.4): единая точка сборки слоя хранения backend — `app.ts` строит
 * её до `auth` (реестр `serviceKeys` нужен резолверу ключа, `mcpRegistry` —
 * сидированию instance-серверов), а `createBackendDeps` переиспользует инстанс.
 */
export async function createBackendStorage(config: BackendConfig): Promise<StorageContext> {
  // ADR-099: единый механизм доверия TLS/CA — применяем **до** первого исходящего
  // запроса (сборка хранилища/PG, дискавери OIDC, сид провайдеров из env ниже).
  // Вызывается в начале `createBackendApp` (env-оверрайды уже выставлены).
  // Fail-closed: битый/отсутствующий CA останавливает старт (не тихий фоллбэк).
  // ADR-099: bootstrap runtime-настройки TLS читаются до подключения к PG и
  // передаются и в initTlsTrust, и драйверу (per-host mTLS по host БД).
  const tlsRuntime = readTlsRuntimeSettings(config.dataDir);
  await initTlsTrust(
    { security: config.synth.security, proxy: config.synth.proxy },
    process.env,
    { dataDir: config.dataDir, tlsRuntime: tlsRuntime ?? null },
  );
  const kind = resolveStorageBackend(config.synth, process.env);
  if (kind === 'memory') {
    console.warn('storage.backend=memory: данные не сохраняются на диск');
  }
  const storage = await createStorageContextAsync(kind, {
    dataDir: config.dataDir,
    secretKey: resolveSecretKey(config.synth),
    env: process.env,
    postgres: resolvePostgresConfig(config.synth, process.env),
    postgresPassword: resolvePostgresPassword({ dataDir: config.dataDir }, process.env),
    ...(config.synth.security?.tls ? { security: { tls: config.synth.security.tls } } : {}),
    ...(tlsRuntime ? { tlsRuntime } : {}),
    degradedMode: resolveDegradedMode(config.synth),
    fallbackDir: resolveStorageFallbackDir(config.synth, process.env),
    dedupStore: config.synth.events.dedupStore,
    scheduleCrossProcess: config.synth.scheduler.crossProcessLocks,
    bundlesPath: config.synth.commands.bundlesPath,
    // ADR-090: путь lock-файла плагинов задаёт раскладка (композиционный
    // корень) — `<home>/plugin/plugins.lock.json` либо `{dataDir}/plugin/…`.
    // Резолвер один — `resolvePluginLayout` (его же использует `PluginRuntime`),
    // поэтому порт и каталоги установки согласованы.
    pluginLockPath: resolvePluginLayout({ dataDir: config.dataDir, env: process.env }).lockPath,
  });
  // ADR-099: второй шаг egress — runtime-override прокси после хранилища и до
  // создания deps/провайдеров (TLS/PG уже применены ранним `initTlsTrust`).
  await applyStartupProxyConfig(
    storage.settings,
    { proxy: config.synth.proxy },
    process.env,
    { dataDir: config.dataDir },
  );
  return storage;
}

/**
 * Собрать зависимости backend-приложения (хранилища/менеджеры/оркестратор/
 * событийное ядро/планировщик/webhooks). Роуты монтирует вызывающий
 * (`mountBackendRoutes`), поэтому здесь нет ни одного `app.*`-вызова.
 */
export async function createBackendDeps(
  config: BackendConfig,
  storage?: StorageContext,
  metrics?: MetricsRegistry,
  /**
   * ADR-077: эффективная секция `execution` (режим исполнения + параметры
   * удалённого исполнителя). Не задана — резолвится из конфигу инстанса.
   */
  executionConfig?: ResolvedExecutionConfig,
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

  // ADR-096 (W2.3/W2.4): единый контекст хранения — домен получает порты из
  // одного места. По умолчанию собирается `createBackendStorage`, готовый можно
  // передать (паритет с `app.ts`, где `serviceKeys`/`mcpRegistry` нужны до `auth`).
  const storageContext = storage ?? (await createBackendStorage(config));
  // ADR-098 (W5): деградированное хранилище (postgres недоступен → файловый
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
    analyticsRollups,
    // ADR-051/ADR-100: реестр пайплайнов; ADR-086 §5: реестр установок пакетов.
    pipelines: pipelineStore,
    packs: packStore,
  } = storageContext;

  // ADR-101: реестр активных прогонов пайплайнов — **один на процесс**.
  // Его получают и HTTP-роут пайплайнов, и встроенные тулы агента: поэтому
  // soft-lock «не запустить второй прогон того же пайплайна» и отмена
  // идущего прогона работают одинаково для обоих контуров.
  const pipelineRunControl = new PipelineRunControl();

  // ADR-101/ADR-051: рантайм автоматизации для встроенных тулов
  // (`pipeline_*`/`schedule_*`). Движок пайплайнов и шедулер создаются
  // **ниже** (после оркестратора), поэтому объект заполняется по мере сборки,
  // а оркестратор получает late-bound геттер (`engine/tools/automation-runtime.ts`).
  const automationRuntime: AutomationRuntime = {
    pipelines: storageContext.projectPipelines,
    runs: storageContext.pipelineRuns,
    runControl: pipelineRunControl,
    templates: pipelineStore,
    schedules: scheduleStore,
    jobs: jobStore,
  };

  // ADR-030: ядровая шина хуков — общий инстанс для SessionManager и оркестратора.
  const hooks = new HookBus();
  // ADR-102: сборщик роллапов аналитики (write-path) — только через порт слоя
  // хранения; в деградации выключен (не пишем домен в файловый фоллбек).
  const analytics = storageDegraded ? undefined : new AnalyticsRecorder({ repo: analyticsRollups });
  const sessionManager = new SessionManager(fileStore, {
    projectStore,
    hooks,
    // ADR-102: точка персиста сообщений (`messages_assistant`/`messages_tool`).
    analytics,
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
  // ADR-102: шов записи `activity` через hook-шину (ADR-030) + retention суточных
  // роллапов (prune на старте и каждые 6 ч, таймер `unref`).
  const detachAnalyticsHooks = analytics
    ? attachAnalyticsActivityHooks(hooks, {
        recorder: analytics,
        resolveSessionAxes: async (sessionId) =>
          sessionAxes(await sessionManager.getSession(sessionId)),
      })
    : () => {};
  const stopAnalyticsRollupPruner =
    storageDegraded || !analytics
      ? () => {}
      : startAnalyticsRollupPruner(analyticsRollups, {
          getRetentionDays: () => config.synth.analytics.retentionDays,
        });

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

  // ADR-105 (Ф3): коннекторы с `auth.kind='credential'` авторизуются токеном
  // из слоя доступов (подстановка в транспорт, refresh при 401).
  const oauthProviders = new OAuthProviderRegistry();
  // Каталог OAuth-провайдеров из конфига инстанса (`oauth.providers`): без него
  // refresh живого доступа не работает — провайдера не найти.
  await registerOAuthProvidersFromConfig(oauthProviders, config.synth.oauth.providers, {
    dataDir,
  });
  const oauthCredentialService = new OAuthCredentialService({
    repo: storageContext.externalCredentials,
    clientFor: (provider: string) => oauthProviders.clientFor(provider),
    // ADR-105 (Ф4): журнал операций со слоем доступов (append-only).
    audit: storageContext.credentialAudit,
  });
  mcpManager.setCredentialSource(
    createRepositoryCredentialSource({
      repo: storageContext.externalCredentials,
      refresh: async (credentialId: string) => {
        await oauthCredentialService.refresh(credentialId);
      },
      // ADR-105 (Ф4): подстановка токена в транспорт журналируется (`use`).
      audit: storageContext.credentialAudit,
    }),
  );

  // Сидирование тестовых пользователей (debug mode) — до построения рантайма
  // (паритет с прежним `app.ts`: сид стоял между хранилищами и рантаймом).
  seedDebugTestUsers(profilesStore, config.auth);

  const eventBus = new EventBus();
  const queueManager = new QueueProcessorManager();
  // ADR-102: пользовательские сообщения персистит процессор — мера `messages_user`.
  queueManager.setAnalytics(analytics);

  // Этап 1 roadmap 0.13 (блок 3): сервис «вопрос пользователю» (`ask_user`).
  //
  // Паритет с standalone-core: тот же порт записи (ADR-096), тот же срок
  // ожидания ответа из конфигурации `questions.timeoutMs` (`0` — без
  // таймаута). Один инстанс на процесс: его получают и оркестратор (тул
  // `question`), и HTTP-роуты сессий.
  const questionService = storageDegraded
    ? undefined
    : new QuestionService({
        repository: storageContext.questions,
        eventBus,
        timeoutMs: config.synth.questions.timeoutMs,
      });
  // Старт: открытые вопросы прошлого процесса не пережили рестарт (ожидание
  // в памяти) — снимаем их с причиной `interrupted`. Best-effort: ошибка не
  // роняет старт.
  if (questionService) {
    try {
      await questionService.recoverOnStart();
    } catch (err) {
      console.warn(
        `[questions] восстановление открытых вопросов не удалось: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Retention-очистка терминальных записей вопросов (сразу + каждые 6 ч).
  const stopQuestionPruner = storageDegraded
    ? () => {}
    : startQuestionPruner(storageContext.questions, {
        getRetentionDays: () => config.synth.questions.retentionDays,
      });

  // Этап 1 roadmap 0.13 (блок 4): единый реестр фоновых прогонов (PROP-096).
  //
  // Паритет с standalone-core: тот же порт записи (ADR-096), те же лимиты из
  // конфигурации `background.*`. Один инстанс на процесс: его получают тул
  // `task` (фоновый запуск саб-агента) и HTTP-точки обслуживания реестра.
  //
  // Уведомление родителя о завершении фонового прогона (ADR-111): ОДИН путь —
  // постановка в очередь (`enqueueUserMessage`); процессор добавит сообщение в
  // историю сам и опубликует `message.added` (двух копий больше нет).
  // `processMessage` собирается ниже (после оркестратора) — нотификатор
  // создаётся лениво, при первом вызове колбэка (он приходит только из
  // фонового прогона, т.е. уже после старта).
  let backgroundNotifier: ReturnType<typeof createBackgroundParentNotifier> | null = null;
  const notifyBackgroundParent = async (
    sessionId: string,
    message: Message,
  ): Promise<void> => {
    backgroundNotifier ??= createBackgroundParentNotifier({
      sessionManager,
      eventBus,
      processorManager: queueManager,
      processMessage,
    });
    await backgroundNotifier(sessionId, message);
  };
  const backgroundService = storageDegraded
    ? undefined
    : new BackgroundRunService({
        repository: storageContext.backgroundRuns,
        eventBus,
        limits: {
          maxSubagentsPerSession: config.synth.background.maxSubagentsPerSession,
          // PROP-097: лимит одновременных фоновых шелл-процессов на сессию.
          maxProcessesPerSession: config.synth.background.maxProcessesPerSession,
          maxRunsPerSession: config.synth.background.maxRunsPerSession,
        },
        // Точка сборки уведомления — здесь (глобальных синглтонов нет).
        //
        // ADR-036: обфускация user-сообщений НЕ применяется — уведомление
        // системное (автор `Subagent`/`Process`), а не пользовательский ввод;
        // секреты в исходящих LLM-запросах обфусцирует сам Gateway.
        onNotifyParent: notifyBackgroundParent,
      });
  // Старт: прогоны прошлого процесса не пережили рестарт (хэндлы отмены — в
  // памяти) — помечаем их `orphaned`. Best-effort: ошибка не роняет старт.
  if (backgroundService) {
    try {
      await backgroundService.recoverOnStart();
    } catch (err) {
      console.warn(
        `[background] восстановление фоновых прогонов не удалось: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Retention-очистка терминальных записей реестра (сразу + каждые 6 ч).
  const stopBackgroundRunPruner = storageDegraded
    ? () => {}
    : startBackgroundRunPruner(storageContext.backgroundRuns, {
        getRetentionDays: () => config.synth.background.retentionDays,
      });
  // PROP-097 (блок 5b): retention логов фоновых процессов. Создаётся **до**
  // pruner'а записей реестра: лог удаляется, пока его запись ещё видна.
  const stopProcessLogPruner = storageDegraded
    ? () => {}
    : startProcessLogPruner(storageContext.backgroundRuns, storageContext.blobs, {
        getRetentionDays: () => config.synth.background.retentionDays,
      });

  // ADR-094: доменные коллекторы. `metrics` приходит только при
  // `metrics.enabled=true` — иначе реестр остаётся пустым (`/metrics` → 404).
  // Фоновые таймеры `unref`-ятся; остановка — `stopMetricsCollectors` на
  // graceful shutdown (`app.ts`/`main.ts`).
  const stopMetricsCollectors: Array<() => void> = [];
  // ADR-094: доменные хуки (колбэки сервисов) — создаются только при включённых метриках.
  const schedulerJobMetrics = metrics ? createSchedulerMetrics(metrics) : undefined;
  const webhookDeliveryMetrics = metrics ? createWebhookMetrics(metrics) : undefined;
  const eventMetrics = metrics ? createEventMetrics(metrics) : undefined;
  // ADR-106 Ф1: решения Authority-слоя (`synth_authority_decisions_total`) —
  // лейблы только `action`/`effect`/`source`, без id (ADR-094).
  const authorityMetrics = metrics ? createAuthorityMetrics(metrics) : undefined;
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
    // ADR-094/PROP-047: метрики памяти (`synth_memory_*`) — пересчёт на скрейпе.
    stopMetricsCollectors.push(startMemoryMetrics(metrics, {
      facts: storageContext.memoryFacts,
      indexes: storageContext.memoryIndexes,
    }));
  }

  // ADR-107: телеметрия памяти — блоки памяти в промпте хода и recall-запросы
  // плагина памяти. Метрики выключены — телеметрии нет (плагин и ход работают
  // как раньше).
  const memoryTelemetry = metrics ? createMemoryTelemetry(metrics) : undefined;

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
    // ADR-094: исходящие доставки (ok/error/blocked + retries/duration).
    onDelivery: webhookDeliveryMetrics,
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
  // ADR-098 (W5): в деградации не пишем в фоллбек.
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

  // ADR-090 (Ф3а): **один** реестр провайдеров блоков
  // системного промпта на инстанс — композер добавляет блоки в промпт сессии,
  // фасад плагинов (`PluginRuntime` → `PluginHost`) их регистрирует.
  const promptBlocks = new PromptBlockRegistry();

  // ADR-096 + ADR-086 §5: агенты из **стора** — в реестр при старте.
  // `createAgentRegistry` читает только файловый каталог `{dataDir}/agents`,
  // а при `storage.backend=postgres` стор агентов — это БД: агент, поставленный
  // пакетом расширения, после рестарта не попадал в реестр → Router не
  // резолвил `agentTemplate` (`resolveAgentTemplate` → `null`) и сессия не
  // создавалась. Merge — как в `GET /api/v2/agents` (override выигрывает).
  try {
    registerStoredAgents(agentRegistry, await agentStore.list());
  } catch (err) {
    console.warn(
      `[agents] не удалось загрузить агентов из стора: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

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

  // ADR-077: порт исполнения команд. Режим (`inline`/`remote`) — параметр
  // запуска процесса (инвариант 24), поэтому порт собирается здесь, при старте.
  // Тот же порт получают оркестратор (тулы, inline-shell, детект зависимостей)
  // и резолвер проектных инструкций.
  const execution = executionConfig ?? resolveExecutionConfig(config.synth, process.env);
  // ADR-094/ADR-077: метрики пула исполнителей (`synth_executor_*`) — приёмник
  // для клиента удалённого порта (очередь, занятость, ожидание, исход).
  const executorMetrics = metrics ? createExecutorMetricsCollector(metrics) : undefined;
  const executionPort = await createExecutionPortForConfig(
    execution,
    executorMetrics ? { metricsSink: executorMetrics } : undefined,
  );

  // PROP-097 (блок 5b): сервис фоновых шелл-процессов (паритет с standalone).
  //
  // Тот же порт исполнения, что у тулов (ADR-077): фон — это лишь способ
  // ожидания, а не отдельный путь исполнения. Учёт прогона — общий реестр
  // фоновых прогонов (`kind: 'process'`), лог — blob-хранилище (ADR-096).
  // В деградированном режиме хранилища сервиса нет (писать некуда).
  const processService = backgroundService
    ? new ProcessService({
        executionPort,
        background: backgroundService,
        blobs: storageContext.blobs,
        eventBus,
        limits: { maxLogBytes: config.synth.background.logMaxBytes },
      })
    : undefined;

  // ADR-114: сервис worktree'ов (per-session рабочий каталог).
  //
  // Один инстанс на процесс: его получают HTTP-роуты проектов
  // (`/projects/:id/worktrees*`), тулы `git_worktree_*` и привязка сессии
  // (`PATCH /sessions/:id { worktreeId }`). Порт инвентаря — из контекста
  // хранения (ADR-096); git-команды — через порт исполнения (ADR-077);
  // `onUpdated` публикует `worktree.updated` в каналы сессий проекта
  // (ADR-114 §6, ADR-024). В деградированном режиме хранилища сервиса нет
  // (писать некуда — split-brain).
  const worktreeService = storageDegraded
    ? undefined
    : new WorktreeService({
        repository: storageContext.worktrees,
        workspacesRoot: config.workspacesRoot,
        execution: executionPort,
        defaultWorkingDir,
        // Привязанная живая сессия — по полю `session.worktree` (ADR-114 §1.3).
        resolveAttachedSession: async (worktreeId: string) => {
          const sessions = await sessionManager.listSessions(undefined, { light: true });
          return sessions.find((s) => s.worktree?.worktreeId === worktreeId)?.id;
        },
        onUpdated: (projectId: string) => {
          void publishWorktreeUpdated({ eventBus, sessionStore: sessionManager }, projectId);
        },
      });

  // ADR-070 §2.9.1/ADR-101: зависимости окружения (git/rg/sh) — детекция при
  // старте, fail-open при ошибке. Общий для оркестратора и движка пайплайнов
  // (контекст шага, ADR-101 §10).
  //
  // ADR-077: проба бинарников идёт **через порт исполнения** — в split-режиме
  // они ищутся в окружении исполнителя. Порт передаётся здесь: кэш детекции
  // модульный, порт берётся из первого вызова (fail-closed в remote-режиме).
  const runtimeDeps = await detectRuntimeDeps(executionPort);

  // ADR-106 Ф1/Ф2: Authority-слой. Решение считается и пишется в журнал
  // (`{dataDir}/audit/authority.jsonl` через порт). При `authority.enabled`
  // **без** `authority.shadow` решение **применяется** (Ф2): `deny`/`ask`
  // сужают решение permission-слоя. Секция `authority` выключена по умолчанию:
  // слой считает решения только когда его явно включили.
  const authorityPolicy = (await storageContext.authorityPolicy?.getPolicy()) ?? null;
  const authorityGuard = config.synth.authority?.enabled
    ? new AuthorityGuard({
        enabled: true,
        shadow: config.synth.authority.shadow,
        journal: storageContext.authorityDecisions,
        policy: authorityPolicy,
        // ADR-094: счётчик решений Authority-слоя (`synth_authority_decisions_total`).
        onDecision: authorityMetrics?.onDecision,
      })
    : undefined;

  // ADR-106 Ф3: реестр подтверждений. Задаётся **только** в enforced-режиме
  // (слой Authority применяет решения): ответ на `permission_reply` принимает
  // лишь носитель покрывающего гранта — не «кто видит сессию» (дыра
  // «`VIEWER` подтверждает мутирующий тул»).
  const approvalRegistry = authorityGuard?.enforced
    ? new ApprovalRegistry({
        coverage: createApprovalCoverageResolver({
          policy: authorityPolicy,
          profile: async (sessionId, principal) => {
            const session = await sessionManager.getSession(sessionId);
            const project = session?.projectId
              ? await projectStore.load(session.projectId)
              : null;
            return buildApprovalResponderProfile({
              principal,
              sources: { session, project },
            });
          },
        }),
      })
    : undefined;

  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    hooks,
    // ADR-106 Ф1/Ф2: шов решения Authority-слоя (считает, журналит и —
    // в enforced-режиме — применяет решение).
    authorityGate: authorityGuard?.gate,
    // ADR-106 Ф3: реестр подтверждений (привязка к ходу + носитель гранта).
    ...(approvalRegistry ? { approvalRegistry } : {}),
    // ADR-077: порт исполнения команд (inline — исполнение в процессе).
    executionPort,
    // ADR-102: сборщик `usage`/`decision` роллапов (write-path).
    analytics,
    contextBuilder,
    contextConfig,
    providerLoader,
    contextOptimizer,
    modelPriceLoader,
    dataDir,
    toolRegistry,
    agentRegistry,
    // ADR-090: тот же реестр, что у фасада плагинов
    // (ниже, `PluginRuntime`) — блоки плагинов попадают в промпт сессии.
    promptBlocks,
    mcpManager,
    projectStore,
    // Онбординг: тул `profile_update` сохраняет ответы интервью в профиль.
    profilesStore,
    // ADR-076 §T6: тот же store, что у git/ssh-роутов — без дублей инстансов.
    sshKeyStore,
    // ADR-096 (W2.4): словари классификации — порт из контекста хранения.
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
    // ADR-090: бюджет времени фильтров LLM-вызовов
    // (`plugins.llmFilterTimeoutMs`); реестр — `orchestrator.getLlmFilters()`.
    llmFilterTimeoutMs: config.synth.plugins?.llmFilterTimeoutMs,
    // ADR-094: реестр метрик (только при `metrics.enabled`) — LLM-вызовы
    // сессий учитываются и при выключенном LLM Gateway.
    metrics,
    // ADR-107: телеметрия блоков памяти в промпте хода
    // (`synth_memory_context_*`).
    ...(memoryTelemetry ? { onMemoryContext: memoryTelemetry.recordContext } : {}),
    cachePolicy: config.synth.llm.cache,
    toolsPolicy,
    mcpPolicy,
    toolsDisabled,
    // ADR-046 §4.5: системный hard-gate скиллов (runtime-настройка).
    skillsDisabled,
    // ADR-070 §2.9.1: зависимости окружения (git/rg/sh) — детекция при старте.
    // Проба бинарников — через тот же порт исполнения (ADR-077).
    runtimeDeps: await detectRuntimeDeps(executionPort),
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
    // ADR-101/ADR-051: late-bound рантайм автоматизации для встроенных тулов
    // (`pipeline_*`/`schedule_*`) — движок пайплайнов и шедулер создаются ниже,
    // поэтому геттер отдаёт актуальный снимок в момент хода.
    getAutomationRuntime: () => automationRuntime,
    // «Стоп»: персистентный флаг отмены сессии — прерывает длинный
    // многоитерационный Tool Use на границе итерации (backoff/гонка).
    isCancelRequested: async (sid) =>
      (await sessionManager.getSession(sid))?.status.cancelRequested === true,
    // Этап 1 roadmap 0.13 (блок 3): сервис «вопрос пользователю» — тул
    // `question` задаёт вопрос и ждёт ответа пользователя.
    ...(questionService ? { questionService } : {}),
    // Этап 1 roadmap 0.13 (блок 4): единый реестр фоновых прогонов — тул
    // `task` с `background: true` регистрирует фонового саб-агента и
    // возвращает управление сразу (PROP-096).
    ...(backgroundService ? { backgroundService } : {}),
    // PROP-097: сервис фоновых шелл-процессов — тот же экземпляр, что у
    // реестра и тула `execute_shell` (через `ctx.extra.processService`).
    ...(processService ? { processService } : {}),
    // ADR-114: сервис worktree'ов — тулы `git_worktree_*` (инвентарь
    // per-session рабочих каталогов проекта).
    ...(worktreeService ? { worktreeService } : {}),
    backgroundEnabled: config.synth.background.enabled,
  });

  // ADR-090 (Ф5б-2): эффективный конфиг слоя = config.yaml (+env) поверх
  // runtime-настроек (`settings.json`/PG): админка `/api/v2/settings/plugins`
  // пишет runtime, рантайм собирается при старте (применение — рестартом,
  // инвариант 24), поэтому слияние делается **здесь**, а не в рантайме.
  const effectivePluginsConfig = mergePluginsConfig(
    config.synth.plugins,
    await settingsStore.getPlugins(),
  );

  // ADR-090 (Ф5б-1): рантайм плагинов — старт-активация установленного
  // (`plugins.lock.json` — источник истины), список со статусом активации и
  // точки `activate`/`deactivate` для HTTP API/CLI (Ф5б-2/3). Реестры — **те же**
  // экземпляры, что у оркестратора (`promptBlocks`, `getLlmFilters()`, `toolRegistry`).
  // `plugins.executionEnabled=false` (дефолт) → `activateInstalled()` — no-op.
  // Ф4б-2: транспорты исполнения плагина (`inline` — в процессе core,
  // `remote` — отдельный процесс на loopback). Менеджер процессов гасится в
  // `PluginRuntime.dispose()` при остановке инстанса.
  const pluginProcessManager = new PluginProcessManager({
    secretsDir: join(dataDir, 'secrets'),
    logger: { warn: (message: string) => console.warn(`[plugin-process] ${message}`) },
  });

  // ADR-090 (WP-F): сервис эмбеддингов фасада (`facade.embed`).
  //
  // Эмбеддинги плагина идут **тем же** путём, что и остальные LLM-вызовы:
  // провайдер создаётся `ProviderFactory`, оборачивается в `GatewayProvider`
  // (`orchestrator.wrapProviderWithGateway`) — значит, работают guard'ы,
  // обфускация, rate-limit, аудит и embedding-фаза фильтров `llmFilters`
  // (инвариант 3, ADR-036). Плагин провайдера напрямую не достаёт.
  //
  // Провайдер/модель приходят из фасада: конфиг инстанса
  // (`plugins.embeddingProvider`/`plugins.embeddingModel`) с перекрытием
  // аргументом вызова. `GatewayProvider.embed` принимает **одну** строку —
  // батча в v1 нет, поэтому цикл по текстам.
  const pluginEmbed: PluginEmbedFn = async (texts, opts) => {
    const providerName = opts?.provider?.trim() ?? '';
    if (!providerName) {
      throw new PluginFacadeError(
        'plugin.embedding_not_configured',
        'Эмбеддинги не сконфигурированы: задайте plugins.embeddingProvider ' +
          '(или передайте провайдера в вызове facade.embed).',
      );
    }
    const sharedConfig = providerLoader(providerName);
    if (!sharedConfig) {
      throw new PluginFacadeError(
        'plugin.embedding_not_configured',
        `Провайдер «${providerName}» не найден в инстансе — эмбеддинги недоступны.`,
      );
    }
    const model = opts?.model?.trim() || sharedConfig.defaultModel || '';
    const provider = orchestrator.wrapProviderWithGateway(
      ProviderFactory.create(providerName, toCoreProviderConfig(sharedConfig, model)),
    );
    const vectors: number[][] = [];
    for (const text of texts) {
      vectors.push(await provider.embed(text));
    }
    return vectors;
  };

  const pluginRuntime = new PluginRuntime({
    layout: resolvePluginLayout({ dataDir, env: process.env }),
    config: effectivePluginsConfig,
    hostVersion: SYNTH_VERSION,
    audit: storageContext.pluginAudit,
    lock: storageContext.pluginLock,
    promptBlocks,
    llmFilters: orchestrator.getLlmFilters(),
    tools: toolRegistry,
    // PROP-047 §2.1: порты памяти инстанса — фасад плагина отдаёт **scoped**
    // доступ (namespace навязывает хост). Порты обязательны в
    // `StorageContext`, поэтому сервис доступен всегда.
    memory: {
      memoryFacts: storageContext.memoryFacts,
      memoryIndexes: storageContext.memoryIndexes,
    },
    loaders: {
      inline: createInlinePluginLoader(),
      remote: createRemotePluginLoader({ processManager: pluginProcessManager }),
    },
    processManager: pluginProcessManager,
    // ADR-090 (WP-F): сервис эмбеддингов фасада — через Gateway (инвариант 3).
    embed: pluginEmbed,
    // ADR-107: телеметрия recall/search-запросов памяти
    // (`synth_memory_recall_*`).
    ...(memoryTelemetry ? { memoryTelemetry: memoryTelemetry.recordRecall } : {}),
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
      // ADR-102: персистентные decision-метрики (ось provider/model).
      analytics,
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
  // ADR-089/ADR-051: учёт экземпляров пайплайна (ADR-100) — состояние
  // автомата публикации живёт в ядре (решение владельца), add-on отдаёт
  // артефакт по id. Трекер работает через порт `storage.pipelines`.
  const pipelineTracker = new PipelineTracker({ repository: pipelineStore });
  // ADR-089: дефолтные `provider`/`model` инстанса — общий seam для funnel'а
  // сессий и движка пайплайнов (ADR-101): приоритет — runtime-пара «Модели»
  // (provider+model), затем config.yaml (llm.defaultProvider/defaultModel).
  const resolveLlmDefaults = async (): Promise<{ provider?: string; model?: string }> => {
    const pair = await settingsStore.getDefaultModel();
    if (pair) return { provider: pair.provider, model: pair.model };
    return {
      provider: config.synth.llm.defaultProvider,
      model: config.synth.llm.defaultModel,
    };
  };
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
    // мог ответить без ручной простановки модели. Приоритет: runtime-пара
    // «Модели» (provider+model), затем config.
    resolveLlmDefaults,
    // ADR-089: агент по умолчанию инстанса — чтобы сессия из внешнего события
    // (auto-bind/bind/ephemeral) фиксировала `settings.agentRole` и UI рисовал
    // бейдж агента (паритет с `POST /api/v2/sessions`). Источник — админка
    // «Агенты» (`getDefaultAgentId`) поверх `DEFAULT_AGENT_ID`.
    resolveDefaultAgent: getDefaultAgentId,
    // ADR-089/ADR-051: учёт экземпляров пайплайна (ADR-100) — решение с
    // `pipeline: {id, step}` продвигает автомат пайплайна; учёт best-effort.
    pipelineTracker,
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
  const eventIngress = new EventIngress({ requestSessionService, metrics: eventMetrics });

  // ADR-101 (Э5): движок пайплайнов — второй движок рядом с оркестратором
  // (ADR-101 §1). Собирается в точке сборки (никаких глобальных синглтонов):
  // шаг пайплайна не сессия, но окружение то же — порты хранилища (ADR-096),
  // permission-слой (ADR-029), промпт (ADR-070), Gateway (ADR-036).
  //
  // HTTP-роутов у движка нет (Э6): он живёт в `deps` и используется
  // вызывающим кодом (запуск прогона/возобновление — Э6).
  const pipelinePermissions: PipelinePermissionDeps = {
    permissionConfig: config.synth.permission,
    runtimeDeps,
  };
  // ADR-036/ADR-101: провайдер шага — **всегда** через `GatewayProvider`
  // (обёртка оркестратора: та же точка, что у пула провайдеров). Провайдер
  // не кэшируется — обёртка подхватывает live-конфиг LLM Gateway.
  const resolvePipelineProvider = async (): Promise<BaseProvider | null> => {
    try {
      const defaults = await resolveLlmDefaults();
      const providerName = defaults.provider?.trim();
      if (!providerName) return null;
      const sharedConfig = providerLoader(providerName);
      if (!sharedConfig) return null;
      const coreConfig = toCoreProviderConfig(
        sharedConfig,
        defaults.model?.trim() || sharedConfig.defaultModel || '',
      );
      return orchestrator.wrapProviderWithGateway(
        ProviderFactory.create(providerName, coreConfig),
      );
    } catch {
      // Провайдер не собран — шаг упадёт с `pipeline.provider_not_found`.
      return null;
    }
  };
  const pipelineEngine = new PipelineEngine({
    // ADR-096: порты спецификаций пайплайнов и прогонов — из контекста хранения.
    pipelines: storageContext.projectPipelines,
    runs: storageContext.pipelineRuns,
    // ADR-101 §4: исполнители видов шага (tool/script/human/agent).
    executors: [
      createToolStepExecutor({ toolRegistry, permissions: pipelinePermissions }),
      createScriptStepExecutor({ toolRegistry, permissions: pipelinePermissions }),
      createHumanStepExecutor(),
      createAgentStepExecutor({ toolRegistry, permissions: pipelinePermissions }),
    ],
    // ADR-101 §9: выходы пайплайна — сессия/файл/шлюз/none.
    exits: [
      createPipelineExitHandler({
        sessionManager,
        projectStore,
        eventBus,
        ingress: eventIngress,
        workspacesRoot: config.workspacesRoot,
        resolveLlmDefaults,
        // ADR-089: владелец сессии, созданной выходом, — владелец проекта
        // прогона (резолвится в обработчике выхода). Без проекта владельца нет:
        // сессия инстансная (видима ADMIN/LEAD) — права уточняются в Э6.
        onSessionMaterialized: (session) => {
          const owner = session.ownerId || session.userId;
          if (!owner) return;
          void eventHub.subscribeToSession(owner, session.id).catch((e: unknown) =>
            console.warn('subscribeToSession failed:', e),
          );
        },
      }),
    ],
    // ADR-101 §2.12: инстансные события прогона (новая шина не заводится).
    eventBus,
    // ADR-094: метрики прогонов (`synth_pipeline_*`).
    metrics: metrics ? createPipelineMetrics(metrics) : undefined,
    // ADR-101 §4/ADR-070: промпт шага — тем же сборщиком, что у сессий.
    composer: orchestrator.getComposer(),
    resolveProvider: resolvePipelineProvider,
    resolveLlmDefaults,
    // ADR-101 §10: контекст шага — те же объекты, что собраны для сессий.
    projectStore,
    toolRegistry,
    mcpManager,
    instructionsResolver: orchestrator.getInstructionsResolver(),
    agentRegistry,
    skillsCatalog: skillService,
    runtimeDeps,
    workspacesRoot: config.workspacesRoot,
  });

  // ADR-101/ADR-051: движок пайплайнов появился — отдаём его тулам
  // `pipeline_*` через рантайм автоматизации (late-bound).
  automationRuntime.engine = pipelineEngine;

  // ADR-101: встроенные шаблоны пайплайнов инстанса (сид при старте).
  // Идемпотентно: существующий шаблон не перезаписывается. Ошибка сидирования
  // **не** роняет старт — только предупреждение в лог. В деградированном
  // режиме (ADR-098) хранилище read-only — запись не выполняется вовсе.
  if (!storageDegraded) {
    try {
      await ensureBuiltinPipelines({
        pipelines: storageContext.projectPipelines,
        logger: {
          info: (message) => console.log(message),
          warn: (message) => console.warn(message),
        },
      });
    } catch (err) {
      console.warn(
        `[pipelines] не удалось засеять встроенные шаблоны: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ADR-051 (срез) / ADR-089: планировщик публикует cron-события через ingress.
  // `start()` гейтится конфигом (`scheduler.enabled: false` — тикер не стартует),
  // ошибки старта логируются и не роняют процесс; остановка — `stopScheduler`.
  const schedulerTickMs = config.synth.scheduler.tickSec * 1000;
  // ADR-097: `leaderElection=postgres` требует advisory-локов backend'а
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
    // ADR-030 (Ф0 ADR-090): хук `schedule_fired` (async, метаданные расписания).
    hooks,
    // ADR-094: завершённые Job (outcome + дрейф cron).
    onJob: schedulerJobMetrics,
    // ADR-101: цель расписания `mode:'pipeline'` — прямой запуск прогона.
    // Прогон идёт в фоне: ждём только `onStarted` (id прогона), не конца.
    runPipeline: async ({ projectId, pipelineId, version, payload, dedupKey }) => {
      const started = new Promise<PipelineRunRecord>((resolve, reject) => {
        const p = pipelineEngine.run({
          projectId,
          pipelineId,
          ...(version !== undefined ? { version } : {}),
          trigger: { kind: 'schedule', source: 'cron', type: 'schedule_fired', payload, dedupKey },
          onStarted: resolve,
        });
        // Ошибка до старта — reject (Job → error). Ошибка после старта — в журнале
        // прогона; обработчик снимает unhandled rejection, `reject` уже не сработает.
        p.catch(reject);
      });
      const run = await started;
      return { runId: run.id };
    },
    // ADR-051/ADR-089/ADR-096: тикер стартует только у лидера (default —
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

  // ADR-101/ADR-051: шедулер появился — отдаём его тулам `schedule_*`
  // через рантайм автоматизации (late-bound).
  automationRuntime.scheduler = schedulerService;

  // ADR-092: авто-миграции схемы данных при старте (паритет со standalone-core) —
  // обязательная страховочная копия + межпроцессный лок. Миграция снапшотов скоупа —
  // зарегистрированная миграция реестра (`session-scope-snapshots-v1`), отдельный
  // прямой вызов больше не нужен. Fail-closed: ошибка не глушится.
  // ADR-098 (W5): в деградации миграции не применяем (фоллбек-каталог пуст —
  // страховочная копия/миграция были бы доменной записью в фоллбек).
  if (!storageDegraded) {
    await applyStartupMigrations({
      dataDir,
      settingsStore,
      sessionManager,
      projectStore,
      // ADR-097: под PG — advisory-лок драйвера вместо файлового `{dataDir}/migrate`.
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
    // ADR-106 Ф3: реестр подтверждений (enforced-режим Authority-слоя).
    approvalRegistry,
    // ADR-096: контекст хранения инстанса — для операций, которым нужен
    // целиком (напр. портативный экспорт/импорт проекта, ADR-091).
    storageContext,
    // ADR-094: реестр метрик (доменные коллекторы подключаются выше) и
    // остановка фоновых коллекторов на graceful shutdown.
    metrics,
    stopMetricsCollectors,
    projectStore,
    sessionManager,
    // ADR-089: остановка sweeper'а авто-архивации ephemeral-сессий.
    stopEphemeralSweeper,
    sshKeyStore,
    providerStore,
    modelStore,
    agentStore,
    // ADR-096 (W2.4): конфигурационные словари и реестр service-key — из контекста.
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
    // ADR-102 (волна 1): порт пред-агрегированных роллапов аналитики — для роутов отчётов.
    analyticsRollups,
    // ADR-102: write-path — сборщик роллапов (+ остановка hook-подписки и pruner'а).
    analytics,
    detachAnalyticsHooks,
    stopAnalyticsRollupPruner,
    stopEgressLogPruner,
    mcpManager,
    mcpRegistryStore,
    // ADR-105 (Ф3/Ф4): реестр описаний OAuth-провайдеров и сервис слоя доступов
    // (HTTP-контур `/api/v2/oauth/credentials`).
    oauthProviders,
    oauthCredentialService,
    // ADR-051/ADR-100: порт реестра пайплайнов (определения + экземпляры).
    pipelines: pipelineStore,
    // ADR-101 (Э5): движок пайплайнов (второй движок) — HTTP-роутов нет (Э6).
    pipelineEngine,
    // ADR-101: реестр активных прогонов — общий для HTTP-роута пайплайнов и
    // встроенных тулов агента (soft-lock + отмена идущего прогона).
    pipelineRunControl,
    // ADR-086 §5: порт реестра установок пакетов расширений.
    packs: packStore,
    eventBus,
    queueManager,
    // Этап 1 roadmap 0.13 (блок 3): сервис вопросов пользователю (+ pruner).
    questionService,
    stopQuestionPruner,
    // Этап 1 roadmap 0.13 (блок 4): реестр фоновых прогонов (+ pruner).
    backgroundService,
    stopBackgroundRunPruner,
    // PROP-097 (блок 5b): сервис фоновых шелл-процессов (+ pruner логов).
    processService,
    stopProcessLogPruner,
    // ADR-114: сервис worktree'ов — HTTP-контур проектов и привязка сессии.
    worktreeService,
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
    // ADR-090 (Ф5б-1): рантайм плагинов — старт-активация установленного
    // (`app.ts`/`main.ts`) и точки для HTTP API/CLI (Ф5б-2/3). `host`+`installer` внутри.
    pluginRuntime,
    // ADR-077: порт исполнения — тот же инстанс, что у оркестратора и тулов
    // (резолвер проектных инструкций берёт его для `git rev-parse`).
    executionPort,
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
