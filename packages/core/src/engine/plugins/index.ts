/**
 * PROP-090 §10: загрузчик плагинов (`PluginHost`) — баррел модуля.
 *
 * Модуль живёт в `engine/plugins/*` — по конвенции движковых модулей ядра.
 * Ф1: каркас загрузчика + журнал аудита плагинов; **исполнение кода выключено**
 * (`plugins.executionEnabled=false` по умолчанию).
 */
export { PluginHost, DEFAULT_EXTENSION_CONTRACT_VERSION } from './plugin-host.js';
export type { PluginHostOptions } from './plugin-host.js';

export {
  PLUGIN_ACTIVATION_STEPS,
  type PluginActivationDescriptor,
  type PluginActivationHandle,
  type PluginActivationResult,
  type PluginActivationStep,
  type PluginDeactivationResult,
  type PluginDisposer,
  type PluginFacade,
  type PluginLoader,
  type PluginLogger,
  type PluginModule,
  type PluginScanHook,
  type PluginScanResult,
} from './activation.js';

export { computePluginContentHash, verifyPluginIntegrity } from './integrity.js';
export type { PluginIntegrityVerdict } from './integrity.js';

export { readExactHostExceptions } from './exact-host-exceptions.js';
