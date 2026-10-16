import { jwtVerify, createRemoteJWKSet, customFetch } from 'jose';
import type { User } from '@itphx/synth-shared';
// ADR-099: дискавери/токен-эндпоинты/JWKS OIDC — через единый транспорт доверия TLS/CA.
import { egressFetch } from '@itphx/synth-core';

/**
 * Конфигурация OIDC-клиента (Keycloak, confidential client).
 * Схема Authorization Code + PKCE не обязателен — используем client_secret.
 */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /**
   * Дополнительные допустимые `aud` (в дополнение к дефолтам: для id_token —
   * `clientId`, для access_token — `clientId`/`account`). В Keycloak
   * `id_token.aud` = clientId, а `access_token.aud` обычно `account` (строкой
   * или массивом); доп. значения — только для нестандартных конфигураций.
   * Issuer проверяется всегда.
   */
  audience?: string[];
}

/** Audience access_token по умолчанию (Keycloak): клиент либо `account`. */
const DEFAULT_ACCESS_TOKEN_AUDIENCE = 'account';

/** Подмножество документа discovery OpenID Connect. */
export interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** Результат обмена authorization code на токены. */
export interface OidcTokenResult {
  id_token: string;
  access_token: string;
}

/** Известные роли Synth (в realm роли записаны в нижнем регистре). */
const KNOWN_ROLES = ['ADMIN', 'USER', 'LEAD', 'AUDITOR'] as const;

/**
 * OIDC-клиент: discovery, authorize URL, обмен кода, верификация JWT.
 */
export class OidcClient {
  private _discovery: OidcDiscovery | null = null;

  constructor(private readonly config: OidcConfig) {}

  /**
   * GET ${issuer}/.well-known/openid-configuration.
   * Результат кэшируется на время жизни инстанса.
   */
  async getDiscovery(): Promise<OidcDiscovery> {
    if (this._discovery) return this._discovery;
    const url = `${this.config.issuer}/.well-known/openid-configuration`;
    // ADR-099: дискавери — через единый транспорт доверия TLS/CA.
    const res = await egressFetch(url);
    if (!res.ok) {
      throw new Error(`OIDC discovery failed: ${res.status} ${url}`);
    }
    const doc = (await res.json()) as OidcDiscovery;
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new Error('OIDC discovery не содержит обязательных endpoint-ов');
    }
    this._discovery = doc;
    return doc;
  }

  /**
   * URL для редиректа пользователя на authorize endpoint.
   */
  async authorizeUrl(state: string): Promise<string> {
    const discovery = await this.getDiscovery();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: 'openid profile email',
      state,
    });
    return `${discovery.authorization_endpoint}?${params.toString()}`;
  }

  /**
   * POST token_endpoint (form-urlencoded) — обмен authorization code на токены.
   */
  async exchangeCode(code: string): Promise<OidcTokenResult> {
    const discovery = await this.getDiscovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    // ADR-099: обмен кода на токены — через единый транспорт доверия TLS/CA.
    const res = await egressFetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new Error(`OIDC token exchange failed: ${res.status}`);
    }
    const data = (await res.json()) as Partial<OidcTokenResult>;
    if (!data.id_token || !data.access_token) {
      throw new Error('OIDC token exchange не вернул id_token/access_token');
    }
    return { id_token: data.id_token, access_token: data.access_token };
  }

  /**
   * POST token_endpoint — вход по логину/паролю (ROPC, Resource Owner Password Credentials).
   * scope: 'openid' обязателен — без него Keycloak не возвращает id_token (только access_token).
   */
  async exchangePassword(username: string, password: string): Promise<OidcTokenResult> {
    const discovery = await this.getDiscovery();
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      username,
      password,
      scope: 'openid',
    });
    // ADR-099: ROPC-вход — через единый транспорт доверия TLS/CA.
    const res = await egressFetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OIDC ROPC failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as Partial<OidcTokenResult>;
    if (!data.id_token || !data.access_token) {
      throw new Error('OIDC ROPC не вернул id_token/access_token');
    }
    return { id_token: data.id_token, access_token: data.access_token };
  }

  /**
   * Проверка JWT (id_token или access_token) через JWKS провайдера.
   * Проверяются подпись, `iss` (issuer) и `aud`.
   * Возвращает User-подобный объект: id, username, email, roles.
   */
  async verifyToken(token: string): Promise<OidcUser> {
    const discovery = await this.getDiscovery();
    const jwks = this._remoteJwks(discovery.jwks_uri);
    // Тип bearer-токена заранее неизвестен (id_token или access_token), поэтому
    // принимаем audience обоих классов: clientId (id_token) и clientId/`account`
    // (access_token Keycloak). Issuer проверяется всегда.
    const { payload } = await jwtVerify(token, jwks, {
      issuer: this.config.issuer,
      audience: this._anyTokenAudience(),
    });
    return extractUser(payload, this.config.clientId);
  }

  /**
   * Проверка пары id_token + access_token через JWKS провайдера.
   * Роли: из id_token, если пусто — из access_token (client roles учитываются).
   */
  async verifyTokens(idToken: string, accessToken: string): Promise<OidcUser> {
    const discovery = await this.getDiscovery();
    const jwks = this._remoteJwks(discovery.jwks_uri);
    const { payload: idPayload } = await jwtVerify(idToken, jwks, {
      issuer: this.config.issuer,
      // id_token.aud = clientId (+ доп. из конфига).
      audience: this._idTokenAudience(),
    });
    const { payload: accessPayload } = await jwtVerify(accessToken, jwks, {
      issuer: this.config.issuer,
      // Keycloak кладёт в access_token.aud `account`, а клиента — в `azp`;
      // принимаем clientId ИЛИ `account` (+ доп. из конфига), чтобы не ломать
      // валидные токены. `azp` намеренно не форсим (иначе токены realm-клиентов,
      // напр. `synth-cli`, отвергались бы) — issuer и подпись проверяются всегда.
      audience: this._accessTokenAudience(),
    });
    return extractUserFromTokens(idPayload, accessPayload, this.config.clientId);
  }

  /**
   * ADR-099: JWKS-набор с **явным** транспортом доверия TLS/CA (`egressFetch`),
   * а не через глобальный dispatcher процесса — точка не зависит от глобального
   * состояния (`applyGlobalTlsTrust` остаётся основным каналом для прочих fetch).
   * jose 6 отдаёт кастомный транспорт через символ `customFetch`.
   */
  private _remoteJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
    return createRemoteJWKSet(new URL(jwksUri), {
      [customFetch]: (url, options) =>
        egressFetch(url, {
          headers: options.headers,
          method: options.method,
          redirect: options.redirect,
          signal: options.signal,
        }),
    });
  }

  /** Допустимые `aud` id_token: clientId (+ дополнительные из конфига). */
  private _idTokenAudience(): string[] {
    return [...new Set([this.config.clientId, ...(this.config.audience ?? [])])].filter(Boolean);
  }

  /** Допустимые `aud` access_token: clientId ИЛИ `account` (+ дополнительные). */
  private _accessTokenAudience(): string[] {
    return [
      ...new Set([
        this.config.clientId,
        DEFAULT_ACCESS_TOKEN_AUDIENCE,
        ...(this.config.audience ?? []),
      ]),
    ].filter(Boolean);
  }

  /** Допустимые `aud` для bearer-токена неизвестного типа — объединение. */
  private _anyTokenAudience(): string[] {
    return [...new Set([...this._idTokenAudience(), ...this._accessTokenAudience()])];
  }
}

