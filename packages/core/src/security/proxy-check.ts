/**
 * ADR-099 (этап D1): проверка **коннекта к прокси** (без запроса к цели).
 *
 * `POST /api/v2/settings/proxy/check` — диагностика: TCP-connect к прокси и
 * (для `http://`) HTTP-CONNECT-проба, чтобы увидеть `407`/`Proxy-Authenticate`.
 * Цель (target URL) не запрашивается: прокси-проба идёт на зарезервированный
 * `probe.invalid` и не несёт пользовательских данных.
 *
 * Auth-схемы (Basic/NTLM/Negotiate) — этап D2; здесь только распознаём вызов.
 */
import { connect as netConnect } from 'node:net';
import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { Socket } from 'node:net';
import {
  ProxyConfigError,
  defaultProxyEntry,
  parseProxyUrl,
  redactProxyUrl,
  type ProxyAuthChallenge,
  type ProxyCheckResult,
  type ProxyCredentials,
  type ResolvedProxyConfig,
} from '@itphx/synth-shared';
import { getEgressProxyConfig } from './proxy-state.js';

/** Зарезервированный TLD `.invalid` — гарантированно не резолвится. */
const PROBE_TARGET = 'probe.invalid:443';

export interface ProxyCheckOptions {
  /** Явный URL прокси (из тела запроса); иначе — активная конфигурация. */
  url?: string;
  /** Таймаут ожидания ответа прокси (по умолчанию `connectTimeoutMs`). */
  timeoutMs?: number;
  config?: ResolvedProxyConfig | null;
}

/** `Basic`-заголовок для CONNECT-пробы (только в памяти, не логируется). */
function basicAuthHeader(credentials: ProxyCredentials | undefined): string | undefined {
  if (!credentials) return undefined;
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')}`;
}

/** Разбирает `Proxy-Authenticate` в одну из поддерживаемых схем (D2 — реальная аутентификация). */
function parseAuthChallenge(header: string | undefined): ProxyAuthChallenge {
  if (!header) return 'none';
  const value = header.toLowerCase();
  if (value.includes('ntlm')) return 'NTLM';
  if (value.includes('negotiate')) return 'Negotiate';
  if (value.includes('basic')) return 'Basic';
  return 'none';
}

/**
 * Проверяет доступность прокси (только коннект к нему).
 *
 * - TCP-connect — базовый критерий `reachable`;
 * - для `http://` дополнительно шлётся `CONNECT probe.invalid:443`: `407`
 *   даёт `authChallenge` (Basic/NTLM/Negotiate), прочий ответ — `none`;
 * - `https://`-прокси: только TCP (TLS-проба — этап D2).
 *
 * Секреты в URL не поддерживаются (parseProxyUrl fail-closed), наружу не отдаются.
 */
export async function checkProxyConnectivity(
  options: ProxyCheckOptions = {},
): Promise<ProxyCheckResult> {
  const config = options.config !== undefined ? options.config : getEgressProxyConfig();

  // Явный URL из тела: креды — только из его userinfo (не подставляем пароль
  // инстанса к произвольному адресу). Иначе — активный прокси с его кредами.
  let raw: string | undefined;
  let credentials: ProxyCredentials | undefined;
  if (options.url !== undefined) {
    raw = options.url;
  } else {
    const entry = config ? defaultProxyEntry(config) : undefined;
    raw = entry?.url;
    credentials = entry?.credentials;
  }
  if (!raw) {
    return { reachable: false, latencyMs: 0, error: 'прокси не настроен', authChallenge: 'none' };
  }

  let parsed;
  try {
    parsed = parseProxyUrl(raw);
  } catch (err) {
    const message = err instanceof ProxyConfigError ? err.message : String(err);
    return { reachable: false, latencyMs: 0, error: message, authChallenge: 'none' };
  }
  if (options.url !== undefined) {
    if (parsed.username !== undefined && parsed.password === undefined) {
      return {
        reachable: false,
        latencyMs: 0,
        error: 'для прокси в URL задан пользователь без пароля',
        authChallenge: 'none',
      };
    }
    if (parsed.username !== undefined && parsed.password !== undefined) {
      credentials = { username: parsed.username, password: parsed.password };
    }
  }

  const timeoutMs = options.timeoutMs ?? config?.connectTimeoutMs ?? 10_000;
  const proxyTls = config?.tls ?? { rejectUnauthorized: true };
  const started = Date.now();

  return new Promise<ProxyCheckResult>((resolve) => {
    let settled = false;
    let latencyMs = 0;
    let buffer = '';

    // https-прокси: TLS-хендшейк с `proxy.tls` (CA/mTLS к прокси), затем CONNECT.
    const socket: Socket =
      parsed.protocol === 'https:'
        ? tlsConnect({
            host: parsed.hostname,
            port: parsed.port,
            servername: isIP(parsed.hostname) === 0 ? parsed.hostname : undefined,
            ca: proxyTls.ca,
            cert: proxyTls.cert,
            key: proxyTls.key,
            rejectUnauthorized: proxyTls.rejectUnauthorized,
          })
        : netConnect({ host: parsed.hostname, port: parsed.port });

    const finish = (result: Omit<ProxyCheckResult, 'latencyMs' | 'authChallenge'> & {
      latencyMs?: number;
      authChallenge?: ProxyAuthChallenge;
    }): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        reachable: result.reachable,
        latencyMs: result.latencyMs ?? latencyMs,
        authChallenge: result.authChallenge ?? 'none',
        ...(result.error ? { error: result.error } : {}),
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => {
      // Соединение/хендшейк уже состоялись — прокси доступен (ответа нет).
      if (latencyMs > 0) finish({ reachable: true, authChallenge: 'none' });
      else finish({ reachable: false, error: `таймаут подключения к прокси (${timeoutMs} мс)` });
    });
    socket.once('error', (err) => {
      // Ошибки TLS/сети — без кред в сообщении (их там и нет).
      finish({
        reachable: false,
        error: (err as NodeJS.ErrnoException).code
          ? `${(err as NodeJS.ErrnoException).code}: ${err.message}`
          : err.message,
      });
    });

    const onConnected = (): void => {
      latencyMs = Math.max(0, Date.now() - started);
      // CONNECT-проба: 407 несёт Proxy-Authenticate; цель probe.invalid не резолвится.
      const auth = basicAuthHeader(credentials);
      socket.write(
        `CONNECT ${PROBE_TARGET} HTTP/1.1\r\nHost: ${PROBE_TARGET}\r\n` +
          `${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}Connection: close\r\n\r\n`,
      );
    };
    if (parsed.protocol === 'https:') {
      socket.once('secureConnect', onConnected);
    } else {
      socket.once('connect', onConnected);
    }

    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0 && buffer.length < 16_384) return;
      const head = buffer.slice(0, headerEnd >= 0 ? headerEnd : buffer.length);
      const status = /^HTTP\/1\.[01]\s+(\d{3})/i.exec(head);
      const challenge = /^Proxy-Authenticate:\s*(.+)$/im.exec(head)?.[1];
      if (status?.[1] === '407') {
        finish({ reachable: true, authChallenge: parseAuthChallenge(challenge) });
        return;
      }
      finish({ reachable: true, authChallenge: 'none' });
    });
    socket.once('close', () => {
      if (!settled) finish({ reachable: latencyMs > 0, authChallenge: 'none' });
    });
  });
}

/** Безопасное представление проверяемого прокси (для логов/диагностики). */
export function describeProxyTarget(raw: string | undefined): string {
  return redactProxyUrl(raw);
}
