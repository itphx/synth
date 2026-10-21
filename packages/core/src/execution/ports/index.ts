/**
 * Доменные порты слоя исполнения (PROP-077, шаг 1).
 *
 * Порт один — `ExecutionPort`; реализации взаимозаменяемы: `InlineExecutionPort`
 * (в процессе) и `RemoteExecutionPort` (HTTP к исполнителю, шаг 7). Контракт
 * — в `execution/contract/` (по образцу `storage/contract/`).
 */

export type {
  ExecCommand,
  ExecRequest,
  ExecResult,
  ExecutionPort,
  ExecutionErrorInit,
  ExecFailureReason,
} from './execution-port.js';
export {
  ExecutionError,
  isExecutionPort,
  DEFAULT_SHELL_BINARY,
  DEFAULT_MAX_OUTPUT_BYTES,
} from './execution-port.js';
