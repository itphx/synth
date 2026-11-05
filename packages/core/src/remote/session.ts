// Фасад жизненного цикла подключения к удалённому backend (гибридный режим).
// ensureAuthenticated проходит путь: api_key → сохранённые credentials → refresh → device flow.
//
// Поток device flow (RFC 8628):
//   discover → startDeviceFlow → onDeviceCode (печать URL+кода) → pollDeviceToken → сохранить credentials.

import { RemoteBackendClient } from './client.js';
import { loadCredentials, saveCredentials, clearCredentials } from './credentials.js';
import { startDeviceFlow, pollDeviceToken, refreshAccessToken, passwordGrant } from './device-flow.js';
import { RemoteError } from './types.js';
import type { RemoteAuthType, RemoteCredentials, RemoteUser } from './types.js';
import type { RemoteRequestInfo } from '../metrics/collectors/hybrid.js';

export interface RemoteSessionOptions {
  backendUrl: string;
  authType?: 'device' | 'api_key';
  apiKey?: string;
  issuer?: string;
  clientId?: string;
  credentialsPath?: string;
  timeoutMs?: number;
  /** ADR-094: метрики исходящих запросов к удалённому backend. */
  onRequest?: (info: RemoteRequestInfo) => void;
}

/** Информация для показа пользователю во время device flow. */
export interface DeviceCodeInfo {
  verificationUri: string;
  userCode: string;
}

export interface RemoteSessionAuthStatus {
  connected: boolean;
  backendUrl: string;
  user?: RemoteUser;
}

/**
 * Запас обновления access-токена: refresh запускается за 60 с до истечения,
 * иначе токен мог истечь прямо во время длинного LLM-вызова/шага.
 */
const TOKEN_REFRESH_SKEW_MS = 60_000;

function isTokenExpired(expiresAt?: string, skewMs = 0): boolean {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return false;
  return ts - skewMs <= Date.now();
}

export class RemoteSession {
  readonly backendUrl: string;
  readonly authType: RemoteAuthType;
  /** Серверный пользователь (из GET /auth/status), если известен. */
  readonly user?: RemoteUser;

  private _accessToken: string;
  private _refreshToken?: string;
  private _expiresAt?: string;
  private readonly _issuer?: string;
  private readonly _clientId?: string;
  private readonly _timeoutMs?: number;
  private _client: RemoteBackendClient;
  private readonly _credentialsPath?: string;
  /**
   * Single-flight обновления access-токена: параллельные getToken() при
   * истёкшем токене ждут один и тот же refresh (иначе гонка на token-endpoint
   * и рассинхронизация _accessToken/_refreshToken).
   */
  private _refreshPromise: Promise<string | null> | null = null;

  private constructor(
    backendUrl: string,
    authType: RemoteAuthType,
    accessToken: string,
    credentialsPath?: string,
    timeoutMs?: number,
    refreshToken?: string,
    expiresAt?: string,
    issuer?: string,
    clientId?: string,
    user?: RemoteUser,
  ) {
    this.backendUrl = backendUrl;
    this.authType = authType;
    this._accessToken = accessToken;
    this._refreshToken = refreshToken;
    this._expiresAt = expiresAt;
    this._issuer = issuer;
    this._clientId = clientId;
    this._timeoutMs = timeoutMs;
    this._credentialsPath = credentialsPath;
    this.user = user;
    this._client = new RemoteBackendClient({
      backendUrl,
      // Клиент тоже ходит через session.getToken(): протухший accessToken
      // автоматически обновляется в рантайме (а не уходит на backend как есть).
      getToken: () => this.getToken(),
      timeoutMs,
    });
  }

  /**
   * ADR-094: подключить колбэк метрик исходящих запросов (клиент пересоздаётся
   * с хуком). Без хука поведение прежнее.
   */
  attachRequestHook(onRequest?: (info: RemoteRequestInfo) => void): this {
    if (!onRequest) return this;
    this._client = new RemoteBackendClient({
      backendUrl: this.backendUrl,
      getToken: () => this.getToken(),
      timeoutMs: this._timeoutMs,
      onRequest,
    });
    return this;
  }

