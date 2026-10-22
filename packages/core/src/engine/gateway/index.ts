/**
 * LLM Gateway (ADR-036) — независимый слой безопасности.
 * Реэкспорт всех публичных сущностей.
 */

export { detectSecrets, maskSecret, DEFAULT_PATTERNS } from './secret-detector.js';
export type { SecretDetectorPattern } from './secret-detector.js';
export { SecretPatternStore } from './secret-pattern-store.js';
export type { SecretPattern, SecretPatternStoreOptions, SecretPatternsRaw } from './secret-pattern-store.js';
export { obfuscateSecrets, deobfuscateSecrets, restoreSecrets, PLACEHOLDER_PATTERN, PLACEHOLDER_REGEX } from './obfuscator.js';
export type { ObfuscateResult } from './obfuscator.js';
export { runInputGuard } from './input-guard.js';
export type { InputGuardResult, InputGuardMeta } from './input-guard.js';
export { runOutputGuard } from './output-guard.js';
export type { OutputGuardResult } from './output-guard.js';
export { RateLimiter } from './rate-limiter.js';
export { AuditLogger, readAuditLog } from './audit-logger.js';
export type { AuditEventType, AuditEntry, AuditLogQuery } from './audit-logger.js';
export { writePayloadLog, readPayloadLog } from './payload-logger.js';
export type { LlmPayloadEntry, LlmPayloadRequest, LlmPayloadResponse, PayloadLogQuery } from './payload-logger.js';
export { GatewayProvider, DISABLED_GATEWAY_CONFIG } from './gateway-provider.js';
export type { GatewayProviderOptions } from './gateway-provider.js';
export {
  LlmFilterRegistry,
  LlmFilterRegistrationError,
  canVetoLlmFilter,
  defaultLlmFilterFailMode,
  LLM_FILTER_VETO_TRUST_LEVEL,
} from './llm-filter-registry.js';
export type {
  LlmFilterAuditEvent,
  LlmFilterRegistrationOptions,
  LlmFilterRegistryOptions,
  RegisteredLlmFilter,
} from './llm-filter-registry.js';
export { ObfuscationMapStore, stripSessionSecrets } from './obfuscation-map-store.js';
