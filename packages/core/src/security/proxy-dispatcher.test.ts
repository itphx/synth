import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fetch as undiciFetch, type Dispatcher } from 'undici';
import {
  resolveProxyConfig,
  type ProxyConfig,
  type ResolvedProxyConfig,
} from '@itphx/synth-shared';
import { EgressDispatcher } from './proxy-dispatcher.js';
import { egressFetch } from './tls.js';
import { startFakeProxy, startFakeTarget, type FakeProxy, type FakeTarget } from '../test-helpers/fake-proxy.js';
import { startFakeSocks5Proxy } from '../test-helpers/fake-socks5-proxy.js';
import { closeTestServer } from '../test-helpers/close-server.js';

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const PROXY_CERT = readFileSync(join(FIX_DIR, 'tls-test-proxy.pem'), 'utf-8');
const PROXY_KEY = readFileSync(join(FIX_DIR, 'tls-test-proxy.key'), 'utf-8');
const CLIENT_CERT = readFileSync(join(FIX_DIR, 'tls-test-proxy-client.pem'), 'utf-8');
const CLIENT_KEY = readFileSync(join(FIX_DIR, 'tls-test-proxy-client.key'), 'utf-8');
const TARGET_CERT = readFileSync(join(FIX_DIR, 'tls-test-selfsigned.pem'), 'utf-8');
const TARGET_KEY = readFileSync(join(FIX_DIR, 'tls-test-selfsigned.key'), 'utf-8');

function dispatcherFor(options: {
  proxyUrl: string;
  noProxy?: string[];
  fallbackDirect?: boolean;
  tls?: { ca?: string; cert?: string; key?: string; rejectUnauthorized?: boolean };
  auth?: { username: string; password: string };
  proxyTls?: { ca?: string; cert?: string; key?: string; rejectUnauthorized?: boolean };
}): EgressDispatcher {
  const proxy: ResolvedProxyConfig = resolveProxyConfig(
    {
      proxy: {
        url: options.proxyUrl,
        noProxy: options.noProxy ?? [],
        fromEnv: false,
        fallbackDirect: options.fallbackDirect ?? false,
        ...(options.auth
          ? { auth: { type: 'basic' as const, username: options.auth.username } }
          : {}),
      },
    },
    options.auth ? { SYNTH_PROXY_PASSWORD: options.auth.password } : {},
  );
  if (options.proxyTls) proxy.tls = { rejectUnauthorized: true, ...options.proxyTls };
  return new EgressDispatcher({ proxy, tls: options.tls });
}

/** Dispatcher из «сырой» секции `proxy` (профили/правила). */
function profiledDispatcher(
  proxy: Partial<ProxyConfig>,
  env: NodeJS.ProcessEnv = {},
): EgressDispatcher {
  return new EgressDispatcher({ proxy: resolveProxyConfig({ proxy }, env) });
}