  /**
   * Обеспечить аутентифицированную сессию к backendUrl.
   * 1. api_key: токен = apiKey (credentials не сохраняются — это не OAuth-токен, refresh неприменим).
   * 2. Сохранённый accessToken ещё действителен → используем (issuer/clientId берутся
   *    из opts, иначе из сохранённых credentials; без обоих — fail-closed: сессия без
   *    возможности refresh умерла бы через 5 минут, лучше честно попросить войти заново).
   * 3. Просрочен + есть refreshToken + issuer/clientId → refreshAccessToken, обновить и сохранить.
   * 4. Иначе → device flow: discover → startDeviceFlow → onDeviceCode → pollDeviceToken → сохранить.
   */
  static async ensureAuthenticated(
    opts: RemoteSessionOptions,
    onDeviceCode?: (info: DeviceCodeInfo) => Promise<void> | void,
  ): Promise<RemoteSession> {
    const backendUrl = opts.backendUrl.replace(/\/+$/, '');
    const authType = opts.authType ?? 'device';
    const credentialsPath = opts.credentialsPath;
    const finish = (session: RemoteSession): RemoteSession =>
      session.attachRequestHook(opts.onRequest);

    if (authType === 'api_key') {
      if (!opts.apiKey) {
        throw new RemoteError(
          'Для remote.auth.type=api_key укажите API-ключ (флаг --token или remote.auth.apiKey в config.yaml)',
          'AUTH',
        );
      }
      return finish(new RemoteSession(backendUrl, authType, opts.apiKey, credentialsPath, opts.timeoutMs));
    }

    const existing = await loadCredentials(backendUrl, credentialsPath);
    // issuer/clientId: явные opts приоритетнее, затем — сохранённые в credentials
    // (иначе после рестарта refresh зависел бы только от дискавери).
    const issuer = opts.issuer ?? existing?.issuer;
    const clientId = opts.clientId ?? existing?.clientId;

    // Сохранённый accessToken действителен — используем как есть.
    if (existing?.accessToken && !isTokenExpired(existing.expiresAt)) {
      if (!issuer || !clientId) {
        // Полусессия без refresh умрёт через 5 минут (access-token Keycloak) —
        // честный отказ вместо тихой поломки посреди хода.
        throw new RemoteError(
          'Не заданы OIDC issuer/clientId — войдите в гибрид заново (нет параметров для обновления токена)',
          'AUTH',
        );
      }
      return finish(new RemoteSession(
        backendUrl, authType, existing.accessToken, credentialsPath, opts.timeoutMs,
        existing.refreshToken, existing.expiresAt, issuer, clientId,
        existing.user,
      ));
    }

    // Просрочен, но есть refreshToken — пробуем обновить.
    if (existing?.refreshToken) {
      if (!issuer || !clientId) {
        throw new RemoteError(
          'Не заданы remote.auth.issuer/clientId — укажите их в config.yaml или флагами --oidc-issuer/--oidc-client-id',
          'AUTH',
        );
      }
      try {
        const refreshed = await refreshAccessToken(issuer, clientId, existing.refreshToken);
        const updated: RemoteCredentials = {
          backendUrl,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? existing.refreshToken,
          expiresAt: refreshed.expiresIn
            ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
            : undefined,
          user: existing.user,
          issuer,
          clientId,
        };
        await saveCredentials(updated, credentialsPath);
        return finish(new RemoteSession(
          backendUrl, authType, updated.accessToken, credentialsPath, opts.timeoutMs,
          updated.refreshToken, updated.expiresAt, issuer, clientId,
          updated.user,
        ));
      } catch (err) {
        if (err instanceof RemoteError && err.code === 'AUTH') {
          // refresh token недействителен (invalid_grant и т.п.) — чистим и проходим device flow заново.
          await clearCredentials(backendUrl, credentialsPath).catch(() => {});
        } else {
          throw err;
        }
      }
    }

    // Ничего нет (или refresh не удался) → device flow.
    if (!issuer || !clientId) {
      throw new RemoteError(
        'Не заданы remote.auth.issuer/clientId — укажите их в config.yaml или флагами --oidc-issuer/--oidc-client-id',
        'AUTH',
      );
    }

    const deviceSession = await startDeviceFlow(issuer, clientId);
    if (onDeviceCode) {
      await onDeviceCode({
        verificationUri: deviceSession.verificationUri,
        userCode: deviceSession.userCode,
      });
    }
    const token = await pollDeviceToken(deviceSession);

    const creds: RemoteCredentials = {
      backendUrl,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresIn
        ? new Date(Date.now() + token.expiresIn * 1000).toISOString()
        : undefined,
      issuer,
      clientId,
      // id_token не парсим на этом этапе — user оставляем пустым.
    };
    await saveCredentials(creds, credentialsPath);
    return finish(new RemoteSession(
      backendUrl, authType, creds.accessToken, credentialsPath, opts.timeoutMs,
      creds.refreshToken, creds.expiresAt, issuer, clientId,
    ));
  }

