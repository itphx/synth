// OIDC Device Flow (RFC 8628) клиент для гибридного режима.
// Пользователь авторизуется на внешнем устройстве: мы получаем user_code + verification_uri,
// показываем их в CLI, после подтверждения — обмениваем device_code на токен.

import { RemoteError } from './types.js';

/** Таймаут HTTP-запросов к серверу авторизации. */
const AUTH_HTTP_TIMEOUT_MS = 15_000;
/** Общий таймаут ожидания подтверждения пользователем. */
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000;
/** Дополнительная задержка при slow_down (RFC 8628 §3.5). */
const SLOW_DOWN_EXTRA_MS = 5_000;

export interface DeviceFlowDiscovery {
  token_endpoint: string;
  device_authorization_endpoint: string;
  issuer: string;
}

export interface DeviceFlowSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
  tokenEndpoint: string;
  /** client_id из startDeviceFlow — обязателен в token-запросе (RFC 8628 §3.4). */
  clientId: string;
}

export interface DeviceTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

export interface RefreshTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value !== '') return Number(value);
  return undefined;
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(AUTH_HTTP_TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RemoteError(`Сервер авторизации недоступен: ${reason}`, 'AUTH');
  }
  if (!res.ok) {
    throw new RemoteError(`Не удалось получить конфигурацию OIDC-провайдера (HTTP ${res.status})`, 'AUTH');
  }
  return (await res.json()) as Record<string, unknown>;
}

async function postForm(url: string, params: URLSearchParams): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(AUTH_HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RemoteError(`Сервер авторизации недоступен: ${reason}`, 'AUTH');
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // пустое/не-JSON тело — оставляем {}, ошибку сформируем по статусу
  }
  if (!res.ok && !body.error) {
    throw new RemoteError(`Сервер авторизации вернул ошибку (HTTP ${res.status})`, 'AUTH');
  }
  return body;
}

/**
 * Получить конфигурацию OIDC-провайдера: GET {issuer}/.well-known/openid-configuration.
 * Возвращает только endpoint-ы, нужные для device flow.
 */
export async function discover(issuer: string): Promise<DeviceFlowDiscovery> {
  const base = issuer.replace(/\/$/, '');
  const data = await getJson(`${base}/.well-known/openid-configuration`);
  const tokenEndpoint = str(data.token_endpoint);
  const deviceEndpoint = str(data.device_authorization_endpoint);
  if (!tokenEndpoint || !deviceEndpoint) {
    throw new RemoteError('OIDC-провайдер не поддерживает device flow (нет token_endpoint или device_authorization_endpoint)', 'AUTH');
  }
  return {
    token_endpoint: tokenEndpoint,
    device_authorization_endpoint: deviceEndpoint,
    issuer: base,
  };
}

/**
 * Начать device flow: запросить device_code/user_code у сервера авторизации.
 * Возвращает сессию, по которой нужно показать пользователю user_code и verification_uri.
 */
export async function startDeviceFlow(issuer: string, clientId: string): Promise<DeviceFlowSession> {
  const disc = await discover(issuer);
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'openid profile',
  });
  const body = await postForm(disc.device_authorization_endpoint, params);
  const deviceCode = str(body.device_code);
  const userCode = str(body.user_code);
  const verificationUri = str(body.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new RemoteError('Сервер авторизации вернул некорректный ответ (нет device_code/user_code/verification_uri)', 'AUTH');
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: str(body.verification_uri_complete),
    expiresIn: num(body.expires_in) ?? 0,
    interval: num(body.interval) ?? 5,
    tokenEndpoint: disc.token_endpoint,
    clientId,
  };
}

/**
 * Опрашивать token_endpoint, пока пользователь не подтвердит авторизацию.
 * - authorization_pending → ждём interval и продолжаем;
 * - slow_down → добавляем 5 секунд к ожиданию;
 * - expired_token / access_denied → RemoteError('AUTH') с понятным сообщением.
 * onPoll вызывается перед каждой попыткой (начиная с 1).
 */
export async function pollDeviceToken(
  session: DeviceFlowSession,
  onPoll?: (attempt: number) => void,
  timeoutMs: number = DEFAULT_POLL_TIMEOUT_MS,
): Promise<DeviceTokenResult> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    if (Date.now() > deadline) {
      throw new RemoteError('Истёк таймаут ожидания авторизации. Запустите авторизацию заново.', 'AUTH');
    }
    if (attempt > 1) {
      await sleep(session.interval * 1000);
    }
    onPoll?.(attempt);

    const params = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: session.deviceCode,
      client_id: session.clientId,
    });
    const body = await postForm(session.tokenEndpoint, params);

    const accessToken = str(body.access_token);
    if (accessToken) {
      return {
        accessToken,
        refreshToken: str(body.refresh_token),
        expiresIn: num(body.expires_in),
      };
    }

    const err = str(body.error);
    switch (err) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        await sleep(SLOW_DOWN_EXTRA_MS);
        continue;
      case 'expired_token':
        throw new RemoteError('Срок действия кода устройства истёк. Запустите авторизацию заново.', 'AUTH');
      case 'access_denied':
        throw new RemoteError('Доступ отклонён пользователем.', 'AUTH');
      default:
        throw new RemoteError(`Сервер авторизации вернул ошибку: ${err ?? 'неизвестная'}`, 'AUTH');
    }
  }
}

/**
 * Обновить access token по refresh token (grant_type=refresh_token, RFC 6749 §6).
 * Ошибки (в т.ч. invalid_grant) → RemoteError('AUTH') с понятным сообщением.
 */
export async function refreshAccessToken(
  issuer: string,
  clientId: string,
  refreshToken: string,
): Promise<RefreshTokenResult> {
  const disc = await discover(issuer);
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const body = await postForm(disc.token_endpoint, params);

  const accessToken = str(body.access_token);
  if (!accessToken) {
    const err = str(body.error);
    const detail = err === 'invalid_grant'
      ? 'refresh token недействителен или истёк'
      : (err ?? 'неизвестная ошибка');
    throw new RemoteError(`Не удалось обновить токен: ${detail}`, 'AUTH');
  }
  return {
    accessToken,
    refreshToken: str(body.refresh_token),
    expiresIn: num(body.expires_in),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
