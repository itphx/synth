/**
 * Доменные порты слоя исполнения (ADR-077, шаг 1).
 *
 * Порт один — `ExecutionPort`; реализации взаимозаменяемы: `InlineExecutionPort`
 * (в процессе) и `RemoteExecutionPort` (HTTP к исполнителю, шаг 7). Контракт
 * — в `execution/contract/` (по образцу `storage/contract/`).
 */

export type {
  BrowserCallRequest,
  BrowserCallResult,
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
  // План терминалов (Ф1): контракт PTY-сессии.
  PtyForeground,
  PtyHandle,
  PtyOpenRequest,
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
  EXECUTION_PTY_UNSUPPORTED_CODE,
} from './execution-port.js';
// PROP-135 (Ф1): FS-часть контракта порта исполнения (`realpath`/`stat`/
// `readdir`/`readText`/`sniff`/`readBytes`) — файловые операции агента уезжают
// в тот же контур, что и команды.
export { FsPathError, isFsPathError, fsErrorCodeFromErrno } from './execution-fs.js';
export { ExecutionFsUnavailableError, isExecutionFsUnavailableError } from './execution-fs.js';
export type {
  ExecutionFs,
  FsStat,
  FsDirEntry,
  FsEntryKind,
  FsErrorCode,
  FsRawTextResult,
  FsTextOptions,
  FsTextPage,
  FsSniffResult,
  FsBytesResult,
  FsUploadMode,
  FsUploadOptions,
} from './execution-fs.js';