  /**
   * Вход по логину/паролю (ROPC, grant_type=password) — «единая личность»:
   * локальный core логинится как серверный пользователь (username + роли из
   * Keycloak). Токены сохраняются в credentials (переживают рестарт,
   * getToken() авто-обновляет по refresh token).
   *
   * После обмена токена запрашивается серверный пользователь
   * (GET {backendUrl}/auth/status с Bearer access_token); если backend
   * недоступен — credentials уже сохранены, user остаётся пустым.
   *
   * Scope входа — `openid offline_access` (см. `passwordGrant`): offline
   * refresh-токен переживает idle/max-lifespan SSO-сессии, иначе длинные ходы
   * и саб-агенты падают с «сессия истекла». issuer/clientId сохраняются в
   * credentials — после рестарта refresh не зависит от дискавери.
   *
   * Ошибки: RemoteError('AUTH') — неверный логин/пароль;
   * RemoteError('OFFLINE') — сервер авторизации недоступен.
   */
  static async loginWithPassword(
    opts: RemoteSessionOptions,
    username: string,
    password: string,
  ): Promise<RemoteSession> {
    const backendUrl = opts.backendUrl.replace(/\/+$/, '');
    const authType = opts.authType ?? 'device';
    if (!opts.issuer || !opts.clientId) {
      throw new RemoteError(
        'Не заданы remote.auth.issuer/clientId — укажите их в config.yaml или флагами --oidc-issuer/--oidc-client-id',
        'AUTH',
      );
    }
    if (!username || !password) {
      throw new RemoteError('Укажите логин и пароль', 'AUTH');
    }

    const granted = await passwordGrant(opts.issuer, opts.clientId, username, password);
    const expiresAt = granted.expiresIn
      ? new Date(Date.now() + granted.expiresIn * 1000).toISOString()
      : undefined;

    const creds: RemoteCredentials = {
      backendUrl,
      accessToken: granted.accessToken,
      refreshToken: granted.refreshToken,
      expiresAt,
      issuer: opts.issuer,
      clientId: opts.clientId,
    };
    await saveCredentials(creds, opts.credentialsPath);

    // Пытаемся получить серверного пользователя. Если backend недоступен —
    // сессия уже создана, user остаётся пустым (credentials без user сохранены).
    let user: RemoteUser | undefined;
    try {
      const statusClient = new RemoteBackendClient({
        backendUrl,
        getToken: async () => granted.accessToken,
        timeoutMs: opts.timeoutMs,
        onRequest: opts.onRequest,
      });
      const status = await statusClient.getAuthStatus();
      if (status.user) {
        user = { id: status.user.id, username: status.user.username, roles: status.user.roles };
        await saveCredentials({ ...creds, user }, opts.credentialsPath);
      }
    } catch {
      // статус недоступен — не роняем логин
    }

    return new RemoteSession(
      backendUrl, authType, creds.accessToken, opts.credentialsPath, opts.timeoutMs,
      creds.refreshToken, creds.expiresAt, opts.issuer, opts.clientId,
      user,
    ).attachRequestHook(opts.onRequest);
  }

  getClient(): RemoteBackendClient {
    return this._client;
  }

