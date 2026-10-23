/**
 * ADR-105 (Ф2): OAuth-клиент и сервис слоя внешних доступов.
 *
 * Модули:
 * - `types.ts` — описание провайдера (данные), набор токенов, ошибки;
 * - `pkce.ts` — PKCE (RFC 7636, S256) и URL выдачи кода;
 * - `client-secret.ts` — `client_secret` из env/файла (никогда — из конфига);
 * - `client.ts` — клиент провайдера: обмен кода, refresh, revoke;
 * - `service.ts` — сервис доступа поверх порта `ExternalCredentialRepository`.
 */
export {
  OAuthError,
  type OAuthClientAuthMethod,
  type OAuthProviderDescription,
  type OAuthRevokeResult,
  type OAuthTokenSet,
  type OAuthErrorCode,
} from './types.js';
export {
  PKCE_CODE_CHALLENGE_METHOD,
  buildAuthorizationUrl,
  computeCodeChallenge,
  createCodeVerifier,
  createPkcePair,
  createState,
  type AuthorizationUrlOptions,
  type PkcePair,
} from './pkce.js';
export {
  OAUTH_CLIENT_SECRET_ENV_PREFIX,
  OAUTH_CLIENT_SECRET_ENV_SUFFIX,
  OAUTH_CLIENT_SECRET_FILENAME_SUFFIX,
  oauthClientSecretEnv,
  oauthClientSecretPath,
  resolveOAuthClientSecret,
  type ResolveClientSecretOptions,
} from './client-secret.js';
export {
  OAuthClient,
  type ExchangeCodeInput,
  type OAuthClientOptions,
  type RefreshInput,
  type RevokeInput,
} from './client.js';
export {
  OAuthCredentialService,
  type ExchangeAndStoreInput,
  type OAuthCredentialServiceDeps,
  type RevokeResult,
} from './service.js';
export {
  OAuthProviderRegistry,
  type OAuthProviderRegistration,
} from './registry.js';
