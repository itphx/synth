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
import { connect } from 'node:net';
import {
  ProxyConfigError,
  parseProxyUrl,
  redactProxyUrl,
  type ProxyAuthChallenge,
  type ProxyCheckResult,
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

/** URL прокси по умолчанию для пробы: `httpsProxy` → `allProxy` → `url` → `httpProxy`. */
function defaultProxyUrl(config: ResolvedProxyConfig | null): string | undefined {
  if (!config?.enabled) return undefined;
  return config.httpsProxy ?? config.allProxy ?? config.url ?? config.httpProxy;
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
  const raw = options.url ?? defaultProxyUrl(config);
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

  const timeoutMs = options.timeoutMs ?? config?.connectTimeoutMs ?? 10_000;
  const started = Date.now();

  return new Promise<ProxyCheckResult>((resolve) => {
    let settled = false;
    let latencyMs = 0;
    let buffer = '';
    const socket = connect({ host: parsed.hostname, port: parsed.port });

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
      // TCP уже установлен — прокси доступен (HTTP-проба не ответила вовремя).
      if (latencyMs > 0) finish({ reachable: true, authChallenge: 'none' });
      else finish({ reachable: false, error: `таймаут подключения к прокси (${timeoutMs} мс)` });
    });
    socket.once('error', (err) => {
      finish({ reachable: false, error: err.message });
    });
    socket.once('connect', () => {
      latencyMs = Math.max(0, Date.now() - started);
      if (parsed.protocol !== 'http:') {
        finish({ reachable: true, latencyMs, authChallenge: 'none' });
        return;
      }
      // HTTP-CONNECT-проба: 407 несёт Proxy-Authenticate, остальное — «нет вызова».
      socket.write(
        `CONNECT ${PROBE_TARGET} HTTP/1.1\r\nHost: ${PROBE_TARGET}\r\nConnection: close\r\n\r\n`,
      );
    });
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
