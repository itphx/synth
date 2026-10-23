/**
 * ADR-105 (Ф2): PKCE (RFC 7636) для Authorization Code.
 *
 * Клиент — публичный: `code_verifier` (случайный, 43–128 символов unreserved
 * алфавита) и `code_challenge = BASE64URL(SHA256(code_verifier))`, метод
 * `S256`. `plain` не используется (RFC 7636 §4.2 — только при невозможности
 * S256).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { OAuthProviderDescription } from './types.js';

/** Метод PKCE, который использует клиент (RFC 7636 §4.3). */
export const PKCE_CODE_CHALLENGE_METHOD = 'S256' as const;

/** Длина `code_verifier` в байтах случайности (43 символа base64url). */
const CODE_VERIFIER_BYTES = 32;

/** Длина `state` в байтах случайности (безопасность CSRF, RFC 6749 §10.12). */
const STATE_BYTES = 16;

/** PKCE-пара: верификатор и его challenge. */
export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: typeof PKCE_CODE_CHALLENGE_METHOD;
}

/** Случайный `code_verifier` (unreserved-алфавит RFC 7636 §4.1). */
export function createCodeVerifier(): string {
  return randomBytes(CODE_VERIFIER_BYTES).toString('base64url');
}

/** `code_challenge` для S256: `BASE64URL(SHA256(code_verifier))` без padding. */
export function computeCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

/** Новая PKCE-пара (верификатор + challenge). */
export function createPkcePair(): PkcePair {
  const codeVerifier = createCodeVerifier();
  return {
    codeVerifier,
    codeChallenge: computeCodeChallenge(codeVerifier),
    codeChallengeMethod: PKCE_CODE_CHALLENGE_METHOD,
  };
}

/** Случайный `state` для authorize-запроса (CSRF-защита, RFC 6749 §10.12). */
export function createState(): string {
  return randomBytes(STATE_BYTES).toString('base64url');
}

/** Параметры authorize-запроса. */
export interface AuthorizationUrlOptions {
  /** PKCE-пара (challenge подставляется в запрос). */
  pkce?: PkcePair;
  /** `state` (CSRF-защита). */
  state?: string;
  /** `redirect_uri` — переопределяет значение из описания провайдера. */
  redirectUri?: string;
  /** Scope'ы — переопределяют значение из описания провайдера. */
  scopes?: string[];
  /** Дополнительные параметры запроса (провайдерные). */
  extraParams?: Record<string, string>;
}

/**
 * URL выдачи кода (authorization endpoint, RFC 6749 §4.1.1) с PKCE.
 *
 * Обязательные параметры провайдера (`response_type`, `client_id`, `scope`,
 * `code_challenge`) формируются здесь; провайдерные (`authorizeParams`)
 * добавляются **до** них, поэтому стандартные параметры не перетираются.
 */
export function buildAuthorizationUrl(
  provider: OAuthProviderDescription,
  options: AuthorizationUrlOptions = {},
): string {
  let url: URL;
  try {
    url = new URL(provider.authorizeUrl);
  } catch {
    throw new Error(`Некорректный authorize URL провайдера «${provider.provider}»`);
  }
  for (const [name, value] of Object.entries(provider.authorizeParams ?? {})) {
    url.searchParams.set(name, value);
  }
  for (const [name, value] of Object.entries(options.extraParams ?? {})) {
    url.searchParams.set(name, value);
  }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', provider.clientId);
  const redirectUri = options.redirectUri ?? provider.redirectUri;
  if (redirectUri) url.searchParams.set('redirect_uri', redirectUri);
  const scopes = options.scopes ?? provider.scopes ?? [];
  if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
  if (options.state) url.searchParams.set('state', options.state);
  if (options.pkce) {
    url.searchParams.set('code_challenge', options.pkce.codeChallenge);
    url.searchParams.set('code_challenge_method', options.pkce.codeChallengeMethod);
  }
  return url.toString();
}
