// Гибридный режим: remote-клиент, OIDC device flow, хранение credentials.

export { RemoteBackendClient } from './client.js';
export type { RemoteClientOptions, RemoteAuthStatus, RequestOptions, RemoteModelInfo } from './client.js';
export { RemoteEventBridge } from './event-bridge.js';
export type { RemoteEventBridgeOptions } from './event-bridge.js';
export { discover, startDeviceFlow, pollDeviceToken, refreshAccessToken, passwordGrant } from './device-flow.js';
export type { DeviceFlowDiscovery, DeviceFlowSession, DeviceTokenResult, RefreshTokenResult, PasswordGrantResult } from './device-flow.js';
export { loadCredentials, saveCredentials, clearCredentials, listCredentials } from './credentials.js';
export { RemoteSession } from './session.js';
export type { RemoteSessionOptions, RemoteSessionAuthStatus, DeviceCodeInfo } from './session.js';
export { RemoteConnection } from './connection.js';
export type { RemoteConnectionDeps } from './connection.js';
export { RemoteError } from './types.js';
export type { Origin, RemoteAuthType, RemoteCredentials, RemoteErrorCode, RemoteUser } from './types.js';
export {
  REMOTE_PREFIX,
  isRemoteRef,
  toLocalId,
  toRemoteRef,
  annotateOrigin,
  rewriteRemoteItem,
  toRemote,
  mergeItems,
  remoteErrorToHttp,
} from './aggregate.js';
export type { MergeItemsOptions } from './aggregate.js';
export {
  syncProjectToRemote,
  forkProjectToLocal,
  walkDir,
  remoteWalk,
  buildSessionExport,
  resolveLocalWorkspace,
  slugify,
  isBinaryBuffer,
  EXCLUDED_DIRS,
} from './transfer.js';
export type { SyncProjectToRemoteOptions, ForkProjectToLocalOptions, TransferStats } from './transfer.js';
export type { RemoteConfig } from '@itphx/synth-shared';
