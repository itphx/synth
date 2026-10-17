import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Dispatcher } from 'undici';
import { resolveProxyConfig, type ResolvedProxyConfig } from '@itphx/synth-shared';
import { EgressDispatcher } from './proxy-dispatcher.js';
import { egressFetch } from './tls.js';
import { startFakeProxy, startFakeTarget, type FakeProxy, type FakeTarget } from '../test-helpers/fake-proxy.js';

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
    cleanups.push(() => new Promise<void>((resolve) => tlsServer.close(() => resolve())));

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
    cleanups.push(() => new Promise<void>((resolve) => tlsTarget.close(() => resolve())));

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
