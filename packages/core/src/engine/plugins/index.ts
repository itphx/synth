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
  PluginLoadError,
  pluginLoadFailureReason,
  type PluginActivationDescriptor,
  type PluginActivationHandle,
  type PluginActivationResult,
  type PluginActivationStep,
  type PluginDeactivationResult,
  type PluginDisposer,
  type PluginFacade,
  type PluginLlmFilterOptions,
  type PluginLoadFailureReason,
  type PluginToolDefinition,
  type PluginLoader,
  type PluginLogger,
  type PluginModule,
  type PluginScanHook,
  type PluginScanResult,
} from './activation.js';

// Ф4а — `inline`-загрузчик кода плагина (bundle-only, containment, cache-busting).
export {
  DEFAULT_MAX_PLUGIN_BUNDLE_BYTES,
  DEFAULT_PLUGIN_ENTRY,
  PLUGIN_BUNDLE_EXTENSIONS,
  createInlinePluginLoader,
} from './inline-loader.js';
export type { InlinePluginLoaderOptions } from './inline-loader.js';

export { computePluginContentHash, verifyPluginIntegrity } from './integrity.js';
export type { PluginIntegrityVerdict } from './integrity.js';

// Ф5а — сервис установки: манифест → скан → политика → раскладка/lock → аудит.
export { PluginInstaller, resolvePluginEntry } from './installer.js';
export type {
  PluginInstallOutcome,
  PluginInstallRequest,
  PluginInstallerDeps,
  PluginUninstallResult,
} from './installer.js';

export { readExactHostExceptions } from './exact-host-exceptions.js';

// Ф2 — модель доверия: статический сканер, install-policy, раскладка и lock.
export {
  BINARY_EXTENSIONS,
  EXECUTABLE_EXTENSIONS,
  INVISIBLE_UNICODE_PATTERNS,
  PLUGIN_IGNORE_FILE,
  PLUGIN_SCAN_RULES,
  PluginScanCache,
  createPluginScanHook,
  isBinaryContent,
  isExecutableFile,
  isIgnored,
  parseIgnorePatterns,
  scanPluginDirectory,
  scanPluginFiles,
} from './scan/index.js';
export type {
  IgnorePattern,
  PluginScanEntry,
  PluginScanHookOptions,
  PluginScanOptions,
  PluginScanReport,
  ScanRule,
  ScanRuleContext,
} from './scan/index.js';

export {
  ensurePluginLayout,
  pluginBundleDirName,
  pluginInstalledDir,
  pluginQuarantineDir,
  releaseFromQuarantine,
  resolvePluginLayout,
  stagePluginBundle,
} from './layout.js';
export type {
  PluginBundleStageInput,
  PluginBundleStageResult,
  PluginIntegrityFile,
  PluginLayout,
} from './layout.js';

// Ф3в — контрактный suite расширений («паспорт» плагина).
export {
  DEFAULT_PLUGIN_CONTRACT_REFERENCE,
  describePluginContract,
  PLUGIN_CONTRACT_FIXTURES,
} from './contract/index.js';
export type {
  PluginContractFixtureName,
  PluginContractHarness,
  PluginContractHarnessFactory,
  PluginContractReference,
} from './contract/index.js';
