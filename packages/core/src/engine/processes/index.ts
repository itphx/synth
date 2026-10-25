/**
 * Подсистема фоновых шелл-процессов (PROP-097, блок 5b).
 *
 * Сервис (`service.ts`) — запуск/остановка фоновой команды, запись лога и
 * завершение прогона. Учёт прогона — в общем реестре фоновых прогонов
 * (`engine/background`, `kind: 'process'`), лог — в blob-хранилище (ADR-096).
 */
export { ProcessService } from './service.js';
export { startProcessLogPruner } from './prune.js';
export type { ProcessLogPrunerOptions } from './prune.js';
export {
  BackgroundUnsupportedError,
  ProcessError,
  PROCESS_ERROR_CODES,
  PROCESS_LOG_FLUSH_BYTES,
  PROCESS_LOG_FLUSH_INTERVAL_MS,
  PROCESS_LOG_TAIL_LIMIT,
  type ProcessErrorCode,
  type ProcessLimits,
  type ProcessLogger,
  type ProcessLogsOptions,
  type ProcessLogsResult,
  type ProcessServiceOptions,
  type ProcessSpawnInput,
  type ProcessSpawnResult,
} from './types.js';
