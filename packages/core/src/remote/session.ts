// Фасад жизненного цикла подключения к удалённому backend (гибридный режим).
// ensureAuthenticated проходит путь: api_key → сохранённые credentials → refresh → device flow.
//
// Поток device flow (RFC 8628):
//   discover → startDeviceFlow → onDeviceCode (печать URL+кода) → pollDeviceToken → сохранить credentials.

import { RemoteBackendClient } from './client.js';
import { loadCredentials, saveCredentials, clearCredentials } from './credentials.js';
import { startDeviceFlow, pollDeviceToken, refreshAccessToken } from './device-flow.js';
import { RemoteError } from './types.js';
import type { RemoteAuthType, RemoteCredentials, RemoteUser } from './types.js';

export interface RemoteSessionOptions {
  backendUrl: string;
  authType?: 'device' | 'api_key';
  apiKey?: string;
  issuer?: string;
  clientId?: string;
  credentialsPath?: string;
  timeoutMs?: number;
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

  private _accessToken: string;
  private _refreshToken?: string;
  private _expiresAt?: string;
  private readonly _issuer?: string;
  private readonly _clientId?: string;
  private readonly _client: RemoteBackendClient;
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
  ) {
    this.backendUrl = backendUrl;
    this.authType = authType;
    this._accessToken = accessToken;
    this._refreshToken = refreshToken;
    this._expiresAt = expiresAt;
    this._issuer = issuer;
    this._clientId = clientId;
    this._credentialsPath = credentialsPath;
    this._client = new RemoteBackendClient({
      backendUrl,
      // Клиент тоже ходит через session.getToken(): протухший accessToken
      // автоматически обновляется в рантайме (а не уходит на backend как есть).
      getToken: () => this.getToken(),
      timeoutMs,
    });
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

    if (authType === 'api_key') {
      if (!opts.apiKey) {
        throw new RemoteError(
          'Для remote.auth.type=api_key укажите API-ключ (флаг --token или remote.auth.apiKey в config.yaml)',
          'AUTH',
        );
      }
      return new RemoteSession(backendUrl, authType, opts.apiKey, credentialsPath, opts.timeoutMs);
    }

    const existing = await loadCredentials(backendUrl, credentialsPath);

    // Сохранённый accessToken действителен — используем как есть.
    if (existing?.accessToken && !isTokenExpired(existing.expiresAt)) {
      return new RemoteSession(
        backendUrl, authType, existing.accessToken, credentialsPath, opts.timeoutMs,
        existing.refreshToken, existing.expiresAt, opts.issuer, opts.clientId,
      );
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
        return new RemoteSession(
          backendUrl, authType, updated.accessToken, credentialsPath, opts.timeoutMs,
          updated.refreshToken, updated.expiresAt, opts.issuer, opts.clientId,
        );
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
    return new RemoteSession(
      backendUrl, authType, creds.accessToken, credentialsPath, opts.timeoutMs,
      creds.refreshToken, creds.expiresAt, opts.issuer, opts.clientId,
    );
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