  /**
   * Токен для авторизации на удалённом backend (используется RemoteProvider
   * как getToken — автообновление в рантайме).
   * - api_key → apiKey;
   * - accessToken действителен (с запасом `TOKEN_REFRESH_SKEW_MS`) → как есть;
   * - refreshToken + issuer/clientId → refreshAccessToken, пересохранение credentials;
   * - refresh упал/вернул null, а текущий токен ещё не истёк (сработал только
   *   запас) → возвращаем текущий токен: сетевой блип не должен валить шаг;
   * - токен истёк и сеть недоступна → `RemoteError('OFFLINE')` (recoverable-
   *   retry как network_error);
   * - токен истёк и refresh недействителен (AUTH) → null (RemoteProvider бросит
   *   `RemoteAuthExpiredError` — «войдите заново»).
   */
  async getToken(): Promise<string | null> {
    if (this.authType === 'api_key') {
      return this._accessToken;
    }
    if (!isTokenExpired(this._expiresAt, TOKEN_REFRESH_SKEW_MS)) {
      return this._accessToken;
    }
    if (!(this._refreshToken && this._issuer && this._clientId)) {
      // Обновлять нечем: если токен ещё формально жив (в пределах запаса) — отдаём его.
      return isTokenExpired(this._expiresAt) ? null : this._accessToken;
    }
    // Single-flight: пока refresh в полёте, все новые вызовы получают тот же
    // промис; успех/ошибка едины для всех ожидающих.
    if (this._refreshPromise) {
      return this._refreshPromise;
    }
    this._refreshPromise = this._refreshAccessToken();
    try {
      const refreshed = await this._refreshPromise;
      if (refreshed) return refreshed;
    } catch (err) {
      // Сеть упала посреди refresh: пока токен не истёк — шаг не валим.
      if (!isTokenExpired(this._expiresAt)) return this._accessToken;
      throw err;
    } finally {
      this._refreshPromise = null;
    }
    // refresh вернул null (AUTH/прочее): тот же принцип — живой токен отдаём.
    if (!isTokenExpired(this._expiresAt)) return this._accessToken;
    return null;
  }

  /**
   * Обновление access-токена по refresh-гранту с персистом credentials.
   * - сетевой сбой (`RemoteError('OFFLINE')`) — пробрасываем: это recoverable-
   *   ошибка сети, а не истёкшая сессия;
   * - `AUTH` (invalid_grant и т.п.) и прочие ошибки — `null` (нужен повторный вход).
   */
  private async _refreshAccessToken(): Promise<string | null> {
    const refreshToken = this._refreshToken;
    const issuer = this._issuer;
    const clientId = this._clientId;
    if (!refreshToken || !issuer || !clientId) return null;
    try {
      const refreshed = await refreshAccessToken(issuer, clientId, refreshToken);
      this._accessToken = refreshed.accessToken;
      if (refreshed.refreshToken) this._refreshToken = refreshed.refreshToken;
      this._expiresAt = refreshed.expiresIn
        ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
        : undefined;

      // Персист: обновляем сохранённые credentials, если есть (иначе после
      // рестарта сессия возьмёт протухший токен из файла). issuer/clientId
      // сохраняем всегда — без них следующий refresh недоступен.
      const existing = await loadCredentials(this.backendUrl, this._credentialsPath);
      if (existing) {
        await saveCredentials(
          {
            ...existing,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? existing.refreshToken,
            expiresAt: this._expiresAt,
            issuer: this._issuer,
            clientId: this._clientId,
          },
          this._credentialsPath,
        );
      }
      return refreshed.accessToken;
    } catch (err) {
      if (err instanceof RemoteError && err.code === 'OFFLINE') throw err;
      return null;
    }
  }

  /** Статус подключения: OFFLINE → connected:false (перехват RemoteError), иначе пробрасываем. */
  async getAuthStatus(): Promise<RemoteSessionAuthStatus> {
    try {
      const status = await this._client.getAuthStatus();
      return {
        connected: status.authenticated,
        backendUrl: this.backendUrl,
        user: status.user ?? undefined,
      };
    } catch (err) {
      if (err instanceof RemoteError && err.code === 'OFFLINE') {
        return { connected: false, backendUrl: this.backendUrl };
      }
      throw err;
    }
  }

  /** Удалить сохранённые credentials для этого backendUrl. */
  async disconnect(): Promise<void> {
    await clearCredentials(this.backendUrl, this._credentialsPath);
  }
}
