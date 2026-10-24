// Монтирование HTTP-роутов API v2 backend (Hono API Hub).
// Порядок `app.route`/`app.get` сохраняется 1:1 с прежним `app.ts` — он
// определяет приоритеты маршрутов (статические сегменты раньше параметрических,
// SSE-хаб `/api/v2/events` после роутов событий, но до admin-роутов).
// Вынесено из `app.ts` (ADR-095, шаг 4b) — «вынос по швам», без изменения поведения.
import { isAbsolute, normalize, resolve } from 'node:path';
import type { Hono } from 'hono';
import { DEFAULT_LLM_GATEWAY_RATE_LIMIT, ProjectRole, SYNTH_VERSION, resolveSecretKey, resolveStorageBackend, resolvePostgresConfig, resolvePostgresPassword } from '@itphx/synth-shared';
import {
  DEFAULT_AGENT_ID, RateLimiter,
  getPublicOpenApiDocument,
  createFsRoutes, createGitRoutes, createSshKeyRoutes, createAgentSshKeyRoutes,
  createEventRoutes, createSchedulerRoutes, createServiceKeyRoutes, createWebhookRoutes,
  mergeLlmGatewayConfig, mergeSecurityConfig, mergePluginsConfig,
  createSkillRoutes, createCommandRoutes, createSkillBundleRoutes,
  createSessionSkillScopeRoutes, createProjectSkillScopeRoutes, createSkillSettingsRoutes,
  createIdentityRoutes,
  createMaintenanceRoutes,
  createAnalyticsRoutes, AnalyticsService,
  createProjectPortableRoutes,
  createStorageContextAsync,
  ProjectInstructionsResolver, createInstructionsInfoResolver,
  createSettingsRoutes, createDictionaryRoutes, createAuditRoutes as createSecurityAuditRoutes, currentEgressLog,
  createContextRoutes as createCoreContextRoutes,
  createMetricsSettingsRoutes,
  createPacksRoutes, createPipelinesRoutes,
  createPipelineProjectRoutes,
  createPluginsRoutes, createPluginSettingsRoutes,
  createOAuthRoutes, bindCredentialToConnector, syncMcpManagerFromRegistry,
  resolveProjectWorkspace,
  resolvePluginServerPolicy,
} from '@itphx/synth-core';
import type { AuthKit as CoreAuthKit, MetricsReadiness, MetricsRegistry, StorageContext } from '@itphx/synth-core';
import { createProjectRoutes, createProjectAccess } from '../routes/projects.js';
import { createSessionRoutes } from '../routes/sessions.js';
import { createMessageRoutes } from '../routes/messages.js';
import { createQueueRoutes } from '../routes/queue.js';
import { createProviderRoutes } from '../routes/providers.js';
import { createModelRoutes } from '../routes/models.js';
import { createAgentRoutes } from '../routes/agents.js';
import { createMcpRoutes } from '../routes/mcp.js';
import { createContextRoutes as createContextFileRoutes } from '../routes/context.js';
import { createDebugRoutes } from '../routes/debug.js';
import { createUserRoutes } from '../routes/users.js';
import { createAuditRoutes } from '../routes/audit.js';
import { createLogsRoutes, resolveLogDir } from '../routes/logs.js';
import { createGatewayPatternsRoutes } from '../routes/gateway-patterns.js';
import { createLlmRoutes } from '../routes/llm.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';
import { scopeGuard, serviceProjectProjection } from '../auth/service-scope.js';
import { requireAdminOrScope, requireAdminRoleOrScope } from '../auth/guards.js';
import { t, getTranslations } from '../lib/i18n.js';
import type { AuthKit } from '../auth/middleware.js';
import type { BackendConfig } from '../lib/app-config.js';
import type { BackendDeps } from './deps.js';
import { registerEventsSse } from './sse-events.js';

export interface BackendRoutesContext {
  /** Конфиг backend (config.yaml + env + dataDir). */
  config: BackendConfig;
  /** Зависимости backend (`createBackendDeps`). */
  deps: BackendDeps;
  /** ADR-094: live-состояние метрик для админ-раздела «Наблюдаемость». */
  metrics: BackendMetricsContext;
}

