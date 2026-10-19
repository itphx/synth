import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as undici from 'undici';
import {
  buildTlsTrust,
  applyGlobalTlsTrust,
  egressFetch,
  isTlsTrustConfigured,
  TlsDependencyUnavailableError,
  _resetTlsTrustForTests,
} from './tls.js';
import type { FetchLike } from './tls.js';

// Публичный сертификат фикстуры: самоподписанный, помечен «TEST ONLY».
const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const CERT_PATH = join(FIX_DIR, 'tls-test-selfsigned.pem');
const KEY_PATH = join(FIX_DIR, 'tls-test-selfsigned.key');
const CERT_PEM = readFileSync(CERT_PATH, 'utf-8');

/** Подменный транспорт: пишет аргументы и возвращает `200 ok`. */
function recordingFetch(): { impl: FetchLike; calls: Array<{ init?: RequestInit }> } {
  const calls: Array<{ init?: RequestInit }> = [];
  const impl: FetchLike = async (_input, init) => {
    calls.push({ init });
    return new Response('ok');
  };
  return { impl, calls };
}

/** Фейковый undici: проверяем установку global dispatcher без сети. */
function fakeUndici() {
  const setGlobalDispatcher = vi.fn();
  class Agent {
    constructor(public readonly opts: unknown) {}
  }
  return {
    setGlobalDispatcher,
    module: { Agent, setGlobalDispatcher } as unknown as typeof import('undici'),
  };
}

describe('buildTlsTrust', () => {
  it('пустой конфиг → системное доверие', () => {
    const trust = buildTlsTrust(undefined, {});
    expect(trust.rejectUnauthorized).toBe(true);
    expect(trust.ca).toBeUndefined();
    expect(trust.cert).toBeUndefined();
  });

  it('caPem → ca заполнен', () => {
    const trust = buildTlsTrust({ security: { tls: { caPem: CERT_PEM } } }, {});
    expect(trust.ca).toBe(CERT_PEM);
  });

  it('отсутствующий caFile → fail-closed (ошибка)', () => {
    expect(() => buildTlsTrust({ security: { tls: { caFile: '/no/such.pem' } } }, {})).toThrow(
      /не удалось прочитать/i,
    );
  });
});

describe('applyGlobalTlsTrust / isTlsTrustConfigured', () => {
  beforeEach(() => _resetTlsTrustForTests());

  it('без заданного доверия — no-op: undici не загружается, dispatcher не ставится', async () => {
    const loadUndici = vi.fn();
    await applyGlobalTlsTrust({ rejectUnauthorized: true }, { loadUndici });
    expect(loadUndici).not.toHaveBeenCalled();
    expect(isTlsTrustConfigured()).toBe(false);
  });

  it('заданное доверие (ca) → строит Agent и ставит global dispatcher', async () => {
    const { module, setGlobalDispatcher } = fakeUndici();
    await applyGlobalTlsTrust({ ca: CERT_PEM, rejectUnauthorized: true }, { loadUndici: async () => module });
    expect(isTlsTrustConfigured()).toBe(true);
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const agent = setGlobalDispatcher.mock.calls[0]![0] as { opts?: { connect?: { ca?: string } } };
    expect(agent.opts?.connect?.ca).toBe(CERT_PEM);
  });

  it('заданное доверие + отсутствует undici → TlsDependencyUnavailableError', async () => {
    await expect(
      applyGlobalTlsTrust(
        { ca: CERT_PEM, rejectUnauthorized: true },
        { loadUndici: async () => { throw new Error('Cannot find module undici'); } },
      ),
    ).rejects.toBeInstanceOf(TlsDependencyUnavailableError);
  });

  it('rejectUnauthorized=false тоже считается заданным доверием', async () => {
    const { module, setGlobalDispatcher } = fakeUndici();
    await applyGlobalTlsTrust({ rejectUnauthorized: false }, { loadUndici: async () => module });
    expect(isTlsTrustConfigured()).toBe(true);
    const agent = setGlobalDispatcher.mock.calls[0]![0] as {
      opts?: { connect?: { rejectUnauthorized?: boolean } };
    };
    expect(agent.opts?.connect?.rejectUnauthorized).toBe(false);
  });
});

describe('egressFetch', () => {
  beforeEach(() => _resetTlsTrustForTests());

  it('без доверия — обычный fetch (без dispatcher)', async () => {
    const { impl, calls } = recordingFetch();
    await egressFetch('https://example.test/', undefined, { fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init as { dispatcher?: unknown } | undefined)?.dispatcher).toBeUndefined();
  });

  it('явный dispatcher прокидывается в init', async () => {
    const { impl, calls } = recordingFetch();
    const dispatcher = { id: 'fake-dispatcher' };
    await egressFetch('https://example.test/', { method: 'POST' }, { fetchImpl: impl, dispatcher });
    const init = calls[0]!.init as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBe(dispatcher);
    expect(init.method).toBe('POST');
  });

  it('после applyGlobalTlsTrust использует dispatcher доверия процесса', async () => {
    const { module } = fakeUndici();
    await applyGlobalTlsTrust({ ca: CERT_PEM, rejectUnauthorized: true }, { loadUndici: async () => module });
    const { impl, calls } = recordingFetch();
    await egressFetch('https://example.test/', undefined, { fetchImpl: impl });
    expect((calls[0]!.init as { dispatcher?: unknown } | undefined)?.dispatcher).toBeDefined();
  });
});

