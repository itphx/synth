// Сборка зависимостей standalone-core: хранилища, менеджеры, оркестратор,
// событийное ядро (ADR-089), планировщик (ADR-051), webhooks (ADR-052),
// скиллы/команды (ADR-126), runtime-настройки (ADR-005/023).
// Вынесено из `server/app.ts` (ADR-095, шаг 4a) — «вынос по швам», без изменения поведения.
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ProviderConfig, ModelConfig, ModelCompatibility, ToolsPolicy, ToolsDisabledConfig,
  WorkspaceOutsideRootPolicy, WebhooksConfig, SummarizationConfig, Session, Message,
  PluginServerPolicy, BackgroundRunRecord,
} from '@itphx/synth-shared';
import { ensureDataDir, mergeModelCompatibility, parsePrincipalId, readTlsRuntimeSettings, SYNTH_VERSION, generateId, makeTextPart, nowISO, MessageRole } from '@itphx/synth-shared';
import { DEFAULT_TOOL_OUTPUT_MAX_BYTES, DEFAULT_TOOL_OUTPUT_MAX_LINES } from '@itphx/synth-shared/config';
// ADR-135: применение runtime-каталога профилей исполнения (runtime > config,
// env/CLI выше — их разрешает `resolveExecutionConfig`, ADR-023).
import { applyExecutionRuntimeSettings, resolvePromptInjection } from '@itphx/synth-shared/config';
import { serializeMessage } from '../serialize.js';
// PROP-141 (Часть D): сервис переноса сессии между проектами (единый шов).
import { SessionMoveService } from '../../sessions/move-service.js';
// ADR-092: «Стоп» сессии — единая семантика (`POST /:id/abort` и инстансный тул
// `synth_session_stop`), поэтому прокладка тулов собирается здесь же.
import { abortSessionTurn } from '../../sessions/turn-abort.js';
import type { InstanceRuntimeMeta } from '../../engine/instance/meta.js';
import type { RemoteBackendClient } from '../../remote/client.js';

/**
 * Fallback-текст info-блока автопродолжения после рестарта: content — en-текст
 * по контракту ADR-041 (LLM-контекст), UI локализует по `metadata.i18n`.
 */
const RESTART_RESUMED_TEXT = 'The turn was interrupted by an instance restart and continued automatically';
import {
  SessionManager, EventBus, QueueProcessorManager,
  ContextBuilder, ContextOptimizer, ChatOrchestrator,
  enqueueUserMessage, requeueMessages, createToolRegistry, createAgentRegistry, McpManager,
  hiddenMcpServersForExecution,
  DEFAULT_AGENT_ID, registerStoredAgents, migrateLegacyStoredAgents,
  detectRuntimeDeps, HookBus, startEphemeralSweeper,
  isFfmpegAvailable,
  EventRouter, RequestSessionService, EventIngress, eventToMessage,
  addEventAttachmentRefs, AttachmentService,
  ProjectRuleProvider, DecisionRuleProvider,
  type DecisionAgentCandidate,
  PipelineTracker,
  SchedulerRuleProvider, SchedulerService, AlwaysLeader, FileLeader, SharedLeader,
  // PROP-141 (Часть B): движок таймеров/будильников + правило маршрутизации.
  TimerService, TimerRuleProvider, TIMER_EVENT_SOURCE, TIMER_EVENT_TYPE,
  WebhookService,
  createExternalIdentityResolver,
  startEventJournalPruner,
  startWebhookDeliveryPruner,
  // Этап 1 roadmap 0.13 (блок 3): сервис вопросов пользователю + retention.
  QuestionService,
  startQuestionPruner,
  // Этап 1 roadmap 0.13 (блок 4): единый реестр фоновых прогонов (PROP-096).
  BackgroundRunService,
  startBackgroundRunPruner,
  createBackgroundParentNotifier,
  // PROP-143: durable-запись о прогоне, потерянном при рестарте.
  appendLostRunRecords,
  // PROP-142 §3: бюджет автовосстановления + планировщик boot-восстановления.
  recordRecoveryAttempt,
  planBootRecovery,
  resolveRecoveryBudget,
  // PROP-143: durable-запись причины остановки хода (след отказа по бюджету).
  appendStopRecord,
  // PROP-097 (блок 5b): сервис фоновых шелл-процессов + retention логов.
  ProcessService,
  startProcessLogPruner,
  // ADR-126 §5: сервис реестра скриптов проекта (`!`-запуск).
  ScriptService,
  // ADR-115: GC осиротевших вложений сообщений (blob-хранилище + `blob_refs`).
  startAttachmentPruner,
  // ADR-115 × ADR-077: медиа-раннер (ffmpeg inline/remote) и серверные миниатюры.
  createMediaRunner,
  ThumbnailService,
  // ADR-115 × ADR-077: уборка временных каталогов медиа-раннера
  // (`{workspacesRoot}/.synth-media/*`) — после жёсткого kill они остаются.
  startMediaTempPruner,
  // ADR-114: сервис worktree (per-session рабочий каталог) + публикация
  // `worktree.updated` в каналы сессий проекта.
  WorktreeService,
  publishWorktreeUpdated,
  startWorktreeSweeper,
  AnalyticsRecorder,
  attachAnalyticsActivityHooks,
  startAnalyticsRollupPruner,
  sessionAxes,
  createStorageContextAsync,
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
  createWebhookMetrics,
  createEventMetrics,
  // PROP-141 (Часть B): метрики таймеров (`synth_timer_*`, ADR-094).
  createTimerMetrics,
  // ADR-094/ADR-115: метрики вложений (`synth_attachment_*`) + установка их
  // sink'а (сервис вложений собирается внутри фабрики роутов сессий).
  createAttachmentMetrics,
  setAttachmentMetricsHook,
  // ADR-106 Ф1: счётчик решений Authority-слоя (`synth_authority_decisions_total`).
  createAuthorityMetrics,
  // PROP-136 (слайс 136a): метрики журнала исполнений команд (`synth_command_audit_*`).
  createCommandAuditMetrics,
  // PROP-136: append-only журнал исполнений `execute_shell`/`sandbox_exec`.
  createCommandAuditLog,
  // ADR-136/ADR-126 §5: парная запись `finished` по терминальному переходу
  // фонового скрипта.
  createScriptRunAuditFinisher,
  // PROP-136b (слайс 136b-2a): метрики зеркального чекера команд
  // (`synth_command_policy_*`) и сам провайдер.
  createCommandPolicyMetrics,
  createCommandPolicyProvider,
  // ADR-094/ADR-077: метрики пула исполнителей (`synth_executor_*`) — приёмник
  // для клиента удалённого порта.
  createExecutorMetricsCollector,
  startEventJournalMetrics,
  createEgressPolicyResolver,
  createEgressLogSink,
  configureEgressRuntime,
  startEgressLogPruner,
  // ADR-036: общий AuditLogger LLM Gateway (оркестратор + HTTP-роут аудита).
  AuditLogger,
  // ADR-105 (Ф3): источник access-токена для MCP-коннекторов + OAuth-сервис.
  OAuthCredentialService,
  OAuthProviderRegistry,
  registerOAuthProvidersFromConfig,
  createRepositoryCredentialSource,
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
  // PROP-132 (Ф3в): сервис терминалов инстанса + настройки секции `terminal`
  // (env > runtime > config > default, по каждому полю).
  createTerminalService,
  resolveTerminalSettings,
  // PROP-135: порт терминала — тем же роутером, что и порт тулов.
  createTerminalPortResolver,
  // PROP-132 (Ф5): сообщение-уведомление о завершении запуска команды в
  // терминале (точка сборки — тот же нотификатор, что у фоновых процессов).
  buildTerminalRunNotification,
  // ADR-115 × ADR-101: вложения прогона — derive для text-only модели шага.
  createPipelineAttachmentDerive,
  // ADR-101 §9 / ADR-116: артефакты прогонов — blob-порт + `blob_refs`.
  PipelineArtifactStore,
  ensureBuiltinPipelines,
  // ADR-101 §4 × `AgentDefinition`: провайдер агентского шага.
  resolvePipelineStepProvider,
  toCoreProviderConfig,
  ProviderFactory,
  // ADR-090 (Ф3а) / §5, §10 (Ф5б-1): общий реестр блоков
  // промпта (композер + фасад плагинов) и рантайм плагинов (старт-активация).
  PromptBlockRegistry,
  PluginRuntime,
  PluginProcessManager,
  PluginFacadeError,
  createInlinePluginLoader,
  createRemotePluginLoader,
  resolvePluginLayout,
  type BaseProvider,
  type AutomationRuntime,
  type PipelinePermissionDeps,
  type PipelineRunRecord,
  type PluginEmbedFn,
  type StepExecutionContext,
  type StorageContext,
} from '../../index.js';
import { syncProvidersFromEnv } from '../../providers/sync-from-env.js';
import { createInstanceExecutionPort } from '../../execution/factory.js';
import { createExecutionRouter } from '../../execution/router.js';
import {
  attachExecutorMcpSource,
  createExecutorMcpPoolResolver,
} from '../../engine/mcp/executor-mcp-source.js';
import {
  mergeLlmGatewayConfig, mergeSecurityConfig,
  mergeEventsConfig, mergeDecisionConfig, mergePluginsConfig,
  createLiveAttachmentsSettings,
  createLiveContextWindowPolicy,
  createLiveSubagentMaxInputTokens,
  createLiveSessionOpsPerMinute,
  createLiveContextDefaults,
  createLiveStickyNotesLimits,
  createLiveSshMode,
  createLiveBackgroundSettings,
  createLiveAuditSettings,
  readExecutionRuntimeSettings,
} from '../../storage/runtime-settings.js';
import { assertInstanceDataNotTooNew } from '../../storage/instance-meta.js';
// PROP-137 Ф1: fail-closed проверка записи в каталог данных — до сборки
// хранилища (иначе EACCES всплывает позже и неясно, где именно).
import { assertDataDirWritable } from '../../storage/data-dir-check.js';
import { AuthorityGuard } from '../../engine/authority/guard.js';
import {
  buildApprovalResponderProfile,
  createApprovalCoverageResolver,
} from '../../engine/authority/approval.js';
import { ApprovalRegistry } from '../../engine/permission/approval.js';
import { createPermissionAuditSink } from '../../engine/permission/permission-audit.js';
import { applyStartupMigrations, applyPendingRestore } from '../../maintenance/startup.js';
import { SkillService } from '../../engine/skills/service.js';
import { SnippetService } from '../../engine/snippets/service.js';
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
   * Workstream A1: клиент удалённого backend (гибрид) — read-only merge
   * проектов/сессий в инструментах (`list_projects`/`list_sessions`).
   * `null` — гибрид не подключён (только локальный мир).
   */
  getRemoteClient?: () => RemoteBackendClient | null;
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
  /**
   * ADR-090 Ф7: серверная политика плагинов удалённого сервера (гибрид).
   *
   * Возвращает `undefined`, когда сервера нет/он недоступен или политика
   * неизвестна: тогда локальные плагины работают в режиме cooperative и
   * помечаются «не проверен сервером».
   */
  getServerPluginPolicy?: () => PluginServerPolicy | undefined | Promise<PluginServerPolicy | undefined>;
}

/**
 * ADR-096 (W2.4): единая точка сборки слоя хранения standalone — `app.ts`
 * строит её до `auth` (реестр `serviceKeys` нужен резолверу ключа), а
 * `createStandaloneDeps` переиспользует тот же инстанс (один контекст, а не
 * россыпь конкретных классов по `main.ts`/`chat.ts`/`app.ts`).
 */
