/**
 * PROP-068 §4.3 / PROP-090 §9: статический сканер расширений — баррел модуля.
 *
 * Модуль живёт в `engine/plugins/scan/` — по конвенции движковых модулей ядра
 * (`engine/skills/*`, `engine/mcp/*`).
 */
export {
  PLUGIN_IGNORE_FILE,
  BINARY_EXTENSIONS,
  EXECUTABLE_EXTENSIONS,
  isBinaryContent,
  isExecutableFile,
  scanPluginDirectory,
  scanPluginFiles,
} from './scanner.js';
export type { PluginScanEntry, PluginScanOptions, PluginScanReport } from './scanner.js';

export { PluginScanCache } from './cache.js';

export { parseIgnorePatterns, isIgnored } from './ignore.js';
export type { IgnorePattern } from './ignore.js';

export { PLUGIN_SCAN_RULES, INVISIBLE_UNICODE_PATTERNS } from './rules.js';
export type { ScanRule, ScanRuleContext } from './rules.js';

export { createPluginScanHook } from './hook.js';
export type { PluginScanHookOptions } from './hook.js';
