/**
 * LLM Gateway (AD-036) — независимый слой безопасности.
 * Реэкспорт всех публичных сущностей.
 */

export { detectSecrets, maskSecret } from './secret-detector.js';
export { obfuscateSecrets, deobfuscateSecrets, restoreSecrets, PLACEHOLDER_PATTERN, PLACEHOLDER_REGEX } from './obfuscator.js';
export type { ObfuscateResult } from './obfuscator.js';
export { runInputGuard } from './input-guard.js';
export type { InputGuardResult, InputGuardMeta } from './input-guard.js';
export { runOutputGuard } from './output-guard.js';
export type { OutputGuardResult } from './output-guard.js';
export { RateLimiter } from './rate-limiter.js';
export { AuditLogger, readAuditLog } from './audit-logger.js';
export type { AuditEventType, AuditEntry, AuditLogQuery } from './audit-logger.js';
export { GatewayProvider } from './gateway-provider.js';
export type { GatewayProviderOptions } from './gateway-provider.js';
export { ObfuscationMapStore } from './obfuscation-map-store.js';
