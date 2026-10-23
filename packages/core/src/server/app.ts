import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { PermissionConfig, PlanMode, McpServerConfig, SecurityConfig, LLMGatewayConfig, ToolsPolicy, ToolsDisabledConfig, McpNetworkPolicy, SkillsConfig, CommandsConfig, InstructionsConfig, WorkspaceOutsideRootPolicy, WebhooksConfig, SynthConfig, PostgresStorageConfig, ResolvedExecutionConfig } from '@itphx/synth-shared';
import {
  applyBootstrapServiceKeys,
  KeyRateLimiter,
  getServiceCredential,
  getPublicOpenApiDocument,
  initTlsTrust,
  applyStartupProxyConfig,
  requirePluginTokenBinding,
} from '../index.js';
import type { StorageBackendKind } from '../index.js';
import { resolvePluginServerPolicy } from '../engine/plugins/hybrid-policy.js';
import { createLocalAuth } from '../auth/local.js';
import { RemoteConnection } from '../remote/connection.js';
import { createHealthRoutes } from './routes/health.js';
import { createMetricsRoutes } from './routes/metrics.js';
import { resolveMetricsEnabled } from './routes/metrics-settings.js';
import {
  attachHybridMetrics,
  createHttpMetricsMiddleware,
  MetricsRegistry,
  registerProcessMetrics,
  resolveMetricsToken,
  setSynthReady,
} from '../metrics/index.js';
import type { RemoteRequestInfo } from '../metrics/index.js';
import { createHybridRoutes } from './routes/hybrid.js';
import { createAuthRoutes } from './routes/auth.js';
import { createRemoteProxyMiddleware } from './proxy.js';
import type { RemoteEventBridge } from '../remote/event-bridge.js';
import { createStandaloneDeps, createStandaloneStorage } from './app/deps.js';
import { createHybridRemoteState } from './app/hybrid-remote.js';
import { mountStandaloneRoutes } from './app/mount-routes.js';
import { registerEventsSse } from './app/sse-events.js';
import { attachEventWebSocket, EventWebSocketSubscriptions } from './app/ws-events.js';
import { createStandaloneHttpServer } from './app/http-server.js';
import { createStorageDegradedGuard, createStorageStatusRoutes } from './storage-degraded.js';

/** Роль ADMIN у пользователя запроса (standalone — единственный владелец `local`). */
function hasAdminRole(c: Context): boolean {
  const user = c.get('user') as { roles?: string[] } | undefined;
  return Array.isArray(user?.roles) && user.roles.includes('ADMIN');
}

