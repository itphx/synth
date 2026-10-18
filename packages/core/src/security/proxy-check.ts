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
  emptyResolvedProxyConfig,
  isSocksProxyProtocol,
  parseProxyUrl,
  redactProxyUrl,
  resolveProxyRoute,
  type ParsedProxyUrl,
  type ProxyAuthChallenge,
  type ProxyCheckResult,
  type ProxyCredentials,
  type ResolvedProxyConfig,
  type ResolvedProxyRoute,
} from '@itphx/synth-shared';
import { EgressDispatcher, type EgressTlsProfile } from './proxy-dispatcher.js';
import { getEgressProxyConfig } from './proxy-state.js';
import type { FetchLike, TlsTrust } from './tls.js';

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
 * Минимальный SOCKS5-probe (RFC 1928/1929): greeting → выбор метода →
 * (user/pass) → CONNECT `probe.invalid:443`. `authChallenge='Basic'` при
 * выборе метода 0x02 (или отказе аутентификации), иначе `none`.
 */
function socks5Probe(
  parsed: ParsedProxyUrl,
  credentials: ProxyCredentials | undefined,
  timeoutMs: number,
): Promise<ProxyCheckResult> {
  const started = Date.now();
  return new Promise<ProxyCheckResult>((resolve) => {
    let settled = false;
    let latencyMs = 0;
    let buffer = Buffer.alloc(0);
    let state: 'greeting' | 'auth' | 'connect' = 'greeting';
    const socket = netConnect({ host: parsed.hostname, port: parsed.port });

    const finish = (
      result: Pick<ProxyCheckResult, 'reachable'> & {
        latencyMs?: number;
        authChallenge?: ProxyAuthChallenge;
        error?: string;
      },
    ): void => {
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

    const sendConnect = (): void => {
      state = 'connect';
      const host = Buffer.from('probe.invalid', 'utf8');
      const packet = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
        host,
        Buffer.from([0x01, 0xbb]), // 443
      ]);
      socket.write(packet);
    };

    const processBuffer = (): void => {
      while (buffer.length >= 2) {
        if (state === 'greeting') {
          if (buffer.length < 2) return;
          const method = buffer[1]!;
          buffer = buffer.subarray(2);
          if (method === 0x00) {
            sendConnect();
            continue;
          }
          if (method === 0x02) {
            if (!credentials) {
              finish({ reachable: true, authChallenge: 'Basic' });
              return;
            }
            state = 'auth';
            const user = Buffer.from(credentials.username, 'utf8');
            const pass = Buffer.from(credentials.password, 'utf8');
            socket.write(
              Buffer.concat([
                Buffer.from([0x01, user.length]),
                user,
                Buffer.from([pass.length]),
                pass,
              ]),
            );
            continue;
          }
          // 0xFF — нет приемлемого метода (обычно требуется auth).
          finish({ reachable: true, authChallenge: 'Basic' });
          return;
        }
        if (state === 'auth') {
          if (buffer.length < 2) return;
          const status = buffer[1]!;
          buffer = buffer.subarray(2);
          if (status !== 0x00) {
            finish({ reachable: true, authChallenge: 'Basic' });
            return;
          }
          sendConnect();
          continue;
        }
        // connect: ждём минимум VER/REP/RSV/ATYP.
        if (buffer.length < 4) return;
        buffer = buffer.subarray(4);
        finish({ reachable: true, authChallenge: 'none' });
        return;
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => {
      if (latencyMs > 0) finish({ reachable: true, authChallenge: 'none' });
      else finish({ reachable: false, error: `таймаут подключения к SOCKS5 (${timeoutMs} мс)` });
    });
    socket.once('error', (err) => finish({ reachable: false, error: err.message }));
    socket.once('connect', () => {
      latencyMs = Math.max(0, Date.now() - started);
      const methods = credentials ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      processBuffer();
    });
    socket.once('close', () => {
      if (!settled) finish({ reachable: latencyMs > 0, authChallenge: 'none' });
    });
  });
}

/**
 * Проверяет доступность прокси (только коннект к нему).
 *
 * - TCP-connect — базовый критерий `reachable`;
 * - `http://` — TCP + `CONNECT probe.invalid:443` (`407` → `authChallenge`);
 * - `https://` — TLS-хендшейк с `proxy.tls` (CA/mTLS), затем CONNECT-проба;
 * - `socks5://`/`socks5h://` — greeting/methods → user/pass → CONNECT.
 *
 * Секреты в URL поддерживаются для Basic/SOCKS user/pass, наружу не отдаются.
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
  if (isSocksProxyProtocol(parsed.protocol)) {
    return socks5Probe(parsed, credentials, timeoutMs);
  }
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

/** Маршрут проверки target-URL (без секретов: proxyUrl redacted). */
export interface ProxyTargetRouteInfo {
  action: 'proxy' | 'direct';
  /** Фактический путь проверки (`proxy` — через прокси, `direct` — напрямую). */
  via: 'proxy' | 'direct';
  /** `disabled` | `no-proxy` | `rule` | `default` | `no-match` | `no-default`. */
  reason: string;
  ruleId?: string;
  ruleLabel?: string;
  profile?: string;
  profileLabel?: string;
  /** URL прокси без userinfo. */
  proxyUrl?: string;
}

