/**
 * Публичная поверхность `@itphx/synth-executor` — исполнитель команд Synth
 * (ADR-077, шаг 7a).
 *
 * Пакет даёт две вещи:
 *
 * - **сервер исполнителя** (`createExecutorApp`/`startExecutorServer`) —
 *   HTTP/1.1 + JSON API: `POST /exec`, `GET /capabilities`, `GET /health`,
 *   фоновые процессы (`POST /exec/spawn`, `GET /exec/:processId`,
 *   `GET /exec/:processId/logs`, `POST /exec/:processId/stop` — ADR-077,
 *   шаг 7c), а также MCP-хостинг: `GET /mcp/servers`, `GET /mcp/tools`,
 *   `POST /mcp/call` (ADR-077, шаг B1);
 * - **клиент удалённого порта** (`createRemoteExecutionPort`, отдельный
 *   экспорт `@itphx/synth-executor/client`) — реализация `ExecutionPort` из
 *   `@itphx/synth-core` поверх HTTP.
 *
 * Модуль не требует side-effect'ов при импорте: подъём сервера — только в
 * `main.ts` (точка входа процесса).
 *
 * @itphx/synth-core — `peerDependencies`: типы порта (`import type`) и
 * точечный рантайм-импорт (`InlineExecutionPort`, `ExecutionError`,
 * `egressFetch`). Цикл core ↔ исполнитель намеренный (core подключает пакет
 * динамическим `import()` по `execution.mode === 'remote'`) — как в слое
 * хранения (ADR-096/ADR-097).
 */

// Wire-протокол.
export {
  EXECUTOR_PROTOCOL_VERSION,
  EXEC_ERROR_STATUS,
  EXEC_SECRET_LIMITS,
  PORT_FAILURE_REASONS,
  isPortFailureReason,
  isValidExecCommand,
  parseExecRequestBody,
  parseExecSecrets,
  parseSpawnExecRequestBody,
  errorResponse,
} from './protocol.js';
export type {
  ExecRequestBody,
  ExecSuccessBody,
  ExecErrorBody,
  ExecErrorResponse,
  ExecutorCapabilities,
  ExecutorFeatures,
  ExecutorHealth,
  ExecutorErrorReason,
  PortFailureReason,
  McpServerStatusBody,
  McpToolInfoBody,
  McpCallRequestBody,
  McpCallResultBody,
  McpAttachmentPayloadBody,
  SpawnExecRequest,
  SpawnExecResponse,
  BackgroundProcessStatus,
  BackgroundStatusResponse,
  BackgroundLogChunkBody,
  BackgroundLogsResponse,
  StopBackgroundResponse,
} from './protocol.js';
export { parseMcpCallRequestBody } from './protocol.js';

// Конфигурация (env).
export {
  EXECUTOR_ENV,
  EXECUTOR_DEFAULTS,
  resolveExecutorConfig,
  resolveTlsCaFile,
  parseMcpServerSpecs,
  scrubExecutorToken,
  scrubExecutorMcpServers,
} from './config.js';
export type { ExecutorConfig } from './config.js';

// Аутентификация.
export { AUTH_HEADER, BEARER_PREFIX, extractBearerToken, isAuthorized, timingSafeEqualStrings } from './auth.js';

// Containment рабочего каталога.
export {
  resolveContainedCwd,
  resolveRealPath,
  isInsideReal,
  isLexicallyInside,
} from './workspace.js';
export type { CwdResolution } from './workspace.js';

// Слой исполнения.
export { ExecService } from './exec-service.js';
export type { ExecServiceOptions, ExecOutcome } from './exec-service.js';

// Секреты вызова (ADR-077, протокол 4).
export {
  materializeSecrets,
  sweepStaleSshDirs,
  SSH_TEMP_DIR_PREFIX,
  STALE_SSH_DIR_TTL_MS,
} from './secrets.js';
export type { MaterializedSecrets } from './secrets.js';

// Фоновые процессы (ADR-077, шаг 7c; PROP-097).
export {
  BackgroundExecService,
  DEFAULT_MAX_BACKGROUND_PROCESSES,
  DEFAULT_BACKGROUND_MAX_LOG_BYTES,
  DEFAULT_BACKGROUND_LOG_DIR,
  BACKGROUND_KILL_GRACE_MS,
  BACKGROUND_PRUNE_INTERVAL_MS,
  BACKGROUND_PRUNE_TTL_MS,
  DEFAULT_LOG_READ_LIMIT,
  MAX_LOG_READ_LIMIT,
} from './background.js';
export type {
  BackgroundExecServiceOptions,
  BackgroundProcessRecord,
  BackgroundSpawnInput,
  BackgroundSpawnOutcome,
  BackgroundLogsOptions,
  BackgroundLogsResult,
  BackgroundLogChunk,
} from './background.js';

// Toolchain.
export {
  EXTRA_TOOLCHAIN_BINARIES,
  detectToolchain,
  resolveToolchainBinaries,
} from './toolchain.js';
export type { ToolchainInfo } from './toolchain.js';

// MCP-хостинг (ADR-077, шаг B1).
export {
  ExecutorMcpHost,
  ExecutorMcpError,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_TOOL_TIMEOUT_MS,
  MCP_MAX_RESULT_CHARS,
  MCP_CIRCUIT_THRESHOLD,
  MCP_CIRCUIT_COOLDOWN_MS,
  MCP_INHERITED_ENV_VARS,
  MCP_ATTACHMENT_MAX_BYTES_PER_FILE,
  MCP_ATTACHMENT_MAX_TOTAL_BYTES,
  collectMcpContent,
  sanitizeError,
  redactSecrets,
} from './mcp.js';
export type {
  McpServerSpec,
  McpServerState,
  McpServerStatus,
  McpToolDef,
  McpToolInfo,
  McpToolResult,
  McpAttachmentPayload,
  McpAttachmentLimits,
  McpContentParts,
  ExecutorMcpErrorKind,
  ExecutorMcpHostOptions,
} from './mcp.js';

// Сервер.
export {
  createExecutorApp,
  createExecutorHttpServer,
  startExecutorServer,
  toWebRequest,
} from './server.js';
export type {
  ExecutorAppOptions,
  ExecutorServerOptions,
  ExecutorHandle,
} from './server.js';

// Точка входа процесса.
export { main } from './main.js';
