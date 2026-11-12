/**
 * Публичная поверхность `@itphx/synth-provisioner` — provisioner пулов
 * исполнения Synth (PROP-135, Ф4b-2a).
 *
 * Пакет — **отдельный сервис** (процесс), а не библиотека ядра: он не зависит
 * от `@itphx/synth-core`/`shared` и реализует уже существующий контракт
 * `HttpExecutionPoolProvider` из core:
 *
 * - HTTP-приложение и сервер (`createProvisionerApp`/`startProvisionerServer`);
 * - провайдеры пулов (`PoolProvisioner`, `StaticPoolProvisioner`);
 * - реестр и жизненный цикл пулов (`PoolService`: idle/maxLifetime/drain/
 *   release, reaper);
 * - метрики (`ProvisionerMetrics`, exposition 0.0.4);
 * - конфигурация из env (`resolveProvisionerConfig`, fail-closed).
 *
 * Модуль не имеет side-effect'ов при импорте: подъём сервера — только в
 * `main.ts` (точка входа процесса).
 */

// Wire-протокол.
export {
  PROVISIONER_PROTOCOL_VERSION,
  MAX_WORKSPACE_SUB_PATH_LENGTH,
  ERROR_STATUS,
  ensurePoolRequestSchema,
  errorResponse,
  formatIssues,
  isValidWorkspaceSubPath,
} from './protocol.js';
export type {
  EnsurePoolRequest,
  EnsurePoolResponse,
  PoolClass,
  PoolInfo,
  PoolNetworkMode,
  PoolScope,
  PoolState,
  PoolsListResponse,
  ProvisionerCapabilities,
  ProvisionerErrorBody,
  ProvisionerErrorReason,
  ProvisionerErrorResponse,
  ProvisionerErrorStatus,
  ProvisionerHealth,
  ProvisionerLimits,
} from './protocol.js';

// Конфигурация (env).
export {
  PROVISIONER_ENV,
  PROVISIONER_KUBERNETES_ENV,
  PROVISIONER_COMMAND_POLICY_ENV,
  EXECUTOR_COMMAND_POLICY_DEFAULTS,
  EXECUTOR_COMMAND_POLICY_PROVIDERS,
  EXECUTOR_COMMAND_POLICY_FAIL_MODES,
  PROVISIONER_DEFAULTS,
  PROVISIONER_PROVIDERS,
  KUBERNETES_DEFAULTS,
  SERVICE_ACCOUNT_DIR,
  profileSchema,
  profilesSchema,
  staticPoolsSchema,
  resolveProvisionerConfig,
  resolveExecutorCommandPolicy,
  parseJsonEnv,
  scrubProvisionerToken,
} from './config.js';
export type {
  ConfigFileReader,
  ProvisionerConfig,
  ProvisionerExecutorCommandPolicyConfig,
  ProvisionerKubernetesConfig,
  ProvisionerProfile,
  ProvisionerProfiles,
  ProvisionerProviderName,
  ResolveConfigOptions,
} from './config.js';

// Ошибки провайдеров.
export { PoolProvisionerError } from './errors.js';
export type { PoolProviderErrorReason } from './errors.js';

// Аутентификация.
export {
  AUTH_HEADER,
  BEARER_PREFIX,
  extractBearerToken,
  isAuthorized,
  timingSafeEqualStrings,
} from './auth.js';

// Kubernetes API (клиент и провайдер пулов).
export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  HttpKubernetesClient,
} from './kubernetes.js';
export type {
  HttpKubernetesClientOptions,
  KubernetesClient,
  KubernetesContainerStatus,
  KubernetesManifest,
  KubernetesPod,
  KubernetesPodCondition,
  KubernetesPodList,
  KubernetesSecret,
} from './kubernetes.js';
export {
  COMMAND_POLICY_ANNOTATION,
  COMMAND_POLICY_MOUNT_PATH,
  COMMAND_POLICY_TOKEN_FILE,
  COMMAND_POLICY_TOKEN_KEY,
  KUBERNETES_PROVIDER_NAME,
  KubernetesPoolProvisioner,
  MCP_SERVERS_ANNOTATION,
  POOL_HASH_LABEL,
  POOL_KEY_ANNOTATION,
  POOL_NETWORK_LABEL,
  POOL_PROFILE_LABEL,
  buildMcpServersEnvValue,
  buildPoolPodManifest,
  commandPolicyFingerprint,
  isPodReady,
  mcpServersFingerprint,
  poolHash,
  poolObjectName,
  sanitizeLabelValue,
} from './kubernetes-provider.js';
export type {
  KubernetesPoolProvisionerOptions,
  PoolPodManifestOptions,
} from './kubernetes-provider.js';

// Провайдеры пулов.
export {
  StaticPoolProvisioner,
  createPoolProvisioner,
  generatePoolToken,
} from './provider.js';
export type { PoolProvisioner } from './provider.js';

// Реестр и жизненный цикл.
export {
  PoolService,
  PoolCapacityError,
} from './pool-service.js';
export type { PoolRecord, PoolServiceOptions, ProvisionerTimer } from './pool-service.js';

// Метрики.
export {
  ProvisionerMetrics,
  ProvisionerRegistry,
  MiniMetric,
  createProvisionerMetrics,
  escapeHelp,
  escapeLabelValue,
  formatNumber,
  MAX_SERIES_PER_METRIC,
  ENSURE_SECONDS_BUCKETS,
} from './metrics.js';
export type {
  MetricLabels,
  MetricSeriesSnapshot,
  MetricSnapshot,
  MetricType,
  PoolMetricRecord,
  PoolMetricSource,
  ProviderErrorMetricReason,
  ProvisionOutcome,
  ProvisionerErrorMetricReason,
  ReleaseOutcome,
} from './metrics.js';

// HTTP-сервер.
export {
  createProvisionerApp,
  createProvisionerHttpServer,
  startProvisionerServer,
  toWebRequest,
} from './server.js';
export type {
  ProvisionerAppOptions,
  ProvisionerHandle,
  ProvisionerServerOptions,
} from './server.js';

// Точка входа процесса.
export { main } from './main.js';
