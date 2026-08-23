export {
  wrapContent,
  detectPromptInjection,
  applyPolicy,
  buildWarnLine,
  containsWord,
  CONTENT_START,
  CONTENT_END,
  WARN_PREFIX,
} from './prompt-injection.js';
export type {
  TrustLevel,
  InjectionPolicy,
  InjectionDetection,
} from './prompt-injection.js';
export { getToolTrust } from './trust.js';
export type { ToolTrustInfo } from './trust.js';
export {
  tokenizeCommand,
  extractCommandPaths,
  isMutatingCommand,
  loadShellPolicy,
  checkShellCommand,
  matchShellCommandPattern,
  clearShellPolicyCache,
  expandHome,
  tryResolvePath,
  resolveSystemDefinitionsDir,
  findPackageRoot,
  DEFAULT_POLICY,
} from './shell-guard.js';
export type {
  ShellPolicy,
  ShellPolicyOptions,
  ExtractedPath,
  ShellCheckResult,
} from './shell-guard.js';
export {
  loadProtectedPaths,
  checkPath,
  clearProtectedPathsCache,
  DEFAULT_POLICY as DEFAULT_PROTECTED_POLICY,
} from './protected-paths.js';
export type {
  ProtectedPathsPolicy,
  ProtectedPathCheckResult,
  ProtectedPathsOverride,
  ProtectedPathsOptions,
} from './protected-paths.js';
export { ProtectedPathsStore } from './protected-paths-store.js';
export type { ProtectedPathsStoreOptions, ProtectedPathsRaw } from './protected-paths-store.js';
