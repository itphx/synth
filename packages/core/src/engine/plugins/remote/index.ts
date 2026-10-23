/**
 * ADR-090: баррел модуля `engine/plugins/remote/*`.
 *
 * Ф4б-1 — wire-протокол (контракт — `@itphx/synth-shared`,
 * `types/plugin-protocol.ts`), клиент и загрузчик удалённых плагинов.
 * Ф4б-2 — жизненный цикл процесса (spawn/health/stop) и файл токена инстанса.
 */
export {
  DEFAULT_REMOTE_PLUGIN_TIMEOUT_MS,
  LOOPBACK_PLUGIN_HOSTS,
  RemotePluginClient,
  RemotePluginUnavailableError,
} from './client.js';
export type {
  RemotePluginClientOptions,
  RemotePluginFetch,
  RemotePluginUnavailableReason,
} from './client.js';
export { createRemotePluginLoader } from './loader.js';
export type { RemotePluginLoaderOptions } from './loader.js';
export {
  DEFAULT_PLUGIN_HEALTH_TIMEOUT_MS,
  DEFAULT_PLUGIN_READY_TIMEOUT_MS,
  DEFAULT_PLUGIN_SERVER_ENTRY,
  DEFAULT_PLUGIN_STOP_TIMEOUT_MS,
  PLUGIN_TOKEN_FILE,
  PluginProcessManager,
  pluginTokenPath,
} from './process.js';
export type {
  PluginProcessHandle,
  PluginProcessManagerOptions,
  RemotePluginProcess,
} from './process.js';
