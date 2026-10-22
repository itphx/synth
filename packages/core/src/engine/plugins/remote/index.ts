/**
 * PROP-090 §«out-of-process»: баррел модуля `engine/plugins/remote/*`.
 *
 * Ф4б-1 — wire-протокол (контракт — `@itphx/synth-shared`,
 * `types/plugin-protocol.ts`), клиент и загрузчик удалённых плагинов.
 * Управление процессом (spawn/health/stop, файл токена) — Ф4б-2.
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
