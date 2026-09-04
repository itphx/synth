// RemoteConnection — менеджер runtime-подключения к удалённому backend для гибридного режима.
//
// Отличие от RemoteSession (который при отсутствии credentials уходит в интерактивный
// device flow): сервер стартует «холодным», без подключения, а пользователь логинится
// в UI (connectByPassword, ROPC). OIDC-параметры локальный core узнаёт с самого сервера
// (GET {server}/auth/oidc-meta); для старых серверов без эндпоинта есть fallback на
// deps.defaultIssuer/defaultClientId.
//
// Никакого device flow в этом модуле нет: только логин/пароль и сохранённые credentials.

import { RemoteBackendClient } from './client.js';
import type { RemoteCredentials, RemoteUser } from './types.js';
import { RemoteError } from './types.js';
import { loadCredentials, saveCredentials, listCredentials } from './credentials.js';
import { refreshAccessToken } from './device-flow.js';
import { RemoteSession } from './session.js';
import type { RemoteSessionOptions } from './session.js';

/** Таймаут GET {server}/auth/oidc-meta по умолчанию. */
const DEFAULT_OIDC_META_TIMEOUT_MS = 15_000;

/** Обрезать завершающие слэши у адреса сервера. */
function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Токен протух, если expiresAt задан и не позже текущего момента. */
function isTokenExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return false;
  return ts <= Date.now();
}

export interface RemoteConnectionDeps {
  credentialsPath?: string;
  timeoutMs?: number;
  /** Fallback-параметры IdP, если дискавери с сервера недоступен/выключен. */
  defaultIssuer?: string;
  defaultClientId?: string;
}

export class RemoteConnection {
  readonly deps: RemoteConnectionDeps;

  private _backendUrl: string | null = null;
  private _session: RemoteSession | null = null;
  private _user: RemoteUser | null = null;
  /** Последний использованный issuer (для UI/логов). */
  private _issuer: string | null = null;

  constructor(deps: RemoteConnectionDeps) {
    this.deps = deps;
  }

  // ── Состояние ──

  /** true когда есть валидная сессия (токен получен). */
  get connected(): boolean {
    return this._session !== null;
  }

  get backendUrl(): string | null {
    return this._backendUrl;
  }

  get client(): RemoteBackendClient | null {
    return this._session?.getClient() ?? null;
  }

  get getToken(): (() => Promise<string | null>) | null {
    return this._session ? () => this._session!.getToken() : null;
  }

  get user(): RemoteUser | null {
    return this._user;
  }

  get issuer(): string | null {
    return this._issuer;
  }

  // ── Дискавери ──

  /**
   * Спросить у сервера его OIDC issuer + public client_id (GET {server}/auth/oidc-meta).
   * - enabled:false → RemoteError('AUTH') — сервер не принимает вход по логину/паролю;
   * - эндпоинт отсутствует (404/5xx) → fallback на deps.defaultIssuer/defaultClientId,
   *   при их отсутствии — RemoteError('AUTH');
   * - сеть недоступна → fallback на deps.defaultIssuer/defaultClientId,
   *   при их отсутствии — RemoteError('OFFLINE').
   */
  async discoverOidc(serverUrl: string): Promise<{ issuer: string; clientId: string }> {
    const base = normalizeBaseUrl(serverUrl);
    const fallback =
      this.deps.defaultIssuer && this.deps.defaultClientId
        ? { issuer: this.deps.defaultIssuer, clientId: this.deps.defaultClientId }
        : null;

    let res: Response;
    try {
      res = await fetch(`${base}/auth/oidc-meta`, {
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_OIDC_META_TIMEOUT_MS),
      });
    } catch {
      if (fallback) return { ...fallback };
      throw new RemoteError(`Сервер недоступен: не удалось получить OIDC-параметры (${base})`, 'OFFLINE');
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // не-JSON тело — ошибку сформируем по статусу ниже
    }