export interface StandaloneConfig {
  port: number;
  dataDir: string;
  apiKey: string;
  /**
   * ADR-096: физический backend хранения (`storage.backend`; env
   * `SYNTH_STORAGE_BACKEND` > config.yaml > `file`). Не задан — `file`.
   * `memory` — энергонезависимо (герметичные тесты); `postgres` — БД.
   */
  storageBackend?: StorageBackendKind;
  /** ADR-097: параметры PostgreSQL (при `storageBackend: 'postgres'`). */
  postgresConfig?: PostgresStorageConfig;
  /** ADR-097: пароль PostgreSQL (env/файл; не config.yaml — инвариант 13). */
  postgresPassword?: string;
  /** ADR-098 (задел W5): политика при недоступности backend. */
  degradedMode?: 'fallback-file' | 'halt';
  /** ADR-098 (задел W5): каталог файлового фоллбека при деградации. */
  fallbackDir?: string;
  workspacesRoot?: string;
  /** Рабочий каталог по умолчанию для сессий без проекта. Дефолт: {dataDir}/workspaces/default. */
  defaultWorkingDir?: string;
  /**
   * Максимальный размер загружаемого файла (`POST /api/v2/fs/upload`), в байтах.
   * Предзаполняется `resolveMaxUploadBytes` (env `SYNTH_MAX_UPLOAD_BYTES` >
   * config.yaml `storage.maxUploadBytes` > 100 МиБ). Не задан — дефолт 100 МиБ.
   */
  maxUploadBytes?: number;
  uiDistPath?: string;
  systemPromptsDir?: string;
  /** Глобальная секция permission из config.yaml (ADR-029). */
  permissionConfig?: PermissionConfig;
  /** Строгость цикла Plan→Build по умолчанию из config.yaml (ADR-028). */
  defaultPlanMode?: PlanMode;
  /** Секция безопасности (защита от Indirect Prompt Injection) из config.yaml. */
  securityConfig?: SecurityConfig;
  /** ADR-099 (D1): секция `proxy` из config.yaml (HTTP/HTTPS-прокси egress). */
  proxyConfig?: SynthConfig['proxy'];
  /**
   * ADR-076: мастер-ключ шифрования секретов at-rest (SSH-ключи). Задан —
   * приоритетнее env/файла; иначе `SSHKeyStore` использует `SYNTH_SECRET_KEY`
   * или файл `{dataDir}/secrets/master.key`.
   */
  secretKey?: string;
  /** LLM Gateway (ADR-036) из config.yaml — глобальный тумблер и конфиг. */
  gatewayConfig?: LLMGatewayConfig;
  /** ADR-070 §2.2: политика prompt-cache из config.yaml llm.cache (auto | none). */
  llmCachePolicy?: 'auto' | 'none';
  /**
   * ADR-089: дефолтные `provider`/`model` инстанса (`llm.defaultProvider`/
   * `llm.defaultModel`) — применяются к сессиям, материализуемым funnel'ом
   * (`RequestSessionService`: `ephemeral`/`bind`), когда явная модель не задана.
   */
  llmDefaults?: { provider?: string; model?: string };
  /** ADR-071 §2.3: глобальная политика включения встроенных инструментов из config.yaml tools.policy. */
  toolsPolicy?: ToolsPolicy;
  /** ADR-071 §2.3: глобальная политика включения MCP-инструментов из config.yaml mcp.policy. */
  mcpPolicy?: ToolsPolicy;
  /** ADR-071 §2.6: instance-wide отключение инструментов из config.yaml tools.disabled. */
  toolsDisabled?: ToolsDisabledConfig;
  /**
   * ADR-075: политика для абсолютного workspace вне `workspacesRoot` из
   * config.yaml/env (`confirm` | `deny`). Runtime-override — settings/workspace-policy.
   */
  workspaceOutsideRootPolicy?: WorkspaceOutsideRootPolicy;
  /** Конфигурация MCP-серверов из config.yaml mcp.servers (для probe и загрузки тулов). */
  mcpServers?: Record<string, McpServerConfig>;
  /** ADR-071 §2.3.1: политика сетевого доступа HTTP MCP из config.yaml mcp.networkPolicy. */
  mcpNetworkPolicy?: McpNetworkPolicy;
  /** ADR-046: конфигурация скиллов из config.yaml `skills` (paths/trustedProjectDirs/inlineShell). */
  skillsConfig?: SkillsConfig;
  /** ADR-046 §7: конфигурация slash-команд из config.yaml `commands`. */
  commandsConfig?: CommandsConfig;
  /** ADR-069 Фаза 1: конфигурация проектных инструкций из config.yaml `instructions`. */
  instructionsConfig?: InstructionsConfig;
  /** ADR-089: конфигурация приёма внешних событий из config.yaml `events`. */
  eventsConfig?: SynthConfig['events'];
  /** ADR-051 (срез) / ADR-089: конфигурация планировщика из config.yaml `scheduler`. */
  schedulerConfig?: SynthConfig['scheduler'];
  /** ADR-084: конфигурация decision-слоя из config.yaml `decision`. */
  decisionConfig?: SynthConfig['decision'];
  /** ADR-102: конфигурация аналитики (`analytics.retentionDays`) из config.yaml. */
  analyticsConfig?: SynthConfig['analytics'];
  /** ADR-094: конфигурация метрик (`metrics.enabled`) из config.yaml/env. */
  metricsConfig?: SynthConfig['metrics'];
  /**
   * ADR-106 Ф1: секция `authority` (мастер-выключатель слоя + режим
   * наблюдения). Не задана/выключена — Authority-слой не считает решения.
   */
  authorityConfig?: SynthConfig['authority'];
  /**
   * PROP-090 §10: конфигурация слоя плагинов из config.yaml `plugins`
   * (`enabled`/`trustFloor`/`scan`/… и бюджеты: `promptBlockMaxChars`,
   * `llmFilterTimeoutMs`).
   */
  pluginsConfig?: SynthConfig['plugins'];
  /**
   * ADR-077: эффективная секция `execution` (режим исполнения + параметры
   * удалённого исполнителя). Не задана — `inline` (прежнее поведение).
   * Секция — **параметр запуска** (инвариант 24): смена режима — только
   * рестартом процесса.
   */
  executionConfig?: ResolvedExecutionConfig;
  /** ADR-052 (этап II): конфигурация исходящих webhooks из config.yaml `webhooks`. */
  webhooksConfig?: WebhooksConfig;
  /** Egress: политика tools/webhooks и журнал внешних запросов из config.yaml. */
  egressConfig?: SynthConfig['egress'];
  /**
   * Дефолтный адрес удалённого backend (гибрид, `serve --connect`/env/конфиг).
   * Нужен для авто-логина (GET /auth/status) и POST /auth/login без поля server.
   * Сам сервер при этом стартует «холодным»: подключение происходит в рантайме.
   */
  defaultBackendUrl?: string;
  /** API-ключ к удалённому backend (`serve --token`) — машинное подключение при старте. */
  defaultToken?: string;
  /**
   * Параметры remote-аутентификации (гибрид): нужны RemoteConnection как
   * fallback OIDC issuer/client_id (дискавери с сервера имеет приоритет) и
   * путь к credentials. backendUrl больше НЕ передаётся — адрес сервера в
   * defaultBackendUrl.
   */
  remoteAuth?: {
    issuer?: string;
    clientId?: string;
    credentialsPath?: string;
  };
  /** Куда идут LLM-запросы локальных сессий: server (централизация) | local | auto. */
  remoteLlm?: 'server' | 'local' | 'auto';
  /** Таймаут запросов к удалённому backend (мс). */
  remoteTimeoutMs?: number;
  /** Путь к файлу credentials (~/.config/synth/credentials.json по умолчанию). */
  remoteCredentialsPath?: string;
  /**
   * ADR-079: путь к реестру профилей серверов (`<home>/profiles.json` либо XDG).
   * Если не задан — `getProfilesPath()` (XDG-дефолт).
   */
  profilesPath?: string;
  /**
   * Гибридный режим включён (remote.enabled в config.yaml либо задан OIDC
   * fallback --oidc-issuer/--oidc-client-id), даже если адрес сервера ещё не
   * известен (вводится в UI). Позволяет /auth/status отдать oidc_enabled=true и
   * /hybrid/status — enabled=true, чтобы LoginForm показал поле «Адрес сервера».
   */
  hybridEnabled?: boolean;
}