/** User-подобный объект, извлечённый из OIDC-токена. */
export interface OidcUser {
  id: string;
  username: string;
  email?: string;
  roles: string[];
}

/**
 * Извлечь известные роли из payload токена Keycloak:
 * realm_access.roles + resource_access.<clientId>.roles (client roles).
 * Нормализация в ВЕРХНИЙ РЕГИСТР + фильтр KNOWN_ROLES, без дубликатов. Дефолт не применяется.
 */
function extractKnownRoles(payload: Record<string, unknown>, clientId?: string): string[] {
  const realmAccess = (payload.realm_access ?? {}) as Record<string, unknown>;
  const rawRoles = Array.isArray(realmAccess.roles)
    ? (realmAccess.roles as unknown[]).filter((r): r is string => typeof r === 'string')
    : [];

  if (clientId) {
    const resourceAccess = (payload.resource_access ?? {}) as Record<string, unknown>;
    const clientAccess = (resourceAccess[clientId] ?? {}) as Record<string, unknown>;
    if (Array.isArray(clientAccess.roles)) {
      rawRoles.push(...clientAccess.roles.filter((r): r is string => typeof r === 'string'));
    }
  }

  const roles = rawRoles
    .map((r) => r.toUpperCase())
    .filter((r): r is string => (KNOWN_ROLES as readonly string[]).includes(r));

  return [...new Set(roles)];
}

/**
 * Извлечь пользователя из payload id_token Keycloak:
 * - username = preferred_username (fallback email, sub)
 * - roles = realm_access.roles + resource_access.<clientId>.roles → ВЕРХНИЙ РЕГИСТР + фильтр известных (ADMIN/USER/LEAD/AUDITOR)
 * - если ролей нет — дефолт ['USER']
 */
export function extractUser(payload: Record<string, unknown>, clientId?: string): OidcUser {
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const preferredUsername = typeof payload.preferred_username === 'string'
    ? payload.preferred_username
    : undefined;
  const username = preferredUsername || email || sub || '';

  const roles = extractKnownRoles(payload, clientId);

  return {
    id: sub || username || 'oidc-user',
    username: username || 'oidc-user',
    email,
    roles: roles.length > 0 ? roles : ['USER'],
  };
}

/**
 * Объединить роли из id_token и access_token: роли из id_token, если пусто — из access_token.
 * Поля id/username/email берутся из id_token.
 */
export function extractUserFromTokens(
  idPayload: Record<string, unknown>,
  accessPayload: Record<string, unknown>,
  clientId?: string,
): OidcUser {
  const idRoles = extractKnownRoles(idPayload, clientId);
  const accessRoles = extractKnownRoles(accessPayload, clientId);
  const roles = idRoles.length > 0 ? idRoles : accessRoles;
  const user = extractUser(idPayload, clientId);
  return { ...user, roles: roles.length > 0 ? roles : ['USER'] };
}

/**
 * Собрать полноценный User из OIDC-пользователя (объект User требует служебные поля).
 */
export function oidcUserToUser(o: OidcUser): User {
  return {
    id: o.id,
    username: o.username,
    email: o.email,
    roles: o.roles,
    preferredLanguage: 'ru',
    createdAt: new Date().toISOString(),
    teamRole: o.roles[0] || 'USER',
    notes: '',
    interviewCompleted: false,
  };
}

/**
 * Лениво создать OIDC-клиент из конфига (мемоизация).
 * Безопасно при отсутствии oidc-конфига: возвращает null вместо выбрасывания ошибки.
 */
export function createLazyOidcClient(oidc?: OidcConfig): () => OidcClient | null {
  let client: OidcClient | null | undefined;

  return () => {
    if (client !== undefined) return client;
    if (!oidc || !oidc.issuer || !oidc.clientId || !oidc.clientSecret) {
      client = null;
      return null;
    }
    client = new OidcClient(oidc);
    return client;
  };
}
