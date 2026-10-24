export { McpClient, MAX_TOOL_RESULT_CHARS } from './client.js';
export type { McpToolDef, McpToolResult, McpClientLike, McpClientOptions } from './client.js';
export {
  McpCredentialError,
  createCredentialFetch,
  createRepositoryCredentialSource,
} from './credential-auth.js';
export type {
  McpCredentialErrorCode,
  McpCredentialSource,
  RepositoryCredentialSourceDeps,
  CredentialFetchOptions,
} from './credential-auth.js';
export { McpManager } from './manager.js';
export type { McpManagerOptions } from './manager.js';
export { syncMcpManagerFromRegistry } from './manager-sync.js';
export {
  ExecutorMcpClient,
  ExecutorMcpPool,
  ExecutorMcpUnavailableError,
  ExecutorMcpHttpError,
  EXECUTOR_MCP_CONNECT_TIMEOUT_MS,
  EXECUTOR_MCP_TOOL_TIMEOUT_MS,
} from './executor-mcp-client.js';
export type {
  ExecutorMcpPoolOptions,
  ExecutorMcpServerStatus,
  ExecutorMcpToolInfo,
  ExecutorFetch,
} from './executor-mcp-client.js';
export {
  ExecutorMcpSource,
  createExecutorMcpSourceFromConfig,
  attachExecutorMcpSource,
  attachExecutorMcpFromDescriptor,
  EXECUTOR_MCP_SOURCE_TTL_MS,
  EXECUTOR_MCP_DISCOVERY_TIMEOUT_MS,
} from './executor-mcp-source.js';
export type {
  ExecutorMcpServerInfo,
  ExecutorMcpSourceOptions,
  ExecutorMcpManagerLike,
  ExecutorMcpDescriptorLike,
} from './executor-mcp-source.js';
export { resolveMcpScope, resolveMcpProjectScope } from './scope.js';
export type { McpScopeServer, McpScopeSession, McpScopeDecision } from './scope.js';
export { fullMcpAvailability, buildMcpServerSettings, normalizeMcpServerSettings } from './settings.js';
export {
  evaluateMcpNetworkAccess,
  isIpInCidr,
  isHttpMcpConfig,
  isLocalHostname,
  isAddressRule,
  hostMatchesRule,
  findHostException,
  findAddressException,
  normalizeIp,
  mappedIpv4,
} from './network-policy.js';
export type { McpNetworkCheckResult, HostResolver } from './network-policy.js';
