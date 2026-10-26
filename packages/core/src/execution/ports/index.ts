/**
 * Доменные порты слоя исполнения (ADR-077, шаг 1).
 *
 * Порт один — `ExecutionPort`; реализации взаимозаменяемы: `InlineExecutionPort`
 * (в процессе) и `RemoteExecutionPort` (HTTP к исполнителю, шаг 7). Контракт
 * — в `execution/contract/` (по образцу `storage/contract/`).
 */

export type {
  ExecCommand,
  ExecRequest,
  ExecResult,
  ExecSecret,
  ExecutionPort,
  ExecutionErrorInit,
  ExecFailureReason,
  ExecutionCapabilitySummary,
  ExecutionBaseCapability,
  ExecutionMetricsOutcome,
  ExecutionMetricsSink,
  ExecBackgroundChunk,
  ExecBackgroundExit,
  ExecBackgroundProcess,
} from './execution-port.js';
export {
  ExecutionError,
  isExecutionError,
  isExecutionPort,
  DEFAULT_SHELL_BINARY,
  DEFAULT_MAX_OUTPUT_BYTES,
  EXECUTION_BASE_CAPABILITIES,
  EXECUTION_BACKGROUND_UNSUPPORTED_CODE,
  EXECUTION_SECRETS_UNSUPPORTED_CODE,
} from './execution-port.js';
