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
  ERROR_STATUS,
  ensurePoolRequestSchema,
  errorResponse,
  formatIssues,
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
  PROVISIONER_DEFAULTS,
  profileSchema,
  profilesSchema,
  staticPoolsSchema,
  resolveProvisionerConfig,
  parseJsonEnv,
  scrubProvisionerToken,
} from './config.js';
export type { ProvisionerConfig, ProvisionerProfile, ProvisionerProfiles } from './config.js';

// Аутентификация.
export {
  AUTH_HEADER,
  BEARER_PREFIX,
  extractBearerToken,
  isAuthorized,
  timingSafeEqualStrings,
} from './auth.js';

// Провайдеры пулов.
export {
  StaticPoolProvisioner,
  PoolProvisionerError,
  createPoolProvisioner,
  generatePoolToken,
} from './provider.js';
export type { PoolProvisioner, PoolProviderErrorReason } from './provider.js';

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
} from './metrics.js';
export type {
  MetricLabels,
  MetricSeriesSnapshot,
  MetricSnapshot,
  MetricType,
  PoolMetricRecord,
  PoolMetricSource,
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
