/**
 * AD-046 §4.2/AD-069 §5.1: общие сетевые хелперы Synth — SSRF-guard и
 * безопасная загрузка текста по URL.
 *
 * Модуль не знает о скиллах/инструкциях: только протокол http/https, запрет
 * loopback/private/link-local/ULA, ручное следование редиректам (каждый хоп
 * проходит повторную SSRF-проверку), таймаут и лимит байт. Переиспользуется
 * `engine/skills/remote.ts` и `engine/context/instructions.ts` — сетевой код
 * не дублируется.
 */

import { isIP } from 'node:net';
import { hostFromUrl, ipv6ToBigInt, isIpInCidr } from '../mcp/network-policy.js';

/** Подменяемая реализация `fetch` (тесты). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Запрещённые IPv4-диапазоны (SSRF): loopback/private/link-local/CGNAT/спец.
 * `0.0.0.0/8` и `100.64.0.0/10` — усиление (не указаны явно в AD-046).
 */
const BLOCKED_V4_CIDRS: readonly string[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
];

/** Запрещённые IPv6-диапазоны: unspecified, loopback, ULA, link-local, multicast. */
const BLOCKED_V6_CIDRS: readonly string[] = [
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
];

/** Ошибка таймаута сетевой операции. */
export class RemoteTimeoutError extends Error {
  constructor(ms: number) {
    super(`таймаут ${ms} мс`);
    this.name = 'RemoteTimeoutError';
  }
}

/** `true`, если IP-литерал входит в приватный/локальный диапазон. */
export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return BLOCKED_V4_CIDRS.some((cidr) => isIpInCidr(ip, cidr));
  }
  if (version === 6) {
    const value = ipv6ToBigInt(ip);
    if (value === null) return true; // не парсится — fail-closed
    // IPv4-mapped (::ffff:a.b.c.d) — проверяем вложенный IPv4.
    const high = value >> 32n;
    if (high === 0xffffn) {
      const low = value & 0xffffffffn;
      const dotted = `${(low >> 24n) & 0xffn}.${(low >> 16n) & 0xffn}.${(low >> 8n) & 0xffn}.${low & 0xffn}`;
      return isBlockedIp(dotted);
    }
    return BLOCKED_V6_CIDRS.some((cidr) => isIpInCidr(ip, cidr));
  }
  return false;
}

/** `true`, если hostname запрещён: `localhost`/`*.localhost`/`*.local`/приватный IP. */
export function isBlockedHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0) return isBlockedIp(bare);
  return false;
}

/** Валидация URL удалённого источника (protocol + SSRF-host). */
export function validateRemoteUrl(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `некорректный URL: ${raw}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `протокол ${url.protocol || '(пустой)'} не поддерживается (только http/https): ${raw}` };
  }
  const host = hostFromUrl(url.toString());
  if (!host) return { error: `не удалось выделить хост: ${raw}` };
  if (isBlockedHost(host)) {
    return { error: `хост "${host}" запрещён (loopback/private/link-local/local): ${raw}` };
  }
  return { url };
}

/** Человекочитаемое описание ошибки. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new RemoteTimeoutError(timeoutMs));
    }, timeoutMs);

    fetchImpl(url, { ...init, signal: controller.signal }).then(
      (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface FetchTextOptions {
  timeoutMs: number;
  maxBytes: number;
  maxHops: number;
  fetchImpl: FetchLike;
}

/**
 * Скачивает текст по URL с таймаутом/лимитом байт и ручным следованием
 * редиректам (каждый хоп проходит `validateRemoteUrl` — SSRF-проверка на каждом
 * шаге, а не только на исходном URL).
 */
export async function fetchText(
  rawUrl: string,
  opts: FetchTextOptions,
): Promise<{ text: string } | { error: string }> {
  let current = rawUrl;
  for (let hop = 0; hop <= opts.maxHops; hop++) {
    const valid = validateRemoteUrl(current);
    if ('error' in valid) return { error: valid.error };

    let res: Response;
    try {
      res = await fetchWithTimeout(
        valid.url.toString(),
        { redirect: 'manual' },
        opts.fetchImpl,
        opts.timeoutMs,
      );
    } catch (err) {
      return { error: `сетевая ошибка: ${describeError(err)}` };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return { error: `редирект без Location (HTTP ${res.status})` };
      try {
        current = new URL(location, valid.url).toString();
      } catch {
        return { error: `некорректный Location: ${location}` };
      }
      continue;
    }

    if (!res.ok) return { error: `HTTP ${res.status}` };

    const declared = res.headers.get('content-length');
    if (declared && Number(declared) > opts.maxBytes) {
      return { error: `превышен лимит ${opts.maxBytes} байт` };
    }

    let buffer: ArrayBuffer;
    try {
      buffer = await res.arrayBuffer();
    } catch (err) {
      return { error: `ошибка чтения тела: ${describeError(err)}` };
    }
    if (buffer.byteLength > opts.maxBytes) {
      return { error: `превышен лимит ${opts.maxBytes} байт` };
    }
    return { text: new TextDecoder().decode(buffer) };
  }
  return { error: `превышено число редиректов (${opts.maxHops})` };
}