export async function createStandaloneStorage(config: StandaloneConfig): Promise<StorageContext> {
  const kind = config.storageBackend ?? 'file';
  if (kind === 'memory') {
    console.warn('storage.backend=memory: данные не сохраняются на диск');
  }
  // PROP-137 Ф1: fail-closed проверка записи в каталог данных — **до** сборки
  // хранилища. Каталог нужен и при 'file' (все JSON-данные), и при
  // 'postgres' (секреты, мастер-ключ и blob-хранилище — ADR-116/ADR-097).
  // Без проверки EACCES всплывает позже и неясно (сессии/секреты/блобы),
  // а UI при этом отвечает 200 — «сайт открыт, данные не сохраняются».
  if (kind !== 'memory') {
    await assertDataDirWritable(config.dataDir);
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
    // ADR-090: путь lock-файла плагинов задаёт раскладка (композиционный
    // корень) — `<home>/plugin/plugins.lock.json` либо `{dataDir}/plugin/…`.
    // Логику home не дублируем: единственный резолвер — `resolvePluginLayout`,
    // его же использует `PluginRuntime` (раскладка `installed/`/`quarantine/`),
    // поэтому порт и каталоги установки всегда согласованы.
    pluginLockPath: resolvePluginLayout({ dataDir: config.dataDir, env: process.env }).lockPath,
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
  // ADR-098 (W5): деградированное хранилище (postgres недоступен → файловый
  // фоллбек, read-only). Фоновые ПИСАТЕЛИ (миграции, провайдеры из env, шедулер,
  // webhooks, sweeper/ephemeral, retention-прунеры) отключаются, чтобы не
  // создавать доменные данные в фоллбеке (split-brain).
  const storageDegraded = storageContext.degraded !== undefined;
  await ensureDataDir(dataDir);

  // ADR-101: реестр активных прогонов пайплайнов — **один на процесс**.
  // Его получают и HTTP-роут пайплайнов, и встроенные тулы агента: поэтому
  // soft-lock «не запустить второй прогон того же пайплайна» и отмена
  // идущего прогона работают одинаково для обоих контуров.
  const pipelineRunControl = new PipelineRunControl();

  // ADR-091: отложенное восстановление из бэкапа — офлайн-операция, применяется
  // при старте **до** миграций и до использования стораджей (меняет данные
  // каталога: возврат к снимку). Fail-closed: невалидный запрос останавливает
  // старт (запрос не удаляется — оператор исправляет или отменяет).
  await applyPendingRestore({ dataDir });

  // ADR-092: guard совместимости схемы данных — данные новее Synth → отказ старта
  // (дешёвая fail-fast проверка). Устаревшая схема → авто-миграции с обязательной
  // страховочной копией ниже (`applyStartupMigrations`), после сборки стораджей.
  await assertInstanceDataNotTooNew(dataDir);

  // ADR-096 (W2.3/W2.4): единый контекст хранения — домен получает порты из
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
    // ADR-051/ADR-100: реестр пайплайнов; ADR-086 §5: реестр установок пакетов.
    pipelines: pipelineStore,
    packs: packStore,
    // ADR-071 §2.5: единый реестр MCP-серверов (установщик пакета пишет в него).
    mcpRegistry: mcpRegistryStore,
  } = storageContext;

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

  // Egress: живой резолвер политики (settings.json → config.yaml → дефолт) и
  // журнал внешних запросов. Резолвер читает стор на каждый запрос — без
  // стартового снимка/кэша (live-применение без рестарта).
  // ADR-115: живое состояние настроек вложений. Инициализируется runtime-значением
  // (`settings.json`/PG), обновляется роутом `/api/v2/settings/attachments`;
  // сервис вложений, промпт и GC читают резолвер на каждый вызов (без рестарта).
  const attachmentsSettings = createLiveAttachmentsSettings({
    config: config.attachmentsConfig,
    runtime: await settingsStore.getAttachments(),
  });

  // Политика ограничения контекстного окна (`context.windowPolicy`):
  // приоритет env > runtime > config.yaml > default; применяется сразу —
  // оркестратор читает резолвер перед каждым LLM-вызовом.
  const contextWindowSettings = createLiveContextWindowPolicy({
    config: config.contextConfig?.windowPolicy,
    runtime: await settingsStore.getContextWindowPolicy(),
  });

  // Предохранитель объёма промпта саб-агента (`agents.subagentMaxInputTokens`):
  // приоритет env > runtime > config.yaml > 0; читается при сборке `task` extra.
  const subagentMaxInputTokensSettings = createLiveSubagentMaxInputTokens({
    config: config.agentsConfig?.subagentMaxInputTokens,
    runtime: await settingsStore.getSubagentMaxInputTokens(),
  });

  // Лимит тяжёлых операций с сессиями (`limits.sessionOpsPerMinute`):
  // приоритет env > runtime > config.yaml > 10; лимитер читает резолвер на
  // каждый запрос (runtime-изменение применяется без рестарта).
  const sessionOpsPerMinuteSettings = createLiveSessionOpsPerMinute({
    config: config.limitsConfig?.sessionOpsPerMinute,
    runtime: await settingsStore.getSessionOpsPerMinute(),
  });

  // Дефолты оптимизации контекста для **новых** сессий (`context.defaults`):
  // runtime-патч поверх config.yaml; менеджер сессий читает резолвер при
  // создании (`contextDefaults` ниже) — применяется без рестарта.
  const contextDefaultsSettings = createLiveContextDefaults({
    config: config.contextConfig?.defaults,
    runtime: await settingsStore.getContextDefaults(),
  });

  // Instance-wide лимиты заметок сессии (`context.stickyNotes`): runtime-патч
  // поверх config.yaml; core-фабрика сессий читает резолвер при каждой
  // операции с заметкой — применяется без рестарта (существующие не обрезаются).
  const stickyNotesLimitsSettings = createLiveStickyNotesLimits({
    config: config.contextConfig?.stickyNotes,
    runtime: await settingsStore.getStickyNotesLimits(),
  });

  // PROP-124: режим инстанса для SSH-ключей (`ssh.mode`): приоритет
  // env > runtime > config.yaml > `tools`; применяется без рестарта.
  const sshModeSettings = createLiveSshMode({
    config: config.sshConfig?.mode,
    runtime: await settingsStore.getSshMode(),
  });

  // Этап 1 roadmap 0.13 (блок 4): секция `background` (реестр фоновых
  // прогонов) — приоритет env > runtime > config.yaml > default. Один
  // экземпляр на процесс: сервисы реестра/процессов, pruner'ы и оркестратор
  // читают его на каждый запуск/тик, поэтому runtime-настройка
  // (`/api/v2/settings/background`) применяется без рестарта.
  const backgroundSettings = createLiveBackgroundSettings({
    store: settingsStore,
    config: config.backgroundConfig,
  });
  // Стартовое чтение runtime-патча (деградация хранилища — fail-soft внутри).
  await backgroundSettings.refresh();

  // Журнал **решений по подтверждениям прав** (`scope:'permission'`):
  // runtime-секция `audit` (режим `decisions`|`all` + retention), приоритет
  // env > runtime > default. Один экземпляр на процесс — его читают шов
  // журнала (на каждое решение) и retention-прогон ниже, поэтому правка из
  // админки (`PUT /api/v2/settings/audit`, следующий срез) применяется без
  // рестарта (`refresh()` после записи).
  const auditSettings = createLiveAuditSettings({ store: settingsStore });
  await auditSettings.refresh();

  // Retention журнала решений: стартовый прогон, best-effort (ADR-092: старт
  // инстанса не падает из-за уборки). `prune` — опциональный метод порта:
  // фейки/альтернативные реализации могут его не иметь (тогда прунинга нет).
  if (!storageDegraded && typeof securityAudit.prune === 'function') {
    try {
      const removed = await securityAudit.prune(auditSettings.getRetentionDays());
      if (removed > 0) {
        console.info(`[permission] retention журнала решений: удалено ${removed} записей`);
      }
    } catch (err) {
      console.warn(
        `[permission] retention журнала решений не выполнен: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Шов журнала решений: один на процесс — его получают оркестратор
  // (`permissionAudit`) и менеджер ожиданий внутри него (`onDecision`).
  // Актор записи — владелец сессии (в standalone — локальный пользователь).
  const permissionAuditSink = createPermissionAuditSink({
    ...(storageDegraded ? {} : { repository: securityAudit }),
    actorOf: async (sessionId) => (await sessionManager.getSession(sessionId))?.ownerId ?? 'local',
    mode: () => auditSettings.getMode(),
  });

  // ADR-102: сборщик роллапов аналитики (write-path) — только через порт слоя
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

  // ADR-036: общий AuditLogger LLM Gateway создаётся **снаружи**, чтобы
  // оркестратор и HTTP-роут `GET /api/v2/audit` писали/читали **один и тот же**
  // JSONL (`{dataDir}/audit/llm-gateway.jsonl`) — как в managed backend.
  const gatewayAuditLogPath = join(dataDir, 'audit', 'llm-gateway.jsonl');
  const gatewayAuditLogger = new AuditLogger(gatewayAuditLogPath);
  // Полный лог запросов/ответов LLM (после обфускации) — тот же путь, что
  // использует оркестратор (ADR-036); отдаётся в `GET /api/v2/logs/llm`.
  const gatewayPayloadLogPath = join(dataDir, 'audit', 'llm-payloads.jsonl');

  // Защищённые пути: runtime-настройка protectedPaths.enabled (тумблер из UI) приоритетнее config.yaml
  const runtimeSecurity = await settingsStore.getSecuritySettings();
  const effectiveSecurityConfig = mergeSecurityConfig(config.securityConfig, runtimeSecurity);
  if (effectiveSecurityConfig) {
    // ADR-023: env `SYNTH_SECURITY_PROMPT_INJECTION_*` перекрывает runtime и
    // config.yaml (приоритет env > runtime > config > default, фиксация по полю).
    effectiveSecurityConfig.promptInjection = resolvePromptInjection(
      config.securityConfig?.promptInjection,
      runtimeSecurity.promptInjection,
    ).config;
  }

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
  // ADR-126 §11: runtime-отключение скиллов (админка) — hard-gate системного уровня.
  const effectiveSkillsDisabled = (await settingsStore.getSkillsDisabled())
    ?? { categories: [], groups: [], skills: [] };
  // ADR-126/ADR-069: project-trust гейт скиллов/команд/инструкций. Runtime
  // (`settings.json`/PG) приоритетнее `config.yaml`; применяется при старте
  // (резолверы собираются здесь) — `restartRequired` в API, инвариант 24.
  const effectiveSkillsTrustedProjectDirs =
    (await settingsStore.getSkillsTrustedProjectDirs())
    ?? config.skillsConfig?.trustedProjectDirs
    ?? [];

  // ADR-075: политика workspace вне root. config/env — дефолт; runtime-override
  // (settings.json) применяется при старте и live через PUT /settings/workspace-policy
  // (live-состояние ведёт `app/mount-routes.ts`).
  const effectiveWorkspaceOutsideRootPolicy: WorkspaceOutsideRootPolicy =
    (await settingsStore.getWorkspacePolicy()) ?? config.workspaceOutsideRootPolicy ?? 'confirm';

  // ADR-135: runtime-каталог профилей исполнения (`settings.json`/PG).
  //
  // Приоритет эффективного значения — **env/CLI > runtime > config.yaml**
  // (env/CLI разрешаются внутри `resolveExecutionConfig`, ADR-023): поэтому
  // runtime-override применяется поверх уже разрешённой секции, но под env.
  // Каталог `profiles` runtime-секции **заменяет** каталог config.yaml целиком
  // (администратор может и добавить, и удалить профиль из конфига).
  //
  // Секция `execution` — **параметр запуска** (инвариант 24): порты пулов и
  // роутер создаются на старте процесса, поэтому изменение каталога требует
  // рестарта (`restartRequired` в API). Хранилище может быть недоступно
  // (деградация, ADR-098) — тогда действует config-уровень, как раньше.
  const runtimeExecution = await readExecutionRuntimeSettings(settingsStore);
  const baseExecutionConfig = config.executionConfig;
  const effectiveExecutionConfig = baseExecutionConfig
    ? applyExecutionRuntimeSettings(baseExecutionConfig, runtimeExecution)
    : baseExecutionConfig;

  // ADR-084: runtime/эффективный конфиг decision-слоя (админка) приоритетнее
  // config.yaml `decision`. Live-применяется ко всем трём потребителям
  // (микро-каскад, роутер, события ADR-089) через `onDecisionChange`.
  const runtimeDecision = await settingsStore.getDecision();
  let effectiveDecisionSettings = mergeDecisionConfig(config.decisionConfig, runtimeDecision);

  // ADR-036: паттерны детекции секретов и ADR-075 защищённые пути — из контекста
  // хранения (собраны выше); ADR-030: ядровая шина хуков — общий инстанс для
  // SessionManager и оркестратора (эмиты жизненного цикла агента).
  const hooks = new HookBus();
  // PROP-141 (Часть B): каскад удаления сессии — снятие её таймеров/будильников.
  // Сервис таймеров собирается ниже (после ingress'а), поэтому ссылка
  // late-bound: шов один — `SessionManager.deleteSession` (инвариант 16).
  const timerServiceRef: { service?: TimerService } = {};
  // PROP-141 (Часть D): сервис переноса сессии — тоже late-bound (собирается
  // после движка таймеров, а оркестратор/extra тулов читают его на лету).
  const moveServiceRef: { service?: SessionMoveService } = {};
  const sessionManager = new SessionManager(fileStore, {
    mcpSettingsProvider: () => settingsStore.getMcpSettings(),
    projectStore,
    hooks,
    // PROP-141: удаление сессии снимает её автоматизации (таймеры/будильники).
    onSessionDeleted: async (sessionId: string) => {
      await timerServiceRef.service?.onSessionDeleted(sessionId);
    },
    // Дефолты оптимизации контекста новых сессий (`context.defaults` + runtime).
    contextDefaults: () => contextDefaultsSettings.getDefaults(),
    // ADR-102: точка персиста сообщения инкрементирует `activity`
    // (`messages_assistant`/`messages_tool`); пользовательские — в процессоре.
    analytics,
    // ADR-071 §2.4 / ADR-126 §11: системные дефолты для сессий без проекта.
    // Список MCP-серверов — из реестра (источник истины, ADR-071 §2.5).
    systemDefaultsProvider: async () => ({
      mcpDefaultOn: await mcpRegistryStore.toDefaultServers(),
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
  // ADR-102: шов записи `activity` через hook-шину (ADR-030): жизненный цикл
  // сессии/инструментов/саб-агентов → инкременты роллапов. Оси `user`/`project`
  // берутся из контекста хука либо резолвятся по id сессии.
  const detachAnalyticsHooks = analytics
    ? attachAnalyticsActivityHooks(hooks, {
        recorder: analytics,
        resolveSessionAxes: async (sessionId) =>
          sessionAxes(await sessionManager.getSession(sessionId)),
      })
    : () => {};
  // ADR-102 §8: retention суточных роллапов (сразу + каждые 6 ч, `unref`).
  const stopAnalyticsRollupPruner =
    storageDegraded || !analytics
      ? () => {}
      : startAnalyticsRollupPruner(analyticsRollups, {
          getRetentionDays: () => config.analyticsConfig?.retentionDays ?? 400,
        });
  const mcpManager = new McpManager({
    // PROP-135 D1/D2: браузерный MCP-сервер исполнителя остаётся подключённым
    // (его вызывает `ExecutionPort.browserCall` → `POST /mcp/call`), но его
    // инструменты не регистрируются — у модели есть встроенные `browser_*`.
    // `inline` → пусто (`browserMcpServer` там ни при чём).
    hiddenServers: hiddenMcpServersForExecution(effectiveExecutionConfig),
    // Advisory-детекция prompt injection в описаниях/`instructions` MCP
    // (ru+en словарь `injection`) — только пометка в промпте, без блокировки.
    dictionaryStore,
    ...(metrics ? { metrics } : {}),
  });
  // ADR-071 §2.5: единый источник истины для конфигурации MCP-серверов —
  // реестр `McpRegistryStore` (в standalone так же, как в managed). Instance-
  // серверы из `config.mcpServers` сидируются в реестр при старте (идемпотентно
  // по имени), менеджер заполняется картами реестра. Правка записи реестра
  // перечитывает карты (`syncMcpManagerFromRegistry`) — серверы из конфига при
  // этом не исчезают: они уже в реестре.
  await mcpRegistryStore.seedFromConfig(config.mcpServers ?? {});
  const mcpMaps = await mcpRegistryStore.toManagerMaps();
  mcpManager.setConfig(mcpMaps.servers);
  mcpManager.setServerOrigins(mcpMaps.origins);
  mcpManager.setServerTrusts(mcpMaps.trusts);
  mcpManager.setServerAuthors(mcpMaps.authors);
  mcpManager.setDefaultServers(mcpMaps.defaults);
  // ADR-071 §2.4: системный мастер-флаг серверов (реестр `enabled`).
  mcpManager.setServerSystemEnabled(mcpMaps.systemEnabled);

  // ADR-071 §2.3.1: политика сетевого доступа MCP резолвится при каждом
  // подключении/probe (live; живые соединения остаются на политике коннекта).
  mcpManager.setNetworkPolicyResolver(() => egressResolver.resolveMcp());

  // ADR-105 (Ф3): коннекторы с `auth.kind='credential'` авторизуются токеном
  // из слоя доступов (подстановка в транспорт, refresh при 401).
  const oauthProviders = new OAuthProviderRegistry();
  // Каталог OAuth-провайдеров из конфига инстанса (`oauth.providers`): без него
  // refresh живого доступа не работает — провайдера не найти.
  await registerOAuthProvidersFromConfig(oauthProviders, config.oauthProviders, { dataDir });
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

  // Парсим провайдеров из переменных окружения (в деградации — не пишем в фоллбек).
  if (!storageDegraded) await syncProvidersFromEnv(providerStore, modelStore);

  const eventBus = new EventBus();
  const queueManager = new QueueProcessorManager();
  // ADR-102: процессор очереди персистит пользовательские сообщения — его
  // точка записи инкрементирует `activity.messages_user`.
  queueManager.setAnalytics(analytics);

  // Этап 1 roadmap 0.13 (блок 3): сервис «вопрос пользователю» (`ask_user`).
  //
  // Один инстанс на процесс: его получают и оркестратор (тул `question`), и
  // HTTP-роуты сессий (`GET /:id/questions`, `POST .../answer|cancel`).
  // Порт записи — из контекста хранения (ADR-096); срок ожидания ответа — из
  // конфигурации `questions.timeoutMs` (`0` — без таймаута).
  const questionService = storageDegraded
    ? undefined
    : new QuestionService({
        repository: storageContext.questions,
        eventBus,
        timeoutMs: config.questionsConfig?.timeoutMs ?? 0,
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
        getRetentionDays: () => config.questionsConfig?.retentionDays ?? 14,
      });

  // Этап 1 roadmap 0.13 (блок 4): единый реестр фоновых прогонов (PROP-096).
  //
  // Один инстанс на процесс: его получают тул `task` (фоновый запуск
  // саб-агента) и HTTP-точки обслуживания реестра. Порт записи — из контекста
  // хранения (ADR-096); лимиты — из конфигурации `background.*`.
  //
  // Уведомление родителя о завершении фонового прогона (ADR-111): ОДИН путь —
  // постановка в очередь (`enqueueUserMessage`); процессор добавит сообщение в
  // историю сам и опубликует `message.added` (двух копий больше нет).
  // `processMessage` собирается ниже (после оркестратора) — нотификатор
  // создаётся лениво, при первом вызове колбэка (он приходит только из
  // фонового прогона, т.е. уже после старта).
  /**
   * ADR-111/ADR-113: идёт ли ход в сессии. Активный ход → уведомление
   * вклинивается в него (`steerInbox`), иначе — обычная очередь + автоход.
   * `currentStream.cancelled` — ход уже отменяется, инъекция не нужна.
   * Одна функция на нотификатор и матрицу ретрансляции (ниже).
   */
  const isBackgroundTurnActive = async (sid: string): Promise<boolean> => {
    if (queueManager.isRunning(sid)) return true;
    const current = await sessionManager.getSession(sid);
    const stream = current?.currentStream;
    if (!stream || stream.cancelled) return false;
    return current?.status?.cancelRequested !== true;
  };

  /**
   * Корень дерева сессий (обход `parentId` вверх, глубина ≤ 5, защита от
   * циклов) — для ретрансляции результата фонового прогона из дочерней сессии.
   * Возвращает `{id, title}`; ошибка/нет сессии → `null` (fail-safe: доставим
   * владельцу, как раньше).
   */
  const resolveRootSession = async (
    sessionId: string,
  ): Promise<{ id: string; title?: string } | null> => {
    let current = await sessionManager.getSession(sessionId);
    if (!current) return null;
    const seen = new Set<string>([current.id]);
    for (let depth = 0; depth < 5 && current.parentId; depth += 1) {
      if (seen.has(current.parentId)) break;
      const parent = await sessionManager.getSession(current.parentId);
      if (!parent) break;
      seen.add(parent.id);
      current = parent;
    }
    return { id: current.id, ...(current.title ? { title: current.title } : {}) };
  };

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
      isTurnActive: isBackgroundTurnActive,
    });
    await backgroundNotifier(sessionId, message);
  };

  /**
   * ADR-104 × ADR-111/ADR-113: остаток steer-очереди в конце хода не теряется —
   * **все** сообщения (пользовательский ввод и уведомления фоновых прогонов)
   * возвращаются в `pendingMessages`; `autostart` поднимает ход (нормальное
   * завершение), при «Стопе» — нет (ждём пользователя).
   * `processMessage` объявлен ниже — вызов происходит уже в рантайме.
   */
  const requeueSteerMessages = async (
    sessionId: string,
    messages: Message[],
    autostart: boolean,
  ): Promise<{ requeued: number; dropped: number }> => {
    return requeueMessages({
      sessionManager,
      eventBus,
      sessionId,
      messages,
      ...(autostart
        ? { autostart: { processorManager: queueManager, processMessage, eventBus } }
        : {}),
    });
  };
  const backgroundService = storageDegraded
    ? undefined
    : new BackgroundRunService({
        repository: storageContext.backgroundRuns,
        eventBus,
        // Снимок — fallback; живой резолвер читается на каждый запуск
        // (runtime-настройка применяется без рестарта).
        limits: {
          maxSubagentsPerSession: config.backgroundConfig?.maxSubagentsPerSession ?? 2,
          // PROP-097: лимит одновременных фоновых шелл-процессов на сессию.
          maxProcessesPerSession: config.backgroundConfig?.maxProcessesPerSession ?? 5,
          maxRunsPerSession: config.backgroundConfig?.maxRunsPerSession ?? 10,
        },
        getLimits: () => backgroundSettings.getLimits(),
        // Точка сборки уведомления — здесь (глобальных синглтонов нет).
        onNotifyParent: notifyBackgroundParent,
        // ADR-111/ADR-113: матрица доставки — если прогон запущен в дочерней
        // сессии и её ход не идёт, результат ретранслируется в корень.
        isTurnActive: isBackgroundTurnActive,
        resolveRootSessionId: resolveRootSession,
        // «Стоп» сессии останавливает и живые прогоны детей (ADR-111 §detach,
        // решение 2026-10-28): дерево обходит сам сервис (глубина ≤ 5).
        getChildSessionIds: async (parentId) =>
          (await sessionManager.getChildren(parentId, { light: true })).map((s) => s.id),
      });
  // Старт: прогоны прошлого процесса не пережили рестарт (хэндлы отмены — в
  // памяти) — помечаем их `orphaned`. Best-effort: ошибка не роняет старт.
  if (backgroundService) {
    let recovered: BackgroundRunRecord[] = [];
    try {
      recovered = await backgroundService.recoverOnStart();
    } catch (err) {
      console.warn(
        `[background] восстановление фоновых прогонов не удалось: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // PROP-143 §4 п.3: факт прерывания возвращается в историю сессии-владельца
    // (durable-запись `execution_stopped`) — иначе о потере прогона знает только
    // реестр, а не человек/родитель. Ход не запускается — только дозапись.
    if (recovered.length) {
      try {
        const written = await appendLostRunRecords({
          sessionManager,
          eventBus,
          records: recovered,
          logger: { warn: (message: string) => console.warn(message) },
        });
        console.log(
          `[background] фоновые прогоны прерваны рестартом: осиротело ${recovered.length}, записей в историю добавлено ${written}`,
        );
      } catch (err) {
        console.warn(
          `[background] записи о прерванных прогонах не добавлены: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  /**
   * Info-блок «ход продолжен после рестарта»: пишется в историю (роль INFO — в
   * LLM-контекст не попадает) и публикуется `message.added`. Дубль для того же
   * `stream_id` не пишется: recovery и автоскан очередей могут указывать на одно
   * и то же сообщение.
   */
  const addRestartResumedNotice = async (
    sessionId: string,
    streamId: string | undefined,
  ): Promise<void> => {
    const session = await sessionManager.getSession(sessionId);
    const alreadyNotified = session?.messages.some(
      (m) => m.metadata?.type === 'restart_resumed'
        && (m.metadata?.stream_id as string | undefined) === streamId,
    );
    if (alreadyNotified) return;
    const info: Message = {
      id: generateId(),
      role: MessageRole.INFO,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(RESTART_RESUMED_TEXT)],
      content: RESTART_RESUMED_TEXT,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      metadata: {
        type: 'restart_resumed',
        ...(streamId ? { stream_id: streamId } : {}),
        i18n: { key: 'chat.notice.restartResumedText' },
      },
    };
    let index = 0;
    try {
      const updated = await sessionManager.addMessage(sessionId, info);
      if (updated) index = Math.max(0, updated.messages.length - 1);
    } catch (err) {
      console.warn(
        `[sessions] info-блок восстановления не записан: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    eventBus.publish(sessionId, 'message.added', serializeMessage(info, index));
  };
  // Session-маркеры хода/блокировки переживают рестарт: процесс, убитый при
  // rolling update, не успевает снять `currentStream`/`status.blocked`, а
  // процессор очереди такую сессию считает занятой и не стартует — UI вечно
  // показывает активность. Восстановление отложено на 60 с, чтобы старый под
  // успел умереть, а живые маркеры работающего процесса не были сняты.
  // В деградации хранилище read-only — ничего не пишем и не запускаем.
  //
  // PROP-142 §3: автовосстановление — **под бюджетом** (попытки на ход +
  // детект crash-loop). Секция `recovery` конфига (`shared/config/types.ts`).
  const recoveryBudget = resolveRecoveryBudget(config);
  /**
   * Отказ по бюджету автовосстановления: след в истории (PROP-143) —
   * durable-запись `execution_stopped` с причиной `orphaned`. Запись
   * идемпотентна по `dedupeKey` (ход/сессия), ошибка записи не ломает boot.
   */
  const recordRecoveryDenied = async (
    sessionId: string,
    reason: string,
    dedupeKey: string,
  ): Promise<void> => {
    try {
      await appendStopRecord({
        sessionManager,
        eventBus,
        sessionId,
        input: { reason: 'orphaned', error: `recovery budget exhausted (${reason})` },
        dedupeKey,
      });
    } catch (err) {
      console.warn(
        `[sessions] запись об отказе восстановления не добавлена: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.warn(`[sessions] восстановление ${sessionId} запрещено бюджетом (${reason})`);
  };
  if (!storageDegraded) {
    const bootRecovery = setTimeout(() => {
      void sessionManager.recoverInterruptedSessions()
        .then(async (recovered) => {
          for (const r of recovered) {
            eventBus.publish(r.sessionId, 'turn.finished', {
              turn_id: r.turnId,
              turnId: r.turnId,
              stream_id: r.streamId,
              status: 'stopped',
            });
            eventBus.publish(r.sessionId, 'session.updated', { session_id: r.sessionId });
            // PROP-142 §3: план восстановления — вид сессии (основная/дочерняя)
            // и бюджет попыток/crash-loop. Одна сессия не должна ломать boot.
            try {
              const session = await sessionManager.getSession(r.sessionId);
              const plan = planBootRecovery({
                sessions: [
                  {
                    id: r.sessionId,
                    ...(session?.parentId ? { parentId: session.parentId } : {}),
                    ...(session?.sessionOrigin ? { sessionOrigin: session.sessionOrigin } : {}),
                    ...(session?.status.recovery ? { recovery: session.status.recovery } : {}),
                  },
                ],
                config: recoveryBudget,
              })[0];
              if (!plan) continue;
              if (plan.action === 'deny') {
                // Бюджет исчерпан: ход терминализируется, след — в истории.
                await recordRecoveryDenied(
                  r.sessionId,
                  plan.reason,
                  `recovery:${r.turnId ?? r.sessionId}`,
                );
                continue;
              }
              if (plan.action === 'resume-child') {
                // Дочерняя сессия (саб-агент): её цикл ведёт родитель — процессор
                // очереди не создаём (у ребёнка нет своей очереди), возобновляем
                // через цикл саб-агента (PROP-142 §3).
                await recordRecoveryAttempt(sessionManager, r.sessionId);
                try {
                  await orchestrator.startSubagentResume(r.sessionId);
                  await addRestartResumedNotice(r.sessionId, r.streamId);
                } catch (err) {
                  console.warn(
                    `[sessions] возобновление дочерней сессии не выполнено: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
                continue;
              }
              // Основная сессия — прежнее поведение автопродолжения.
              if (!r.resumeMessage) continue;
              await recordRecoveryAttempt(sessionManager, r.sessionId);
              // Автопродолжение: info-блок в истории (в LLM-контекст не попадает —
              // роль INFO исключена из промпта) и resume-сообщение процессору.
              await addRestartResumedNotice(r.sessionId, r.streamId);
              queueManager.createProcessor(r.sessionId, sessionManager, eventBus, processMessage, {
                resumeMessage: r.resumeMessage,
              });
            } catch (err) {
              console.warn(
                `[sessions] восстановление сессии не выполнено: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          if (recovered.length) {
            console.log(`[sessions] сняты маркеры прерванных ходов: ${recovered.length}`);
          }
          // Автозапуск очередей, переживших рестарт: pending без активного хода
          // и без осознанной остановки (`queueStopped`). Сессии саб-агентов не
          // продолжаем — решение за родителем. `light`-список не подходит:
          // он очищает `pendingMessages`.
          try {
            // Список сессий — всегда лёгкий (без истории `messages`/`checkpoints`):
            // полный список сессий с историями давал пик heap и OOM на инстансах
            // с сотнями сессий. Очередь (`pendingMessages`) в лёгкой выборке
            // сохраняется.
            const sessions = await sessionManager.listSessions(undefined, {
              includeArchived: false,
            });
            let queueCandidates = 0;
            let inFlightResumed = 0;
            for (const s of sessions) {
              if (s.archivedAt || s.sessionOrigin === 'subagent') continue;
              if (s.currentStream || s.status.blocked) continue;
              if (s.pendingMessages.length === 0) continue;
              queueCandidates += 1;
              try {
                // PROP-142 §3: бюджет автовосстановления — до любых действий
                // (в т.ч. `queue.stalled`): при отказе очередь не трогаем, след
                // в истории оставляем.
                const plan = planBootRecovery({
                  sessions: [
                    {
                      id: s.id,
                      ...(s.parentId ? { parentId: s.parentId } : {}),
                      ...(s.sessionOrigin ? { sessionOrigin: s.sessionOrigin } : {}),
                      ...(s.status.recovery ? { recovery: s.status.recovery } : {}),
                    },
                  ],
                  config: recoveryBudget,
                })[0];
                if (plan?.action === 'deny') {
                  await recordRecoveryDenied(s.id, plan.reason, `recovery:queue:${s.id}`);
                  continue;
                }
                if (s.status.queueStopped) {
                  eventBus.publish(s.id, 'queue.stalled', {
                    pending_count: s.pendingMessages.length,
                  });
                  continue;
                }
                // Маркеры мог снять прошлый recovery, а сообщение осталось и в
                // истории, и в очереди. Это прерванный in-flight ход: продолжаем
                // его как resume (info-блок + метка `resumed`), а не как новую
                // очередь — иначе сообщение материализуется в историю повторно.
                const resume = await sessionManager.takePendingInFlight(s.id);
                if (resume) {
                  inFlightResumed += 1;
                  await recordRecoveryAttempt(sessionManager, s.id);
                  await addRestartResumedNotice(
                    s.id,
                    resume.metadata?.stream_id as string | undefined,
                  );
                  queueManager.createProcessor(s.id, sessionManager, eventBus, processMessage, {
                    resumeMessage: resume,
                  });
                  continue;
                }
                await recordRecoveryAttempt(sessionManager, s.id);
                queueManager.createProcessor(s.id, sessionManager, eventBus, processMessage);
              } catch (err) {
                console.warn(
                  `[sessions] автозапуск очереди не выполнен: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
            if (queueCandidates > 0) {
              // Только счётчики: ни id, ни содержимого сессий/сообщений.
              console.log(
                `[sessions] автозапуск очередей: кандидатов ${queueCandidates}, in-flight продолжено ${inFlightResumed}`,
              );
            }
          } catch (err) {
            console.warn(
              `[sessions] автозапуск очередей после рестарта: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })
        .catch((err) => {
          console.warn(
            `[sessions] восстановление прерванных ходов: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }, 60_000);
    bootRecovery.unref?.();
  }
  // Retention-очистка терминальных записей реестра (сразу + каждые 6 ч).
  const stopBackgroundRunPruner = storageDegraded
    ? () => {}
    : startBackgroundRunPruner(storageContext.backgroundRuns, {
        // Живой резолвер: retention-настройка применяется на каждом тике.
        getRetentionDays: () => backgroundSettings.getRetentionDays(),
      });
  // PROP-097 (блок 5b): retention логов фоновых процессов. Создаётся **до**
  // pruner'а записей реестра: лог удаляется, пока его запись ещё видна.
  const stopProcessLogPruner = storageDegraded
    ? () => {}
    : startProcessLogPruner(storageContext.backgroundRuns, storageContext.blobs, {
        // Живой резолвер: retention-настройка применяется на каждом тике.
        getRetentionDays: () => backgroundSettings.getRetentionDays(),
      });
  // ADR-094/ADR-115: метрики вложений (`synth_attachment_*`) — создаются до GC,
  // чтобы счётчик удалённых объектов был доступен при первом прогоне.
  // `metrics` приходит только при `metrics.enabled=true`.
  const attachmentMetrics = metrics ? createAttachmentMetrics(metrics) : undefined;
  // ADR-115: GC осиротевших вложений. Критерий — нет ссылок (`blob_refs`) И
  // объект старше `attachments.gcDays` (живой объект может быть старым —
  // удалять по возрасту нельзя). `gcDays <= 0` — без ограничения. Значение
  // читается на каждом прогоне (runtime-настройка применяется без рестарта).
  const stopAttachmentPruner = storageDegraded
    ? () => {}
    : startAttachmentPruner({
        blobs: storageContext.blobs,
        blobRefs: storageContext.blobRefs,
        gcDays: () => attachmentsSettings.getConfig().gcDays,
        ...(attachmentMetrics ? { metrics: attachmentMetrics } : {}),
      });

  // ADR-115 × ADR-077: уборка временных каталогов медиа-раннера
  // (`{workspacesRoot}/.synth-media/<uuid>`). После жёсткого kill раннер не
  // успевает убрать каталог (`finally` не выполняется) — такие каталоги
  // копятся на общем томе. TTL 1 ч, интервал 6 ч, best-effort: каталога нет —
  // нечего убирать (создавать его не надо). В деградированном режиме
  // хранилища уборка не нужна (медиа не обрабатывается).
  const stopMediaTempPruner = storageDegraded
    ? () => {}
    : startMediaTempPruner({
        workspacesRoot: config.workspacesRoot ?? join(dataDir, 'workspaces'),
      });

  // ADR-094: доменные коллекторы. `metrics` приходит только при
  // `metrics.enabled=true` — иначе реестр остается пустым (`/metrics` → 404).
  // Фоновые таймеры `unref`-ятся; остановка — `stopMetricsCollectors` на
  // graceful shutdown (`app.ts` / `main.ts`).
  const stopMetricsCollectors: Array<() => void> = [];
  // ADR-094: доменные хуки (колбэки сервисов) — создаются только при включённых метриках.
  const schedulerJobMetrics = metrics ? createSchedulerMetrics(metrics) : undefined;
  const webhookDeliveryMetrics = metrics ? createWebhookMetrics(metrics) : undefined;
  const eventMetrics = metrics ? createEventMetrics(metrics) : undefined;
  // ADR-106 Ф1: решения Authority-слоя (`synth_authority_decisions_total`) —
  // лейблы только `action`/`effect`/`source`, без id (ADR-094).
  const authorityMetrics = metrics ? createAuthorityMetrics(metrics) : undefined;
  if (metrics) {
    // ADR-115: сервис вложений собирается внутри фабрики роутов сессий, куда
    // метрики не прокинуть — ставим хуки в sink коллектора (снимается на stop).
    stopMetricsCollectors.push(setAttachmentMetricsHook(attachmentMetrics ?? null));
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

  // PROP-136 (слайс 136a): append-only журнал исполнений `execute_shell`/
  // `sandbox_exec`. Один экземпляр на инстанс: его пишет оркестратор и читает
  // `GET /api/v2/audit/commands`. `enabled` — `security.commandAudit`
  // (`SYNTH_COMMAND_AUDIT_ENABLED`); standalone по умолчанию выключен.
  const commandAuditMetrics = metrics ? createCommandAuditMetrics(metrics) : undefined;
  const commandAuditLog = createCommandAuditLog({
    dataDir,
    ...(config.securityConfig?.commandAudit ? { config: config.securityConfig.commandAudit } : {}),
    ...(commandAuditMetrics ? { metrics: commandAuditMetrics } : {}),
  });

  // PROP-136b (слайс 136b-2a): зеркальный чекер команд. Провайдер строится при
  // старте из `security.commandPolicy` (как у исполнителя: `enabled: true` без
  // адреса — ошибка старта, fail-closed). `enabled: false` → `null` — поведение
  // прежнее. Метрики — `synth_command_policy_*`.
  const commandPolicyMetrics = metrics ? createCommandPolicyMetrics(metrics) : undefined;
  const commandPolicyProvider = effectiveSecurityConfig?.commandPolicy
    ? createCommandPolicyProvider(effectiveSecurityConfig.commandPolicy, {
        ...(commandPolicyMetrics ? { metrics: commandPolicyMetrics } : {}),
      })
    : null;

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
    const provider = providerCache.get(name);
    // Fail-closed: отключённый администратором провайдер не создаётся ни в чате,
    // ни в ретраях, ни в пайплайнах/эмбеддингах/суммаризации.
    if (!provider || provider.enabled === false) return null;
    return provider;
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

  // ADR-090 (Ф3а): **один** реестр провайдеров блоков
  // системного промпта на инстанс. Композер добавляет блоки в промпт сессии,
  // фасад плагинов (`PluginRuntime` → `PluginHost`) регистрирует их — экземпляр
  // обязан быть общим, иначе плагинные блоки в промпт не попадут.
  const promptBlocks = new PromptBlockRegistry();

  // Набор ролей прежней поставки (`pm`/`developer`/`qa`/`analyst`/`auditor`)
  // заменён на `leader`/`fixer`/`tester`/`researcher`/`security-auditor`, но в
  // сторе остаются полные копии прежних встроенных агентов. Без миграции в
  // списке живут две роли сразу, а старая несёт подменённый `contextFile` при
  // прежней идентичности/правах (агент получает чужую роль с чужими правами).
  // Переносим пользовательские настройки в целевого встроенного агента,
  // устаревшую запись удаляем; идемпотентно.
  try {
    const migratedAgents = await migrateLegacyStoredAgents(agentStore);
    if (migratedAgents.length > 0) {
      console.info(`[agents] миграция устаревших агентов: ${migratedAgents.join(', ')}`);
    }
  } catch (err) {
    console.warn(
      `[agents] не удалось мигрировать устаревших агентов: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

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

  // ADR-126: сервис скиллов — discovery (instance/project/config.paths) + запись
  // instance-дерева + каталог в промпт и тул `skill`.
  // ADR-116: instance-скиллы — порт слоя хранения (`storageContext.skills`):
  // при `storage.backend=postgres` это метаданные в SQL + содержимое в blobs,
  // при file/memory — файловый/в-памяти стор. Без передачи порта сервис создал
  // бы собственный файловый `SkillStore` и писал мимо backend'а.
  const skillService = new SkillService({
    dataDir,
    store: storageContext.skills,
    configPaths: config.skillsConfig?.paths,
    urls: config.skillsConfig?.urls,
    trustedProjectDirs: effectiveSkillsTrustedProjectDirs,
    toolsets: config.skillsConfig?.toolsets,
  });

  // ADR-126 §7/§4.3: read-only индексация skills.urls — фоном, старт не блокируем.
  void skillService.refreshRemote().catch(() => {});

  // ADR-126 §4: сервис сниппетов (`#`) — три уровня (`instance`/`project`/`user`),
  // discovery + запись файлов + раскрытие. Project-trust — тот же гейт, что у
  // скиллов и команд (`skills.trustedProjectDirs`).
  const snippetService = new SnippetService({
    dataDir,
    trustedProjectDirs: effectiveSkillsTrustedProjectDirs,
  });

  // ADR-092: авто-миграции схемы данных при старте — с обязательной страховочной
  // копией и под межпроцессным локом. Миграция снапшотов скоупа — зарегистрированная
  // миграция реестра (`session-scope-snapshots-v1`, маркер внутри сохранён → no-op
  // при повторном запуске), отдельный прямой вызов больше не нужен.
  // Fail-closed: ошибка копии/миграции не глушится — старт прерывается.
  // ADR-098 (W5): в деградации миграции не применяем — фоллбек-каталог пуст,
  // а страховочная копия/миграция были бы доменной записью в фоллбек.
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
        // ADR-071 §2.5: дефолты MCP-серверов — из реестра (источник истины).
        mcpDefaultOn: await mcpRegistryStore.toDefaultServers(),
        skillsDefaultOn: (await resolveProjectSkillSeed(
          skillService,
          await settingsStore.getSkillsDisabledForNewProjects(),
        )).enabled,
      }),
    });
  }

  // ADR-126 §1: slash-команды и bundles — единый резолвинг в core (UI/CLI/гибрид).
  const commandService = new CommandService({
    config: {
      dataDir,
      commandsPaths: config.commandsConfig?.paths ?? [],
      bundlesPath: config.commandsConfig?.bundlesPath ?? 'skill-bundles',
      conflict: config.commandsConfig?.conflict ?? { mode: 'bundle-wins', namespacePrefix: false },
      maxArgumentsLength: config.commandsConfig?.maxArgumentsLength ?? 10_000,
      maxRenderedBytes: config.commandsConfig?.maxRenderedBytes ?? 200_000,
      toolsets: config.skillsConfig?.toolsets ?? {},
      trustedProjectDirs: effectiveSkillsTrustedProjectDirs,
      inlineShell: config.skillsConfig?.inlineShell ?? false,
    },
    skillRuntime: skillService,
    skillSource: skillService,
    bundleStore,
  });

  // ADR-077: порт исполнения команд. Режим (`inline`/`remote`) — параметр
  // запуска процесса (инвариант 24), поэтому порт собирается здесь, при
  // старте, и не переинициализируется на лету. Выбор режима — фабрика
  // `execution/factory.ts` (`remote` → удалённый порт, fail-closed).
  //
  // ADR-094: удалённому порту передаётся приёмник метрик исполнения
  // (`synth_executor_*`): очередь, занятость пула, ожидание и исход команд.
  // Реестр метрик в пакет исполнителя не попадает — только узкий интерфейс.
  const executorMetrics = metrics ? createExecutorMetricsCollector(metrics) : undefined;
  // PROP-135 Ф4b-1: при `provider: http` адреса исполнителей приходят от
  // provisioner'а — instance-порт собирается **лениво** (на instance-пул),
  // статический `execution.remote.url` не требуется.
  const executionPort = await createInstanceExecutionPort(
    effectiveExecutionConfig,
    executorMetrics ? { metricsSink: executorMetrics } : undefined,
  );

  // PROP-135 Ф4a: роутер портов исполнения (пулы/профили). Порты профилей
  // создаются **на старте** (инвариант 24: `execution.*` — параметр запуска),
  // поэтому роутер синхронен: `portFor(profile)` отдаёт порт профиля.
  // Instance-порт переиспользуется (второй клиент удалённого пула не нужен).
  const executionRouter = await createExecutionRouter({
    config: effectiveExecutionConfig,
    ...(executorMetrics ? { metricsSink: executorMetrics } : {}),
    instancePort: executionPort,
  });

  // PROP-135 слайс 5b-2: резолвер **проектного** (браузерного) пула для
  // вызовов MCP-инструментов исполнителя: по `projectId` цели — адреса и
  // токен пула `project:<id>:browser:<profile>`. Роутер не умеет отдавать
  // ссылку (`poolRefFor` нет — `inline`/вырожденный роутер) → резолвера нет,
  // вызовы идут с инстанс-пула (прежнее поведение).
  const executorMcpResolvePool = createExecutorMcpPoolResolver(executionRouter);

  // PROP-132 (Ф3в): сервис терминалов инстанса — **один экземпляр на процесс**
  // (реестр живых терминалов, поток вывода, ввод, лимиты, аудит, метрики).
  //
  // Жизненный цикл — здесь, а не в `mount-routes.ts`: сервис гасится на
  // graceful shutdown (`stopTerminalService`), а мастер-выключатель
  // `terminal.enabled` применяется **live** (`setEnabled`): живые терминалы
  // закрываются, создание новых запрещается — рестарт не нужен.
  //
  // Зависимости: порт исполнения (PTY открывается на точке исполнения,
  // ADR-077), шина сессий (метаданные терминала), журнал исполнений команд
  // (ADR-136 — только метаданные), реестр метрик (ADR-094) и менеджер
  // сессий (правило idle: живой терминал не убиваем, пока в сессии идёт ход).
  //
  // PROP-135: порт терминала выбирается **тем же** роутером, что и порт тулов
  // (профиль по binding'у + область пула + `workspaceSubPath`) — терминал живёт
  // на той же точке исполнения, что и ход сессии.
  const terminalPortResolver = createTerminalPortResolver({
    router: executionRouter,
    sessions: { getSession: (id: string) => sessionManager.getSession(id) },
    projects: { load: (id: string) => projectStore.load(id) },
    agents: { get: (role: string) => agentRegistry.get(role) },
    workspacesRoot: config.workspacesRoot ?? join(dataDir, 'workspaces'),
  });
  // Эффективные настройки секции `terminal` (env > runtime > config > default,
  // по каждому полю): читаются **до** сборки сервиса — параметры выполнения
  // (`idleMinutes`/`maxPerProject`/`maxPerInstance`), оболочка новых терминалов
  // и журналирование ввода приезжают стартовыми значениями, а дальше меняются
  // live из `/api/v2/settings/terminal`.
  const terminalRuntime = await settingsStore.getTerminal();
  const terminalSettings = resolveTerminalSettings({
    ...(config.terminalConfig ? { config: config.terminalConfig } : {}),
    runtime: terminalRuntime,
    env: process.env,
  });
  const terminalService = createTerminalService({
    port: executionPort,
    resolvePort: terminalPortResolver,
    blobs: storageContext.blobs,
    eventBus,
    commandAuditLog,
    ...(metrics ? { metrics } : {}),
    sessions: { getSession: (id: string) => sessionManager.getSession(id) },
    limits: {
      idleMs: terminalSettings.idleMinutes * 60_000,
      maxPerProject: terminalSettings.maxPerProject,
      maxPerInstance: terminalSettings.maxPerInstance,
    },
    defaultShell: terminalSettings.shell,
    auditInput: terminalSettings.auditInput,
    // PROP-132 (Ф5): результат запуска команды в терминале приходит в сессию
    // **сообщением** — тем же нотификатором, что у фоновых шелл-процессов
    // (ADR-113): ровно одна копия (steer при активном ходе, иначе очередь).
    onRunFinished: async (run, terminal) => {
      const sessionId = terminal?.sessionId ?? run.sessionId;
      if (!sessionId) {
        // Терминал без привязки к сессии — уведомлять некуда (только лог).
        console.warn(
          `[terminal] терминал ${run.terminalId} не привязан к сессии — результат запуска ${run.runId} не доставлен`,
        );
        return;
      }
      await notifyBackgroundParent(sessionId, buildTerminalRunNotification(run));
    },
  });
  // PROP-132: восстановление терминалов из снимков — тот же порядок
  // приоритета. Значение применяется **до** восстановления: выключенное
  // восстановление → снимки не поднимаются (их уберёт reaper).
  terminalService.setAutoRestore(terminalSettings.autoRestore);
  // Снимки терминалов поднимаются **до** применения мастер-выключателя:
  // восстановление поднимает **процесс** (новый PTY) для терминалов, живых на
  // момент остановки, — при выключенном контуре они сразу закрываются
  // (`setEnabled(false)`), при включённом возвращаются с сохранённой историей
  // вывода.
  const restoredTerminals = await terminalService.restoreFromSnapshots();
  if (restoredTerminals > 0) {
    console.log(`[terminal] восстановлено терминалов из снимков: ${restoredTerminals}`);
  }
  terminalService.setEnabled(terminalSettings.enabled);

  // PROP-097 (блок 5b): сервис фоновых шелл-процессов.
  //
  // Тот же порт исполнения, что у тулов (ADR-077): фон — это лишь способ
  // ожидания, а не отдельный путь исполнения. Учёт прогона — общий реестр
  // фоновых прогонов (`kind: 'process'`), лог — blob-хранилище (ADR-096).
  // В деградированном режиме хранилища сервиса нет (писать некуда).
  //
  // Логгер сервиса: предупреждения — в вывод процесса (в journal — консоль).
  const processLogger = { warn: (message: string) => console.warn(message) };
  const processService = backgroundService
    ? new ProcessService({
        executionPort,
        background: backgroundService,
        blobs: storageContext.blobs,
        eventBus,
        // Снимок — fallback; живой предел лога читается при создании лога.
        limits: { maxLogBytes: config.backgroundConfig?.logMaxBytes ?? 10_485_760 },
        getMaxLogBytes: () => backgroundSettings.getMaxLogBytes(),
        logger: processLogger,
        // ADR-136/ADR-126 §5: терминальный переход фонового процесса
        // дописывает в журнал исполнений парную запись `finished`
        // (только метаданные — вывод процесса не пишется).
        onFinished: createScriptRunAuditFinisher({
          audit: commandAuditLog,
          logger: processLogger,
        }),
      })
    : undefined;

  // ADR-126 §5: сервис реестра скриптов проекта (`!`-запуск).
  //
  // Тот же экземпляр получают HTTP-роуты `/api/v2/sessions/:id/scripts*` и
  // тулы `script_list`/`script_run`. Создаётся только вместе с
  // `processService`: запускать скрипты негде (фоновые процессы в
  // деградированном режиме хранилища не создаются — писать прогоны некуда).
  const scriptService = processService
    ? new ScriptService({
        config: {
          dataDir,
          scriptsPaths: config.scriptsConfig?.paths ?? [],
          trustedProjectDirs: effectiveSkillsTrustedProjectDirs,
        },
        processService,
      })
    : undefined;

  // ADR-114: сервис worktree (per-session рабочий каталог).
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
        workspacesRoot: config.workspacesRoot ?? join(dataDir, 'workspaces'),
        execution: executionPort,
        defaultWorkingDir,
        // Привязанная живая сессия — по полю `session.worktree` (ADR-114 §1.3).
        resolveAttachedSession: async (worktreeId: string) => {
          const sessions = await sessionManager.listSessions(undefined);
          return sessions.find((s) => s.worktree?.worktreeId === worktreeId)?.id;
        },
        onUpdated: (projectId: string, detail) => {
          void publishWorktreeUpdated({ eventBus, sessionStore: sessionManager }, {
            projectId,
            ...(detail.worktreeId !== undefined ? { worktreeId: detail.worktreeId } : {}),
            action: detail.action,
          });
        },
      });

  // ADR-114 §7.4: sweep осиротевших записей worktree при старте процесса
  // (записи без каталога — их чистит и prune проекта, §7.3). Фоново: старт
  // **не блокируется**, ошибка — в лог, процесс продолжает жить. В деградированном
  // режиме хранилища сервиса нет — вычищать нечего.
  if (worktreeService) startWorktreeSweeper(worktreeService);

  // ADR-077 (шаг B2): в split-режиме MCP-серверы поднимаются **в исполнителе**
  // (браузерные/tier-4 тулы) — control plane забирает их состав и инструменты
  // по HTTP API исполнителя. Только `mode=remote`: в `inline` источник не
  // создаётся, поведение прежнее. Ошибки discovery не валят старт (fail-closed
  // режима уже проверен сборкой порта исполнения выше).
  //
  // PROP-135 слайс 5b-2: состав читается с **инстанс-пула**, а вызовы
  // инструментов уходят в **проектный** (браузерный) пул — резолвер
  // `executorMcpResolvePool` (см. выше).
  const executorMcpSource = await attachExecutorMcpSource(mcpManager, effectiveExecutionConfig, {
    ...(executorMcpResolvePool ? { resolvePool: executorMcpResolvePool } : {}),
  });

  // ADR-070 §2.9.1/ADR-101: зависимости окружения (git/rg/sh) — детекция при
  // старте, fail-open при ошибке. Пробинг идёт до сборки оркестратора, чтобы
  // первый же запрос видел корректную доступность. Общий для оркестратора и
  // движка пайплайнов (контекст шага, ADR-101 §10).
  //
  // ADR-077: проба бинарников идёт **через порт исполнения** — в split-режиме
  // они ищутся в окружении исполнителя. Порт передаётся здесь: кэш детекции
  // модульный, порт берётся из первого вызова (fail-closed в remote-режиме).
  const runtimeDeps = await detectRuntimeDeps(executionPort);

  // ADR-090 (долги Д3): эффективный конфиг слоя = config.yaml (+env) поверх
  // runtime-настроек — нужен **до** оркестратора: бюджеты `promptBlockMaxChars`
  // и `llmFilterTimeoutMs` попадают в композер/реестр фильтров при сборке.
  const effectivePluginsConfig = mergePluginsConfig(
    config.pluginsConfig,
    await settingsStore.getPlugins(),
  );

  // ADR-106 Ф1/Ф2: Authority-слой. Решение считается и пишется в журнал
  // (`{dataDir}/audit/authority.jsonl` через порт). При `authority.enabled`
  // **без** `authority.shadow` решение **применяется** (Ф2): `deny`/`ask`
  // сужают решение permission-слоя.
  const authorityPolicy = (await storageContext.authorityPolicy?.getPolicy()) ?? null;
  const authorityGuard = config.authorityConfig?.enabled
    ? new AuthorityGuard({
        enabled: true,
        shadow: config.authorityConfig.shadow,
        journal: storageContext.authorityDecisions,
        policy: authorityPolicy,
        // ADR-094: счётчик решений Authority-слоя (`synth_authority_decisions_total`).
        onDecision: authorityMetrics?.onDecision,
      })
    : undefined;

  // ADR-106 Ф3: реестр подтверждений. Задаётся **только** в enforced-режиме
  // (слой Authority применяет решения): ответ на `permission_reply` принимает
  // лишь носитель покрывающего гранта. В shadow/выключенном режиме реестра
  // нет — поведение прежнее (решения не применяются).
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

  /**
   * ADR-115: модальности модели — только из её конфига (каталог провайдера при
   * синхронизации моделей либо ручной override). Справочника модальностей в
   * ядре нет (решение 2026-10-27): не нашли — `undefined`, и гидратация
   * вложений их не фильтрует (ошибку модальности вернёт провайдер).
   *
   * Один резолвер на инстанс: тот же нужен шагам пайплайна (ADR-115 × ADR-101),
   * иначе сессии и прогоны разошлись бы по фильтру модальностей.
   */
  const resolveModelModalities = (
    providerName: string,
    modelId: string,
  ): ModelConfig['modalities'] => {
    const direct = modelCache.get(`${providerName}/${modelId}`) ?? modelCache.get(modelId);
    if (direct?.modalities?.length) return direct.modalities;
    let prefixMatch: ModelConfig['modalities'];
    for (const model of modelCache.values()) {
      if (model.provider !== providerName || !model.modalities?.length) continue;
      if (model.name === modelId) return model.modalities;
      // В сессии имя может нести суффикс (например, `-1017`).
      if (!prefixMatch && modelId.startsWith(model.name)) prefixMatch = model.modalities;
    }
    return prefixMatch;
  };

  /**
   * Совместимость протокола по каталогу: `provider.compatibility` (JSON
   * провайдера) + shorthand `ModelConfig.requiresReasoning` +
   * `model.compatibility` (каталог/ручной override). Порядок слоёв —
   * provider → shorthand → модель (модель перекрывает).
   * `undefined` — явных значений нет, работают эвристики провайдера.
   */
  const resolveModelCompatibility = (
    providerName: string,
    modelId: string,
  ): ModelCompatibility | undefined => {
    const providerCompat = providerCache.get(providerName)?.compatibility;
    let model = modelCache.get(`${providerName}/${modelId}`) ?? modelCache.get(modelId);
    if (!model) {
      for (const candidate of modelCache.values()) {
        if (candidate.provider !== providerName) continue;
        if (candidate.name === modelId) {
          model = candidate;
          break;
        }
      }
    }
    const shorthand: ModelCompatibility | undefined = model?.requiresReasoning !== undefined
      ? { requireReasoning: model.requiresReasoning }
      : undefined;
    if (!providerCompat && !shorthand && !model?.compatibility) return undefined;
    return mergeModelCompatibility(providerCompat, shorthand, model?.compatibility);
  };

  /**
   * Лимит вывода модели из каталога (`ModelConfig.maxOutputTokens`): кап для
   * резолва `max_tokens` и источник значения при авто-лимите сессии.
   * `undefined` — у модели лимит неизвестен (или не положителен).
   */
  const resolveModelMaxOutputTokens = (
    providerName: string,
    modelId: string,
  ): number | undefined => {
    let model = modelCache.get(`${providerName}/${modelId}`) ?? modelCache.get(modelId);
    if (!model) {
      for (const candidate of modelCache.values()) {
        if (candidate.provider !== providerName) continue;
        if (candidate.name === modelId) {
          model = candidate;
          break;
        }
      }
    }
    return typeof model?.maxOutputTokens === 'number' && model.maxOutputTokens > 0
      ? model.maxOutputTokens
      : undefined;
  };

  /** Доступность провайдера для понятной ошибки хода (`provider_disabled`). */
  const providerAvailability = (name: string): 'ok' | 'missing' | 'disabled' => {
    const provider = providerCache.get(name);
    if (!provider) return 'missing';
    return provider.enabled === false ? 'disabled' : 'ok';
  };

  /** Включена ли модель (`false` — отключена); нет записи — `undefined`. */
  const resolveModelEnabled = (providerName: string, modelId: string): boolean | undefined => {
    let model = modelCache.get(`${providerName}/${modelId}`) ?? modelCache.get(modelId);
    if (!model) {
      for (const candidate of modelCache.values()) {
        if (candidate.provider !== providerName) continue;
        if (candidate.name === modelId) {
          model = candidate;
          break;
        }
      }
    }
    return model ? model.enabled !== false : undefined;
  };

  // Workstream A1: снимок метаданных инстанса для read-only тула `synth_info`.
  // Секретов нет: `localKeyPresent` — только факт существования файла (не
  // читаем), `apiKeyConfigured` — только флаг наличия значения.
  const authDebug = process.env.SYNTH_AUTH_DEBUG === 'true';
  const apiKeyConfigured = Boolean(config.apiKey || process.env.SYNTH_API_KEY);
  const localKeyPresent = existsSync(join(dataDir, 'secrets/api-key'));
  const instanceMeta: InstanceRuntimeMeta = {
    mode: config.hybridEnabled ? 'hybrid' : 'standalone',
    server: { port: config.port },
    auth: {
      mode: authDebug ? 'debug' : apiKeyConfigured ? 'api-key' : localKeyPresent ? 'local-key' : 'unknown',
      localKeyPresent,
      apiKeyConfigured,
      oidcEnabled: false,
      debug: authDebug,
    },
    storage: {
      backend: config.storageBackend ?? 'file',
      degraded: storageDegraded,
    },
    features: {
      mcp: true,
      metrics: Boolean(metrics),
      memory: true,
      restartMode: process.env.SYNTH_RESTART_MODE ?? 'disabled',
    },
  };

  // Явная аннотация: замыкания `sessionControl` ниже читают сам оркестратор
  // (лениво, в момент вызова тула) — без неё вывод типа зацикливается.
  const orchestrator: ChatOrchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    hooks,
    // ADR-106 Ф1/Ф2: шов решения Authority-слоя (считает, журналит и —
    // в enforced-режиме — применяет решение).
    authorityGate: authorityGuard?.gate,
    // ADR-106 Ф3: реестр подтверждений (привязка к ходу + носитель гранта).
    ...(approvalRegistry ? { approvalRegistry } : {}),
    // ADR-029: отдельное хранилище ожиданий подтверждения (ADR-096) —
    // персистентная копия ожидания, переживающая рестарт инстанса. Документ
    // сессии не трогаем: запись в него — полная замена истории, а результаты
    // параллельных тулов пишутся точечно (`appendMessage`, ADR-118 §4).
    ...(storageDegraded ? {} : { pendingApprovalRepository: storageContext.pendingApprovals }),
    // ADR-077: порт исполнения команд (inline — исполнение в процессе;
    // режим — параметр запуска, инвариант 24). Тот же порт получает и
    // детект внешних зависимостей (ниже) — иначе они смотрели бы в разные
    // места окружения.
    executionPort,
    // PROP-135 Ф4a: роутер портов — порт тулов выбирается по профилю
    // сессии (`session.settings.executorProfile`).
    executionRouter,
    // ADR-135/PROP-135: эффективная секция `execution` — из неё выводится вид
    // среды исполнения (блок `[СРЕДА ИСПОЛНЕНИЯ]` в системном промпте).
    ...(effectiveExecutionConfig ? { executionConfig: effectiveExecutionConfig } : {}),
    // PROP-135 слайс 5b-2: резолвер проектного (браузерного) пула для вызовов
    // MCP-инструментов исполнителя (в этом слайсе MCP-источник поднимается
    // выше по `attachExecutorMcpSource`; оркестратор поднимет свой, если
    // источник ещё не подключён).
    ...(executorMcpResolvePool ? { executorMcpResolvePool } : {}),
    // ADR-102: сборщик `usage`/`decision` роллапов (write-path).
    analytics,
    // Журнал решений по подтверждениям прав (`scope:'permission'`): цикл хода
    // пишет автоматические решения по правилам (режим `all`), менеджер
    // ожиданий — все исходы подтверждения (`onDecision` внутри оркестратора).
    // Отдельного события `grant` больше нет (см. `permission-audit.ts`).
    permissionAudit: permissionAuditSink,
    contextBuilder,
    contextConfig,
    providerLoader,
    contextOptimizer,
    modelPriceLoader,
    dataDir,
    toolRegistry,
    agentRegistry,
    // Реестр агентов как порт хранения — тулы `synth_agent_*` (тот же store,
    // что у HTTP-роутов `createAgentRoutes`).
    agentStore,
    // ADR-091/ADR-092: тулы обслуживания инстанса (`synth_maintenance_*`,
    // `synth_backup_*`, `synth_restore_*`, `synth_restart_request`) — те же
    // зависимости, что у HTTP-фабрики `createMaintenanceRoutes` (инстанс не
    // создаёт второй контекст хранения: проба БД и план миграций идут через
    // тот же `storageContext`, на котором работает процесс).
    maintenance: {
      dataDir,
      ...(config.secretKey !== undefined ? { secretKey: config.secretKey } : {}),
      env: process.env,
      audit: storageContext.maintenanceAudit,
      storageBackend: config.storageBackend ?? 'file',
      ...(storageContext.health
        ? { dbHealth: () => storageContext.health!() }
        : {}),
      ...(storageContext.schemaMigrations
        ? { schemaMigrations: (o?: { dryRun?: boolean }) => storageContext.schemaMigrations!(o) }
        : {}),
    },
    // ADR-092: сессии инстанса из чата (`synth_sessions_active`,
    // `synth_session_stop`, `synth_session_resume`). «Стоп» — тот же шов, что у
    // роута `POST /:id/abort` (`sessions/turn-abort.ts`), возобновление —
    // штатный funnel очереди (`enqueueUserMessage`, ADR-089/ADR-118); счётчики
    // фоновой работы — одним проходом по реестрам. Замыкания ленивые:
    // `orchestrator`/`processMessage` читаются в момент вызова тула, а не при
    // сборке контекста.
    sessionControl: {
      abortTurn: (sessionId, session) => abortSessionTurn(
        { sessionManager, orchestrator, queueManager, eventBus },
        sessionId,
        session,
      ),
      resumeSubagent: (sessionId, note) => orchestrator.startSubagentResume(
        sessionId,
        note !== undefined ? { prompt: note } : undefined,
      ),
      enqueueContinuation: async (sessionId, message) => Boolean(await enqueueUserMessage(
        sessionManager,
        eventBus,
        sessionId,
        message,
        queueManager,
        processMessage,
        // ADR-036: обфускация user-сообщения до записи в историю — паритет с
        // prompt-путём (сообщение-продолжение пишется как user-реплика).
        (sid, msg) => orchestrator.obfuscateUserMessageForHistory(sid, msg),
      )),
      isProcessorRunning: (sessionId) => queueManager.isRunning(sessionId),
      approvalCounts: () => orchestrator.listPendingApprovalCounts(),
      // PROP-132: живые терминалы привязаны к сессии; непривязанные в снимок
      // сессий не попадают.
      terminals: () => {
        const counts = new Map<string, number>();
        for (const record of terminalService.list()) {
          if (!record.sessionId) continue;
          counts.set(record.sessionId, (counts.get(record.sessionId) ?? 0) + 1);
        }
        return counts;
      },
      ...(backgroundService
        ? {
          // ADR-111/ADR-113: только идущие прогоны (терминальные — история).
          backgroundRuns: async () => {
            const counts = new Map<string, number>();
            for (const run of await backgroundService.list({ status: 'running' })) {
              counts.set(run.sessionId, (counts.get(run.sessionId) ?? 0) + 1);
            }
            return counts;
          },
        }
        : {}),
    },
    // ADR-090: тот же реестр, что у фасада плагинов
    // (ниже, `PluginRuntime`) — блоки плагинов попадают в промпт сессии.
    promptBlocks,
    projectStore,
    // Онбординг: тул `profile_update` сохраняет ответы интервью в профиль.
    profilesStore,
    // ADR-076 §T6: тот же store, что у git-роутов — без дублей инстансов.
    sshKeyStore,
    // ADR-076: таймауты сетевых git-операций (`git.cloneTimeoutMs`/`fetchTimeoutMs`)
    // для git-сервиса тулов `project_repo_*`; git-роуты получают те же значения.
    ...(config.gitConfig?.cloneTimeoutMs !== undefined
      ? { gitCloneTimeoutMs: config.gitConfig.cloneTimeoutMs }
      : {}),
    ...(config.gitConfig?.fetchTimeoutMs !== undefined
      ? { gitFetchTimeoutMs: config.gitConfig.fetchTimeoutMs }
      : {}),
    // Таймауты git-тулов по классу операции: локальные изменяющие и сетевые.
    ...(config.gitConfig?.localTimeoutMs !== undefined
      ? { gitLocalTimeoutMs: config.gitConfig.localTimeoutMs }
      : {}),
    ...(config.gitConfig?.networkTimeoutMs !== undefined
      ? { gitNetworkTimeoutMs: config.gitConfig.networkTimeoutMs }
      : {}),
    // Общий предел вывода инструментов (`tools.outputMaxLines`/
    // `tools.outputMaxBytes`) — усечение результата тула с пояснением.
    toolOutputLimits: {
      maxLines: config.toolsConfig?.outputMaxLines ?? DEFAULT_TOOL_OUTPUT_MAX_LINES,
      maxBytes: config.toolsConfig?.outputMaxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES,
    },
    // ADR-096 (W2.4): словари классификации — порт из контекста хранения.
    dictionaryStore,
    // ADR-115/ADR-116: blob-порт гидратации вложений — из контекста хранения,
    // без фоллбэка по `dataDir` (иначе standalone смотрел бы в другой корень).
    blobs: storageContext.blobs,
    // ADR-115: модальности модели — из её конфига (общий резолвер инстанса,
    // выше: им же пользуются шаги пайплайнов).
    resolveModelModalities,
    // Совместимость протокола (provider+model) из каталога.
    resolveModelCompatibility,
    // Лимит вывода модели из каталога (кап `max_tokens`) + дефолт `llm.maxTokens`.
    resolveModelMaxOutputTokens,
    // Понятные ошибки движка: провайдер отключён (`provider_disabled`) и модель
    // отключена (`model_disabled`) — fail-closed без LLM-вызова.
    providerAvailability,
    resolveModelEnabled,
    ...(config.llmMaxTokens !== undefined ? { defaultMaxOutputTokens: config.llmMaxTokens } : {}),
    // ADR-115: `attachments.workspaceFallback` — материализация отброшенных
    // вложений в workspace; live-конфиг (проверяется на каждый ход).
    attachmentsConfig: () => attachmentsSettings.getConfig(),
    // Политика контекстного окна — live-геттер (перед каждым LLM-вызовом).
    contextWindowPolicy: () => contextWindowSettings.getPolicy(),
    // Бюджет промпта саб-агента — live-геттер (runtime-настройка из UI).
    getSubagentMaxInputTokens: () => subagentMaxInputTokensSettings.getValue(),
    // ADR-115: каталог моделей инстанса для агента (тул `list_models`):
    // источники — каталог провайдеров и ручные override (тот же `modelStore`,
    // что у `GET /api/v2/models`), поэтому модальности совпадают с UI.
    listModels: () => modelStore.list(),
    // ADR-115: порт ссылок на blob-объекты — для инъекции вложений тулов
    // (`ToolResult.attachments`, включая `attach_workspace_file`).
    blobRefs: storageContext.blobRefs,
    defaultWorkingDir,
    workspacesRoot: config.workspacesRoot ?? join(dataDir, 'workspaces'),
    // ADR-075: тулы проекта (workspace) читают live-политику вне root.
    getWorkspaceOutsideRootPolicy: async () =>
      (await settingsStore.getWorkspacePolicy()) ?? config.workspaceOutsideRootPolicy ?? 'confirm',
    permissionConfig: config.permissionConfig,
    defaultPlanMode: config.defaultPlanMode,
    // Секция `session.autoTitle` — авто-именование сессии (ранний триггер).
    ...(config.sessionConfig?.autoTitle ? { autoTitle: config.sessionConfig.autoTitle } : {}),
    securityConfig: effectiveSecurityConfig,
    gatewayConfig,
    // PROP-136 (слайс 136a): журнал исполнений команд — тот же экземпляр
    // читает `GET /api/v2/audit/commands`.
    commandAudit: commandAuditLog,
    // PROP-136b (слайс 136b-2a): зеркальный чекер команд (нет — прежнее поведение).
    ...(commandPolicyProvider ? { commandPolicy: commandPolicyProvider } : {}),
    // ADR-036: общий AuditLogger — оркестратор и `GET /api/v2/audit` пишут
    // в один и тот же JSONL.
    gatewayAuditLogger,
    gatewayPayloadLogPath,
    gatewayPatternStore: patternStore,
    // ADR-090/«Точка promptBlocks»: бюджеты слоя плагинов.
    // Реестр фильтров создаётся оркестратором (`getLlmFilters()`), бюджет блока
    // уходит в композер; оба меняются живьём — `setLlmFilterTimeoutMs`/
    // `setPromptBlockMaxChars` (долги Д3).
    llmFilterTimeoutMs: effectivePluginsConfig.llmFilterTimeoutMs,
    promptBlockMaxChars: effectivePluginsConfig.promptBlockMaxChars,
    // ADR-094: реестр метрик (только при `metrics.enabled`) — LLM-вызовы
    // сессий учитываются и при выключенном LLM Gateway.
    metrics,
    // ADR-107: телеметрия блоков памяти в промпте хода
    // (`synth_memory_context_*`).
    ...(memoryTelemetry ? { onMemoryContext: memoryTelemetry.recordContext } : {}),
    mcpManager,
    // Workstream A1: реестр MCP и снимок инстанса — read-only тулы
    // `synth_info`/`synth_mcp_list`/`synth_mcp_test`. Политика читается live.
    mcpRegistry: mcpRegistryStore,
    getMcpNetworkPolicy: () => egressResolver.resolveMcp(),
    instanceMeta,
    // Workstream A1: гибрид — read-only merge проектов/сессий в тулах.
    getRemoteClient: accessors.getRemoteClient,
    cachePolicy: config.llmCachePolicy,
    toolsPolicy: effectiveToolsPolicy,
    mcpPolicy: effectiveMcpPolicy,
    toolsDisabled: effectiveToolsDisabled,
    // ADR-126 §11: системный hard-gate скиллов (runtime-настройка).
    skillsDisabled: effectiveSkillsDisabled,
    // ADR-070 §2.9.1: зависимости окружения (git/rg/sh) — детекция при старте,
    // fail-open при ошибке. Пробинг идёт до сборки оркестратора, чтобы первый
    // же запрос видел корректную доступность.
    // Проба бинарников — через тот же порт исполнения (ADR-077).
    runtimeDeps: await detectRuntimeDeps(executionPort),
    // ADR-071 §2.6: калибровка chars-per-token по модели (runtime-настройки).
    tokenRatioLoader: (model) => settingsStore.getTokenRatio(model),
    onTokenRatioCalibrated: (model, ratio) => settingsStore.setTokenRatio(model, ratio),
    // ADR-126 §5: каталог скиллов в промпт + тул `skill`.
    skillRuntime: skillService,
    // ADR-126 §1: резолвинг `/`-команд до LLM.
    commandRuntime: commandService,
    // ADR-069 Фаза 1: проектные инструкции (merged chain AGENTS.md).
    instructionsConfig: config.instructionsConfig,
    // ADR-069 Фаза 2a: project-trust гейт инструкций (config.skills.trustedProjectDirs).
    instructionsTrustedProjectDirs: effectiveSkillsTrustedProjectDirs,
    // ADR-084: decision-слой микро-каскада (config.decision). Runtime-обновление —
    // через `setDecisionConfig` (Ф5).
    decisionConfig: effectiveDecisionSettings,
    // ADR-089: late-bound funnel создания сессий для тула `task` (саб-агент).
    // Сам сервис создаётся ниже (после оркестратора) — геттер читает его в рантайме.
    getRequestSessionService: () => requestSessionService,
    // ADR-051: late-bound резолвер активности расписания в сессии (ScheduleStore
    // создаётся ниже) — включает статический блок `Scheduler` в промпт.
    isSchedulerActive: (sid) => scheduleStore.hasEnabledTargetFor(sid),
    // PROP-141 (Часть D): сервис переноса сессии (late-bound — собирается
    // после движка таймеров) → extra тулов `project_attach`/`project_create`.
    getMoveService: () => moveServiceRef.service,
    // PROP-141 (этап 6): движок таймеров/будильников (late-bound — тот же
    // экземпляр, что у HTTP-роутов `/api/v2/timers*`) и порт реестра →
    // extra тулов `timer`/`alarm`.
    getTimerService: () => timerServiceRef.service,
    timerRepository: storageContext.timers,
    // Этап 1 roadmap 0.13 (блок 3): сервис «вопрос пользователю» — тул
    // `question` задаёт вопрос и ждёт ответа пользователя.
    ...(questionService ? { questionService } : {}),
    // Этап 1 roadmap 0.13 (блок 4): единый реестр фоновых прогонов — тул
    // `task` с `background: true` регистрирует фонового саб-агента и
    // возвращает управление сразу (PROP-096).
    ...(backgroundService ? { backgroundService } : {}),
    // ADR-104 × ADR-111/ADR-113: ход закончился, а в steer-очереди остались
    // сообщения (ввод пользователя, уведомления фоновых прогонов) — возвращаем
    // их в очередь и поднимаем ход (при «Стопе» — без автозапуска).
    requeueSteerMessages: (sessionId, messages, opts) =>
      requeueSteerMessages(sessionId, messages, opts.autostart),
    // PROP-097: сервис фоновых шелл-процессов — тот же экземпляр, что у
    // реестра и тула `execute_shell` (через `ctx.extra.processService`).
    ...(processService ? { processService } : {}),
    // ADR-126 §5: реестр скриптов проекта — тулы `script_list`/`script_run`
    // (через `ctx.extra.scriptService`) и HTTP-роут `/sessions/:id/scripts*`.
    ...(scriptService ? { scriptService } : {}),
    // PROP-132 (Ф5): сервис интерактивных терминалов — тот же экземпляр, что у
    // HTTP-роутов `/api/v2/terminals*` (через `ctx.extra.terminalService`).
    terminalService,
    // PROP-124 §0: режим инстанса для SSH-ключей (`ssh.mode`) — live-геттер:
    // runtime-настройка (`/api/v2/settings/ssh`) применяется без рестарта.
    // `tools` (дефолт) — ключ в окружение команд не попадает; `agent` — ключи
    // роли агента выдаются вызову `execute_shell` (эфемерный `ssh-agent`).
    getSshMode: () => sshModeSettings.getMode(),
    // ADR-114: сервис worktree — тулы `git_worktree_*` (инвентарь
    // per-session рабочих каталогов проекта).
    ...(worktreeService ? { worktreeService } : {}),
    // Снимок — fallback; живой геттер читается при сборке контекста каждого
    // вызова (runtime-тумблер `background.enabled` действует без рестарта).
    backgroundEnabled: config.backgroundConfig?.enabled ?? true,
    getBackgroundEnabled: () => backgroundSettings.isEnabled(),
    // Предохранитель по объёму промпта саб-агента (не окно модели): при
    // превышении прогон завершается отчётом (`agents.subagentMaxInputTokens`).
    subagentMaxInputTokens: config.agentsConfig?.subagentMaxInputTokens,
    // Лимит глубины вложенности саб-агентов (`agents.subagentDepth`): при
    // превышении тул `task` отказывает до создания дочерней сессии.
    subagentDepth: config.agentsConfig?.subagentDepth,
    // ADR-101/ADR-051: late-bound рантайм автоматизации для встроенных тулов
    // (`pipeline_*`/`schedule_*`) — движок пайплайнов и шедулер создаются ниже,
    // поэтому геттер отдаёт актуальный снимок в момент хода.
    getAutomationRuntime: () => automationRuntime,
    // «Стоп»: персистентный флаг отмены сессии — прерывает длинный
    // многоитерационный Tool Use на границе итерации (backoff/гонка).
    isCancelRequested: async (sid) =>
      (await sessionManager.getSession(sid))?.status.cancelRequested === true,
  });

  // ADR-029: восстановление ожиданий подтверждения после рестарта инстанса.
  //
  // Живой реестр ожиданий живёт в памяти процесса и после рестарта пуст, а
  // вопрос пользователю — ещё актуален. Персистентная копия лежит в
  // **отдельном хранилище ожиданий** (`storage.pendingApprovals`, ADR-096) —
  // в документе сессии её быть не может (гонка lost update с точечной
  // записью истории, ADR-118 §4).
  //
  // Паттерн — тот же, что у `questionService.recoverOnStart()`: best-effort,
  // ошибка не роняет старт.
  if (!storageDegraded) {
    try {
      await orchestrator.restorePendingApprovals();
    } catch (err) {
      console.warn(
        `[permission] восстановление ожиданий подтверждения не удалось: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ADR-090 (Ф5б-2): эффективный конфиг слоя = config.yaml (+env) поверх
  // runtime-настроек (`settings.json`/PG): админка `/api/v2/settings/plugins`
  // пишет runtime, рантайм собирается при старте (применение — рестартом,
  // инвариант 24), поэтому слияние делается **здесь**, а не в рантайме.

  // ADR-090 (Ф5б-1): рантайм плагинов — старт-активация установленного
  // (`plugins.lock.json` — источник истины), список со статусом активации и
  // точки `activate`/`deactivate` для HTTP API/CLI (Ф5б-2/3). Реестры — **те же**
  // экземпляры, что у оркестратора: блоки промпта (`promptBlocks` выше), фильтры
  // LLM-вызовов (`getLlmFilters()`) и инструменты (`toolRegistry`).
  // `executionEnabled=false` (дефолт) → `activateInstalled()` — no-op.
  // Ф4б-2: транспорты исполнения плагина. `inline` — код в процессе core;
  // `remote` — отдельный процесс на loopback (менеджер поднимает его сам).
  // Менеджер процессов нужен и хосту (выбор транспорта), и рантайму (гашение
  // процессов при остановке инстанса).
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
      ProviderFactory.create(
        providerName,
        toCoreProviderConfig(sharedConfig, model, undefined, resolveModelCompatibility(providerName, model)),
      ),
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
    // Ф7 (ADR-090): серверная политика плагинов в гибриде (Уровень 1 —
    // cooperative). Не задана — сервера нет: плагины работают, но помечаются
    // «не проверен сервером».
    ...(accessors.getServerPluginPolicy
      ? { serverPolicy: accessors.getServerPluginPolicy }
      : {}),
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
  // PROP-141 (Часть B): правило маршрутизации срабатываний таймеров/будильников.
  // Источник свой (`timer`), тип свой (`timer_fired`) — правила cron и внешних
  // событий не затрагиваются.
  eventRouter.registerRuleProvider(new TimerRuleProvider());
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
  // ADR-089/ADR-051: учёт экземпляров пайплайна (ADR-100) — состояние
  // автомата публикации живёт в ядре (решение владельца), add-on отдаёт
  // артефакт по id. Трекер работает через порт `storage.pipelines`.
  const pipelineTracker = new PipelineTracker({ repository: pipelineStore });
  // ADR-089: дефолтные `provider`/`model` инстанса — общий seam для funnel'а
  // сессий и движка пайплайнов (ADR-101): приоритет — runtime-пара «Модели»
  // (provider+model), затем config.yaml (llm.defaultProvider/defaultModel).
  // Явные значения сессии/выхода — выше (funnel/выход `session`).
  const resolveLlmDefaults = async (): Promise<{ provider?: string; model?: string }> => {
    const pair = await settingsStore.getDefaultModel();
    if (pair) return { provider: pair.provider, model: pair.model };
    return {
      provider: config.llmDefaults?.provider,
      model: config.llmDefaults?.model,
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
    resolveLlmDefaults,
    // ADR-089: агент по умолчанию инстанса — чтобы сессия из внешнего события
    // (auto-bind/bind/ephemeral) фиксировала `settings.agentRole` и UI рисовал
    // бейдж агента (паритет с `POST /api/v2/sessions`). Источник — админка
    // «Агенты» (`getDefaultAgentId`) поверх `DEFAULT_AGENT_ID`.
    resolveDefaultAgent: getDefaultAgentId,
    // ADR-089/ADR-051: учёт экземпляров пайплайна (ADR-100) — решение с
    // `pipeline: {id, step}` продвигает автомат пайплайна; учёт best-effort.
    pipelineTracker,
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
      // PROP-141: таймер — системный автор `Timer`, его не переопределяем.
      if (
        event.source !== 'cron'
        && event.source !== TIMER_EVENT_SOURCE
        && event.identity?.principalId
      ) {
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
        const queued = await enqueueUserMessage(
          sessionManager, eventBus, sessionId, message, queueManager, processMessage,
          (sid, msg) => orchestrator.obfuscateUserMessageForHistory(sid, msg),
        );
        // ADR-115 × ADR-089: ссылки на вложения события — только после успешной
        // постановки (иначе GC удалит объект, на который сообщение не ссылается).
        if (queued) {
          await addEventAttachmentRefs(storageContext.blobRefs, event, message.id);
        }
      } else if (mode === 'steer') {
        // PROP-141 (Часть B, «Доставка»): доставка срабатывания таймера —
        // **как завершение фонового процесса** (ADR-113/ADR-104): ход идёт —
        // вклинивание в него на границе шага, хода нет — обычная очередь с
        // автоходом, фоллбек — запись в историю. Ровно одна копия в истории
        // гарантирует сам нотификатор (`createBackgroundParentNotifier`).
        //
        // Ошибка доставки **пробрасывается наружу**: движок таймеров по ней
        // ставит `outcome:'error'` (и `lastError` у записи).
        await notifyBackgroundParent(sessionId, message);
      } else {
        // ADR-036: `defer` тоже кладёт сообщение в историю — обфусцируем до
        // постановки. Старт процессора не выполняем (только очередь владельца).
        message = await orchestrator.obfuscateUserMessageForHistory(sessionId, message);
        const queued = await sessionManager.addPendingMessage(sessionId, message);
        if (queued) {
          await addEventAttachmentRefs(storageContext.blobRefs, event, message.id);
        }
      }
    },
  });

  // ADR-089: ingress-точка приёма внешних событий (Этап 6).
  // ADR-115 × ADR-089: сервис вложений проверяет ссылки `attachments[]` события
  // (объект есть, метаданные совпадают со sidecar) и даёт лимиты
  // `attachments.maxFilesPerMessage`/`maxBytesPerFile` (runtime-настройки — живые).
  // ADR-115 × ADR-077: медиа-раннер — единая точка запуска ffmpeg. Inline —
  // локально, remote — на исполнителе в общем workspace (`requires: ['ffmpeg']`).
  const mediaRunner = createMediaRunner({
    blobs: storageContext.blobs,
    executionPort,
    workspacesRoot: config.workspacesRoot ?? join(dataDir, 'workspaces'),
    log: (message) => console.warn(message),
  });
  // ADR-115: серверные миниатюры вложений (content-addressed `.thumbs`).
  // Настройки (`attachments.thumbnail`: enabled/maxWidthPx) — тот же live-резолвер,
  // что у `AttachmentService` (runtime-патч применяется без рестарта).
  const attachmentThumbnails = new ThumbnailService({
    blobs: storageContext.blobs,
    runner: mediaRunner,
    config: () => attachmentsSettings.getConfig().thumbnail,
    log: (message) => console.warn(message),
  });
  const eventAttachmentService = new AttachmentService({
    blobs: storageContext.blobs,
    config: () => attachmentsSettings.getConfig(),
    thumbnails: attachmentThumbnails,
  });
  const eventIngress = new EventIngress({
    requestSessionService,
    metrics: eventMetrics,
    attachments: eventAttachmentService,
  });

  // ADR-101 (Э5): движок пайплайнов — второй движок рядом с оркестратором
  // (ADR-101 §1). Собирается в точке сборки (никаких глобальных синглтонов):
  // шаг пайплайна не сессия, но окружение то же — порты хранилища (ADR-096),
  // permission-слой (ADR-029), промпт (ADR-070), Gateway (ADR-036).
  //
  // HTTP-роутов у движка нет (Э6): он живёт в `deps` и используется
  // вызывающим кодом (запуск прогона/возобновление — Э6).
  const pipelinePermissions: PipelinePermissionDeps = {
    permissionConfig: config.permissionConfig,
    runtimeDeps,
    // Журнал решений по правам (`scope:'permission'`) — тот же шов, что у
    // оркестратора: решения по правилам шага видны в общем журнале инстанса.
    audit: permissionAuditSink,
  };
  // ADR-036/ADR-101: провайдер шага — **всегда** через `GatewayProvider`
  // (обёртка оркестратора: та же точка, что у пула провайдеров). Провайдер
  // не кэшируется — обёртка подхватывает live-конфиг LLM Gateway.
  // ADR-101 §4 × `AgentDefinition`: провайдер/модель/температура/sampling
  // агента шага (`ctx.step.agent`) приоритетнее дефолтов инстанса — резолвер
  // общий с managed-точкой сборки (`resolvePipelineStepProvider`).
  const resolvePipelineProvider = (ctx: StepExecutionContext): Promise<BaseProvider | null> =>
    resolvePipelineStepProvider(ctx, {
      resolveLlmDefaults,
      loadProviderConfig: providerLoader,
      toProviderConfig: (shared, model) =>
        toCoreProviderConfig(shared, model, undefined, resolveModelCompatibility(shared.name, model)),
      createProvider: (name, config, temperature, topP, topK) =>
        ProviderFactory.create(name, config, temperature, topP, topK),
      wrapProvider: (provider) => orchestrator.wrapProviderWithGateway(provider),
    });
  const pipelineWorkspacesRoot = config.workspacesRoot ?? join(dataDir, 'workspaces');
  // ADR-101 §9 / ADR-116: артефакты прогонов — байты в общем blob-порте,
  // отдельного хранилища артефактов нет (решение 2026-10-27). Тот же инстанс
  // получают выход `file` (запись) и HTTP-раздача артефактов (`GET
  // /pipeline-runs/:runId/artifacts/:name`).
  const pipelineArtifacts = new PipelineArtifactStore({
    blobs: storageContext.blobs,
    blobRefs: storageContext.blobRefs,
  });
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
        // ADR-116: выход `file` дополнительно кладёт байты в blob-порт.
        artifacts: pipelineArtifacts,
        workspacesRoot: pipelineWorkspacesRoot,
        resolveLlmDefaults,
        // ADR-089: владелец сессии, созданной выходом, — человек-владелец
        // инстанса (standalone — `local`); у проекта — владелец проекта.
        resolveOwnerId: () => 'local',
        // ADR-089/инвариант 18: хабы подписывают владельца сами — уведомляем
        // WS-хаб standalone о материализованной сессии.
        onSessionMaterialized: async (session) => {
          const owner = await localOwnerResolver.normalizeOwner(
            session.ownerId ?? session.userId,
          );
          if (owner) await accessors.onSessionMaterialized?.(owner, session.id);
        },
      }),
    ],
    // ADR-101 §2.12: инстансные события прогона (новая шина не заводится).
    eventBus,
    // ADR-094: метрики прогонов (`synth_pipeline_*`).
    metrics: metrics ? createPipelineMetrics(metrics) : undefined,
    // ADR-101 §4/ADR-070: промпт шага — тем же сборщиком, что у сессий.
    composer: orchestrator.getComposer(),
    // IPI шага (ADR-101): тот же фильтр контента тулов, что у хода и
    // саб-агента. Конфиг — **живой** геттер оркестратора (runtime-настройка
    // безопасности применяется без рестарта), словари — порт инстанса.
    securityContentFilter: {
      getConfig: () => orchestrator.getSecurityConfig(),
      dictionaryStore,
    },
    // ADR-135/PROP-135: среда исполнения шага — та же, что у сессий.
    environmentKind: orchestrator.getEnvironmentKind(),
    resolveProvider: resolvePipelineProvider,
    resolveLlmDefaults,
    // ADR-115 × ADR-101: вложения прогона — тот же сервис вложений, что у
    // приёма событий (чтение `attachments/…`, sidecar-метаданные, лимиты) и
    // тот же blob-порт артефактов, что у HTTP-раздачи (`artifacts/…`).
    attachments: eventAttachmentService,
    artifacts: pipelineArtifacts,
    resolveModalities: resolveModelModalities,
    deriveAttachment: createPipelineAttachmentDerive({
      config: () => attachmentsSettings.getConfig(),
      attachments: eventAttachmentService,
      blobs: storageContext.blobs,
      // Инвариант 3: LLM-вызов только через gateway — провайдер aux-модели
      // обёрнут той же обвязкой, что и провайдер шага.
      resolveProvider: async (provider, model) => {
        try {
          const sharedConfig = providerLoader(provider);
          if (!sharedConfig) return null;
          return orchestrator.wrapProviderWithGateway(
            ProviderFactory.create(
              provider,
              toCoreProviderConfig(sharedConfig, model, undefined, resolveModelCompatibility(provider, model)),
            ),
          );
        } catch {
          return null;
        }
      },
      hasFfmpeg: () => isFfmpegAvailable(executionPort).catch(() => false),
      executionPort,
      workspacesRoot: pipelineWorkspacesRoot,
      promptTemplate: (language) => contextConfig.getMediaDeriveTemplate(language),
      language: 'ru',
      log: (message) => console.warn(message),
    }),
    attachmentsNoticeTemplate: (language) => contextConfig.getAttachmentsDroppedTemplate(language),
    // ADR-101 §10: контекст шага — те же объекты, что собраны для сессий.
    projectStore,
    toolRegistry,
    mcpManager,
    instructionsResolver: orchestrator.getInstructionsResolver(),
    agentRegistry,
    skillsCatalog: skillService,
    runtimeDeps,
    workspacesRoot: pipelineWorkspacesRoot,
    // ADR-077/PROP-135: контур исполнения шага — те же порт и роутер, что у
    // сессий: плагинный тул получает `ctx.runtime` (PROP-138), `sandbox_exec`
    // находит пул по классу `sandbox`, а per-project монтирование PVC —
    // `executionWorkspaceSubPath` (движок считает его от `workspacesRoot`).
    executionPort,
    executionRouter,
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
  // `start()` гейтится конфигом; остановка — на shutdown (`stopScheduler`).
  const schedulerTickMs = (config.schedulerConfig?.tickSec ?? 60) * 1000;
  // ADR-097: `leaderElection=postgres` требует advisory-локов backend'а
  // (`storage.backend=postgres`); иначе — предупреждение и AlwaysLeader.
  if (config.schedulerConfig?.leaderElection === 'postgres' && !storageContext.locks) {
    console.warn(
      '[scheduler] leaderElection=postgres, но backend не предоставляет advisory-локи ' +
        '(нужен storage.backend=postgres) — используется AlwaysLeader',
    );
  }
  // ADR-051/ADR-089 + PROP-141: **общий** лидер-выбор для шедулера и движка
  // таймеров. Второй лок означал бы двух владельцев (тик расписаний в одной
  // реплике, таймеров — в другой), а `FileMutex` повторно не захватывается тем
  // же экземпляром. `SharedLeader` — один лок на оба тикера.
  const sharedLeader = new SharedLeader(
    config.schedulerConfig?.leaderElection === 'file'
      ? new FileLeader({ dataDir, tickMs: schedulerTickMs })
      : config.schedulerConfig?.leaderElection === 'postgres' && storageContext.locks
        ? storageContext.locks.createLeader({ name: 'scheduler/leader', tickMs: schedulerTickMs })
        : new AlwaysLeader(),
  );
  const schedulerService = new SchedulerService({
    scheduleStore,
    ingress: eventIngress,
    jobStore,
    tickMs: schedulerTickMs,
    defaultEphemeralTtl: effectiveEvents.ephemeralTtl,
    catchUp: config.schedulerConfig?.catchUp ?? 'skip',
    jobRetentionDays: config.schedulerConfig?.jobRetentionDays ?? 30,
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
    // PROP-141: тот же лидер-выбор — и у шедулера, и у таймеров (второго
    // тикера нет): общий `SharedLeader` поверх одного экземпляра лока.
    leader: sharedLeader,
  });
  // PROP-141: бэкфилл `projectId` у легаси-расписаний (идемпотентно).
  //
  // Выполняется **до** старта шедулера: инстансных автоматизаций нет, каждое
  // расписание принадлежит проекту. Проект выводится из цели (`pipeline`/
  // `ephemeral` — из самой цели, `bound`/`queue` — у сессии-цели); вывести
  // нельзя — запись остаётся в реестре, но отключается (`project_required`)
  // и не срабатывает. Ошибка бэкфилла не роняет старт (запись не теряется).
  try {
    const backfill = await storageContext.schedules.backfillProjectIds?.();
    if (backfill && (backfill.backfilled > 0 || backfill.disabled > 0)) {
      console.warn(
        `[scheduler] бэкфилл проектов расписаний: проект проставлен у ${backfill.backfilled}, `
          + `отключено ${backfill.disabled}`,
      );
    }
  } catch (err) {
    console.warn(
      `[scheduler] бэкфилл проектов расписаний не удался: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (config.schedulerConfig?.enabled !== false && !storageDegraded) {
    void schedulerService.start().catch((err) => {
      console.warn(`[scheduler] не удалось запустить: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // PROP-141 (Часть B, «Доставка»): движок таймеров/будильников.
  //
  // Доставка — **гибрид** (PROP-141, «Доставка»): журнал и дедуп — через
  // событийный контур (`EventIngress` → Router → `TimerRuleProvider`), сама
  // доставка в сессию — как завершение фонового процесса (ADR-113/ADR-104):
  // вклинивание в текущий ход, иначе очередь, иначе запись в историю.
  const timerMetrics = metrics ? createTimerMetrics(metrics) : undefined;
  const timerService = storageDegraded
    ? undefined
    : new TimerService({
        // ADR-096: порты реестра таймеров и истории срабатываний.
        timers: storageContext.timers,
        firings: storageContext.timerFirings,
        // Ошибка доставки пробрасывается наружу — движок ставит `outcome:'error'`.
        deliver: async (timer, firing, meta) => {
          const result = await eventIngress.ingest({
            source: TIMER_EVENT_SOURCE,
            type: TIMER_EVENT_TYPE,
            payload: {
              sessionId: timer.sessionId,
              timerId: timer.id,
              kind: timer.kind,
              repeat: timer.repeat.mode,
              comment: timer.comment,
              ...(timer.name ? { name: timer.name } : {}),
              scheduledFor: firing.scheduledFor,
              firedAt: firing.firedAt,
              catchup: meta.catchup,
            },
            // Дедуп по (таймер, плановое время) — повторный тик и смена лидера
            // не дают двух сообщений.
            dedupKey: `timer:${timer.id}:${firing.scheduledFor}`,
            identity: { principalId: timer.ownerId },
          });
          if (result.error) throw new Error(result.error);
        },
        // PROP-141: лидер тот же, что у шедулера (второго тикера нет).
        leader: sharedLeader,
        // ADR-094: метрики `synth_timer_*`.
        metrics: timerMetrics,
        // Аудит `scope:'timer'` (создание/правка/срабатывание/отмена).
        audit: securityAudit,
        // Live-события в канале сессии (ADR-009/ADR-024; новых каналов нет).
        onEvent: (sessionId, type, data) => {
          eventBus.publish(sessionId, type, data);
        },
      });
  timerServiceRef.service = timerService;
  if (timerService) {
    void timerService.start().catch((err) => {
      console.warn(`[timers] не удалось запустить: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // PROP-141 (Часть D): сервис переноса сессии между проектами — единый шов
  // для HTTP-роута `PATCH /sessions/:id { project_id }` и агентских
  // `project_attach`/`project_create`.
  //
  // Зависимости — те же инстансы, что у остального контура: реестр фоновых
  // прогонов (порт), сервис фоновых прогонов, сервис шелл-процессов, сервис
  // терминалов, движок таймеров, реестр таймеров, реестр расписаний, признак
  // активного хода, шина событий и журнал аудита.
  const moveService = storageDegraded
    ? undefined
    : new SessionMoveService({
        sessionManager,
        backgroundRuns: storageContext.backgroundRuns,
        ...(backgroundService ? { backgroundService } : {}),
        ...(processService ? { processService } : {}),
        terminalService,
        ...(timerService ? { timerService } : {}),
        timers: storageContext.timers,
        scheduleStore,
        isTurnActive: isBackgroundTurnActive,
        eventBus,
        ...(securityAudit ? { audit: securityAudit } : {}),
      });
  moveServiceRef.service = moveService;

  // ADR-101/ADR-051: шедулер появился — отдаём его тулам `schedule_*`
  // через рантайм автоматизации (late-bound).
  automationRuntime.scheduler = schedulerService;

  return {
    dataDir,
    // PROP-135 Ф6a: роутер портов исполнения — каталог профилей для
    // валидации `project.executor`/`settings.executorProfile` в роутах.
    executionRouter,
    // PROP-135 Ф6b-1: эффективная секция `execution` — admin-API профилей и
    // пулов (`/api/v2/execution/*`) отдаёт `provider`/`pooling`/каталог без
    // повторного резолва конфигурации.
    executionConfig: effectiveExecutionConfig,
    // ADR-135: секция `execution` **config-уровня** (без runtime) — база для
    // runtime-каталога профилей в `/api/v2/settings/execution` («дефолты»).
    fallbackExecutionConfig: baseExecutionConfig,
    // ADR-106 Ф3: реестр подтверждений (enforced-режим Authority-слоя).
    approvalRegistry,
    // ADR-096: контекст хранения инстанса — для операций, которым нужен
    // целиком (напр. портативный экспорт/импорт проекта, ADR-091).
    storageContext,
    // ADR-094: реестр метрик (доменные коллекторы подключены выше).
    metrics,
    // ADR-094: остановка фоновых коллекторов (graceful shutdown).
    stopMetricsCollectors,
    settingsStore,
    // ADR-096 (W2.3): умолчания оформления из контекста хранения (паритет с backend).
    defaultsStore,
    getDefaultAgentId,
    defaultWorkingDir,
    /** ADR-075: начальная политика workspace вне root (config/env + runtime-override). */
    workspaceOutsideRootPolicy: effectiveWorkspaceOutsideRootPolicy,
    /**
     * ADR-126/ADR-069: эффективный project-trust гейт скиллов/команд/инструкций
     * (runtime > config), снятый на старте. Нужен резолверу инструкций в
     * `mount-routes` (а не только оркестратору).
     */
    skillsTrustedProjectDirs: effectiveSkillsTrustedProjectDirs,
    protectedPathsStore,
    projectStore,
    sessionManager,
    stopEphemeralSweeper,
    // ADR-076: тот же store, что у git-роутов и оркестратора — без дублей инстансов.
    sshKeyStore,
    // ADR-096 (W2.4): конфигурационные словари и реестр service-key — из контекста.
    dictionaries: dictionaryStore,
    serviceApiKeyStore,
    providerStore,
    modelStore,
    agentStore,
    mcpManager,
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
    // ADR-126 §5: сервис реестра скриптов проекта (HTTP-контур `/scripts*`).
    scriptService,
    // ADR-115: GC осиротевших вложений сообщений.
    stopAttachmentPruner,
    // ADR-115 × ADR-077: уборка временных каталогов медиа-раннера.
    stopMediaTempPruner,
    // ADR-115: живое состояние настроек вложений (сервис/промпт/GC + админ-API).
    attachmentsSettings,
    // Политика ограничения контекстного окна (live, админ-API).
    contextWindowSettings,
    subagentMaxInputTokensSettings,
    // Лимит тяжёлых операций с сессиями (live, админ-API).
    sessionOpsPerMinuteSettings,
    // Дефолты оптимизации контекста новых сессий (live, админ-API).
    contextDefaultsSettings,
    // Instance-wide лимиты заметок сессии (live, админ-API).
    stickyNotesLimitsSettings,
    // PROP-124: режим инстанса для SSH-ключей (live, админ-API).
    sshModeSettings,
    // Этап 1 roadmap 0.13 (блок 4): живое состояние секции `background`
    // (сервисы/прунеры/оркестратор + админ-API `/settings/background`).
    backgroundSettings,
    // Журнал решений по подтверждениям прав: живое состояние секции `audit`
    // (режим + retention) — шов `permissionAuditSink` читает его на каждое
    // решение; роут `/settings/audit` обновляет и вызывает `refresh()`.
    auditSettings,
    // Шов журнала решений (allow/deny/revoke) — для мутаций правил вне хода.
    permissionAuditSink,
    // ADR-114: сервис worktree — HTTP-контур проектов и привязка сессии.
    worktreeService,
    webhooksConfig,
    // Egress: живой резолвер политики + журналы безопасности.
    egressResolver,
    egressLogConfig,
    securityAudit,
    egressRequests,
    // ADR-036: общий AuditLogger LLM Gateway (оркестратор + `GET /api/v2/audit`)
    // и путь payload-лога (`GET /api/v2/logs/llm`) — тот же JSONL.
    gatewayAuditLogger,
    gatewayAuditLogPath,
    gatewayPayloadLogPath,
    // PROP-136 (слайс 136a): журнал исполнений команд — роуты
    // `/api/v2/audit/commands` читают тот же экземпляр, что пишет оркестратор.
    commandAuditLog,
    // PROP-132 (Ф3в): сервис терминалов инстанса (один на процесс) + его
    // остановка на graceful shutdown (`dispose()` закрывает живые терминалы).
    terminalService,
    // PROP-141 (Часть D): сервис переноса сессии между проектами (роуты
    // `PATCH /sessions/:id { project_id }`).
    moveService,
    stopTerminalService: () => terminalService.dispose(),
    // PROP-136b (слайс 136b-2a): зеркальный чекер команд — возвращается для
    // тестов/UI (провайдер уже передан оркестратору).
    commandPolicyProvider,
    // ADR-036: порт regex-паттернов детекции секретов (`GET /api/v2/gateway/patterns`).
    gatewayPatternStore: patternStore,
    // ADR-102 (волна 1): порт пред-агрегированных роллапов аналитики — для роутов отчётов.
    analyticsRollups,
    // ADR-102: write-path — сборщик роллапов (+ остановка детачей hook-подписки и pruner'а).
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
    // ADR-126/ADR-089: порт файлов контекста — запись ролевого промпта агента
    // вместе с агентом (`POST /api/v2/agents`, поле `role_prompt`).
    contextFiles: contextConfig,
    skillService,
    bundleStore,
    commandService,
    // ADR-126 §4: сервис сниппетов (`#`) — HTTP-контур `/api/v2/snippets`.
    snippetService,
    // ADR-051/ADR-100: порт реестра пайплайнов (определения + экземпляры).
    pipelines: pipelineStore,
    // ADR-101 (Э5): движок пайплайнов (второй движок) — HTTP-роутов нет (Э6).
    pipelineEngine,
    // ADR-101 §9 / ADR-116: хранилище артефактов прогонов — раздача байтов
    // в HTTP-контуре пайплайнов (`createPipelineProjectRoutes`).
    pipelineArtifacts,
    // ADR-115 × ADR-101: сервис вложений — проверка `attachments[]` в теле
    // запуска прогона (тот же экземпляр, что у приёма событий).
    pipelineAttachments: eventAttachmentService,
    // ADR-115: провайдер серверных миниатюр (`?variant=thumb` в роутах вложений).
    attachmentThumbnails,
    // ADR-101: реестр активных прогонов — общий для HTTP-роута пайплайнов и
    // встроенных тулов агента (soft-lock + отмена идущего прогона).
    pipelineRunControl,
    // ADR-086 §5: порт реестра установок пакетов расширений.
    packs: packStore,
    // ADR-071 §2.5: единый реестр MCP-серверов (установщик пакета пишет в него).
    mcpRegistryStore,
    // ADR-105 (Ф3/Ф4): реестр описаний OAuth-провайдеров и сервис слоя доступов
    // (HTTP-контур `/api/v2/oauth/credentials`).
    oauthProviders,
    oauthCredentialService,
    orchestrator,
    // ADR-090 (Ф5б-1): рантайм плагинов — старт-активация установленного
    // (`main.ts`) и точки для HTTP API/CLI (Ф5б-2/3). `host`+`installer` внутри.
    pluginRuntime,
    // ADR-077: порт исполнения — тот же инстанс, что у оркестратора и тулов
    // (резолвер проектных инструкций берёт его для `git rev-parse`).
    executionPort,
    // ADR-077 (шаг B2): источник MCP-серверов исполнителя (только remote);
    // `null` в inline — останавливать нечего.
    executorMcpSource,
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
    // PROP-141 (Часть B): движок таймеров/будильников + его остановка
    // (graceful shutdown — рядом с `stopScheduler`).
    timerService,
    stopTimerService: () => timerService?.stop(),
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