/** Результат проверки **target URL** (диагностика egress-маршрута). */
export interface ProxyTargetCheckResult {
  url: string;
  route: ProxyTargetRouteInfo;
  /** `true` — транспорт получил HTTP-ответ (любой статус). */
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  authChallenge: ProxyAuthChallenge;
  error?: string;
}

export interface ProxyTargetCheckOptions {
  /** Target http(s) URL; userinfo запрещён. */
  url: string;
  /** Сохранённая конфигурация прокси (маршрут/профили/правила). */
  config?: ResolvedProxyConfig | null;
  /** Доверие TLS к цели (CA/mTLS-профили). */
  tls?: TlsTrust;
  timeoutMs?: number;
  /** Тестовый транспорт (иначе глобальный `fetch` + явный dispatcher). */
  fetchImpl?: FetchLike;
}

/** Таймаут проверки по умолчанию (если в конфигурации прокси не задан). */
const DEFAULT_TARGET_CHECK_TIMEOUT_MS = 10_000;

/** Разобранный target-URL либо внятная ошибка (без эха userinfo). */
function parseTargetUrl(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'url: некорректный URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `url: схема "${url.protocol.replace(/:$/, '')}" не поддерживается (http/https)` };
  }
  if (url.username !== '' || url.password !== '') {
    return { error: 'url: userinfo (логин/пароль) в URL не допускается' };
  }
  return { url };
}

/** Redacted-описание маршрута для ответа API (без секретов). */
function describeTargetRoute(
  config: ResolvedProxyConfig | null | undefined,
  route: ResolvedProxyRoute,
): ProxyTargetRouteInfo {
  const info: ProxyTargetRouteInfo = {
    action: route.action,
    via: route.action,
    reason: route.reason,
  };
  if (route.rule !== undefined) {
    info.ruleId = route.rule.id;
    if (route.rule.label !== undefined) info.ruleLabel = route.rule.label;
  }
  if (route.profile !== undefined) {
    info.profile = route.profile;
    const label = config?.profiles?.[route.profile]?.label;
    if (label !== undefined && label !== '') info.profileLabel = label;
  }
  if (route.proxyUrl !== undefined) {
    const proxyUrl = redactProxyUrl(route.proxyUrl);
    if (proxyUrl) info.proxyUrl = proxyUrl;
  }
  return info;
}

/** `code` из цепочки ошибок транспорта (undici оборачивает причины). */
function errorCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Текст ошибки без секретов: код + сообщение (прокси-URL уже без userinfo). */
function describeCheckError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCodeOf(error);
  return code !== undefined && !message.startsWith(`${code}:`) ? `${code}: ${message}` : message;
}

/** `true` — ошибка транспорта (или её `cause`) означает ответ прокси `407`. */
function isAuthChallengeFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (code === 'EGRESS_PROXY_AUTH_REQUIRED' || code === 'EGRESS_PROXY_AUTH_FAILED') return true;
    const message = current instanceof Error ? current.message : String(current);
    if (/Proxy Authentication Required \(407\)|Proxy response \(407\)|\(407\)/i.test(message)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Схема аутентификации из ошибки 407: `Proxy-Authenticate` в ошибке undici не
 * сохраняется (CONNECT-ветка отдаёт только статус), поэтому распознаём явные
 * упоминания и иначе считаем `Basic` (HTTP-прокси с кред-схемой).
 */
function authChallengeOfError(error: unknown): ProxyAuthChallenge {
  let text = '';
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    text += ` ${current instanceof Error ? current.message : String(current)}`;
    current = (current as { cause?: unknown }).cause;
  }
  if (/ntlm/i.test(text)) return 'NTLM';
  if (/negotiate|kerberos/i.test(text)) return 'Negotiate';
  return 'Basic';
}

/** URL для отчёта: без userinfo (секрет не эхоится даже при ошибке валидации). */
function displayTargetUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return '';
  }
}

/** TLS-опции dispatcher'а из доверия к цели (без профилей). */
function dispatcherTls(tls: TlsTrust | undefined): {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized: boolean;
} {
  return {
    ...(tls?.ca !== undefined ? { ca: tls.ca } : {}),
    ...(tls?.cert !== undefined ? { cert: tls.cert } : {}),
    ...(tls?.key !== undefined ? { key: tls.key } : {}),
    rejectUnauthorized: tls?.rejectUnauthorized ?? true,
  };
}

