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
//
// ADR-095 (шаг 4b): фасад-композиция — зависимости (`app/deps.ts`), порядок
// монтирования роутов (`app/mount-routes.ts`), SSE-хаб (`app/sse-events.ts`),
// HTTP/WS-адаптер (`app/listen.ts`). Экспорты и поведение прежние.

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { createMiddleware } from 'hono/factory';
import {
  applyBootstrapServiceKeys,
  checkExecutionMode,
  createHealthRoutes,
  createHttpMetricsMiddleware,
  createMetricsRoutes,
  KeyRateLimiter,
  getServiceCredential,
  MetricsRegistry,
  registerProcessMetrics,
  resolveMetricsEnabled,
  resolveMetricsToken,
  setSynthReady,
} from '@itphx/synth-core';
import { resolveExecutionConfig } from '@itphx/synth-shared';
import type {
  EventBus, SessionManager, QueueProcessorManager, ChatOrchestrator, ProjectRepository,
  SettingsRepository, EventRouter, RequestSessionService, EventBindingRepository,
  EventJournalRepository, EventIngress, ScheduleRepository, SchedulerService,
  WebhookRepository, WebhookService, StorageContext, PluginRuntime,
} from '@itphx/synth-core';
import { createStorageDegradedGuard, createStorageStatusRoutes } from '@itphx/synth-core/server/storage-degraded.js';
import { loadBackendConfig } from './lib/app-config.js';
import type { BackendConfig } from './lib/app-config.js';
import { resolveCorsOrigin } from './lib/cors.js';
import { createAuthMiddleware } from './auth/middleware.js';
import type { AuthKit } from './auth/middleware.js';
import { createAuthRoutes } from './routes/auth.js';
import { t } from './lib/i18n.js';
import type { EventHub } from './events/hub.js';
import { createBackendDeps, createBackendStorage } from './app/deps.js';
import { mountBackendRoutes } from './app/mount-routes.js';
import { createBackendListen } from './app/listen.js';

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
  projectStore: ProjectRepository;
  orchestrator: ChatOrchestrator;
  queueManager: QueueProcessorManager;
  settingsStore: SettingsRepository;
  /** ADR-094: реестр метрик (HTTP/процесс и доменные коллекторы). */
  metrics: MetricsRegistry;
  /** ADR-094: остановка процессных метрик и фоновых доменных коллекторов на shutdown. */
  stopMetrics: () => void;
  // ADR-089: ядро маршрутизации событий и единый funnel создания сессий.
  eventRouter: EventRouter;
  requestSessionService: RequestSessionService;
  eventBindingStore: EventBindingRepository;
  eventJournal: EventJournalRepository;
  /** ADR-089: ingress-точка приёма внешних событий. */
  ingress: EventIngress;
  /**
   * PROP-090 §5/§10 (Ф5б-1): рантайм плагинов — старт-активация установленного
   * (`main.ts`) и точки для HTTP API/CLI (Ф5б-2/3).
   */
  pluginRuntime: PluginRuntime;
  // ADR-051 (срез) / ADR-089: реестр расписаний и планировщик (cron/interval).
  scheduleStore: ScheduleRepository;
  scheduler: SchedulerService;
  /** ADR-051 (срез): остановка планировщика (на graceful shutdown). */
  stopScheduler: () => void;
  /** ADR-089: остановка sweeper'а авто-архивации ephemeral-сессий. */
  stopEphemeralSweeper: () => void;
  /** ADR-089: остановка периодической retention-очистки журнала событий. */
  stopEventJournalPruner: () => void;
  /** ADR-102: остановка retention-очистки суточных роллапов аналитики. */
  stopAnalyticsRollupPruner: () => void;
  /** ADR-052 (этап II): реестр подписок webhooks (для тестов/диагностики). */
  webhookStore: WebhookRepository;
  /** ADR-052 (этап II): движок исходящих webhooks. */
  webhookService: WebhookService;
  /** ADR-052 (этап II): остановка движка webhooks (на graceful shutdown). */
  stopWebhookService: () => void;
  /** ADR-052 (этап II): остановка retention-очистки журнала доставок. */
  stopWebhookDeliveryPruner: () => void;
  /** Egress: остановка retention-очистки журнала внешних запросов. */
  stopEgressLogPruner: () => void;
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
 * Backend-приложение Synth (managed): `createBackendApp` без прослушивания порта.
 * Фасад-композиция: зависимости — `app/deps.ts`, порядок монтирования роутов —
 * `app/mount-routes.ts`, SSE-хаб — `app/sse-events.ts`, HTTP/WS — `app/listen.ts`.
 */
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

    // ADR-077: топология исполнения — параметр запуска (инвариант 24). Fail-closed:
    // неверный `mode`/`failMode` — ошибка; `remote` без адресов/пакета исполнителя/
    // читаемого токена — старт прерывается, а не «молча уходит в inline».
    const execution = resolveExecutionConfig(backendConfig.synth, process.env);
    const executionCheck = await checkExecutionMode(execution);
    if (!executionCheck.ok) {
      throw new Error(executionCheck.message);
    }

    const app = new Hono();

    app.use(logger());

    // ADR-096 (W2.4): единый контекст хранения — собирается до `auth`, реестр
    // service-key (`storage.serviceKeys`) нужен резолверу `synth_svc_…`; тот же
    // инстанс переиспользует `createBackendDeps` (в т.ч. `mcpRegistry`, который
    // деп сидирует instance-серверами).
    // ADR-094: контекст хранения нужен до включения метрик — runtime-настройка
    // `metrics.enabled` (`settings.json`/PG) применяется при старте.
    const storage = await createBackendStorage(backendConfig);

    // ADR-094: метрики — реестр до middleware; при `metrics.enabled=false`
    // ничего не собираем, `/metrics` отдаёт 404 (middleware не ставим).
    // Приоритет: env `SYNTH_METRICS_ENABLED` > runtime (`settings.json`) >
    // config.yaml `metrics.enabled` > default false.
    const runtimeMetrics = await storage.settings.getMetrics();
    const metricsEnabled = resolveMetricsEnabled({
      configEnabled: backendConfig.synth.metrics.enabled,
      runtimeEnabled: runtimeMetrics.enabled,
      env: process.env,
    }).enabled;
    const metrics = new MetricsRegistry();
    const stopProcessMetrics = metricsEnabled ? registerProcessMetrics(metrics) : null;
    if (metricsEnabled) app.use('*', createHttpMetricsMiddleware(metrics));

    // CORS настраивается после загрузки конфига

    // Health (без auth). ADR-098 (W5): при деградации хранилища status='degraded'
    // + блок storage (аддитивно к {status, version, time}). `degradedInfo`
    // заполняется после сборки контекста хранения ниже (до первого запроса).
    // ADR-094: `/ready` — readiness (200 и при деградации, 503 — только не готов).
    const degradedInfo: StorageContext['degraded'] | null = storage.degraded ?? null;
    let initialized = false;
    app.route('/', createHealthRoutes({
      getStorageDegraded: () => degradedInfo ?? null,
      getReadiness: () => ({
        ready: initialized,
        storage: degradedInfo ? 'degraded' : 'ok',
      }),
    }));

    // ADR-094: `/metrics` — до auth (скрейп по сети pod'а, опциональный bearer).
    // Токен читается на каждый запрос — правка из UI применяется без рестарта.
    app.route('/', createMetricsRoutes({
      registry: metrics,
      enabled: metricsEnabled,
      getToken: metricsEnabled ? () => resolveMetricsToken(backendConfig.dataDir) : undefined,
    }));

    // Динамический CORS origin (fail-closed): явный ORIGIN через env `SYNTH_CORS_ORIGIN`;
    // иначе явный dev-флаг `SYNTH_CORS_ALLOW_ALL=true` (отражать любой origin);
    // иначе — точное совпадение с белым списком `server.allowedOrigins`.
    // Пустой белый список НЕ разрешает все origin — заголовки CORS не выставляются.
    const allowedOrigins: string[] = backendConfig.synth.server.allowedOrigins ?? [];
    const envCorsOrigin = process.env.SYNTH_CORS_ORIGIN || undefined;
    const allowAllOrigins = process.env.SYNTH_CORS_ALLOW_ALL === 'true';

    app.use(cors({
      origin: (origin) => resolveCorsOrigin(origin, {
        allowedOrigins,
        envOrigin: envCorsOrigin,
        allowAll: allowAllOrigins,
      }),
      credentials: true,
    }));

    // ADR-098 (W5): состояние деградации — для health/guard/диагностики
    // (уже проставлено при сборке контекста выше).
    // ADR-052 (этап I): реестр service-key — резолвер ключа `synth_svc_…`
    // нужен аутентификации (паритет с core `server/app.ts`).
    const serviceApiKeyStore = storage.serviceKeys;
    // ADR-052/O1: идемпотентный bootstrap installer-ключей из env/Secret
    // (best-effort — ошибка конфигурации не роняет старт, пишется в лог).
    await applyBootstrapServiceKeys(
      serviceApiKeyStore,
      backendConfig.synth.security.bootstrapServiceKeys ?? [],
    );
    const auth = createAuthMiddleware({
      ...backendConfig.auth,
      resolveServiceKey: async (raw) => {
        const resolved = await serviceApiKeyStore.resolveBySecret(raw);
        if (!resolved) return null;
        const key = resolved.key;
        // Best-effort отметка использования — не блокирует и не роняет запрос.
        void serviceApiKeyStore.touch(key.id).catch(() => {});
        return {
          user: {
            id: `service:${key.id}`,
            username: key.label,
            roles: [...key.roles],
            preferredLanguage: 'ru',
            createdAt: key.createdAt,
            teamRole: key.roles[0] ?? 'USER',
            notes: '',
            interviewCompleted: false,
            isLocal: false,
          },
          credential: resolved.credential,
        };
      },
    });

    // Прикрепляем пользователя ко всем запросам
    app.use('*', auth.attachUser);

    // ADR-052: per-key rate limit service-key (`rateLimitPerMinute` ключа;
    // 0/не задан — без лимита). После attachUser: `serviceKey` уже в контексте.
    const serviceKeyRateLimiter = new KeyRateLimiter(60_000);
    app.use('*', createMiddleware(async (c, next) => {
      const credential = getServiceCredential(c);
      const limit = credential?.rateLimitPerMinute ?? 0;
      if (credential && limit > 0 && !serviceKeyRateLimiter.check(credential.keyId, limit)) {
        return c.json(
          { error: { code: 'RATE_LIMITED', message: t('errors.rateLimited.serviceKey', undefined, c) } },
          429,
        );
      }
      await next();
    }));

    // Зависимости (stores/managers/оркестратор/событийное ядро/шедулер/webhooks).
    // Тот же контекст хранения, что собран до `auth`. ADR-094: реестр передаётся
    // только при `metrics.enabled` — иначе доменные коллекторы не подключаются.
    const deps = await createBackendDeps(
      backendConfig,
      storage,
      metricsEnabled ? metrics : undefined,
      execution,
    );

    // Auth routes (после profilesStore)
    app.route('/auth', createAuthRoutes(auth, backendConfig.auth, deps.profilesStore, deps.dataDir, deps.defaultsStore));

    // ADR-098 (W5): деградированное хранилище — managed: доступ только роли
    // ADMIN (остальным 503 STORAGE_DEGRADED), мутации — 503 STORAGE_DEGRADED_READONLY
    // (кроме ремонтных операций maintenance). Guard — после auth-роутов (логин/health
    // не блокируются) и до admin-роутов.
    app.use('/api/*', createStorageDegradedGuard({
      getDegraded: () => degradedInfo,
      isAdmin: (c) => {
        const user = c.get('user') as { roles?: string[] } | undefined;
        return Array.isArray(user?.roles) && user.roles.includes('ADMIN');
      },
      mutationAllowlist: ['/api/v2/maintenance'],
    }));

    // ADR-098 (W5): диагностика деградации (проверка соединения + «нужен рестарт»).
    app.route('/', createStorageStatusRoutes({ getDegraded: () => degradedInfo }));

    // Роуты API v2 (порядок монтирования — как раньше, см. mount-routes.ts).
    mountBackendRoutes(app, auth, {
      config: backendConfig,
      deps,
      // ADR-094: админ-раздел «Наблюдаемость» — running-флаг, реестр,
      // readiness, backend хранения и uptime.
      metrics: {
        runningEnabled: metricsEnabled,
        getRegistry: () => metrics,
        getReadiness: () => ({
          ready: initialized,
          storage: degradedInfo ? 'degraded' : 'ok',
        }),
        storageBackend: storage.kind,
        getUptimeSec: () => Math.floor(process.uptime()),
      },
    });

    // 404
    app.notFound((c) => {
      return c.json({
        error: {
          code: 'NOT_FOUND',
          message: t('errors.notFound.route', { method: c.req.method, path: c.req.path }, c),
        },
      }, 404);
    });

    // HTTP-сервер (раздача Hono-приложения) + WebSocket /ws/events.
    const listen = createBackendListen({
      app,
      auth,
      eventHub: deps.eventHub,
      sessionManager: deps.sessionManager,
      projectStore: deps.projectStore,
      eventBus: deps.eventBus,
      queueManager: deps.queueManager,
      processMessage: deps.processMessage,
      orchestrator: deps.orchestrator,
      defaultPort: backendConfig.port,
      // PROP-108 Ф3: реестр подтверждений — ответ на `permission_reply`
      // принимает только носитель покрывающего гранта (не «кто видит сессию»).
      approvalRegistry: deps.approvalRegistry,
      // ADR-094: активные WS-соединения — в streams_active (если метрики включены).
      metrics: metricsEnabled ? metrics : undefined,
    });

    // Композиция завершена — readiness переключается в ready (ADR-094).
    initialized = true;
    if (metricsEnabled) setSynthReady(metrics, 1);

    return {
      app,
      dataDir: deps.dataDir,
      port: backendConfig.port,
      config: backendConfig,
      auth,
      eventBus: deps.eventBus,
      eventHub: deps.eventHub,
      sessionManager: deps.sessionManager,
      projectStore: deps.projectStore,
      orchestrator: deps.orchestrator,
      queueManager: deps.queueManager,
      settingsStore: deps.settingsStore,
      // ADR-094: реестр метрик и остановка процессных **и** доменных коллекторов
      // (таймеры сессий/хранилища, подписка шины, decision/journal).
      metrics,
      stopMetrics: () => {
        stopProcessMetrics?.stop();
        for (const stop of deps.stopMetricsCollectors) {
          try {
            stop();
          } catch {
            // Остановка метрик не должна ломать shutdown.
          }
        }
      },
      // ADR-089: ядро событий (понадобится на этапах 5–6).
      eventRouter: deps.eventRouter,
      requestSessionService: deps.requestSessionService,
      eventBindingStore: deps.eventBindingStore,
      eventJournal: deps.eventJournal,
      ingress: deps.eventIngress,
      // PROP-090 §5/§10 (Ф5б-1): рантайм плагинов — старт-активация в `main.ts`
      // и точки для HTTP API/CLI (Ф5б-2/3).
      pluginRuntime: deps.pluginRuntime,
      // ADR-051 (срез) / ADR-089: реестр расписаний и планировщик.
      scheduleStore: deps.scheduleStore,
      scheduler: deps.schedulerService,
      stopScheduler: () => deps.schedulerService.stop(),
      stopEphemeralSweeper: deps.stopEphemeralSweeper,
      stopEventJournalPruner: deps.stopEventJournalPruner,
      stopAnalyticsRollupPruner: deps.stopAnalyticsRollupPruner,
      // ADR-052 (этап II): реестр подписок и движок webhooks + остановка на shutdown.
      webhookStore: deps.webhookStore,
      webhookService: deps.webhookService,
      stopWebhookService: () => deps.webhookService.stop(),
      stopWebhookDeliveryPruner: () => deps.stopWebhookDeliveryPruner(),
      stopEgressLogPruner: () => deps.stopEgressLogPruner(),
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
