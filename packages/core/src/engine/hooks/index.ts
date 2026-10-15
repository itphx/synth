/**
 * ADR-030: ядровая hook-шина (`HookBus`) — in-process примитив системы хуков.
 * Пока только класс + типы (встраивание в оркестратор — отдельный этап).
 */
export { HookBus, HOOK_ASYNC_TIMEOUT_MS } from './hook-bus.js';
export type {
  HookHandler,
  HookRegistrationOptions,
  HookEmitResult,
} from './hook-bus.js';
