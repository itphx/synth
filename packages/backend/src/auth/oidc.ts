import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { User } from '@itphx/synth-shared';

/**
 * Конфигурация OIDC-клиента (Keycloak, confidential client).
 * Схема Authorization Code + PKCE не обязателен — используем client_secret.
 */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

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
    const res = await fetch(url);
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

    const res = await fetch(discovery.token_endpoint, {
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
    const res = await fetch(discovery.token_endpoint, {
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
   * Проверка JWT (id_token) через JWKS провайдера.
   * Возвращает User-подобный объект: id, username, email, roles.
   */
  async verifyToken(token: string): Promise<OidcUser> {
    const discovery = await this.getDiscovery();
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const { payload } = await jwtVerify(token, jwks);
    return extractUser(payload);
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
 * Извлечь пользователя из payload id_token Keycloak:
 * - username = preferred_username (fallback email, sub)
 * - roles = realm_access.roles → ВЕРХНИЙ РЕГИСТР + фильтр известных (ADMIN/USER/LEAD/AUDITOR)
 * - если ролей нет — дефолт ['USER']
 */
function extractUser(payload: Record<string, unknown>): OidcUser {
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const preferredUsername = typeof payload.preferred_username === 'string'
    ? payload.preferred_username
    : undefined;
  const username = preferredUsername || email || sub || '';

  const realmAccess = (payload.realm_access ?? {}) as Record<string, unknown>;
  const rawRoles = Array.isArray(realmAccess.roles)
    ? (realmAccess.roles as unknown[]).filter((r): r is string => typeof r === 'string')
    : [];

  const roles = rawRoles
    .map((r) => r.toUpperCase())
    .filter((r): r is string => (KNOWN_ROLES as readonly string[]).includes(r));

  return {
    id: sub || username || 'oidc-user',
    username: username || 'oidc-user',
    email,
    roles: roles.length > 0 ? roles : ['USER'],
  };
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