/** Достаёт код ошибки из цепочки `cause` (undici оборачивает dispatch-ошибки). */
function errorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Ограничивает ожидание, чтобы зависший запрос падал тестом, а не вешал suite. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `close()` не должен висеть даже на сломанном коде — иначе встанет afterEach. */
function boundedClose(dispatcher: EgressDispatcher): () => Promise<void> {
  return () =>
    Promise.race([dispatcher.close(), delay(1000)]).then(() => undefined);
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function setup() {
  const proxy: FakeProxy = await startFakeProxy({ mode: 'tunnel' });
  const target: FakeTarget = await startFakeTarget();
  cleanups.push(() => target.close(), () => proxy.close());
  return { proxy, target };
}

describe('EgressDispatcher (ADR-099 D1)', () => {
  it('прокси включён → запрос идёт через прокси', async () => {
    const { proxy, target } = await setup();
    const dispatcher = dispatcherFor({ proxyUrl: proxy.url });
    cleanups.push(() => dispatcher.close());

    const via: string[] = [];
    const res = await egressFetch(`${target.url}/x`, {}, { dispatcher, onVia: (v) => via.push(v) });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(proxy.connects + proxy.absoluteRequests).toBe(1);
    expect(via).toEqual(['proxy']);
  });

  it('no_proxy-хост → direct (прокси не задействован)', async () => {
    const { proxy, target } = await setup();
    const dispatcher = dispatcherFor({ proxyUrl: proxy.url, noProxy: ['127.0.0.1'] });
    cleanups.push(() => dispatcher.close());

    const via: string[] = [];
    const res = await egressFetch(`${target.url}/x`, {}, { dispatcher, onVia: (v) => via.push(v) });

    expect(res.status).toBe(200);
    expect(proxy.connects + proxy.absoluteRequests).toBe(0);
    expect(via).toEqual(['direct']);
  });

  it('no_proxy=* → всё напрямую', async () => {
    const { proxy, target } = await setup();
    const dispatcher = dispatcherFor({ proxyUrl: proxy.url, noProxy: ['*'] });
    cleanups.push(() => dispatcher.close());

    const res = await egressFetch(`${target.url}/x`, {}, { dispatcher });
    expect(res.status).toBe(200);
    expect(proxy.connects + proxy.absoluteRequests).toBe(0);
  });

  it('недоступный прокси → EGRESS_PROXY_UNAVAILABLE, direct-запрос не уходит', async () => {
    const target = await startFakeTarget();
    cleanups.push(() => target.close());
    // Порт, на котором гарантированно никого нет: подняли и закрыли fake-прокси.
    const dead = await startFakeProxy({ mode: 'tunnel' });
    await dead.close();
    const dispatcher = dispatcherFor({ proxyUrl: dead.url });
    cleanups.push(() => dispatcher.close());

    let error: unknown;
    try {
      await egressFetch(`${target.url}/x`, {}, { dispatcher });
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(errorCode(error)).toBe('EGRESS_PROXY_UNAVAILABLE');
    expect(target.requests).toBe(0);
  });

  it('fallbackDirect=true (явный opt-in) → прямое соединение, via=fallback', async () => {
    const target = await startFakeTarget();
    cleanups.push(() => target.close());
    const dead = await startFakeProxy({ mode: 'tunnel' });
    await dead.close();
    const dispatcher = dispatcherFor({ proxyUrl: dead.url, fallbackDirect: true });
    cleanups.push(() => dispatcher.close());

    const via: string[] = [];
    const res = await egressFetch(`${target.url}/x`, {}, { dispatcher, onVia: (v) => via.push(v) });

    expect(res.status).toBe(200);
    expect(target.requests).toBe(1);
    // Плановый маршрут — proxy, фактический после fallback — fallback
    // (журнал egress берёт последнее значение).
    expect(via.at(-1)).toBe('fallback');
  });

  it('http-прокси + https-цель: requestTls (CA) применяется к цели, а не к прокси', async () => {
    const fixDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
    const cert = readFileSync(join(fixDir, 'tls-test-selfsigned.pem'), 'utf-8');
    const key = readFileSync(join(fixDir, 'tls-test-selfsigned.key'), 'utf-8');
    const tlsServer = createServer({ cert, key }, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('tls-ok');
    });
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', () => resolve()));
    const tlsPort = (tlsServer.address() as AddressInfo).port;
    cleanups.push(() => closeTestServer(tlsServer));

    const proxy = await startFakeProxy({ mode: 'tunnel' });
    cleanups.push(() => proxy.close());
    const dispatcher = dispatcherFor({
      proxyUrl: proxy.url,
      tls: { ca: cert, rejectUnauthorized: true },
    });
    cleanups.push(() => dispatcher.close());

    const res = await egressFetch(`https://127.0.0.1:${tlsPort}/x`, {}, { dispatcher });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('tls-ok');
    expect(proxy.connects).toBe(1);
    expect(dispatcher.requestTlsOptions.ca).toBe(cert);
  });

  it('new-style handler получает onResponseError(controller, err), а не «висит»', async () => {
    const target = await startFakeTarget();
    cleanups.push(() => target.close());
    const dead = await startFakeProxy({ mode: 'tunnel' });
    await dead.close();
    const dispatcher = dispatcherFor({ proxyUrl: dead.url });
    cleanups.push(() => dispatcher.close());

    const received = new Promise<{ error: Error; controller: { aborted: boolean; reason: Error | null } }>(
      (resolve) => {
        dispatcher.dispatch(
          { origin: target.url, path: '/', method: 'GET' },
          {
            onResponseError(controller: Dispatcher.DispatchController, error: Error) {
              resolve({ error, controller });
            },
          } as never,
        );
      },
    );
    const outcome = await Promise.race([
      received,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('new-style handler не получил onResponseError')), 3000),
      ),
    ]);

    expect(outcome.error.name).toBe('EgressProxyUnavailableError');
    expect(outcome.controller.aborted).toBe(true);
    expect(target.requests).toBe(0);
  });

  it('legacy handler получает onError(err)', async () => {
    const target = await startFakeTarget();
    cleanups.push(() => target.close());
    const dead = await startFakeProxy({ mode: 'tunnel' });
    await dead.close();
    const dispatcher = dispatcherFor({ proxyUrl: dead.url });
    cleanups.push(() => dispatcher.close());

    const received = new Promise<Error>((resolve) => {
      dispatcher.dispatch(
        { origin: target.url, path: '/', method: 'GET' },
        {
          onError(error: Error) {
            resolve(error);
          },
        } as never,
      );
    });
    const error = await Promise.race([
      received,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('legacy handler не получил onError')), 3000),
      ),
    ]);

    expect(error.name).toBe('EgressProxyUnavailableError');
    expect(target.requests).toBe(0);
  });

  it('Basic: успешная аутентификация — Proxy-Authorization в первом CONNECT', async () => {
    const expected = `Basic ${Buffer.from('user:pass', 'utf8').toString('base64')}`;
    const proxy = await startFakeProxy({ mode: 'tunnel', requireAuth: expected });
    const target = await startFakeTarget();
    cleanups.push(() => target.close(), () => proxy.close());
    const dispatcher = dispatcherFor({
      proxyUrl: proxy.url,
      auth: { username: 'user', password: 'pass' },
    });
    cleanups.push(() => dispatcher.close());

    const res = await egressFetch(`${target.url}/x`, {}, { dispatcher });
    expect(res.status).toBe(200);
    // undici кладёт `proxy-authorization` в CONNECT сразу (без ретрая 407).
    expect(proxy.connectAuthHeaders).toEqual([expected]);
  });

  it('Basic: неверные креды → EGRESS_PROXY_AUTH_FAILED, direct не уходит даже при fallbackDirect', async () => {
    const proxy = await startFakeProxy({
      mode: 'tunnel',
      requireAuth: `Basic ${Buffer.from('user:right', 'utf8').toString('base64')}`,
    });
    const target = await startFakeTarget();
    cleanups.push(() => target.close(), () => proxy.close());
    const dispatcher = dispatcherFor({
      proxyUrl: proxy.url,
      auth: { username: 'user', password: 'wrong' },
      fallbackDirect: true,
    });
    cleanups.push(() => dispatcher.close());

    let error: unknown;
    try {
      await egressFetch(`${target.url}/x`, {}, { dispatcher });
    } catch (err) {
      error = err;
    }
    expect(errorCode(error)).toBe('EGRESS_PROXY_AUTH_FAILED');
    expect(target.requests).toBe(0);
  });

  it('Basic: прокси требует креды, а их нет → EGRESS_PROXY_AUTH_REQUIRED', async () => {
    const proxy = await startFakeProxy({
      mode: 'tunnel',
      requireAuth: `Basic ${Buffer.from('user:pass', 'utf8').toString('base64')}`,
    });
    const target = await startFakeTarget();
    cleanups.push(() => target.close(), () => proxy.close());
    const dispatcher = dispatcherFor({ proxyUrl: proxy.url });
    cleanups.push(() => dispatcher.close());

    let error: unknown;
    try {
      await egressFetch(`${target.url}/x`, {}, { dispatcher });
    } catch (err) {
      error = err;
    }
    expect(errorCode(error)).toBe('EGRESS_PROXY_AUTH_REQUIRED');
    expect(target.requests).toBe(0);
  });

  it('https-прокси: TLS к прокси (proxy.tls CA) + TLS к цели (requestTls CA)', async () => {
    const tlsTarget = createServer({ cert: TARGET_CERT, key: TARGET_KEY }, (_req, res) => {
      res.writeHead(200);
      res.end('tls-ok');
    });
    await new Promise<void>((resolve) => tlsTarget.listen(0, '127.0.0.1', () => resolve()));
    const targetPort = (tlsTarget.address() as AddressInfo).port;
    cleanups.push(() => closeTestServer(tlsTarget));

    const proxy = await startFakeProxy({
      mode: 'tunnel',
      tls: { key: PROXY_KEY, cert: PROXY_CERT },
    });
    cleanups.push(() => proxy.close());
    const dispatcher = dispatcherFor({
      proxyUrl: `https://localhost:${proxy.port}`,
      proxyTls: { ca: PROXY_CERT },
      tls: { ca: TARGET_CERT, rejectUnauthorized: true },
    });
    cleanups.push(() => dispatcher.close());

    const res = await egressFetch(`https://127.0.0.1:${targetPort}/x`, {}, { dispatcher });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('tls-ok');
    expect(proxy.connects).toBe(1);
  });

  it('https-прокси без доверия к его CA → ошибка (self-signed)', async () => {
    const proxy = await startFakeProxy({
      mode: 'tunnel',
      tls: { key: PROXY_KEY, cert: PROXY_CERT },
    });
    const target = await startFakeTarget();
    cleanups.push(() => target.close(), () => proxy.close());
    const dispatcher = dispatcherFor({ proxyUrl: `https://localhost:${proxy.port}` });
    cleanups.push(() => dispatcher.close());

    let error: unknown;
    try {
      await egressFetch(`${target.url}/x`, {}, { dispatcher });
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(proxy.connects).toBe(0);
    expect(target.requests).toBe(0);
  });

  it('mTLS к прокси: с клиентским сертом — успех, без — отказ', async () => {
    const proxy = await startFakeProxy({
      mode: 'tunnel',
      tls: {
        key: PROXY_KEY,
        cert: PROXY_CERT,
        ca: CLIENT_CERT,
        requestCert: true,
        rejectUnauthorized: false,
        requireClientCert: true,
      },
    });
    const target = await startFakeTarget();
    cleanups.push(() => target.close(), () => proxy.close());

    const withCert = dispatcherFor({
      proxyUrl: `https://localhost:${proxy.port}`,
      proxyTls: { ca: PROXY_CERT, cert: CLIENT_CERT, key: CLIENT_KEY },
    });
    cleanups.push(() => withCert.close());
    const ok = await egressFetch(`${target.url}/x`, {}, { dispatcher: withCert });
    expect(ok.status).toBe(200);
    expect(proxy.clientCertSubjects[0]).toBe('synth-test-client');

    const noCert = dispatcherFor({
      proxyUrl: `https://localhost:${proxy.port}`,
      proxyTls: { ca: PROXY_CERT },
    });
    cleanups.push(() => noCert.close());
    let error: unknown;
    try {
      await egressFetch(`${target.url}/x`, {
        signal: AbortSignal.timeout(3000),
      }, { dispatcher: noCert });
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(target.requests).toBe(1); // только успешный запрос с сертом
  });

  it('SOCKS5 no-auth: запрос идёт через SOCKS (CONNECT → target)', async () => {
    const socks = await startFakeSocks5Proxy();
    const target = await startFakeTarget();
    cleanups.push(() => target.close(), () => socks.close());
    const dispatcher = dispatcherFor({ proxyUrl: socks.url });
    cleanups.push(() => dispatcher.close());

    const via: string[] = [];
    const res = await egressFetch(`${target.url}/x`, {}, { dispatcher, onVia: (v) => via.push(v) });
    expect(res.status).toBe(200);
    expect(via).toEqual(['proxy']);
    expect(socks.connections).toBe(1);
    expect(socks.targets).toEqual([`127.0.0.1:${target.port}`]);
  });

  it('SOCKS5 user/pass: успешная аутентификация', async () => {
    const socks = await startFakeSocks5Proxy({ auth: { username: 'user', password: 'pass' } });
    const target = await startFakeTarget();
    cleanups.push(() => target.close(), () => socks.close());
    const dispatcher = dispatcherFor({
      proxyUrl: socks.url,
      auth: { username: 'user', password: 'pass' },
    });
    cleanups.push(() => dispatcher.close());

    const res = await egressFetch(`${target.url}/x`, {}, { dispatcher });
    expect(res.status).toBe(200);
    expect(socks.authAttempts).toBe(1);
    expect(socks.targets).toEqual([`127.0.0.1:${target.port}`]);
  });

  it('SOCKS5: неверный пароль → EGRESS_PROXY_AUTH_FAILED, direct не ушёл', async () => {
    const socks = await startFakeSocks5Proxy({ auth: { username: 'user', password: 'right' } });
    const target = await startFakeTarget();
    cleanups.push(() => target.close(), () => socks.close());
    const dispatcher = dispatcherFor({
      proxyUrl: socks.url,
      auth: { username: 'user', password: 'wrong' },
      fallbackDirect: true,
    });
    cleanups.push(() => dispatcher.close());

    let error: unknown;
    try {
      await egressFetch(`${target.url}/x`, {}, { dispatcher });
    } catch (err) {
      error = err;
    }
    expect(errorCode(error)).toBe('EGRESS_PROXY_AUTH_FAILED');
    expect(target.requests).toBe(0);
    expect(socks.targets).toEqual([]);
  });

  it('SOCKS5: прокси требует auth, кред нет → EGRESS_PROXY_AUTH_REQUIRED', async () => {
    const socks = await startFakeSocks5Proxy({ auth: { username: 'user', password: 'pass' } });
    const target = await startFakeTarget();
    cleanups.push(() => target.close(), () => socks.close());
    const dispatcher = dispatcherFor({ proxyUrl: socks.url });
    cleanups.push(() => dispatcher.close());

    let error: unknown;
    try {
      await egressFetch(`${target.url}/x`, {}, { dispatcher });
    } catch (err) {
      error = err;
    }
    expect(errorCode(error)).toBe('EGRESS_PROXY_AUTH_REQUIRED');
    expect(target.requests).toBe(0);
  });

  it('SOCKS5 + no_proxy → direct (SOCKS-сервер не получил соединений)', async () => {
    const socks = await startFakeSocks5Proxy();
    const target = await startFakeTarget();
    cleanups.push(() => target.close(), () => socks.close());
    const dispatcher = dispatcherFor({ proxyUrl: socks.url, noProxy: ['127.0.0.1'] });
    cleanups.push(() => dispatcher.close());

    const res = await egressFetch(`${target.url}/x`, {}, { dispatcher });
    expect(res.status).toBe(200);
    expect(socks.connections).toBe(0);
    expect(target.requests).toBe(1);
  });

  it('SOCKS5 + https-цель: CONNECT → TLS (системное доверие)', async () => {
    const tlsTarget = createServer({ cert: TARGET_CERT, key: TARGET_KEY }, (_req, res) => {
      res.writeHead(200);
      res.end('socks-tls-ok');
    });
    await new Promise<void>((resolve) => tlsTarget.listen(0, '127.0.0.1', () => resolve()));
    const targetPort = (tlsTarget.address() as AddressInfo).port;
    cleanups.push(() => closeTestServer(tlsTarget));

    const socks = await startFakeSocks5Proxy();
    cleanups.push(() => socks.close());
    const dispatcher = dispatcherFor({ proxyUrl: socks.url });
    cleanups.push(() => dispatcher.close());

    // Ограничение undici Socks5ProxyAgent: TLS к цели — системное доверие
    // (requestTls/security.tls не пробрасываются) → для self-signed отключаем
    // проверку только на время теста.
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const res = await egressFetch(`https://localhost:${targetPort}/x`, {}, { dispatcher });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('socks-tls-ok');
      expect(socks.targets).toEqual([`localhost:${targetPort}`]);
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  });

  it('407 от прокси → запрос не проходит (нет тихого direct)', async () => {
    const proxy = await startFakeProxy({ mode: '407' });
    const target = await startFakeTarget();
    cleanups.push(() => target.close(), () => proxy.close());
    const dispatcher = dispatcherFor({ proxyUrl: proxy.url });
    cleanups.push(() => dispatcher.close());

    let error: unknown;
    try {
      await egressFetch(`${target.url}/x`, {}, { dispatcher });
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(target.requests).toBe(0);
  });
});

describe('EgressDispatcher: профили маршрутизации', () => {
  it('mode=all: default-профиль для всех, правило ведёт в другой профиль', async () => {
    const proxyDefault = await startFakeProxy({ mode: 'tunnel' });
    const proxyLlm = await startFakeProxy({ mode: 'tunnel' });
    const targetA = await startFakeTarget();
    const targetB = await startFakeTarget();
    cleanups.push(
      () => targetA.close(),
      () => targetB.close(),
      () => proxyDefault.close(),
      () => proxyLlm.close(),
    );
    const dispatcher = profiledDispatcher({
      mode: 'all',
      fromEnv: false,
      profiles: {
        default: { url: proxyDefault.url },
        llm: { label: 'LLM', url: proxyLlm.url },
      },
      rules: [
        {
          id: 'r_llm',
          hosts: [`127.0.0.1:${targetB.port}`],
          action: 'proxy',
          profile: 'llm',
        },
      ],
    });
    cleanups.push(() => dispatcher.close());

    expect(dispatcher.proxyRouteFor(`${targetA.url}/x`)).toMatchObject({
      action: 'proxy',
      reason: 'default',
      profile: 'default',
    });
    expect(dispatcher.proxyRouteFor(`${targetB.url}/x`)).toMatchObject({
      action: 'proxy',
      reason: 'rule',
      profile: 'llm',
    });
    expect(dispatcher.proxyProfileFor(`${targetB.url}/x`)?.url).toBe(proxyLlm.url);

    // Повторные запросы — тот же агент профиля, без смешивания.
    for (const target of [targetA, targetB, targetA, targetB]) {
      const res = await egressFetch(`${target.url}/x`, {}, { dispatcher });
      expect(res.status).toBe(200);
    }
    // Профили не смешиваются: каждый прокси туннелирует только свой target
    // (keep-alive переиспользует соединение — CONNECT может быть один).
    expect([...new Set(proxyDefault.connectTargets)]).toEqual([`127.0.0.1:${targetA.port}`]);
    expect([...new Set(proxyLlm.connectTargets)]).toEqual([`127.0.0.1:${targetB.port}`]);
    expect(targetA.requests).toBe(2);
    expect(targetB.requests).toBe(2);
  });

  it('правило action=direct → прямое соединение, прокси не задействован', async () => {
    const proxy = await startFakeProxy({ mode: 'tunnel' });
    const target = await startFakeTarget();
    cleanups.push(() => target.close(), () => proxy.close());
    const dispatcher = profiledDispatcher({
      mode: 'all',
      fromEnv: false,
      profiles: { default: { url: proxy.url } },
      rules: [{ hosts: [`127.0.0.1:${target.port}`], action: 'direct' }],
    });
    cleanups.push(() => dispatcher.close());

    const via: string[] = [];
    const res = await egressFetch(`${target.url}/x`, {}, { dispatcher, onVia: (v) => via.push(v) });
    expect(res.status).toBe(200);
    expect(via).toEqual(['direct']);
    expect(proxy.connects + proxy.absoluteRequests).toBe(0);
    expect(dispatcher.proxyRouteFor(target.url)).toMatchObject({
      action: 'direct',
      reason: 'rule',
    });
  });

  it('mode=selected: без правила — direct (no-match), с правилом — proxy', async () => {
    const proxy = await startFakeProxy({ mode: 'tunnel' });
    const proxied = await startFakeTarget();
    const directTarget = await startFakeTarget();
    cleanups.push(
      () => proxied.close(),
      () => directTarget.close(),
      () => proxy.close(),
    );
    const dispatcher = profiledDispatcher({
      mode: 'selected',
      fromEnv: false,
      profiles: { llm: { url: proxy.url } },
      rules: [
        {
          hosts: [`127.0.0.1:${proxied.port}`],
          action: 'proxy',
          profile: 'llm',
        },
      ],
    });
    cleanups.push(() => dispatcher.close());

    await egressFetch(`${proxied.url}/x`, {}, { dispatcher });
    await egressFetch(`${directTarget.url}/x`, {}, { dispatcher });
    expect(proxy.connects).toBe(1);
    expect(proxied.requests).toBe(1);
    expect(directTarget.requests).toBe(1);
    expect(dispatcher.proxyRouteFor(directTarget.url)).toMatchObject({
      action: 'direct',
      reason: 'no-match',
    });
  });

  it('профиль с собственными URL и Basic-кредами (env профиля)', async () => {
    const expected = `Basic ${Buffer.from('user:pass', 'utf8').toString('base64')}`;
    const proxy = await startFakeProxy({ mode: 'tunnel', requireAuth: expected });
    const other = await startFakeProxy({ mode: 'tunnel' });
    const target = await startFakeTarget();
    cleanups.push(() => target.close(), () => proxy.close(), () => other.close());
    const dispatcher = profiledDispatcher(
      {
        mode: 'all',
        fromEnv: false,
        profiles: {
          default: { url: other.url },
          secure: {
            label: 'Secure',
            url: proxy.url,
            auth: { type: 'basic', username: 'user' },
          },
        },
        rules: [
          { hosts: [`127.0.0.1:${target.port}`], action: 'proxy', profile: 'secure' },
        ],
      },
      { SYNTH_PROXY_SECURE_PASSWORD: 'pass' },
    );
    cleanups.push(() => dispatcher.close());

    const res = await egressFetch(`${target.url}/x`, {}, { dispatcher });
    expect(res.status).toBe(200);
    expect(proxy.connectAuthHeaders).toEqual([expected]);
    expect(other.connects + other.absoluteRequests).toBe(0);
    // Креды не утекают в описание профиля/маршрута.
    expect(dispatcher.proxyProfileFor(target.url)?.auth).toEqual({
      type: 'basic',
      username: 'user',
    });
  });

  it('noProxy выигрывает у профилей/правил', async () => {
    const proxy = await startFakeProxy({ mode: 'tunnel' });
    const target = await startFakeTarget();
    cleanups.push(() => target.close(), () => proxy.close());
    const dispatcher = profiledDispatcher({
      mode: 'all',
      fromEnv: false,
      noProxy: ['127.0.0.1'],
      profiles: { default: { url: proxy.url } },
      rules: [
        { hosts: [`127.0.0.1:${target.port}`], action: 'proxy', profile: 'default' },
      ],
    });
    cleanups.push(() => dispatcher.close());

    const res = await egressFetch(`${target.url}/x`, {}, { dispatcher });
    expect(res.status).toBe(200);
    expect(proxy.connects + proxy.absoluteRequests).toBe(0);
    expect(dispatcher.proxyRouteFor(target.url)).toMatchObject({
      action: 'direct',
      reason: 'no-proxy',
    });
  });

  it('target TLS и TLS прокси независимы (профиль → proxyTls, security.tls → requestTls)', async () => {
    const tlsTarget = createServer({ cert: TARGET_CERT, key: TARGET_KEY }, (_req, res) => {
      res.writeHead(200);
      res.end('tls-ok');
    });
    await new Promise<void>((resolve) => tlsTarget.listen(0, '127.0.0.1', () => resolve()));
    const targetPort = (tlsTarget.address() as AddressInfo).port;
    cleanups.push(() => closeTestServer(tlsTarget));

    const proxy = await startFakeProxy({
      mode: 'tunnel',
      tls: { key: PROXY_KEY, cert: PROXY_CERT },
    });
    cleanups.push(() => proxy.close());

    const dispatcher = new EgressDispatcher({
      proxy: resolveProxyConfig({
        proxy: {
          mode: 'all',
          fromEnv: false,
          profiles: {
            default: {
              url: `https://localhost:${proxy.port}`,
              tls: { caPem: PROXY_CERT },
            },
          },
        },
      }),
      tls: { ca: TARGET_CERT, rejectUnauthorized: true },
    });
    cleanups.push(() => dispatcher.close());

    const origin = `https://127.0.0.1:${targetPort}`;
    // TLS к прокси — из профиля, TLS к цели — из security.tls (независимы).
    expect(dispatcher.proxyProfileFor(origin)?.tls?.ca).toBe(PROXY_CERT);
    expect(dispatcher.requestTlsFor(origin).ca).toBe(TARGET_CERT);

    const res = await egressFetch(`${origin}/x`, {}, { dispatcher });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('tls-ok');
    expect(proxy.connects).toBe(1);
  });

  it('SOCKS5 из именованного профиля (mode=all)', async () => {
    const socks = await startFakeSocks5Proxy();
    const target = await startFakeTarget();
    cleanups.push(() => target.close(), () => socks.close());
    const dispatcher = profiledDispatcher({
      mode: 'all',
      fromEnv: false,
      profiles: { default: { url: socks.url } },
    });
    cleanups.push(() => dispatcher.close());

    const res = await egressFetch(`${target.url}/x`, {}, { dispatcher });
    expect(res.status).toBe(200);
    expect(socks.connections).toBe(1);
    expect(socks.targets).toEqual([`127.0.0.1:${target.port}`]);
  });

  it('legacy-default: синтетический профиль, маршрут default, TLS из config.tls', () => {
    const proxy = resolveProxyConfig(
      { proxy: { url: 'http://legacy:3128', fromEnv: false } },
      {},
    );
    proxy.tls = { rejectUnauthorized: false };
    const dispatcher = new EgressDispatcher({ proxy });

    expect(dispatcher.proxyRouteFor('https://example.com/x')).toMatchObject({
      action: 'proxy',
      reason: 'default',
      profile: 'default',
      proxyUrl: 'http://legacy:3128',
    });
    expect(dispatcher.proxyProfileFor('https://example.com/x')).toMatchObject({
      name: 'default',
      legacy: true,
      tls: { rejectUnauthorized: false },
    });
    expect(dispatcher.routeFor('https://example.com/x')).toBe('proxy');
    expect(dispatcher.plannedVia('https://example.com/x')).toBe('proxy');
  });
});

/**
 * Регрессия: undici определяет стиль handler'а по наличию `onRequestStart`
 * (`UnwrapHandler.unwrap`). Legacy-handler (встроенный fetch в Node 22,
 * `undici@7` fetch) не имеет new-style методов — обёртка обязана повторять его
 * контракт, иначе ответ/ошибка теряются и запрос висит навсегда.
 */
describe('EgressDispatcher: стиль handler (legacy/new-style)', () => {
  it('legacy handler undici fetch: ответ через прокси доходит, запрос не висит', async () => {
    const { proxy, target } = await setup();
    const dispatcher = dispatcherFor({ proxyUrl: proxy.url });
    cleanups.push(boundedClose(dispatcher));

    // undici@7 fetch использует legacy-handler независимо от версии Node.
    const res = await withTimeout(
      undiciFetch(`${target.url}/legacy`, { dispatcher }),
      2500,
      'legacy handler: ответ через прокси не дошёл (запрос завис)',
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(proxy.connects + proxy.absoluteRequests).toBe(1);
  });

  it('legacy handler: onHeaders → onData → onComplete через прокси', async () => {
    const { proxy, target } = await setup();
    const dispatcher = dispatcherFor({ proxyUrl: proxy.url });
    cleanups.push(boundedClose(dispatcher));

    let status = 0;
    let body = '';
    const received = withTimeout(
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        dispatcher.dispatch(
          { origin: target.url, path: '/legacy', method: 'GET' },
          {
            onConnect() {},
            onHeaders(statusCode: number, _headers: unknown, _resume: () => void) {
              status = statusCode;
              return true;
            },
            onData(chunk: Buffer) {
              body += chunk.toString();
              return true;
            },
            onComplete() {
              resolve({ status, body });
            },
            onError(error: Error) {
              reject(error);
            },
          } as never,
        );
      }),
      2500,
      'legacy handler не получил ответ через прокси',
    );

    expect(await received).toEqual({ status: 200, body: 'ok' });
    expect(target.requests).toBe(1);
  });

  it('new-style handler по-прежнему получает onResponseStart/onResponseEnd', async () => {
    const { proxy, target } = await setup();
    const dispatcher = dispatcherFor({ proxyUrl: proxy.url });
    cleanups.push(boundedClose(dispatcher));

    let status = 0;
    let body = '';
    const received = withTimeout(
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        dispatcher.dispatch(
          { origin: target.url, path: '/new-style', method: 'GET' },
          {
            onRequestStart() {},
            onResponseStart(_controller: Dispatcher.DispatchController, statusCode: number) {
              status = statusCode;
            },
            onResponseData(_controller: Dispatcher.DispatchController, chunk: Buffer) {
              body += chunk.toString();
            },
            onResponseEnd() {
              resolve({ status, body });
            },
            onResponseError(_controller: Dispatcher.DispatchController, error: Error) {
              reject(error);
            },
          } as never,
        );
      }),
      2500,
      'new-style handler не получил ответ через прокси',
    );

    expect(await received).toEqual({ status: 200, body: 'ok' });
    expect(target.requests).toBe(1);
  });
});
