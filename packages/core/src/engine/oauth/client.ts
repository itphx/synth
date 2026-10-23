/**
 * ADR-105 (Ф2): OAuth-клиент (Authorization Code + PKCE, refresh, revoke).
 *
 * Сеть — **только** `egressFetch` (ADR-099, единый egress-слой: TLS/CA/прокси).
 * Свой HTTP-агент/диспетчер клиент не создаёт; транспорт инъектируется только
 * для тестов (`fetchImpl`).
 *
 * Транспортная часть переиспользует `remote/device-flow.ts` (`postFormDetailed`)
 * — второй реализации form-POST не заводим (Device Flow не дублируем).
 *
 * Секреты (access/refresh-токен, `client_secret`) **не попадают** в текст
 * ошибок и никуда не логируются (ADR-105 §7).
 */
import { postFormDetailed } from '../../remote/device-flow.js';
import type { AuthFetchLike } from '../../remote/device-flow.js';
import { OAuthError } from './types.js';
import type {
  OAuthClientAuthMethod,
  OAuthProviderDescription,
  OAuthRevokeResult,
  OAuthTokenSet,
} from './types.js';

/** Таймаут запросов к провайдеру по умолчанию, мс. */
const DEFAULT_OAUTH_TIMEOUT_MS = 15_000;

/** Максимальная длина `error_description`, попадающего в текст ошибки. */
const MAX_ERROR_DESCRIPTION_CHARS = 200;