/** ADR-094: live-состояние метрик (паритет с core `StandaloneMetricsContext`). */
export interface BackendMetricsContext {
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

/**
 * Смонтировать все `/api/v2/*`-роуты и служебные заглушки (`/api/config/themes`,
 * i18n-эндпоинты) в порядке, идентичном прежнему `createBackendApp`.
 */
export function mountBackendRoutes(app: Hono, auth: AuthKit, ctx: BackendRoutesContext): void {
  const { config, deps } = ctx;
  const {
    dataDir, projectStore, sessionManager, eventBus, queueManager, processMessage, orchestrator,
    profilesStore, getDefaultAgentId, requestSessionService, contextOptimizer, protectedPathsStore,
    providerStore, providerCache, modelStore, modelCache, agentStore, agentRegistry, contextConfig,
    sshKeyStore, commandService, bundleStore, dictionaries, serviceApiKeyStore,
    eventIngress, eventBindingStore, eventJournal, routeRuleStore, eventApiKeyStore,
    schedulerService, scheduleStore, jobStore, webhookStore, webhookDeliveryStore, webhookService,
    webhooksConfig, eventHub, mcpManager, mcpRegistryStore, skillService, settingsStore,
    egressResolver, securityAudit, egressRequests,
    defaultWorkingDir, patternStore, toolRegistry, gatewayAuditLogger, gatewayPayloadLogPath,
    gatewayConfig, providerLoader, modelLoader, modelWindowLoader, resolveAgentTemplate,
    identityClaimStore, live, maintenanceAudit,
    analyticsRollups, analytics, metrics,
    pipelines, packs,
  } = deps;

  /**
   * Fallback-пара «модель по умолчанию» из config (`llm.defaultProvider` +
   * `llm.defaultModel`) — только если заданы оба.
   */
  const backendConfigDefaultModel = () =>
    config.synth.llm.defaultProvider && config.synth.llm.defaultModel
      ? { provider: config.synth.llm.defaultProvider, model: config.synth.llm.defaultModel }
      : null;

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

  // ADR-052 (этап I): публичный OpenAPI-документ (spike) за requireAuth;
  // публичную выдачу без auth согласуем отдельно.
  app.get('/api/v2/openapi.json', auth.requireAuth, (c) => c.json(getPublicOpenApiDocument()));

  // Projects routes
  app.route('/api/v2/projects', createProjectRoutes(auth, projectStore, sessionManager, config.workspacesRoot, mcpManager, skillService, settingsStore, mcpRegistryStore));

  // ADR-091 (этап 2): портативный экспорт/импорт проекта (скачать/загрузить архив).
  // Managed RBAC: скачивание — право чтения проекта (owner/участник/LEAD/ADMIN),
  // импорт в существующий проект (`mergeInto`) — право редактирования; создание
  // нового проекта — любая аутентифицированная роль. Владелец новых сущностей —
  // текущий пользователь; хаб подписывается на импортированные сессии
  // (ADR-089, инвариант 18).
  app.route('/api/v2/projects', createProjectPortableRoutes(
    { requireAuth: auth.requireAuth },
    {
      dataDir,
      // ADR-096: экспорт/импорт проекта работают через контекст хранения
      // инстанса (иначе — свой файловый контекст, а на `backend=postgres`
      // проект не найден бы).
      storage: deps.storageContext,
      getProject: (id) => projectStore.load(id),
      canRead: async (c, projectId) => {
        const user = await auth.getCurrentUser(c);
        if (!user) return false;
        const project = await projectStore.load(projectId);
        return project ? projectAccess.canReadProject(c, project, user.id) : false;
      },
      canEdit: async (c, projectId) => {
        const user = await auth.getCurrentUser(c);
        if (!user) return false;
        const project = await projectStore.load(projectId);
        return project ? projectAccess.canEditProjectContent(c, project, user.id) : false;
      },
      // security-фикс 0.11.3: экспорт проекта по умолчанию БЕЗ секретов сессий
      // (карта обфускации LLM Gateway + `metadata.secrets`). Явный opt-in
      // `?withSecrets=true` — только elevated (ADMIN/LEAD): архив проекта
      // содержит сессии других участников, а карта обфускации — это секрет.
      canExportSecrets: (c) =>
        auth.isAdmin(c as never) || auth.hasRole(c as never, 'LEAD'),
      audit: maintenanceAudit,
      maxUploadBytes: config.maxUploadBytes,
      resolveOwnerId: (c) => {
        const user = c.get('user') as { id?: string } | undefined;
        return user?.id;
      },
      onSessionCreated: (sessionId, ownerId) => {
        void eventHub.subscribeToSession(ownerId, sessionId);
      },
      messages: {
        forbidden: (c) => t('auth.forbidden', undefined, c),
        notFound: (c) => t('errors.notFound.project', undefined, c),
        invalidBody: (c) => t('errors.validation.projectImportBody', undefined, c),
        invalidArchive: (c) => t('errors.validation.invalidProjectArchive', undefined, c),
        checksumMismatch: (c) => t('errors.validation.projectArchiveChecksum', undefined, c),
        nameConflict: (c) => t('errors.conflict.projectNameInUse', undefined, c),
        confirmRequired: (c) => t('errors.validation.maintenanceConfirmRequired', undefined, c),
        workspaceError: (c) => t('errors.validation.projectWorkspaceRestore', undefined, c),
        payloadTooLarge: (c) => t('errors.payloadTooLarge', undefined, c),
      },
    },
  ));

  // Sessions routes
  app.route('/api/v2/sessions', createSessionRoutes(auth, sessionManager, eventBus, queueManager, processMessage, orchestrator, eventHub, contextOptimizer, projectStore, profilesStore, getDefaultAgentId, requestSessionService, analytics));

  // Messages routes
  app.route('/api/v2/messages', createMessageRoutes(auth, sessionManager, contextOptimizer, eventBus, projectStore));

  // Queue routes
  app.route('/api/v2/queue', createQueueRoutes(auth, sessionManager, queueManager, eventBus, processMessage, projectStore));

  // FS routes (ADR-075): core-фабрика, managed поверх workspace проекта.
  // ADR-089 (P0): доступ к проекту обязателен — иначе любой USER читал/писал бы
  // файлы чужого проекта по id (IDOR). Чтение — canRead, мутации — canEditContent.
  const projectAccess = createProjectAccess(auth);
  app.route('/api/v2/fs', createFsRoutes(auth, config.workspacesRoot, undefined, {
    requireProjectId: true,
    getOutsideRootPolicy: () => 'deny',
    getProtectedPathsPolicy: () => protectedPathsStore.getPolicy(),
    // Лимит загрузки: config/env (resolveMaxUploadBytes), иначе дефолт фабрики.
    maxUploadBytes: config.maxUploadBytes,
    authorizeProject: async (c, projectId) => {
      const user = await auth.getCurrentUser(c);
      if (!user) return false;
      const project = await projectStore.load(projectId);
      if (!project) return false;
      return c.req.method === 'GET'
        ? projectAccess.canReadProject(c, project, user.id)
        : projectAccess.canEditProjectContent(c, project, user.id);
    },
    getProjectWorkspace: (projectId) => resolveProjectWorkspace(projectId, {
      workspacesRoot: config.workspacesRoot,
      getProject: (id) => projectStore.load(id),
      outsideRootPolicy: () => 'deny',
      strict: true,
    }),
  }));

  // Providers routes
  app.route('/api/v2/providers', createProviderRoutes(auth, providerStore, providerCache, {
    resolvePolicy: () => egressResolver.resolveTools(),
    log: currentEgressLog(),
  }, async () => (await settingsStore.getDefaultModel()) ?? backendConfigDefaultModel()));

  // Models routes
  app.route('/api/v2/models', createModelRoutes(auth, modelStore, providerStore, modelCache, providerCache, {
    getDefaultModel: async () => (await settingsStore.getDefaultModel()) ?? backendConfigDefaultModel(),
    setDefaultModel: (pair) => settingsStore.setDefaultModel(pair),
  }));

  // Agents routes
  // ADR-046/ADR-089: ролевой промпт агента (`role_prompt` в теле POST)
  // пишется портом файлов контекста — `{dataDir}/context/roles/<contextFile>`.
  app.route('/api/v2/agents', createAgentRoutes(auth, agentStore, agentRegistry, getDefaultAgentId, contextConfig));

  // Context routes (глобальные identity-файлы; админ-мутации)
  app.route('/api/v2/context', createContextFileRoutes(auth, contextConfig));

  // User admin routes
  app.route('/api/v2/users', createUserRoutes(auth, profilesStore));

  // Git routes (ADR-076 §T4): core-фабрика + managed RBAC. Write-эндпоинты
  // (init/clone/register/remove/fetch) требуют прав на изменение контента
  // проекта (owner/EDITOR/LEAD/ADMIN); read-only (scan/log/commit) — права
  // чтения проекта (owner/участник/LEAD/ADMIN). Проверка — граничный guard
  // core-фабрики (ADR-089, инвариант 16): без неё любой аутентифицированный
  // читал бы git-данные чужого проекта по его id.
  app.route('/api/v2/git', createGitRoutes(auth, projectStore, config.workspacesRoot, {
    sshKeyStore,
    authorizeProject: async (c, projectId) => {
      const user = await auth.getCurrentUser(c);
      if (!user) return false;
      const project = await projectStore.load(projectId);
      if (!project) return false;
      return projectAccess.canEditProjectContent(c, project, user.id);
    },
    authorizeRead: async (c, projectId) => {
      const user = await auth.getCurrentUser(c);
      if (!user) return false;
      const project = await projectStore.load(projectId);
      if (!project) return false;
      return projectAccess.canReadProject(c, project, user.id);
    },
  }));

  // SSH-ключи агентов (ADR-076 §T5): core-фабрика + managed RBAC.
  // Ключи — секреты: чтение — requireAuth (глобально), запись — только ADMIN.
  app.route('/api/v2/ssh-keys', createSshKeyRoutes(auth, sshKeyStore, {
    writeGuard: auth.requireAdmin,
  }));
  app.route('/api/v2/agents/:agentId/ssh-keys', createAgentSshKeyRoutes(auth, sshKeyStore, {
    writeGuard: auth.requireAdmin,
  }));

  // ADR-089: приём внешних событий (ingress), биндинги и журнал. Ingress —
  // requireAuth + rate limit (внешние сервисы до ADR-052 используют общий ключ);
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
      // ADR-089/ADR-052: мутации bindings/routes/keys — LEAD и ADMIN; чтение
      // ключей привязки — тоже LEAD и ADMIN (чувствительные метаданные).
      writeGuard: auth.requirePermission('ADMIN', 'LEAD'),
      keyReadGuard: auth.requirePermission('ADMIN', 'LEAD'),
      // ADR-052 (этап I): scope-гейт и проектная проекция service-key (i18n-403).
      scopeGuard,
      serviceProjectProjection,
      // ADR-089/ADR-052: per-key rate limit и мастер-выключатель приёма (live).
      getKeyRateLimitPerMinute: () => live.getEvents().keyRateLimitPerMinute,
      isEnabled: () => live.getEvents().enabled,
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

  // ADR-051 / ADR-089: CRUD расписаний, принудительный запуск и Job-история.
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
      // ADR-052 (этап I): scope-гейт, проектная проекция и резолвинг
      // projectId `bound`/`queue`-целей расписания.
      scopeGuard,
      serviceProjectProjection,
      resolveSessionProject: async (id) => (await sessionManager.getSession(id))?.projectId,
    },
  ));

  // ADR-051/ADR-100: API пайплайнов — определения (ставит установщик пакета),
  // экземпляры и ручной запуск. Чтение — ADMIN (реестр автоматов инстанса),
  // ручной запуск — ADMIN или service-key со scope `automation:install`.
  app.route('/api/v2/pipelines', createPipelinesRoutes(
    { requireAuth: auth.requireAuth },
    { pipelines },
    {
      readGuard: auth.requirePermission('ADMIN'),
      writeGuard: requireAdminRoleOrScope('automation:install'),
      scopeGuard,
    },
  ));

  // ADR-101 (Э6): пайплайны проекта (черновик/публикация), прогоны и журнал,
  // HITL-действия и шаблоны инстанса (инстанцирование в проект).
  // Права — по правилам проекта (ADR-089 §5.5/§5.8): читать — владелец/
  // участник/LEAD/ADMIN, изменять — OWNER/EDITOR/LEAD/ADMIN (VIEWER читает,
  // но не мутирует — инвариант 21). Шаблоны инстанса — ADMIN.
  app.route('/api/v2', createPipelineProjectRoutes(
    { requireAuth: auth.requireAuth },
    {
      pipelines: deps.storageContext.projectPipelines,
      runs: deps.storageContext.pipelineRuns,
      engine: deps.pipelineEngine,
      projects: projectStore,
      templates: pipelines,
    },
    {
      writeGuard: auth.requireAuth,
      adminGuard: auth.requirePermission('ADMIN'),
      canReadProject: async (c, project, userId) =>
        projectAccess.canReadProject(c as never, project, userId),
      canEditProject: async (c, project, userId) =>
        projectAccess.canEditProjectContent(c as never, project, userId),
      getCurrentUserId: async (c) => (await auth.getCurrentUser(c))?.id ?? '',
      scopeGuard,
      serviceProjectProjection,
      messages: {
        pipelineNotFound: (c) => t('errors.notFound.pipeline', undefined, c),
        runNotFound: (c) => t('errors.notFound.pipelineRun', undefined, c),
        projectNotFound: (c) => t('errors.notFound.project', undefined, c),
        templateNotFound: (c) => t('errors.notFound.pipelineTemplate', undefined, c),
        forbidden: (c) => t('auth.forbidden', undefined, c),
        invalidBody: (c) => t('errors.validation.invalidPipelineBody', undefined, c),
        invalidSpec: (c) => t('errors.validation.invalidPipelineSpec', undefined, c),
        notPublished: (c) => t('errors.conflict.pipelineNotPublished', undefined, c),
        invalidState: (c) => t('errors.conflict.pipelineInvalidState', undefined, c),
        nothingToPublish: (c) => t('errors.conflict.pipelineNothingToPublish', undefined, c),
        runFinished: (c) => t('errors.conflict.pipelineRunFinished', undefined, c),
        templateNotInstantiable: (c) =>
          t('errors.conflict.pipelineTemplateUnsupported', undefined, c),
        projectIdRequired: (c) => t('errors.validation.projectIdRequired', undefined, c),
      },
    },
  ));

  // ADR-086 §5: установка пакетов расширений (скиллы/MCP/агенты/пайплайны) и
  // реестр установок. Managed RBAC: установка — ADMIN или service-key со
  // scope `automation:install`; одобрение и снятие — **только ADMIN** (снимают
  // чужие артефакты инстанса).
  app.route('/api/v2/packs', createPacksRoutes(
    { requireAuth: auth.requireAuth },
    {
      packs,
      pipelines,
      skills: skillService,
      mcpRegistry: mcpRegistryStore,
      agents: agentStore,
      roleFiles: contextConfig,
      routes: routeRuleStore,
      // ADR-106 Ф5: контент полномочий пакета активируется в политике
      // инстанса при одобрении и снимается при снятии установки.
      authorityPolicy: deps.storageContext.authorityPolicy,
      registerAgent: (agent) => agentRegistry.register(agent),
      unregisterAgent: (id) => agentRegistry.unregister(id),
      resolveUserId: (c) => {
        const user = c.get('user') as { id?: string } | undefined;
        return user?.id;
      },
    },
    {
      readGuard: auth.requirePermission('ADMIN'),
      writeGuard: requireAdminRoleOrScope('automation:install'),
      approveGuard: auth.requirePermission('ADMIN'),
      uninstallGuard: auth.requirePermission('ADMIN'),
      scopeGuard,
    },
  ));

  // ADR-090 (Ф5б-2): управление плагинами инстанса. Managed RBAC:
  // чтение — ADMIN (реестр инстанса), установка/активация/деактивация —
  // ADMIN или service-key со scope `addons:install` (установка аддонов —
  // зонтичный scope реестра расширений), подтверждение карантина и снятие —
  // **только ADMIN** (снятие гасит код в процессе ядра). Установка из
  // локального каталога/архива запрещена (`localInstall: false` → 403
  // `LOCAL_INSTALL_DISABLED`): путь с ФС хоста в managed не принимается.
  // Сетевые источники (`npm`/`url`) разрешены — это не локальный путь, а
  // доставка бандла с проверкой целостности (SRI/sha256).
  app.route('/api/v2/plugins', createPluginsRoutes(
    { requireAuth: auth.requireAuth },
    {
      runtime: deps.pluginRuntime,
      config: mergePluginsConfig(config.synth.plugins, {}),
      settings: settingsStore,
      localInstall: false,
      // Ф7 (ADR-090): реестр service-key — для выдачи server-scoped токена
      // плагину (`POST /api/v2/plugins/token`).
      serviceKeys: serviceApiKeyStore,
      // Ф7: серверная политика (allow-list) из работающего рантайма.
      serverPolicy: () => resolvePluginServerPolicy(deps.pluginRuntime.config),
      resolveUserId: (c) => {
        const user = c.get('user') as { id?: string } | undefined;
        return user?.id;
      },
    },
    {
      readGuard: auth.requirePermission('ADMIN'),
      writeGuard: requireAdminRoleOrScope('addons:install'),
      approveGuard: auth.requirePermission('ADMIN'),
      uninstallGuard: auth.requirePermission('ADMIN'),
      // Ф7 (Уровень 2): выдача server-scoped токена — только ADMIN (токен даёт
      // плагину машинный доступ к серверу).
      tokenGuard: auth.requirePermission('ADMIN'),
    },
  ));

  // ADR-090 (Ф5б-2): runtime-настройки слоя плагинов. Managed RBAC —
  // ADMIN (чтение и запись): политика доверия/скана/исполнения — инстанс-уровневая.
  // `restartRequired` — всегда true (рантайм собирается при старте, инвариант 24).
  app.route('/api/v2/settings', createPluginSettingsRoutes(
    { requireAuth: auth.requireAuth },
    {
      config: mergePluginsConfig(config.synth.plugins, {}),
      settings: settingsStore,
      running: deps.pluginRuntime.config,
      // Долги Д3: бюджеты (`promptBlockMaxChars`, `llmFilterTimeoutMs`) —
      // живые; остальные ключи — после рестарта (инвариант 24).
      onPluginsChange: (effective) => {
        deps.orchestrator.setPromptBlockMaxChars(effective.promptBlockMaxChars);
        deps.orchestrator.setLlmFilterTimeoutMs(effective.llmFilterTimeoutMs);
      },
    },
    {
      readGuard: auth.requirePermission('ADMIN'),
      writeGuard: auth.requirePermission('ADMIN'),
    },
  ));

  // ADR-052 (этап I): CRUD service-key инстанса (`synth_svc_…`). Managed RBAC:
  // только ADMIN (ключи дают машинный доступ — управление админское), i18n.
  app.route('/api/v2/service-keys', createServiceKeyRoutes(
    { requireAuth: auth.requireAuth },
    { store: serviceApiKeyStore },
    {
      writeGuard: auth.requirePermission('ADMIN'),
      readGuard: auth.requirePermission('ADMIN'),
      // createdBy: `attachUser` уже положил пользователя в контекст — берём его id.
      resolveUserId: (c) => {
        const user = c.get('user') as { id?: string } | undefined;
        return user?.id ?? '';
      },
      messages: {
        invalidKey: (c) => t('errors.validation.invalidServiceKey', undefined, c),
        keyNotFound: (c) => t('errors.notFound.serviceKey', undefined, c),
        keyLabelConflict: (c) => t('errors.conflict.serviceKeyLabel', undefined, c),
      },
    },
  ));

  // ADR-052 (этап II): подписки на исходящие webhooks (CRUD + журнал + тест).
  // Managed RBAC: только ADMIN (webhook может утекать данные на произвольный
  // URL), i18n. Мастер-выключатель `webhooks.enabled` → 503 на мутации/тест.
  app.route('/api/v2/webhooks', createWebhookRoutes(
    { requireAuth: auth.requireAuth },
    { store: webhookStore, deliveryStore: webhookDeliveryStore, service: webhookService },
    {
      writeGuard: auth.requirePermission('ADMIN'),
      readGuard: auth.requirePermission('ADMIN'),
      resolveUserId: (c) => {
        const user = c.get('user') as { id?: string } | undefined;
        return user?.id ?? 'unknown';
      },
      isEnabled: () => webhooksConfig.enabled,
      // Отдельный экземпляр политики (live; граница доверия не смешивается с tools).
      resolvePolicy: () => egressResolver.resolveWebhooks(),
      messages: {
        invalid: (c) => t('errors.validation.invalidWebhook', undefined, c),
        notFound: (c) => t('errors.notFound.webhook', undefined, c),
        labelConflict: (c) => t('errors.conflict.webhookLabel', undefined, c),
        targetForbidden: (c) => t('errors.validation.webhookTargetForbidden', undefined, c),
        disabled: (c) => t('errors.unavailable.webhooksDisabled', undefined, c),
      },
    },
  ));

  // ADR-091/ADR-092: обслуживание инстанса (backup/restore/doctor/migrate).
  // Managed RBAC: только ADMIN — операции меняют/отдают данные всего инстанса
  // (архивы могут содержать секреты), i18n.
  // ADR-097: при backend=postgres doctor/migrations ходят в БД через read-only
  // пробу (контекст в режиме `skip` — миграции не применяются).
  const maintenanceBackend = resolveStorageBackend(config.synth, process.env);
  const withPostgresContext = maintenanceBackend === 'postgres'
    ? async <T>(fn: (ctx: StorageContext) => Promise<T>): Promise<T> => {
        const ctx = await createStorageContextAsync('postgres', {
          dataDir,
          secretKey: resolveSecretKey(config.synth),
          env: process.env,
          postgres: resolvePostgresConfig(config.synth, process.env),
          postgresPassword: resolvePostgresPassword({ dataDir }, process.env),
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
    { requireAuth: auth.requireAuth },
    {
      dataDir,
      secretKey: resolveSecretKey(config.synth),
      env: process.env,
      audit: maintenanceAudit,
      storageBackend: maintenanceBackend,
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
    {
      writeGuard: auth.requirePermission('ADMIN'),
      readGuard: auth.requirePermission('ADMIN'),
      maxUploadBytes: config.maxUploadBytes,
      resolveUserId: (c) => {
        const user = c.get('user') as { id?: string } | undefined;
        return user?.id ?? 'unknown';
      },
      messages: {
        invalidBody: (c) => t('errors.validation.invalidMaintenanceBody', undefined, c),
        confirmRequired: (c) => t('errors.validation.maintenanceConfirmRequired', undefined, c),
        backupNotFound: (c) => t('errors.notFound.backup', undefined, c),
        invalidBackupName: (c) => t('errors.validation.invalidBackupName', undefined, c),
        payloadTooLarge: (c) => t('errors.payloadTooLarge', undefined, c),
        invalidArchive: (c) => t('errors.validation.invalidRestoreArchive', undefined, c),
        schemaTooNew: (c) => t('errors.conflict.schemaTooNew', undefined, c),
        invalidAuditLimit: (c) => t('errors.validation.invalidAuditLimit', undefined, c),
        invalidAuditOp: (c) => t('errors.validation.invalidAuditOp', undefined, c),
        encryptedRestore: (c) => t('errors.validation.encryptedRestoreUnsupported', undefined, c),
        restartUnsupported: (c) => t('errors.unavailable.restartUnsupported', undefined, c),
      },
    },
  ));

  // MCP routes (единый реестр; legacy /servers — адаптеры над ним)
  app.route('/api/v2/mcp', createMcpRoutes(auth, mcpManager, sessionManager, {
    registry: mcpRegistryStore,
    // Политика резолвится на каждый запрос (live; исключения/режим — из стора).
    getNetworkPolicy: () => egressResolver.resolveMcp(),
    // ADR-105 (Ф3): порт слоя внешних доступов — право привязать доступ
    // к коннектору проверяется на границе (инвариант 16).
    credentials: deps.storageContext.externalCredentials,
    // ADR-105 (Ф3): проектный доступ привязывает участник проекта с правом
    // изменения содержимого (OWNER/EDITOR + LEAD/ADMIN; VIEWER — нет).
    canEditProject: async (c, projectId) => {
      const user = c.get('user') as { id?: string } | undefined;
      if (!user?.id) return false;
      const project = await projectStore.load(projectId);
      return project ? projectAccess.canEditProjectContent(c as never, project, user.id) : false;
    },
  }));

  // ADR-105 (Ф4): HTTP-контур слоя внешних доступов. Managed RBAC:
  // чтение — свои доступы (владелец/участник проекта), `ADMIN`/`LEAD` — все;
  // мутации — владелец доступа (инстансные — `ADMIN`/`LEAD`); право
  // распоряжения доступом проверяется на границе (инвариант 16).
  app.route('/api/v2/oauth', createOAuthRoutes(
    { requireAuth: auth.requireAuth },
    {
      credentials: deps.storageContext.externalCredentials,
      service: deps.oauthCredentialService,
      providers: deps.oauthProviders,
      // ADR-105 (Ф4): журнал операций со слоем доступов (привязка к коннектору).
      audit: deps.storageContext.credentialAudit,
      ownerKind: 'user',
      resolveActor: (c) => {
        const user = c.get('user') as { id?: string; roles?: string[] } | undefined;
        return { userId: user?.id ?? '', roles: user?.roles ?? [] };
      },
      canReadProject: async (c, projectId) => {
        const user = await auth.getCurrentUser(c);
        if (!user) return false;
        const project = await projectStore.load(projectId);
        return project ? projectAccess.canReadProject(c, project, user.id) : false;
      },
      canEditProject: async (c, projectId) => {
        const user = await auth.getCurrentUser(c);
        if (!user) return false;
        const project = await projectStore.load(projectId);
        return project ? projectAccess.canEditProjectContent(c, project, user.id) : false;
      },
      bindConnector: async ({ connectorId, credentialId, actor, c }) => {
        await bindCredentialToConnector({
          registry: deps.mcpRegistryStore,
          connectorId,
          credentialId,
          // Запись реестра меняет автор записи или `ADMIN` (как в `mcp-registry`).
          canModify: (entry) => {
            const user = c.get('user') as { id?: string } | undefined;
            if (auth.isAdmin(c)) return true;
            if (entry.author?.userId && user?.id && entry.author.userId === user.id) return true;
            return actor.roles.includes('ADMIN') || actor.roles.includes('LEAD');
          },
        });
        // Реестр — источник истины для конфигурации серверов (ADR-071 §2.5):
        // без синхронизации менеджер остался бы со старым конфигом (без `auth`).
        await syncMcpManagerFromRegistry(mcpManager, deps.mcpRegistryStore);
      },
    },
  ));

  // Скиллы (ADR-046 §9.1/§9.2): core-фабрика + RBAC ADMIN на запись.
  app.route('/api/v2/skills', createSkillRoutes(auth as unknown as CoreAuthKit, {
    skillService,
    resolveProjectWorkspace: async (projectId) => {
      const project = await projectStore.load(projectId);
      if (!project?.workspace) return undefined;
      return isAbsolute(project.workspace)
        ? normalize(project.workspace)
        : resolve(config.workspacesRoot, project.workspace);
    },
  }, { writeGuard: requireAdminOrScope('addons:install') }));

  // ADR-046 §7/§9.1: команды и bundles (mirror core, мутации — ADMIN).
  app.route('/api/v2/commands', createCommandRoutes(auth as unknown as CoreAuthKit, {
    commandService,
    resolveProjectWorkspace: async (projectId) => {
      const project = await projectStore.load(projectId);
      if (!project?.workspace) return undefined;
      return isAbsolute(project.workspace)
        ? normalize(project.workspace)
        : resolve(config.workspacesRoot, project.workspace);
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

  // ADR-046 §4.5: scope-API скиллов. Доступ к сессии — та же семантика, что у
  // `createSessionRoutes` (единая точка истины на ресурс сессии): владелец|ADMIN
  // (`canAccess`), участник проекта (`resolveCanAccessExtra`), сквозной обзор
  // ADMIN/LEAD (`resolveElevated`); проект — owner/LEAD/ADMIN.
  const resolveSkillWorkspace = async (projectId: string): Promise<string | undefined> => {
    const project = await projectStore.load(projectId);
    if (!project?.workspace) return undefined;
    return isAbsolute(project.workspace)
      ? normalize(project.workspace)
      : resolve(config.workspacesRoot, project.workspace);
  };
  app.route('/api/v2/sessions', createSessionSkillScopeRoutes(auth as unknown as CoreAuthKit, {
    sessionManager, skillService, settingsStore, projectStore,
    permissionConfig: config.synth.permission,
    resolveProjectWorkspace: resolveSkillWorkspace,
  }, {
    writeGuard: auth.requireAuth,
    resolveUserId: async (c) => (await auth.getCurrentUser(c as never))?.id ?? '',
    canAccess: (session, c, userId) =>
      (session.ownerId ?? session.userId) === userId
      || auth.isAdmin(c as never),
    resolveElevated: (c) =>
      auth.isAdmin(c as never) || auth.hasRole(c as never, 'LEAD'),
    // read/write по роли в проекте (та же модель `createProjectAccess`, что и в
    // session/message/queue-фабриках): GET — owner/любой участник, PUT — owner/EDITOR.
    resolveCanAccessExtra: (() => {
      const { canReadProject, canEditProjectContent } = createProjectAccess(auth);
      return async (session, c, userId, access) => {
        if (!session.projectId) return false;
        const project = await projectStore.load(session.projectId);
        if (!project) return false;
        const ctx = c as Parameters<typeof auth.isAdmin>[0];
        return access === 'read'
          ? canReadProject(ctx, project, userId)
          : canEditProjectContent(ctx, project, userId);
      };
    })(),
  }));
  app.route('/api/v2/projects', createProjectSkillScopeRoutes(auth as unknown as CoreAuthKit, {
    sessionManager, skillService, settingsStore, projectStore,
    permissionConfig: config.synth.permission,
    resolveProjectWorkspace: resolveSkillWorkspace,
  }, {
    // ADR-046 §4.5: проектным уровнем управляют owner/LEAD/ADMIN — как в
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

  // ADR-089: идентичности текущего пользователя (`GET/DELETE /api/v2/me/identities`).
  // RBAC: аутентифицированный пользователь (только свои); линковка — claim-flow
  // (`POST /api/v2/me/identities/claim`).
  // Резолвим **id профиля** по `username` аутентифицированного пользователя
  // (OIDC `sub` — не id профиля: профили хранятся под сгенерированным id).
  // Не передаём `roles` — чтобы не перезаписывать роли существующего профиля.
  app.route('/api/v2/me', createIdentityRoutes(auth as unknown as CoreAuthKit, profilesStore, {
    resolveProfileId: async (c) => {
      const u = await auth.getCurrentUser(c as never);
      if (!u) return '';
      const profile = (await profilesStore.getProfileByUsername(u.username))
        ?? (await profilesStore.getOrCreateProfile({ username: u.username, email: u.email }));
      return profile.id;
    },
    claimStore: identityClaimStore,
    // ADR-089 (claim-flow): анти-брутфорс одноразового кода (6 символов, TTL 10 мин) —
    // per-user fixed window 60 c (ключ — Authorization-токен, не IP).
    rateLimitGuard: createRateLimiter(
      10,
      60_000,
      (c) => t('errors.rateLimited.identityClaim', undefined, c),
    ),
    messages: {
      identityNotFound: (c) => t('errors.notFound.identity', undefined, c),
      claimNotFound: (c) => t('errors.notFound.identityClaim', undefined, c),
      claimConflict: (c) => t('errors.conflict.identityClaim', undefined, c),
      claimCodeRequired: (c) => t('errors.validation.claimCodeRequired', undefined, c),
      unauthorized: (c) => t('auth.unauthorized', undefined, c),
    },
  }));

  // LLM Gateway audit routes (ADR-036) — GET только ADMIN/AUDITOR, POST /revealed — все авторизованные
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

  // LLM Gateway patterns routes (ADR-036) — управление regex-паттернами детекции секретов, только ADMIN
  app.route('/api/v2/gateway', createGatewayPatternsRoutes(auth, patternStore));

  // LLM Proxy (гибридный режим, Часть 5) — OpenAI-совместимый POST /api/v2/llm/chat/completions.
  // Локальный core гоняет LLM-запросы централизованно через LLM Gateway (ADR-036):
  // обфускация/блокировка секретов, rate limit, аудит, полный payload-лог.
  app.route('/api/v2/llm', createLlmRoutes(auth, {
    providerLoader,
    modelLoader,
    // mergeLlmGatewayConfig может вернуть undefined, если ни base, ни runtime не заданы —
    // но schema с default({}) гарантирует base, поэтому подставляем его.
    gatewayConfig: gatewayConfig ?? config.synth.llmGateway,
    gatewayAuditLogger,
    gatewayRateLimiter: new RateLimiter(
      (gatewayConfig ?? config.synth.llmGateway).rateLimit.userPerMinute,
      (gatewayConfig ?? config.synth.llmGateway).rateLimit.providerPerMinute,
    ),
    gatewayPayloadLogPath,
    patternStore,
    rateLimiter: createRateLimiter(120, 60_000),
    // ADR-094: LLM-прокси учитывается в метриках (undefined — выключено).
    metrics,
  }));

  // Settings routes (runtime-настройки для UI: workspace + mcp; переиспользуем core-реализацию)
  app.route('/api/v2/settings', createSettingsRoutes(auth as unknown as CoreAuthKit, {
    settingsStore,
    fallbackWorkspace: defaultWorkingDir,
    // ADR-075: managed-развёртывание — политика вне `workspacesRoot` всегда `deny`
    // (enforcement — в `routes/projects.ts`); строго read-only: GET отдаёт
    // fallback + readOnly, PUT/DELETE → 403 WORKSPACE_POLICY_READ_ONLY.
    fallbackWorkspaceOutsideRootPolicy: 'deny',
    workspacePolicyReadOnly: true,
    // Агент по умолчанию при первом развёртывании (config.yaml не задаёт — DEFAULT_AGENT_ID).
    fallbackDefaultAgent: DEFAULT_AGENT_ID,
    // Модель по умолчанию: fallback из config (только если заданы оба поля);
    // runtime-пара приоритетнее. Валидация — провайдер в каталоге + модель `provider/model`.
    fallbackDefaultModel: backendConfigDefaultModel(),
    validateDefaultModel: async (pair) => {
      const provider = await providerStore.load(pair.provider);
      if (!provider) return `провайдер "${pair.provider}" не найден`;
      const model = await modelStore.load(`${pair.provider}/${pair.model}`);
      if (!model) return `модель "${pair.provider}/${pair.model}" не найдена`;
      return true;
    },
    // ADR-072 Ф2: дефолты из config.yaml (без runtime) — для GET/DELETE-сброса к умолчанию.
    fallbackLlmGateway: {
      enabled: config.synth.llmGateway.enabled,
      inputMode: config.synth.llmGateway.inputMode,
      logPayloads: config.synth.llmGateway.logPayloads,
      rateLimit: {
        userPerMinute: config.synth.llmGateway.rateLimit?.userPerMinute ?? DEFAULT_LLM_GATEWAY_RATE_LIMIT.userPerMinute,
        providerPerMinute: config.synth.llmGateway.rateLimit?.providerPerMinute ?? DEFAULT_LLM_GATEWAY_RATE_LIMIT.providerPerMinute,
      },
    },
    fallbackSecurity: {
      protectedPaths: { enabled: config.synth.security.protectedPaths?.enabled ?? true },
      // ADR-029: askTimeoutMs живёт в permission-секции конфига (не в security).
      askTimeoutMs: config.synth.permission?.askTimeoutMs,
    },
    // ADR-036: live-применение тумблера LLM Gateway из UI — без рестарта сервера.
    onLlmGatewayChange: async (runtime) => {
      const merged = mergeLlmGatewayConfig(config.synth.llmGateway, runtime);
      orchestrator.setGatewayConfig(merged);
    },
    // live-применение тумблера защищённых путей из UI — без рестарта сервера.
    onSecurityChange: async (runtime) => {
      const merged = mergeSecurityConfig(config.synth.security, runtime);
      orchestrator.setSecurityConfig(merged);
    },
    // ADR-071 §2.3: live-применение политики встроенных инструментов из админки.
    fallbackToolsPolicy: config.synth.tools.policy,
    onToolsPolicyChange: async (policy) => {
      orchestrator.setToolsPolicy(policy);
    },
    // ADR-071 §2.3: live-применение политики MCP-инструментов из админки.
    fallbackMcpPolicy: config.synth.mcp.policy,
    onMcpPolicyChange: async (policy) => {
      orchestrator.setMcpPolicy(policy);
    },
    // ADR-071 §2.6: live-применение instance-wide отключения инструментов.
    fallbackToolsDisabled: config.synth.tools.disabled,
    onToolsDisabledChange: async (disabled) => {
      orchestrator.setToolsDisabled(disabled);
    },
    knownTools: () => toolRegistry.list().map((tool) => ({
      name: tool.name,
      capabilities: [...tool.capabilities],
    })),
    // ADR-071 §2.3.1: live-применение политики сетевого доступа MCP из админки.
    fallbackMcpNetworkPolicy: config.synth.mcp.networkPolicy,
    // ADR-071 §2.3.1: колбэк не нужен — `McpManager` резолвит политику из стора
    // при каждом connect/probe (live, без стартового снимка).
    // Egress: дефолты config.yaml для GET/DELETE-сброса + аудит изменений.
    fallbackEgressTools: config.synth.egress.tools,
    fallbackEgressWebhooks: config.synth.egress.webhooks,
    // ADR-099: прокси — config-уровень, runtime-override и файл пароля.
    fallbackProxy: config.synth.proxy,
    // ADR-099: TLS/CA — config-уровень (read-only в UI; runtime — bootstrap).
    fallbackTls: config.synth.security?.tls,
    dataDir,
    env: process.env,
    securityAudit,
    resolveActor: (c) => {
      const user = c.get('user') as { id?: unknown } | undefined;
      return typeof user?.id === 'string' && user.id ? user.id : 'unknown';
    },
    // ADR-089: дефолт config.yaml для GET/DELETE-сброса раздела «События».
    fallbackEvents: config.synth.events,
    // ADR-089: live-применение runtime-настроек «События» — Router/funnel/pruner.
    onEventsChange: (effective) => {
      live.setEvents(effective);
    },
    // ADR-084: дефолт config.yaml для GET/DELETE-сброса decision-слоя.
    fallbackDecision: config.synth.decision,
    // ADR-084: live-применение runtime-настроек decision-слоя — микро-каскад и
    // роутер читают конфиг геттером оркестратора; события — через `live.setEvents`.
    onDecisionChange: (effective) => {
      live.setDecision(effective);
    },
    protectedPathsStore,
  }, {
    // Instance-wide настройки (ADR-072): все мутации `/api/v2/settings/*`
    // (workspace, mcp, llm-gateway, security, tools-policy, mcp-policy,
    // mcp-network-policy, default-agent, workspace-policy, tools-disabled,
    // protected-paths, events, decision) — только ADMIN (managed RBAC).
    // События/decision наследуют тот же guard (если не заданы отдельно).
    settingsWriteGuard: auth.requirePermission('ADMIN'),
  }));

  // ADR-094: админ-раздел «Наблюдаемость» — runtime `metrics.enabled` (рестарт),
  // live-статус и bearer-токен `/metrics` (write-only, применяется сразу).
  // Managed RBAC: чтение и мутации — только ADMIN.
  app.route('/api/v2/settings', createMetricsSettingsRoutes(
    { requireAuth: auth.requireAuth },
    {
      settingsStore,
      dataDir,
      configEnabled: config.synth.metrics.enabled,
      runningEnabled: ctx.metrics.runningEnabled,
      getRegistry: ctx.metrics.getRegistry,
      getReadiness: ctx.metrics.getReadiness,
      getStorageBackend: () => ctx.metrics.storageBackend,
      getUptimeSec: ctx.metrics.getUptimeSec,
      version: SYNTH_VERSION,
    },
    {
      readGuard: auth.requirePermission('ADMIN'),
      writeGuard: auth.requirePermission('ADMIN'),
    },
  ));

  // Журналы безопасности: аудит изменений политик + внешние запросы (egress).
  // Managed RBAC: чтение только ADMIN/AUDITOR.
  app.route('/api/v2/audit', createSecurityAuditRoutes(auth as unknown as CoreAuthKit, {
    securityAudit,
    egressRequests,
  }, {
    readGuard: auth.requirePermission('ADMIN', 'AUDITOR'),
  }));

  // ADR-102 (волна 1): отчёты аналитики — только чтение, данных без локализации.
  // Managed RBAC (§7): ADMIN/LEAD — сквозной обзор; AUDITOR — чтение всех отчётов;
  // обычный USER — принудительный фильтр оси `user` по себе (+ 403 на `decision`/`summary`).
  app.route('/api/v2/analytics', createAnalyticsRoutes(
    { requireAuth: auth.requireAuth },
    { service: new AnalyticsService({ repo: analyticsRollups }) },
    {
      resolveElevated: (c) => auth.isAdmin(c as never) || auth.hasRole(c as never, 'LEAD'),
      resolveAuditor: (c) => auth.hasRole(c as never, 'AUDITOR'),
      // `attachUser` уже положил пользователя в контекст — берём его id.
      resolveUserId: (c) => {
        const user = c.get('user') as { id?: string } | undefined;
        return user?.id ?? '';
      },
      messages: {
        invalidPeriod: (c) => t('errors.validation.invalidAnalyticsPeriod', undefined, c),
        invalidRange: (c) => t('errors.validation.invalidAnalyticsRange', undefined, c),
        invalidGroupBy: (c) => t('errors.validation.invalidAnalyticsGroupBy', undefined, c),
        invalidOption: (c) => t('errors.validation.invalidAnalyticsOption', undefined, c),
        forbidden: (c) => t('errors.forbidden.analytics', undefined, c),
      },
    },
  ));

  // Словари классификации: чтение — все авторизованные, запись/сброс — ADMIN
  // (тот же guard, что у users.ts). Реализация общая с core; порт — из контекста хранения.
  app.route('/api/v2/dictionaries', createDictionaryRoutes(
    auth,
    dictionaries,
    { writeGuard: auth.requireAdmin },
  ));

  // ADR-069 §9.3: прозрачность проектных инструкций — core-фабрика (резолвер не
  // дублируется). RBAC: сессия — владелец|ADMIN (canAccess, как в session-роутах);
  // проект — owner/LEAD/ADMIN (canAccessProject, как в project-скиллах).
  const instructionsInfoResolver = createInstructionsInfoResolver(
    new ProjectInstructionsResolver({
      config: config.synth.instructions,
      dictionaryStore: dictionaries,
      dataDir,
      trustedProjectDirs: config.synth.skills.trustedProjectDirs,
      // ADR-069 R3: авто-trust workspace внутри workspacesRoot (managed-каталоги).
      workspacesRoot: config.workspacesRoot,
      // ADR-077: `git rev-parse` — через порт исполнения (тот же, что у тулов).
      execution: deps.executionPort,
    }),
    config.synth.instructions,
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

  // Глобальный SSE-хаб для всех сессий пользователя (ADR-052: `events:watch`).
  registerEventsSse(app, { auth, eventHub, scopeGuard });

  // Admin routes (кроме graceful shutdown — он живёт в main.ts, т.к. требует server)
  app.route('/api/v2/admin/debug', createDebugRoutes(auth));
}