/**
 * @deprecated Гибрид переведён на runtime-подключение через RemoteConnection
 * (поле defaultBackendUrl + методы connect* на возвращаемом app-хэндле).
 * Статические remoteClient/remoteProvider/remoteGetToken/remoteEventBridge/
 * remoteBlockLocalProviders удалены — при необходимости подключите приложение
 * через connectRemoteWithApiKey/connectRemoteFromSaved.
 */

// ADR-095 (шаг 4a): `RemoteProviderSpec`/`injectRemoteProvider` вынесены в
// `app/hybrid-remote.ts`; реэкспорт сохраняет прежний импорт из `server/app.js`.
export { injectRemoteProvider } from './app/hybrid-remote.js';
export type { RemoteProviderSpec } from './app/hybrid-remote.js';

/**
 * Standalone-приложение Synth: `synth serve` без managed backend.
 * Фасад-композиция: зависимости — `app/deps.ts`, гибридное состояние —
 * `app/hybrid-remote.ts`, роуты — `app/mount-routes.ts`, транспорт —
 * `app/sse-events.ts`/`app/ws-events.ts`/`app/http-server.ts`, статика — `app/static.ts`.
 */
export async function createStandaloneApp(config: StandaloneConfig) {
  // ADR-099: единый механизм доверия TLS/CA — применяем **до** первого исходящего
  // запроса (сборка хранилища, сид провайдеров из env, дискавери/провайдеры ниже).
  // Fail-closed: битый/отсутствующий CA останавливает старт (не тихий фоллбэк).
  await initTlsTrust(
    { security: config.securityConfig, proxy: config.proxyConfig },
    process.env,
    { dataDir: config.dataDir },
  );
  const app = new Hono();
  // ADR-096 (W2.4): единый контекст хранения собирается здесь — реестр
  // service-key (`storage.serviceKeys`) нужен аутентификации до сборки
  // зависимостей; тот же инстанс переиспользует `createStandaloneDeps`.
  const storage = await createStandaloneStorage(config);
  // ADR-099: второй шаг egress — runtime-override прокси (`settings.json`/PG).
  // Применяется после хранилища и **до** создания deps/провайдеров; TLS/PG уже
  // инициализированы ранним `initTlsTrust` выше. Живого переключения нет.
  await applyStartupProxyConfig(
    storage.settings,
    { proxy: config.proxyConfig },
    process.env,
    { dataDir: config.dataDir },
  );
  // ADR-052 (этап I): реестр service-key — резолвер ключа (`synth_svc_…`)
  // нужен локальной аутентификации (`requireAuth`).
  const serviceApiKeyStore = storage.serviceKeys;
  // ADR-052/O1: идемпотентный bootstrap installer-ключей из env/Secret
  // (best-effort — ошибка конфигурации не роняет старт, пишется в лог).
  await applyBootstrapServiceKeys(
    serviceApiKeyStore,
    config.securityConfig?.bootstrapServiceKeys ?? [],
  );
  const auth = createLocalAuth({
    apiKey: config.apiKey,
    // ADR-052: service-key аутентифицирует машину в синтетического пользователя
    // (roles — для RBAC/доступности эндпоинтов); scopes/проектная проекция
    // проверяются отдельно (`requireScope`/`checkServiceProjectProjection`).
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

  app.use(logger());

  // ADR-094: метрики — реестр до middleware; при `metrics.enabled=false` ничего
  // не собираем и эндпоинт отдаёт 404 (middleware не ставим вовсе).
  // Приоритет: env `SYNTH_METRICS_ENABLED` > runtime (`settings.json`) >
  // config.yaml `metrics.enabled` > default false. Runtime читается из
  // контекста хранения (PG/file) до сборки deps — иначе включение из UI
  // не применялось бы после рестарта.
  const runtimeMetrics = await storage.settings.getMetrics();
  const metricsBaseEnabled = config.metricsConfig?.enabled ?? false;
  const metricsEnabled = resolveMetricsEnabled({
    configEnabled: metricsBaseEnabled,
    runtimeEnabled: runtimeMetrics.enabled,
    env: process.env,
  }).enabled;
  const metrics = new MetricsRegistry();
  const stopProcessMetrics = metricsEnabled ? registerProcessMetrics(metrics) : null;
  if (metricsEnabled) app.use('*', createHttpMetricsMiddleware(metrics));

  app.use(cors({
    origin: (_origin) => _origin || '*',
    credentials: true,
  }));

  // Runtime-подключение к удалённому backend (гибрид). Connection создаётся
  // всегда: без defaultBackendUrl/credentials он остаётся disconnected, а
  // пользователь логинится в UI (POST /auth/login) в рантайме.
  // ADR-094: колбэк метрик запросов подключается ниже (после `attachHybridMetrics`);
  // до этого — no-op (holder), т.к. реестр создаётся раньше соединения.
  let hybridOnRequest: ((info: RemoteRequestInfo) => void) | undefined;
  const connection = new RemoteConnection({
    credentialsPath: config.remoteCredentialsPath ?? config.remoteAuth?.credentialsPath,
    timeoutMs: config.remoteTimeoutMs,
    defaultIssuer: config.remoteAuth?.issuer,
    defaultClientId: config.remoteAuth?.clientId,
    onRequest: (info) => hybridOnRequest?.(info),
  });

  // Состояние гибрида: зеркала провайдеров/моделей, мост событий, статус живости,
  // публичные connect*/disconnect/logout. Общие зависимости — лениво (deps ниже).
  const hybrid = createHybridRemoteState(config, connection, {
    getEventBus: () => deps.eventBus,
    getProviderStore: () => deps.providerStore,
    getProviderCache: () => deps.providerCache,
    getModelCache: () => deps.modelCache,
  });

  // ADR-094: readiness — приложение готово, когда композиция завершена; при
  // деградированном хранилище остаётся 200 (`storage:'degraded'`) — иначе pod
  // выпал бы из балансировки и потерял доступ к read-only-диагностике.
  let initialized = false;
  // Health — без auth; `/ready` — liveness/readiness-разделение (ADR-094).
  const healthRoutes = createHealthRoutes({
    getStorageDegraded: () => storage.degraded ?? null,
    getReadiness: () => ({
      ready: initialized,
      storage: storage.degraded ? 'degraded' : 'ok',
    }),
  });
  app.route('/', healthRoutes);

  // ADR-094: `/metrics` — до auth (скрейп по сети pod'а, опциональный bearer).
  // Токен читается на каждый запрос — правка из UI применяется без рестарта.
  app.route('/', createMetricsRoutes({
    registry: metrics,
    enabled: metricsEnabled,
    getToken: metricsEnabled ? () => resolveMetricsToken(config.dataDir) : undefined,
  }));

  // Hybrid status — без auth (как health): UI опрашивает статус подключения
  // к удалённому backend до аутентификации.
  const hybridRoutes = createHybridRoutes(hybrid.getHybridState);
  app.route('/', hybridRoutes);

  // Auth routes — без auth (только spa-login проверяет ключ сам)
  app.route('/auth', createAuthRoutes(auth, {
    connection,
    connectRemote: hybrid.connectRemote,
    connectRemoteFromSaved: hybrid.connectRemoteFromSaved,
    connectRemoteWithApiKey: hybrid.connectRemoteWithApiKey,
    disconnectRemote: hybrid.disconnectRemote,
    defaultBackendUrl: config.defaultBackendUrl,
    issuerAvailable: !!config.remoteAuth?.issuer,
    hybridEnabled: config.hybridEnabled,
    rememberServer: hybrid.rememberServer,
    logoutRemote: hybrid.logoutRemote,
  }));


  // Всё остальное требует аутентификации
  app.use('/api/*', auth.requireAuth);
  app.use('/ws/*', auth.requireAuth);

  // PROP-090 Ф7 (Уровень 2): plugin-bound service-key (`plugin_id`) принимается
  // только с заголовком `X-Synth-Plugin-Id` и тем же значением, со scope
  // `plugins:invoke` и — при `plugins.hybrid.mode='allowlist'` — с именем
  // плагина в серверном allow-list. Гейт стоит на границе (после `requireAuth`,
  // где уже разрешён service-кредентал), поэтому правило действует на **все**
  // серверные API, а не только на плагинные роуты. Fail-closed: ключ с
  // привязкой без корректного заголовка отвергается всегда.
  app.use('/api/*', requirePluginTokenBinding(
    () => resolvePluginServerPolicy(deps.pluginRuntime.config),
  ));

  // ADR-098 (W5): деградированное хранилище — ADMIN-only + строгий read-only.
  // Guard идёт после `requireAuth` (нужен `user` для admin-проверки) и до роутов.
  // Ремонтные операции (maintenance: doctor/бэкап/выгрузка-перенос данных) не
  // блокируются — их нужно успеть выполнить до рестарта.
  app.use('/api/*', createStorageDegradedGuard({
    getDegraded: () => storage.degraded ?? null,
    isAdmin: (c) => hasAdminRole(c),
    mutationAllowlist: ['/api/v2/maintenance'],
  }));

  // ADR-098 (W5): диагностика деградации — проверка соединения с БД и признак
  // «нужен рестарт» (авто-возврат не реализован). Монтируется после guard'а:
  // не-администраторы получают 503 ещё до хендлера.
  app.route('/', createStorageStatusRoutes({ getDegraded: () => storage.degraded ?? null }));

  // ADR-052 (этап I): per-key rate limit service-key (`rateLimitPerMinute` ключа;
  // 0/не задан — без лимита) — паритет с managed backend (`app.ts`). После
  // `requireAuth`: `serviceKey` уже в контексте; для интерактивных кред
  // (api-key/cookie) middleware — no-op. Лимитер (fixed window 60 c) — один на
  // приложение, а не на запрос.
  const serviceKeyRateLimiter = new KeyRateLimiter(60_000);
  app.use('*', async (c, next) => {
    const credential = getServiceCredential(c);
    const limit = credential?.rateLimitPerMinute ?? 0;
    if (credential && limit > 0 && !serviceKeyRateLimiter.check(credential.keyId, limit)) {
      return c.json(
        { error: { code: 'RATE_LIMITED', message: 'Превышен лимит запросов по service-key' } },
        429,
      );
    }
    await next();
  });

  // ADR-052 (этап I): публичный OpenAPI-документ (spike). Отдаётся за
  // `requireAuth`; публичную выдачу без auth согласуем отдельно. Регистрируется
  // до прокси-middleware, чтобы в гибриде локальный документ не уходил на backend.
  app.get('/api/v2/openapi.json', (c) => c.json(getPublicOpenApiDocument()));

  // Гибрид (Batch 2, T5): серверные/админ-эндпоинты (которых нет у standalone
  // или источник истины — сервер) проксируются на удалённый backend.
  // Стоит ПОСЛЕ requireAuth и ДО локальных роутов — в гибриде перехватывает
  // /api/v2/{audit,users,admin,logs,gateway,context,llm,providers,models}.
  // Middleware регистрируется ВСЕГДА; без runtime-подключения getClient() даёт
  // null → next() (запрос обрабатывают локальные роуты).
  app.use('/api/*', createRemoteProxyMiddleware(
    () => connection.client,
    () => connection.getToken?.() ?? Promise.resolve(null),
  ));

  // ADR-089: реестр подписок WS-хаба создаётся ДО сборки зависимостей — funnel
  // (`RequestSessionService.onSessionMaterialized`) должен подписать уже
  // подключённых клиентов на сессию, материализованную позже (паритет с managed
  // `EventHub.subscribeToSession`; иначе подписка-снимок при `connect` теряет
  // события новых сессий).
  const wsSubscriptions = new EventWebSocketSubscriptions();

  // Зависимости (stores/managers/оркестратор/событийное ядро/шедулер/webhooks).
  // ADR-094: реестр передаётся только при `metrics.enabled` — иначе коллекторы
  // не подключаются и `/metrics` отдаёт 404 (пустой реестр).
  const deps = await createStandaloneDeps(config, {
    getActiveRemoteProviderNames: () => hybrid.getActiveRemoteProviderNames(),
    isBlockLocalProviders: () => hybrid.isBlockLocalProviders(),
    // PROP-090 Ф7: серверная политика плагинов удалённого сервера. Нет
    // подключения/сервер недоступен → политика неизвестна → локальный плагин
    // работает в режиме cooperative (помечен «не проверен сервером»).
    getServerPluginPolicy: async () => {
      if (!connection.connected) return undefined;
      return await connection.refreshPluginPolicy();
    },
    onSessionMaterialized: (owner, sessionId) => {
      wsSubscriptions.subscribeToSession(owner, sessionId);
    },
  }, storage, metricsEnabled ? metrics : undefined);

  // ADR-094: остановка фоновых коллекторов. Гибридный gauge (`synth_hybrid_connected`)
  // читает состояние подключения при скрейпе — accessor живёт в этой области
  // (`connection`), поэтому подключается здесь, а не в `deps.ts`.
  const stopMetricsCollectors: Array<() => void> = [...deps.stopMetricsCollectors];
  if (metricsEnabled) {
    const hybridMetrics = attachHybridMetrics(metrics, () => Boolean(connection.client));
    hybridOnRequest = hybridMetrics.onRequest;
    stopMetricsCollectors.push(hybridMetrics.stop);
  }

  // Роуты API v2 (порядок монтирования — как раньше, см. mount-routes.ts).
  mountStandaloneRoutes(app, auth, {
    config,
    deps,
    // ADR-094: админ-раздел «Наблюдаемость» — running-флаг, реестр, readiness,
    // backend хранения и uptime; readiness читается лениво (композиция ещё идёт).
    metrics: {
      runningEnabled: metricsEnabled,
      getRegistry: () => metrics,
      getReadiness: () => ({
        ready: initialized,
        storage: storage.degraded ? 'degraded' : 'ok',
      }),
      storageBackend: storage.kind,
      getUptimeSec: () => Math.floor(process.uptime()),
    },
    remote: {
      getClient: () => connection.client,
      getActiveRemoteModels: () => hybrid.getActiveRemoteModels(),
      getActiveRemoteProviderNames: () => hybrid.getActiveRemoteProviderNames(),
      isBlockLocalProviders: () => hybrid.isBlockLocalProviders(),
    },
    // ADR-089: роуты сессий уведомляют WS-хаб о созданной/форкнутой сессии
    // (паритет с managed `EventHub.subscribeToSession`) — тем же реестром, что
    // и `onSessionMaterialized`; fork/import идут мимо funnel'а.
    subscribeWsSession: (userId, sessionId) => { wsSubscriptions.subscribeToSession(userId, sessionId); },
  });

  // Глобальный SSE-хаб (GET /api/v2/events) — после роутов событий.
  registerEventsSse(app, deps.eventBus);

  // 404
  app.notFound((c) => {
    return c.json({
      error: {
        code: 'NOT_FOUND',
        message: `Маршрут не найден: ${c.req.method} ${c.req.path}`,
      },
    }, 404);
  });

  // Создаём HTTP сервер (статика UI + раздача Hono-приложения).
  const server = createStandaloneHttpServer({ app, uiDistPath: config.uiDistPath });

  // WebSocket /ws/events
  const wss = attachEventWebSocket({
    server,
    auth,
    connection,
    eventBus: deps.eventBus,
    sessionManager: deps.sessionManager,
    queueManager: deps.queueManager,
    processMessage: deps.processMessage,
    orchestrator: deps.orchestrator,
    subscriptions: wsSubscriptions,
    // ADR-089 (standalone): нормализация legacy-владельца (UUID профиля `local`)
    // при снимке подписок `connect` — иначе такие сессии не получают подписчиков.
    localOwnerResolver: deps.localOwnerResolver,
    // ADR-106 Ф3: реестр подтверждений — ответ принимает только носитель
    // покрывающего гранта (не «кто видит сессию»).
    ...(deps.approvalRegistry ? { approvalRegistry: deps.approvalRegistry } : {}),
    // ADR-094: активные WS-соединения — в streams_active (если метрики включены).
    metrics: metricsEnabled ? metrics : undefined,
  });

  const port = config.port;

  console.log(`synth-core starting on http://localhost:${port}`);
  console.log(`  data dir: ${config.dataDir}`);
  console.log(`  api key: ${config.apiKey.slice(0, 8)}...`);
  if (config.uiDistPath && existsSync(config.uiDistPath)) {
    console.log(`  ui: serving from ${config.uiDistPath}`);
  }
  if (config.defaultBackendUrl) {
    console.log(`  remote: гибридный режим (сервер ${config.defaultBackendUrl}) — подключение в рантайме`);
  }

  // Watcher фактической живости: создаётся (но НЕ стартует — чтобы тесты app не
  // гоняли интервалы); запускает cli.ts через handle.startConnectionWatcher().
  const connectionWatcher = hybrid.createConnectionWatcher();

  // Композиция завершена — readiness переключается в ready (ADR-094).
  initialized = true;
  if (metricsEnabled) setSynthReady(metrics, 1);

  return {
    app,
    server,
    wss,
    port,
    // ADR-094: реестр метрик, backend хранения и состояние деградации —
    // для диагностики/тестов и будущих доменных коллекторов.
    metrics,
    storageKind: storage.kind,
    getStorageDegraded: () => storage.degraded ?? null,
    // ADR-094: остановка процессных метрик **и** фоновых доменных коллекторов
    // (таймеры сессий/хранилища, подписка шины, decision/hybrid-коллекторы).
    stopMetrics: () => {
      stopProcessMetrics?.stop();
      for (const stop of stopMetricsCollectors) {
        try {
          stop();
        } catch {
          // Остановка метрик не должна ломать shutdown.
        }
      }
    },
    /** ADR-094: только фоновые доменные коллекторы (если нужно раздельно). */
    stopMetricsCollectors,
    connection,
    connectRemote: hybrid.connectRemote,
    connectRemoteFromSaved: hybrid.connectRemoteFromSaved,
    connectRemoteWithApiKey: hybrid.connectRemoteWithApiKey,
    disconnectRemote: hybrid.disconnectRemote,
    // Watcher фактической живости подключения: НЕ стартует внутри
    // createStandaloneApp — запускает/останавливает cli.ts (server.listen →
    // gracefulShutdown), чтобы тесты app не держали фоновых интервалов.
    startConnectionWatcher: () => connectionWatcher?.start(),
    stopConnectionWatcher: () => connectionWatcher?.stop(),
    getHybridStatus: hybrid.getHybridState,
    eventBus: deps.eventBus,
    // ADR-089: ядро событий — роутер, funnel создания сессий и хранилища
    // (понадобятся на этапах 5–6 при подключении роутов приёма событий).
    eventRouter: deps.eventRouter,
    requestSessionService: deps.requestSessionService,
    eventBindingStore: deps.eventBindingStore,
    eventJournal: deps.eventJournal,
    // PROP-090 §5/§10 (Ф5б-1): рантайм плагинов — старт-активация в `main.ts`
    // и точки для HTTP API/CLI (Ф5б-2/3).
    pluginRuntime: deps.pluginRuntime,
    // ADR-089: ingress-точка приёма внешних событий.
    ingress: deps.eventIngress,
    // ADR-051 (срез) / ADR-089: реестр расписаний и планировщик.
    scheduleStore: deps.scheduleStore,
    scheduler: deps.schedulerService,
    // ADR-089: остановка sweeper'а ephemeral-сессий (вызывается на graceful shutdown).
    stopEphemeralSweeper: deps.stopEphemeralSweeper,
    // ADR-089: остановка периодической retention-очистки журнала событий.
    stopEventJournalPruner: deps.stopEventJournalPruner,
    // ADR-102: остановка retention-очистки суточных роллапов аналитики.
    stopAnalyticsRollupPruner: deps.stopAnalyticsRollupPruner,
    // ADR-052 (этап II): остановка движка webhooks и retention-очистки доставок.
    stopWebhookService: () => deps.webhookService.stop(),
    stopWebhookDeliveryPruner: () => deps.stopWebhookDeliveryPruner(),
    // Egress: остановка retention-очистки журнала внешних запросов.
    stopEgressLogPruner: () => deps.stopEgressLogPruner(),
    // ADR-052 (этап II): реестр подписок webhooks (для тестов/диагностики).
    webhookStore: deps.webhookStore,
    webhookService: deps.webhookService,
    // ADR-051 (срез): остановка планировщика (на graceful shutdown).
    stopScheduler: () => deps.schedulerService.stop(),
    // ADR-077 (шаг B2): остановка источника MCP-серверов исполнителя (в inline — no-op).
    stopExecutorMcpSource: () => deps.executorMcpSource?.close(),
    // ADR-097: освобождение ресурсов backend'а хранения (пул соединений PG);
    // `file`/`memory` `close` не задают — вызов безопасен (optional).
    closeStorage: async () => {
      await storage.close?.();
    },
    // Текущий мост событий (создаётся/обновляется в applyConnected) — для stop() при shutdown.
    get remoteEventBridge(): RemoteEventBridge | undefined {
      return hybrid.getRemoteEventBridge();
    },
  };
}