    if (body.enabled === false) {
      throw new RemoteError('Сервер не поддерживает вход по логину/паролю', 'AUTH');
    }
    if (!res.ok) {
      // Старый сервер без эндпоинта (404) или ошибка сервера — fallback на дефолты.
      if (fallback) return { ...fallback };
      throw new RemoteError(`Сервер не отдал OIDC-параметры (HTTP ${res.status})`, 'AUTH');
    }

    const issuer = typeof body.issuer === 'string' ? body.issuer : undefined;
    const clientId = typeof body.clientId === 'string' ? body.clientId : undefined;
    if (!issuer || !clientId) {
      throw new RemoteError('Сервер вернул некорректные OIDC-параметры', 'AUTH');
    }
    return { issuer, clientId };
  }

  // ── Подключение ──

  /**
   * Полное подключение: serverUrl → discoverOidc → RemoteSession.loginWithPassword.
   * Обновляет _backendUrl/_session/_user/_issuer только после успешного входа,
   * так что наружу не уходят частичные состояния. Ошибки пароля приходят из
   * loginWithPassword как RemoteError('AUTH') и пробрасываются с русским сообщением.
   */
  async connectByPassword(serverUrl: string, username: string, password: string): Promise<RemoteUser> {
    const backendUrl = normalizeBaseUrl(serverUrl);
    const { issuer, clientId } = await this.discoverOidc(backendUrl);

    const session = await RemoteSession.loginWithPassword(
      {
        backendUrl,
        issuer,
        clientId,
        credentialsPath: this.deps.credentialsPath,
        timeoutMs: this.deps.timeoutMs,
      },
      username,
      password,
    );

    // loginWithPassword уже пробовал получить user из /auth/status; если сервер не
    // ответил — делаем ещё одну попытку. Без профиля (id/roles) RemoteUser не собрать,
    // поэтому соединение не фиксируем.
    const user = session.user ?? (await this._fetchUserBestEffort(session));
    if (!user) {
      throw new RemoteError('Удалённый сервер не ответил профилем пользователя после входа', 'AUTH');
    }

    this._backendUrl = backendUrl;
    this._session = session;
    this._user = user;
    this._issuer = issuer;
    return user;
  }

  /**
   * Подключение по API-ключу (authType='api_key', без дискавери OIDC).
   * Используется для машинного входа (`serve --token` / CLI-автоматизация):
   * никакого device flow, issuer не нужен. Сессия строится сразу, после чего
   * best-effort запрашивается серверный пользователь (GET /auth/status).
   * Если профиль не получить — подключение не фиксируется.
   */
  async connectWithApiKey(serverUrl: string, apiKey: string): Promise<RemoteUser> {
    const backendUrl = normalizeBaseUrl(serverUrl);
    if (!apiKey) {
      throw new RemoteError('Для подключения по API-ключу укажите ключ (--token)', 'AUTH');
    }

    const session = await RemoteSession.ensureAuthenticated({
      backendUrl,
      authType: 'api_key',
      apiKey,
      credentialsPath: this.deps.credentialsPath,
      timeoutMs: this.deps.timeoutMs,
    });

    const user = session.user ?? (await this._fetchUserBestEffort(session));
    if (!user) {
      throw new RemoteError('Удалённый сервер не ответил профилем пользователя после подключения', 'AUTH');
    }

    this._backendUrl = backendUrl;
    this._session = session;
    this._user = user;
    this._issuer = null;
    return user;
  }

  /**
   * Неинтерактивное подключение по сохранённым credentials (старт/авто-логин).
   * Не запускает device flow! Если credentials нет или протухли без refresh —
   * возвращает null (не бросает). Если backendUrl не передан — ищет по всем
   * сохранённым credentials (порядок файла).
   */
  async connectFromSaved(backendUrl?: string): Promise<RemoteUser | null> {
    const candidates: string[] = [];
    if (backendUrl) {
      candidates.push(normalizeBaseUrl(backendUrl));
    } else if (this._backendUrl) {
      candidates.push(this._backendUrl);
    } else {
      candidates.push(...(await listCredentials(this.deps.credentialsPath)));
    }

    for (const url of candidates) {
      const user = await this._tryConnectFromSaved(url);
      if (user) return user;
    }
    return null;
  }

  /** Полный сброс runtime-состояния (провайдер/event bridge чистит вызывающий). */
  disconnect(): void {
    this._session = null;
    this._user = null;
    this._backendUrl = null;
    this._issuer = null;
  }

  // ── Приватные помощники ──

  /** Попытка подключиться к одному backendUrl по сохранённым credentials. */
  private async _tryConnectFromSaved(backendUrl: string): Promise<RemoteUser | null> {
    let creds: RemoteCredentials | null = null;
    try {
      creds = await loadCredentials(backendUrl, this.deps.credentialsPath);
    } catch {
      return null;
    }
    if (!creds?.accessToken) return null;

    const expired = isTokenExpired(creds.expiresAt);
    let issuer: string | undefined;
    let clientId: string | undefined;

    if (expired) {
      // Протух + есть refreshToken → дискавери (или deps.default*) и refresh.
      if (!creds.refreshToken) return null;
      try {
        const meta = await this.discoverOidc(backendUrl);
        issuer = meta.issuer;
        clientId = meta.clientId;
        const refreshed = await refreshAccessToken(issuer, clientId, creds.refreshToken);
        const updated: RemoteCredentials = {
          backendUrl,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? creds.refreshToken,
          expiresAt: refreshed.expiresIn
            ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
            : undefined,
          user: creds.user,
        };
        await saveCredentials(updated, this.deps.credentialsPath);
      } catch {
        // дискавери/refresh не удались (сеть, OIDC выключен, invalid_grant) — не авто-логинимся
        return null;
      }
    } else {
      // Валидный accessToken: issuer/clientId нужны для runtime-refresh (getToken).
      // Дискавери best-effort (внутри — fallback на deps.default*); при неудаче сессия
      // всё равно строится, но авто-refresh в рантайме будет недоступен.
      try {
        const meta = await this.discoverOidc(backendUrl);
        issuer = meta.issuer;
        clientId = meta.clientId;
      } catch {
        issuer = this.deps.defaultIssuer;
        clientId = this.deps.defaultClientId;
      }
    }

    // На диске теперь валидные credentials → ensureAuthenticated выйдет на ветке
    // «сохранённый accessToken действителен» и НЕ запустит device flow.
    let session: RemoteSession;
    try {
      session = await RemoteSession.ensureAuthenticated({
        backendUrl,
        issuer,
        clientId,
        credentialsPath: this.deps.credentialsPath,
        timeoutMs: this.deps.timeoutMs,
      } satisfies RemoteSessionOptions);
    } catch {
      return null;
    }

    // Обновить _user из /auth/status (best-effort; при недоступности сервера
    // getAuthStatus сам возвращает connected:false).
    let user: RemoteUser | null = session.user ?? null;
    try {
      const status = await session.getAuthStatus();
      if (status.connected && status.user) {
        user = { id: status.user.id, username: status.user.username, roles: status.user.roles };
      }
    } catch {
      // оставляем user из credentials
    }

    this._backendUrl = backendUrl;
    this._session = session;
    this._user = user;
    this._issuer = issuer ?? null;
    return user;
  }

  /** Единичная best-effort попытка получить серверного пользователя. */
  private async _fetchUserBestEffort(session: RemoteSession): Promise<RemoteUser | null> {
    try {
      const status = await session.getClient().getAuthStatus();
      if (status.user) {
        return { id: status.user.id, username: status.user.username, roles: status.user.roles };
      }
    } catch {
      // best-effort
    }
    return null;
  }
}
