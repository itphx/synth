/**
 * Публичная поверхность `@itphx/synth-executor` — исполнитель команд Synth
 * (ADR-077, шаг 7a).
 *
 * Пакет даёт две вещи:
 *
 * - **сервер исполнителя** (`createExecutorApp`/`startExecutorServer`) —
 *   HTTP/1.1 + JSON API: `POST /exec`, `GET /capabilities`, `GET /health`,
 *   а также MCP-хостинг: `GET /mcp/servers`, `GET /mcp/tools`,
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
  PORT_FAILURE_REASONS,
  isPortFailureReason,
  isValidExecCommand,
  parseExecRequestBody,
  errorResponse,
} from './protocol.js';
export type {
  ExecRequestBody,
  ExecSuccessBody,
  ExecErrorBody,
  ExecErrorResponse,
  ExecutorCapabilities,
  ExecutorHealth,
  ExecutorErrorReason,
  PortFailureReason,
  McpServerStatusBody,
  McpToolInfoBody,
  McpCallRequestBody,
  McpCallResultBody,
} from './protocol.js';
export { parseMcpCallRequestBody } from './protocol.js';

// Конфигурация (env).
export {
  EXECUTOR_ENV,
  EXECUTOR_DEFAULTS,
  resolveExecutorConfig,
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