/**
 * ADR-099 (фикс egress): `fetch` и dispatcher должны быть **одного происхождения**
 * (один пакет `undici`). Глобальный `fetch` Node — встроенный undici другой версии:
 * его контракт диспетчера несовместим с диспетчером из `undici@7`, и ответ приходит
 * **без заголовков** (`content-type: null`) — ломалось чтение tools/list у
 * HTTP-MCP-серверов (ADR-071).
 */
describe('egressFetch: происхождение транспорта (ADR-099)', () => {
  let httpServer: HttpServer;
  let baseUrl: string;

  beforeAll(async () => {
    httpServer = createHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  beforeEach(() => {
    _resetTlsTrustForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetTlsTrustForTests();
  });

  it('регресс: заданный dispatcher не теряет заголовки ответа', async () => {
    const agent = new undici.Agent();
    try {
      const res = await egressFetch(`${baseUrl}/mcp`, { method: 'POST' }, { dispatcher: agent });
      expect(res.status).toBe(200);
      // До фикса здесь было `null`: глобальный fetch Node + чужой Dispatcher.
      expect(res.headers.get('content-type')).toBe('application/json');
    } finally {
      await agent.close();
    }
  });

  it('при заданном dispatcher используется fetch из undici, а не глобальный', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const undiciFetch = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response('ok'));
    const loadUndici = vi.fn(async () => ({ fetch: undiciFetch }) as unknown as typeof import('undici'));
    const dispatcher = { id: 'fake-dispatcher' };

    await egressFetch('https://example.test/', undefined, { dispatcher, loadUndici });

    expect(loadUndici).toHaveBeenCalledTimes(1);
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
    const init = undiciFetch.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBe(dispatcher);
  });

  it('без dispatcher — глобальный fetch, undici не грузится', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const loadUndici = vi.fn();

    await egressFetch('https://example.test/', undefined, { loadUndici });

    expect(loadUndici).not.toHaveBeenCalled();
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });

  it('deps.fetchImpl используется как раньше (dispatcher уходит в init)', async () => {
    const { impl, calls } = recordingFetch();
    const dispatcher = { id: 'fake-dispatcher' };
    const loadUndici = vi.fn();

    await egressFetch('https://example.test/', { method: 'POST' }, { fetchImpl: impl, dispatcher, loadUndici });

    expect(loadUndici).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    const init = calls[0]!.init as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBe(dispatcher);
    expect(init.method).toBe('POST');
  });

  it('undici недоступен при заданном dispatcher → TlsDependencyUnavailableError', async () => {
    await expect(
      egressFetch(
        'https://example.test/',
        undefined,
        {
          dispatcher: { id: 'fake-dispatcher' },
          loadUndici: async () => {
            throw new Error('Cannot find module undici');
          },
        },
      ),
    ).rejects.toBeInstanceOf(TlsDependencyUnavailableError);
  });
});

describe('интеграция с node:https (self-signed)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer(
      { key: readFileSync(KEY_PATH, 'utf-8'), cert: CERT_PEM },
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `https://127.0.0.1:${port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    _resetTlsTrustForTests();
    // Чистое системное доверие: без пользовательского CA (иначе negative-тест
    // унаследует dispatcher предыдущего теста).
    undici.setGlobalDispatcher(new undici.Agent());
  });

  afterEach(() => _resetTlsTrustForTests());

  it('без CA → ошибка проверки самоподписанного сертификата', async () => {
    let error: unknown;
    try {
      await egressFetch(baseUrl);
      error = undefined;
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    const code = (error as { cause?: { code?: string } })?.cause?.code;
    const causeMsg = (error as { cause?: { message?: string } })?.cause?.message ?? '';
    const msg = `${String(error)} ${code ?? ''} ${causeMsg}`;
    expect(msg).toMatch(/self[- ]signed|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|certificate/i);
  });

  it('с caPem → успешный запрос', async () => {
    const trust = buildTlsTrust({ security: { tls: { caPem: CERT_PEM } } }, {});
    await applyGlobalTlsTrust(trust);
    const res = await egressFetch(baseUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('с caFile → успешный запрос', async () => {
    const trust = buildTlsTrust({ security: { tls: { caFile: CERT_PATH } } }, {});
    await applyGlobalTlsTrust(trust);
    const res = await egressFetch(baseUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
