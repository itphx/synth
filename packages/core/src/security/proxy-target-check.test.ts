/**
 * ADR-099: проверка **target URL** (`checkProxyTarget`) — маршрут, транспорт,
 * auth/таймаут/TLS и отсутствие секретов в ответе.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AddressInfo, Socket } from 'node:net';
import { fetch as undiciFetch } from 'undici';
import { resolveProxyConfig, type ProxyConfig } from '@itphx/synth-shared';
import { checkProxyTarget } from './proxy-check.js';
import type { FetchLike } from './tls.js';
import { startFakeProxy } from '../test-helpers/fake-proxy.js';
import { closeTestServer } from '../test-helpers/close-server.js';

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const TARGET_CERT = readFileSync(join(FIX_DIR, 'tls-test-selfsigned.pem'), 'utf-8');
const TARGET_KEY = readFileSync(join(FIX_DIR, 'tls-test-selfsigned.key'), 'utf-8');

interface RecordingTarget {
  url: string;
  port: number;
  readonly requests: number;
  readonly methods: string[];
  readonly bodies: string[];
  readonly headers: Array<Record<string, string | string[] | undefined>>;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** Локальная цель со счётчиками метода/тела/заголовков. */
async function startRecordingTarget(
  handler?: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void,
): Promise<RecordingTarget> {
  let requests = 0;
  const methods: string[] = [];
  const bodies: string[] = [];
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    requests += 1;
    methods.push(req.method ?? '');
    headers.push(req.headers);
    let body = '';
    req.on('data', (chunk) => (body += chunk.toString()));
    req.on('end', () => {
      bodies.push(body);
      if (handler) {
        handler(req, res);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    get requests() {
      return requests;
    },
    get methods() {
      return methods;
    },
    get bodies() {
      return bodies;
    },
    get headers() {
      return headers;
    },
    async close() {
      await closeTestServer(server, { sockets });
    },
  };
}

function proxyConfig(proxy: Partial<ProxyConfig>, env: NodeJS.ProcessEnv = {}) {
  return resolveProxyConfig({ proxy }, env);
}

function profiledConfig(
  proxyUrl: string,
  extra: Partial<ProxyConfig> = {},
  env: NodeJS.ProcessEnv = {},
) {
  return proxyConfig(
    { mode: 'all', fromEnv: false, profiles: { default: { url: proxyUrl } }, ...extra },
    env,
  );
}

describe('checkProxyTarget — маршрут', () => {
  it('прокси выключен → direct (disabled), HEAD без тела и без кред к цели', async () => {
    const target = await startRecordingTarget();
    cleanups.push(() => target.close());

    const result = await checkProxyTarget({ url: target.url, config: null, timeoutMs: 3000 });
    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.route).toEqual({ action: 'direct', via: 'direct', reason: 'disabled' });
    expect(result.authChallenge).toBe('none');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(target.methods).toEqual(['HEAD']);
    expect(target.bodies).toEqual(['']);
    expect(target.headers[0]?.authorization).toBeUndefined();
    expect(target.headers[0]?.['proxy-authorization']).toBeUndefined();
  });

  it('mode=all: запрос идёт через default-профиль, proxyUrl в маршруте', async () => {
    const proxy = await startFakeProxy({ mode: 'tunnel' });
    const target = await startRecordingTarget();
    cleanups.push(() => target.close(), () => proxy.close());
    const config = profiledConfig(proxy.url);

    const result = await checkProxyTarget({ url: `${target.url}/x`, config, timeoutMs: 3000 });
    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.route).toMatchObject({
      action: 'proxy',
      via: 'proxy',
      reason: 'default',
      profile: 'default',
      proxyUrl: proxy.url,
    });
    expect(result.route.ruleId).toBeUndefined();
    expect(proxy.connects).toBe(1);
    expect(target.methods).toEqual(['HEAD']);
  });

  it('правило ведёт в профиль (ruleId/profileLabel), другой прокси не задействован', async () => {
    const proxyDefault = await startFakeProxy({ mode: 'tunnel' });
    const proxyLlm = await startFakeProxy({ mode: 'tunnel' });
    const target = await startRecordingTarget();
    cleanups.push(() => target.close(), () => proxyDefault.close(), () => proxyLlm.close());
    const config = proxyConfig({
      mode: 'all',
      fromEnv: false,
      profiles: {
        default: { url: proxyDefault.url },
        llm: { label: 'LLM egress', url: proxyLlm.url },
      },
      rules: [
        {
          id: 'r_llm',
          label: 'LLM',
          hosts: [`127.0.0.1:${target.port}`],
          action: 'proxy',
          profile: 'llm',
        },
      ],
    });

    const result = await checkProxyTarget({ url: target.url, config, timeoutMs: 3000 });
    expect(result.ok).toBe(true);
    expect(result.route).toMatchObject({
      action: 'proxy',
      reason: 'rule',
      ruleId: 'r_llm',
      ruleLabel: 'LLM',
      profile: 'llm',
      profileLabel: 'LLM egress',
      proxyUrl: proxyLlm.url,
    });
    expect(proxyLlm.connects).toBe(1);
    expect(proxyDefault.connects + proxyDefault.absoluteRequests).toBe(0);
  });

  it('правило action=direct → direct, прокси не задействован', async () => {
    const proxy = await startFakeProxy({ mode: 'tunnel' });
    const target = await startRecordingTarget();
    cleanups.push(() => target.close(), () => proxy.close());
    const config = proxyConfig({
      mode: 'all',
      fromEnv: false,
      profiles: { default: { url: proxy.url } },
      rules: [{ hosts: [`127.0.0.1:${target.port}`], action: 'direct' }],
    });

    const result = await checkProxyTarget({ url: target.url, config, timeoutMs: 3000 });
    expect(result.ok).toBe(true);
    expect(result.route).toMatchObject({ action: 'direct', via: 'direct', reason: 'rule' });
    expect(proxy.connects + proxy.absoluteRequests).toBe(0);
  });

  it('noProxy → direct (no-proxy), даже если правило требует прокси', async () => {
    const proxy = await startFakeProxy({ mode: 'tunnel' });
    const target = await startRecordingTarget();
    cleanups.push(() => target.close(), () => proxy.close());
    const config = proxyConfig({
      mode: 'all',
      fromEnv: false,
      noProxy: ['127.0.0.1'],
      profiles: { default: { url: proxy.url } },
      rules: [{ hosts: [`127.0.0.1:${target.port}`], action: 'proxy', profile: 'default' }],
    });

    const result = await checkProxyTarget({ url: target.url, config, timeoutMs: 3000 });
    expect(result.ok).toBe(true);
    expect(result.route.reason).toBe('no-proxy');
    expect(result.route.action).toBe('direct');
    expect(proxy.connects + proxy.absoluteRequests).toBe(0);
  });

  it('mode=selected без правила → direct (no-match)', async () => {
    const proxy = await startFakeProxy({ mode: 'tunnel' });
    const target = await startRecordingTarget();
    cleanups.push(() => target.close(), () => proxy.close());
    const config = proxyConfig({
      mode: 'selected',
      fromEnv: false,
      profiles: { llm: { url: proxy.url } },
      rules: [{ hosts: ['*.openai.com'], action: 'proxy', profile: 'llm' }],
    });

    const result = await checkProxyTarget({ url: target.url, config, timeoutMs: 3000 });
    expect(result.ok).toBe(true);
    expect(result.route).toEqual({ action: 'direct', via: 'direct', reason: 'no-match' });
    expect(proxy.connects).toBe(0);
  });
});

