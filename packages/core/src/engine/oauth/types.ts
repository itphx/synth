/**
 * ADR-105 (Ф2): контракты OAuth-клиента.
 *
 * Описание провайдера — **данные** (ADR-105 §13, вариант «А»): endpoint'ы,
 * `client_id`, scope'ы. Никакого кода провайдера в ядре нет — плагин/каталог
 * приносит только описание, креды живут в слое доступов.
 *
 * `client_secret` — **не** часть описания: он читается только из env или из
 * файла `{dataDir}/secrets/oauth/<provider>.client_secret` (см. `client-secret.ts`),
 * в конфиг не пишется и нигде не логируется.
 */

/**
 * Способ подтверждения клиента (RFC 6749 §2.3.1):
 * - `none` — публичный клиент (PKCE, без секрета);
 * - `client_secret_post` — секрет в теле запроса;
 * - `client_secret_basic` — секрет в заголовке `Authorization: Basic`.
 */
export type OAuthClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

/** Описание OAuth-провайдера (коннектора) — только данные. */
export interface OAuthProviderDescription {
  /** Ключ провайдера — совпадает с `provider` в записи доступа. */
  provider: string;
  /** Endpoint выдачи кода (authorization endpoint, RFC 6749 §3.1). */
  authorizeUrl: string;
  /** Endpoint обмена кода и обновления токена (token endpoint, RFC 6749 §3.2/§6). */
  tokenUrl: string;
  /** Endpoint отзыва токена (RFC 7009) — необязателен. */
  revokeUrl?: string;
  /** Endpoint device flow (RFC 8628 §3.1) — необязателен. */
  deviceAuthorizationUrl?: string;
  /** `client_id` приложения (публичное значение, не секрет). */
  clientId: string;
  /** Scope'ы по умолчанию для этого провайдера. */
  scopes?: string[];
  /** Способ подтверждения клиента (по умолчанию — `none`, т.е. PKCE без секрета). */
  clientAuth?: OAuthClientAuthMethod;
  /** `redirect_uri` по умолчанию (может быть переопределён при выдаче кода). */
  redirectUri?: string;
  /** Дополнительные параметры authorize-запроса (провайдерные). */
  authorizeParams?: Record<string, string>;
}

/** Набор токенов провайдера (после обмена кода или refresh). */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Срок жизни access-токена, секунды (если провайдер сообщил). */
  expiresIn?: number;
  /** Фактически выданные scope'ы (если провайдер сообщил). */
  scope?: string;
  /** Тип токена (обычно `Bearer`). */
  tokenType?: string;
}

/** Результат отзыва токена (RFC 7009) — best-effort. */
export interface OAuthRevokeResult {
  /** `true` — провайдер подтвердил отзыв (2xx). */
  revoked: boolean;
  /** HTTP-статус ответа провайдера (если ответ был). */
  status?: number;
  /** Причина неудачи: `not_supported` / `network` / код ошибки провайдера. */
  reason?: string;
}

/**
 * Коды ошибок OAuth-клиента. `invalid_grant` — особый: означает, что
 * refresh-токен отозван/истёк, доступ переводится в `status:'error'`
 * (ADR-105 §3).
 */
export type OAuthErrorCode =
  | 'invalid_grant'
  | 'invalid_request'
  | 'invalid_client'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'server_error'
  | 'provider_error'
  | 'network'
  | 'invalid_response'
  | 'not_found'
  | 'revoked'
  | 'no_refresh_token'
  | 'missing_client_secret';

/**
 * Ошибка OAuth-клиента.
 *
 * В тексте ошибки **нет** секретов: ни `client_secret`, ни токенов (ADR-105
 * §7 — «нет утечки в логи/телеметрию»). Код ошибки — машинно-читаемый
 * (для вызывающего слоя и UI), текст — для оператора.
 */
export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}
