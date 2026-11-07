export { McpClient, MAX_TOOL_RESULT_CHARS, collectMcpContent, mcpAttachmentsOnlyText, MCP_ATTACHMENT_MAX_BYTES_PER_FILE, MCP_ATTACHMENT_MAX_TOTAL_BYTES } from './client.js';
export type {
  McpToolDef,
  McpToolResult,
  McpAttachmentPayload,
  McpAttachmentLimits,
  McpContentParts,
  McpClientLike,
  McpClientOptions,
} from './client.js';
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
// PROP-125: серверные MCP-серверы гибрида в режиме `tools`.
export {
  RemoteBackendMcpClient,
  REMOTE_MCP_CONNECT_TIMEOUT_MS,
  REMOTE_MCP_TOOL_TIMEOUT_MS,
} from './remote-backend-mcp-client.js';
export type { RemoteMcpBackendApi } from './remote-backend-mcp-client.js';
export {
  RemoteMcpSource,
  RemoteMcpFallbackClient,
  resolveRemoteMcpMode,
  REMOTE_MCP_SOURCE_TTL_MS,
  REMOTE_MCP_SOURCE_RETRY_MS,
  REMOTE_MCP_OFFLINE_REASON,
} from './remote-mcp-source.js';
export type {
  RemoteMcpServerSnapshot,
  RemoteMcpSourceOptions,
  RemoteMcpFallbackHooks,
} from './remote-mcp-source.js';
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
