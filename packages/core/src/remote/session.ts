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

function isTokenExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return false;
  return ts <= Date.now();
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
   * 2. Сохранённый accessToken ещё действителен → используем.
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

    // Сохранённый accessToken действителен — используем как есть.
    if (existing?.accessToken && !isTokenExpired(existing.expiresAt)) {
      return finish(new RemoteSession(
        backendUrl, authType, existing.accessToken, credentialsPath, opts.timeoutMs,
        existing.refreshToken, existing.expiresAt, opts.issuer, opts.clientId,
        existing.user,
      ));
    }

    // Просрочен, но есть refreshToken — пробуем обновить.
    if (existing?.refreshToken) {
      if (!opts.issuer || !opts.clientId) {
        throw new RemoteError(
          'Не заданы remote.auth.issuer/clientId — укажите их в config.yaml или флагами --oidc-issuer/--oidc-client-id',
          'AUTH',
        );
      }
      try {
        const refreshed = await refreshAccessToken(opts.issuer, opts.clientId, existing.refreshToken);
        const updated: RemoteCredentials = {
          backendUrl,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? existing.refreshToken,
          expiresAt: refreshed.expiresIn
            ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
            : undefined,
          user: existing.user,
        };
        await saveCredentials(updated, credentialsPath);
        return finish(new RemoteSession(
          backendUrl, authType, updated.accessToken, credentialsPath, opts.timeoutMs,
          updated.refreshToken, updated.expiresAt, opts.issuer, opts.clientId,
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
    if (!opts.issuer || !opts.clientId) {
      throw new RemoteError(
        'Не заданы remote.auth.issuer/clientId — укажите их в config.yaml или флагами --oidc-issuer/--oidc-client-id',
        'AUTH',
      );
    }

    const deviceSession = await startDeviceFlow(opts.issuer, opts.clientId);
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
      // id_token не парсим на этом этапе — user оставляем пустым.
    };
    await saveCredentials(creds, credentialsPath);
    return finish(new RemoteSession(
      backendUrl, authType, creds.accessToken, credentialsPath, opts.timeoutMs,
      creds.refreshToken, creds.expiresAt, opts.issuer, opts.clientId,
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
   * - accessToken действителен → как есть;
   * - протух + refreshToken + issuer/clientId → refreshAccessToken, пересохранение credentials;
   * - протух без refresh → null (RemoteProvider бросит ProviderError).
   */
  async getToken(): Promise<string | null> {
    if (this.authType === 'api_key') {
      return this._accessToken;
    }
    if (!isTokenExpired(this._expiresAt)) {
      return this._accessToken;
    }
    if (this._refreshToken && this._issuer && this._clientId) {
      try {
        const refreshed = await refreshAccessToken(this._issuer, this._clientId, this._refreshToken);
        this._accessToken = refreshed.accessToken;
        if (refreshed.refreshToken) this._refreshToken = refreshed.refreshToken;
        this._expiresAt = refreshed.expiresIn
          ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
          : undefined;

        // Персист: обновляем сохранённые credentials, если есть (иначе после
        // рестарта сессия возьмёт протухший токен из файла).
        const existing = await loadCredentials(this.backendUrl, this._credentialsPath);
        if (existing) {
          await saveCredentials(
            {
              ...existing,
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken ?? existing.refreshToken,
              expiresAt: this._expiresAt,
            },
            this._credentialsPath,
          );
        }
        return refreshed.accessToken;
      } catch {
        // Ошибка refresh (RemoteError('AUTH') — невалидный/истёкший refresh token,
        // либо сеть недоступна) НЕ роняем поток: возвращаем null. Запрос уйдёт без
        // токена и получит 401/ошибку сети (UNAUTHORIZED/OFFLINE), а RemoteProvider
        // бросит ProviderError «токен истёк» — корректная offline-деградация.
        return null;
      }
    }
    return null;
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