describe('checkProxyTarget — ошибки', () => {
  it('407 от прокси → ok:false, authChallenge Basic, секреты не раскрыты', async () => {
    const proxy = await startFakeProxy({ mode: '407' });
    const target = await startRecordingTarget();
    cleanups.push(() => target.close(), () => proxy.close());
    const config = proxyConfig(
      {
        mode: 'all',
        fromEnv: false,
        profiles: {
          default: {
            url: proxy.url,
            auth: { type: 'basic', username: 'user' },
          },
        },
      },
      { SYNTH_PROXY_PASSWORD: 'super-secret' },
    );

    const result = await checkProxyTarget({ url: target.url, config, timeoutMs: 3000 });
    expect(result.ok).toBe(false);
    expect(result.authChallenge).toBe('Basic');
    expect(result.error).toContain('407');
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(JSON.stringify(result)).not.toContain('user:super-secret');
  });

  it('DNS-ошибка → ok:false с понятным error', async () => {
    const result = await checkProxyTarget({
      url: 'http://synth-check-does-not-exist.invalid/',
      config: null,
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/ENOTFOUND|EAI_AGAIN|getaddrinfo|not found/i);
    expect(result.route.action).toBe('direct');
  });

  it('TLS-ошибка (self-signed без доверия) → ok:false', async () => {
    const server = createHttpsServer({ cert: TARGET_CERT, key: TARGET_KEY }, (_req, res) => {
      res.writeHead(200);
      res.end('tls');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    cleanups.push(() => closeTestServer(server));

    const result = await checkProxyTarget({
      url: `https://127.0.0.1:${port}/`,
      config: null,
      timeoutMs: 3000,
    });
    expect(result.ok).toBe(false);
    expect(result.route.action).toBe('direct');
    expect(result.error).toMatch(/certificate|self.signed|SELF_SIGNED/i);
  });

  it('TLS-доверие к цели из опции tls (CA) → ok:true', async () => {
    const server = createHttpsServer({ cert: TARGET_CERT, key: TARGET_KEY }, (_req, res) => {
      res.writeHead(200);
      res.end('tls');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    cleanups.push(() => closeTestServer(server));

    const result = await checkProxyTarget({
      url: `https://127.0.0.1:${port}/`,
      config: null,
      tls: { ca: TARGET_CERT, rejectUnauthorized: true },
      timeoutMs: 3000,
    });
    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.route.action).toBe('direct');
  });

  it('таймаут → ok:false, error про таймаут', async () => {
    // Сервер принимает соединение, но не отвечает.
    const silent = await startRecordingTarget(() => {});
    cleanups.push(() => silent.close());

    const result = await checkProxyTarget({ url: silent.url, config: null, timeoutMs: 150 });
    expect(result.ok).toBe(false);
    expect(result.authChallenge).toBe('none');
    expect(result.error).toMatch(/таймаут/);
    expect(result.latencyMs).toBeGreaterThanOrEqual(100);
  });

  it('редирект не выполняется (redirect: manual)', async () => {
    const finalTarget = await startRecordingTarget();
    const redirecting = await startRecordingTarget((_req, res) => {
      res.writeHead(302, { Location: `${finalTarget.url}/final` });
      res.end();
    });
    cleanups.push(() => finalTarget.close(), () => redirecting.close());

    const result = await checkProxyTarget({ url: redirecting.url, config: null, timeoutMs: 3000 });
    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(302);
    expect(finalTarget.requests).toBe(0);
  });

  it('некорректный URL / userinfo → ошибка без эха секрета', async () => {
    const ftp = await checkProxyTarget({ url: 'ftp://example.com/file', config: null });
    expect(ftp.ok).toBe(false);
    expect(ftp.error).toMatch(/http\/https/);
    expect(ftp.route.action).toBe('direct');

    const userinfo = await checkProxyTarget({
      url: 'http://user:secret@example.com/',
      config: null,
    });
    expect(userinfo.ok).toBe(false);
    expect(userinfo.error).toMatch(/userinfo/);
    expect(JSON.stringify(userinfo)).not.toContain('secret');
  });
});

describe('checkProxyTarget — legacy handler (Node 22 / undici@7 fetch)', () => {
  it('legacy handler + молчащий прокси → таймаут возвращается, запрос не висит', async () => {
    const proxy = await startFakeProxy({ mode: 'silent' });
    const target = await startRecordingTarget();
    cleanups.push(() => target.close(), () => proxy.close());
    const config = profiledConfig(proxy.url);

    // undici@7 fetch использует legacy-handler независимо от версии Node:
    // без style-aware обёртки ответ/ошибка теряются и `checkProxyTarget`
    // (вместе с `dispatcher.close()`) висит навсегда.
    const result = await Promise.race([
      checkProxyTarget({
        url: target.url,
        config,
        timeoutMs: 300,
        fetchImpl: undiciFetch as unknown as FetchLike,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('checkProxyTarget завис на legacy handler')), 5000),
      ),
    ]);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/таймаут/);
    expect(result.route).toMatchObject({ action: 'proxy', via: 'proxy' });
    expect(proxy.connects + proxy.absoluteRequests).toBeGreaterThanOrEqual(1);
  });
});

describe('checkProxyTarget — контракт запроса', () => {
  it('HEAD, redirect manual, без тела, dispatcher передан', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return new Response(null, { status: 204 });
    };
    const result = await checkProxyTarget({
      url: 'https://example.com/health',
      config: null,
      fetchImpl,
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(204);
    expect(captured?.method).toBe('HEAD');
    expect(captured?.redirect).toBe('manual');
    expect(captured?.body).toBeUndefined();
    expect((captured as { dispatcher?: unknown } | undefined)?.dispatcher).toBeDefined();
    expect(captured?.headers).toBeUndefined();
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
  });
});