/** Коды ошибок OAuth (RFC 6749 §4.1.2.1, §5.2), которые клиент различает. */
const KNOWN_ERROR_CODES = new Set([
  'invalid_grant',
  'invalid_request',
  'invalid_client',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
  'server_error',
]);

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Разбор тела ответа провайдера в набор токенов (ошибка → `OAuthError`). */
function parseTokenResponse(status: number, body: Record<string, unknown>): OAuthTokenSet {
  const error = str(body.error);
  if (error) {
    const description = str(body.error_description);
    const detail = description
      ? ` — ${description.slice(0, MAX_ERROR_DESCRIPTION_CHARS)}`
      : '';
    const code = KNOWN_ERROR_CODES.has(error)
      ? (error as OAuthError['code'])
      : 'provider_error';
    throw new OAuthError(code, `Провайдер вернул ошибку OAuth: ${error}${detail}`);
  }
  const accessToken = str(body.access_token);
  if (!accessToken) {
    throw new OAuthError(
      'invalid_response',
      `Провайдер не вернул access_token (HTTP ${status})`,
    );
  }
  const refreshToken = str(body.refresh_token);
  const expiresIn = num(body.expires_in);
  const scope = str(body.scope);
  const tokenType = str(body.token_type);
  return {
    accessToken,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(expiresIn !== undefined ? { expiresIn } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(tokenType !== undefined ? { tokenType } : {}),
  };
}

/** Параметры клиента. */
export interface OAuthClientOptions {
  /** Описание провайдера (данные). */
  provider: OAuthProviderDescription;
  /**
   * `client_secret` (plaintext) — только из env/файла (см. `client-secret.ts`).
   * Значение не логируется и не возвращается наружу.
   */
  clientSecret?: string;
  /** Транспорт (тесты); по умолчанию — `egressFetch` (ADR-099). */
  fetchImpl?: AuthFetchLike;
  /** Таймаут запроса, мс. */
  timeoutMs?: number;
}

/** Параметры обмена кода на токены. */
export interface ExchangeCodeInput {
  /** Код авторизации (RFC 6749 §4.1.2). */
  code: string;
  /** PKCE-верификатор (обязателен для публичного клиента). */
  codeVerifier?: string;
  /** `redirect_uri` — должен совпадать с тем, что был в authorize-запросе. */
  redirectUri?: string;
  /** `client_id` — переопределяет значение из описания провайдера. */
  clientId?: string;
}

/** Параметры refresh (RFC 6749 §6). */
export interface RefreshInput {
  refreshToken: string;
  /** `client_id` — переопределяет значение из описания провайдера. */
  clientId?: string;
  /** Запрошенные scope'ы (уже granted — сузить нельзя). */
  scopes?: string[];
}

/** Параметры отзыва (RFC 7009). */
export interface RevokeInput {
  /** Отзываемый токен (обычно refresh-токен). */
  token: string;
  /** `client_id` — переопределяет значение из описания провайдера. */
  clientId?: string;
  /** `token_type_hint` (по умолчанию — `refresh_token`). */
  tokenTypeHint?: string;
}

/**
 * Клиент одного OAuth-провайдера.
 *
 * Экземпляр привязан к описанию провайдера; токены наружу не отдаются —
 * возвращаются вызывающему, который кладёт их в хранилище доступов
 * (`ExternalCredentialRepository`).
 */
export class OAuthClient {
  private readonly _provider: OAuthProviderDescription;
  private readonly _clientSecret?: string;
  private readonly _fetchImpl?: AuthFetchLike;
  private readonly _timeoutMs: number;

  constructor(options: OAuthClientOptions) {
    this._provider = options.provider;
    this._clientSecret = options.clientSecret;
    this._fetchImpl = options.fetchImpl;
    this._timeoutMs = options.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS;
  }

  /** Описание провайдера, с которым работает клиент. */
  get provider(): OAuthProviderDescription {
    return this._provider;
  }

  /** `client_id` по умолчанию (из описания провайдера). */
  get clientId(): string {
    return this._provider.clientId;
  }

  /** Scope'ы по умолчанию (из описания провайдера). */
  get defaultScopes(): string[] {
    return [...(this._provider.scopes ?? [])];
  }

  /** Поддерживается ли отзыв токена (есть `revokeUrl`). */
  get supportsRevoke(): boolean {
    return typeof this._provider.revokeUrl === 'string' && this._provider.revokeUrl !== '';
  }

  /**
   * Обмен кода авторизации на токены (RFC 6749 §4.1.3).
   *
   * Публичный клиент (`clientAuth: 'none'`) — с PKCE-верификатором; клиент с
   * секретом — с `client_secret` (post или basic, по описанию провайдера).
   */
  async exchangeCode(input: ExchangeCodeInput): Promise<OAuthTokenSet> {
    const clientId = input.clientId ?? this._provider.clientId;
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: clientId,
    });
    if (input.codeVerifier) params.set('code_verifier', input.codeVerifier);
    if (input.redirectUri) params.set('redirect_uri', input.redirectUri);
    const headers = this._applyClientAuth(params, clientId);
    const result = await this._post(this._provider.tokenUrl, params, headers);
    return parseTokenResponse(result.status, result.body);
  }

  /**
   * Обновление access-токена по refresh-токену (RFC 6749 §6).
   *
   * `invalid_grant` (refresh-токен отозван/истёк) → `OAuthError('invalid_grant')`:
   * вызывающий переводит доступ в `status:'error'` (ADR-105 §3).
   */
  async refresh(input: RefreshInput): Promise<OAuthTokenSet> {
    const clientId = input.clientId ?? this._provider.clientId;
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: clientId,
    });
    if (input.scopes && input.scopes.length > 0) params.set('scope', input.scopes.join(' '));
    const headers = this._applyClientAuth(params, clientId);
    const result = await this._post(this._provider.tokenUrl, params, headers);
    return parseTokenResponse(result.status, result.body);
  }

  /**
   * Отзыв токена у провайдера (RFC 7009) — **best-effort**.
   *
   * Провайдер может не поддерживать revoke или ответить ошибкой (5xx) — тогда
   * отзыв не состоялся, но локальный отзыв доступа (в хранилище) всё равно
   * выполняется. Исключений здесь не бросает.
   */
  async revoke(input: RevokeInput): Promise<OAuthRevokeResult> {
    if (!this.supportsRevoke) return { revoked: false, reason: 'not_supported' };
    const clientId = input.clientId ?? this._provider.clientId;
    const params = new URLSearchParams({
      token: input.token,
      token_type_hint: input.tokenTypeHint ?? 'refresh_token',
      client_id: clientId,
    });
    const headers = this._applyClientAuth(params, clientId);
    let result: { status: number; body: Record<string, unknown> };
    try {
      result = await this._post(this._provider.revokeUrl as string, params, headers);
    } catch {
      // best-effort: сеть недоступна — отзыв у провайдера не состоялся.
      return { revoked: false, reason: 'network' };
    }
    const { status, body } = result;
    if (status >= 200 && status < 300) return { revoked: true, status };
    return { revoked: false, status, reason: str(body.error) ?? 'provider_error' };
  }

  /**
   * Подтверждение клиента (RFC 6749 §2.3.1).
   *
   * `client_secret_basic` кладёт секрет в заголовок `Authorization: Basic` —
   * поэтому такие запросы **не** должны пересылаться на чужой origin
   * (host-binding заголовков, ADR-105 §7, `engine/net/egress-guard.ts`).
   */
  private _applyClientAuth(
    params: URLSearchParams,
    clientId: string,
  ): Record<string, string> {
    const method: OAuthClientAuthMethod = this._provider.clientAuth ?? 'none';
    const headers: Record<string, string> = {};
    if (method === 'none') return headers;
    const secret = this._clientSecret;
    if (!secret) {
      throw new OAuthError(
        'missing_client_secret',
        `Для провайдера «${this._provider.provider}» нужен client_secret (env или файл secrets/oauth)`,
      );
    }
    if (method === 'client_secret_post') {
      params.set('client_secret', secret);
      return headers;
    }
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
    return headers;
  }

  /** POST формы к провайдеру через единый транспорт (`postFormDetailed`). */
  private async _post(
    url: string,
    params: URLSearchParams,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const fetchImpl = this._fetchImpl;
    const opts = {
      timeoutMs: this._timeoutMs,
      headers,
      ...(fetchImpl
        ? { fetchImpl: (input: string, requestInit?: RequestInit) => fetchImpl(input, requestInit) }
        : {}),
    };
    return postFormDetailed(url, params, opts);
  }
}
