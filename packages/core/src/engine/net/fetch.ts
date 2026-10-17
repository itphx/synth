/**
 * ADR-046 §4.2/ADR-069 §5.1: общие сетевые хелперы Synth — SSRF-guard и
 * безопасная загрузка текста по URL.
 *
 * Модуль не знает о скиллах/инструкциях: только протокол http/https, запрет
 * loopback/private/link-local/ULA, ручное следование редиректам (каждый хоп
 * проходит повторную SSRF-проверку), таймаут и лимит байт. Переиспользуется
 * `engine/skills/remote.ts` и `engine/context/instructions.ts` — сетевой код
 * не дублируется.
 *
 * Единая реализация проверки — `engine/net/egress-guard.ts` (PROP-100):
 * схема + DNS-резолв **всех** A/AAAA + политика приватных диапазонов
 * (`checkEgressUrl`), редиректы — `fetchWithEgressGuard`. Здесь — только
 * удобные обёртки (`validateRemoteUrl`/`fetchText`) и таймаут/лимит байт.
 */

import { checkEgressUrl, fetchWithEgressGuard, EgressBlockedError } from './egress-guard.js';
import type { FetchLike } from './egress-guard.js';
import type { HostResolver } from '../mcp/network-policy.js';
import type { EgressPolicy, EgressRequestScope } from '@itphx/synth-shared';
import { resolveToolsEgressPolicy, currentEgressLog } from './egress-runtime.js';

// Обратная совместимость: SSRF-примитивы и тип транспорта жили здесь.
export { isBlockedHost, isBlockedIp } from './egress-guard.js';
export type { FetchLike } from './egress-guard.js';

/** Ошибка таймаута сетевой операции. */
export class RemoteTimeoutError extends Error {
  constructor(ms: number) {
    super(`таймаут ${ms} мс`);
    this.name = 'RemoteTimeoutError';
  }
}

export interface ValidateRemoteUrlOptions {
  /** Инъекция DNS-резолвера (тесты). */
  resolveHost?: HostResolver;
  /** Resolved-политика; не задана — живой резолвер (settings → config → дефолт). */
  policy?: EgressPolicy;
}

/**
 * Валидация URL удалённого источника: protocol + SSRF (исключения и **DNS-резолв
 * всех A/AAAA**). Ошибка/пустой резолв → `{ error }` (fail-closed).
 */
export async function validateRemoteUrl(
  raw: string,
  options: ValidateRemoteUrlOptions = {},
): Promise<{ url: URL } | { error: string }> {
  const policy = options.policy ?? await resolveToolsEgressPolicy();
  const check = await checkEgressUrl(raw, policy, { resolveHost: options.resolveHost });
  return check.allowed ? { url: check.url } : { error: check.reason };
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
  /** Инъекция DNS-резолвера SSRF-проверки (тесты). */
  resolveHost?: HostResolver;
  /** Resolved-политика; не задана — живой резолвер (settings → config → дефолт). */
  policy?: EgressPolicy;
  /** Источник запроса для журнала egress. */
  scope?: EgressRequestScope;
  sessionId?: string;
  projectId?: string;
  actor?: string;
}

/**
 * Скачивает текст по URL с таймаутом/лимитом байт и ручным следованием
 * редиректам. Каждый хоп проходит `checkEgressUrl` (SSRF-проверка с DNS-резолвом
 * на каждом шаге; `fetchWithEgressGuard`) — на исходном URL проверка не
 * останавливается.
 */
export async function fetchText(
  rawUrl: string,
  opts: FetchTextOptions,
): Promise<{ text: string } | { error: string }> {
  const policy = opts.policy ?? await resolveToolsEgressPolicy();
  let res: Response;
  try {
    res = await fetchWithEgressGuard(
      rawUrl,
      { redirect: 'manual' },
      {
        policy,
        resolveHost: opts.resolveHost,
        maxHops: opts.maxHops,
        fetchImpl: (input, init) => fetchWithTimeout(input, init ?? {}, opts.fetchImpl, opts.timeoutMs),
        ...(opts.scope ? { scope: opts.scope } : {}),
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        ...(opts.actor ? { actor: opts.actor } : {}),
        log: currentEgressLog(),
      },
    );
  } catch (err) {
    if (err instanceof EgressBlockedError) return { error: err.message };
    return { error: `сетевая ошибка: ${describeError(err)}` };
  }

  if (res.status >= 300 && res.status < 400) {
    return { error: `редирект без Location (HTTP ${res.status})` };
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