/** Per-host TLS-профили цели в формате dispatcher'а. */
function dispatcherTlsProfiles(tls: TlsTrust | undefined): EgressTlsProfile[] {
  return (tls?.profiles ?? []).map((profile) => ({
    id: profile.id,
    hosts: [...profile.hosts],
    tls: {
      ...(profile.ca !== undefined ? { ca: profile.ca } : {}),
      ...(profile.cert !== undefined ? { cert: profile.cert } : {}),
      ...(profile.key !== undefined ? { key: profile.key } : {}),
      rejectUnauthorized: profile.rejectUnauthorized,
    },
  }));
}

/**
 * Проверка **target URL** (ADR-099; `POST /api/v2/settings/proxy`-диагностика):
 * строит маршрут через `resolveProxyRoute` (disabled/noProxy/правила/default),
 * выполняет `HEAD` без тела и без кред к цели, `redirect:'manual'`.
 *
 * - `ok: true` — транспорт получил любой HTTP-ответ (в т.ч. 4xx/5xx);
 * - `ok: false` — DNS/TLS/прокси/аутентификация/таймаут (понятный `error`);
 * - `407` — `ok:false`, `authChallenge` из ошибки (`Basic`/`NTLM`/`Negotiate`);
 * - egress-политика сюда **не входит** — её проверяет вызывающий API до вызова.
 *
 * Dispatcher создаётся явно (не берётся глобальный), поэтому проверка не
 * зависит от живого прокси-маршрута процесса; закрывается в `finally`.
 */
export async function checkProxyTarget(
  options: ProxyTargetCheckOptions,
): Promise<ProxyTargetCheckResult> {
  const started = Date.now();
  const parsed = parseTargetUrl(options.url);
  if ('error' in parsed) {
    return {
      url: displayTargetUrl(options.url),
      route: { action: 'direct', via: 'direct', reason: 'no-match' },
      ok: false,
      latencyMs: Math.max(0, Date.now() - started),
      authChallenge: 'none',
      error: parsed.error,
    };
  }

  const { url } = parsed;
  const config = options.config ?? null;
  const route = resolveProxyRoute(config, url);
  const routeInfo = describeTargetRoute(config, route);
  const timeoutMs = options.timeoutMs ?? config?.connectTimeoutMs ?? DEFAULT_TARGET_CHECK_TIMEOUT_MS;

  // Прямой маршрут — dispatcher с пустым прокси (изоляция от глобального
  // dispatcher'а процесса); прокси-маршрут — сохранённая конфигурация.
  const dispatcher = new EgressDispatcher({
    proxy: route.action === 'proxy' && config ? config : emptyResolvedProxyConfig(),
    tls: dispatcherTls(options.tls),
    tlsProfiles: dispatcherTlsProfiles(options.tls),
  });

  const init = {
    method: 'HEAD',
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher,
  } as unknown as RequestInit;

  const impl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  try {
    const response = await impl(url.href, init);
    // Тело HEAD не нужно; освобождаем сокет (best-effort).
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 407) {
      const challenge = parseAuthChallenge(
        response.headers.get('proxy-authenticate') ?? undefined,
      );
      return {
        url: url.href,
        route: routeInfo,
        ok: false,
        httpStatus: 407,
        latencyMs: Math.max(0, Date.now() - started),
        authChallenge: challenge === 'none' ? 'Basic' : challenge,
        error:
          `Прокси ${routeInfo.proxyUrl ?? '(не задан)'} требует аутентификации (407)` +
          (challenge === 'none' ? '' : `: ${challenge}`),
      };
    }
    return {
      url: url.href,
      route: routeInfo,
      ok: true,
      httpStatus: response.status,
      latencyMs: Math.max(0, Date.now() - started),
      authChallenge: 'none',
    };
  } catch (error) {
    const timeout =
      (error as { name?: string } | null)?.name === 'TimeoutError' ||
      (error as { name?: string } | null)?.name === 'AbortError' ||
      errorCodeOf(error) === 'UND_ERR_ABORTED';
    const authFailure = isAuthChallengeFailure(error);
    const message = timeout
      ? `таймаут проверки (${timeoutMs} мс)`
      : authFailure
        ? `Прокси ${routeInfo.proxyUrl ?? '(не задан)'} требует аутентификации (407)`
        : describeCheckError(error);
    return {
      url: url.href,
      route: routeInfo,
      ok: false,
      latencyMs: Math.max(0, Date.now() - started),
      authChallenge: authFailure ? authChallengeOfError(error) : 'none',
      error: message,
    };
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

/** Безопасное представление проверяемого прокси (для логов/диагностики). */
export function describeProxyTarget(raw: string | undefined): string {
  return redactProxyUrl(raw);
}
