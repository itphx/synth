/**
 * PROP-090 Ф4б-1: тесты клиента удалённого плагина (`remote/client.ts`).
 *
 * Проверки — на **реальном** `node:http`-сервере на `127.0.0.1:0`: подмена
 * `fetch` скрыла бы именно те дефекты (Authorization, таймаут, разбор ошибок),
 * ради которых клиент написан.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PLUGIN_PROTOCOL_VERSION } from '@itphx/synth-shared';

import { RemotePluginClient, RemotePluginUnavailableError } from './client.js';

const TOKEN = 'plugin-client-token-test-1234567890';
const NAME = 'demo-plugin';
const VERSION = '1.0.0';

/** Запущенные заглушки (закрываются в `afterEach`). */
const servers: Array<{ close: () => Promise<void> }> = [];

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void | Promise<void>;

/** Поднять HTTP-заглушку на случайном loopback-порту. */
async function startStub(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      void Promise.resolve(handler(req, res, body)).catch(() => {
        if (!res.writableEnded) res.destroy();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ close }) => close()));
});

/** Ответ JSON с кодом. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Валидный ответ `/capabilities`. */
function capabilities(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: PLUGIN_PROTOCOL_VERSION,
    name: NAME,
    version: VERSION,
    points: {
      promptBlocks: [{ key: 'plugin.demo.memory', tier: 'context', order: 100 }],
      llmFilters: [{ id: 'plugin:demo-plugin:dlp', phase: 'pre_request' }],
    },
    ...over,
  };
}

/** Клиент на loopback-адрес заглушки. */
function makeClient(url: string, over: { timeoutMs?: number } = {}): RemotePluginClient {
  return new RemotePluginClient({
    baseUrl: url,
    token: TOKEN,
    name: NAME,
    version: VERSION,
    ...over,
  });
}

/** Ожидаемая ошибка клиента с причиной. */
async function expectUnavailable(
  promise: Promise<unknown>,
  reason: string,
): Promise<RemotePluginUnavailableError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RemotePluginUnavailableError);
  const unavailable = err as RemotePluginUnavailableError;
  expect(unavailable.reason).toBe(reason);
  expect(unavailable.message).not.toContain(TOKEN);
  return unavailable;
}

/** Порт, на котором никто не слушает (соединение отклоняется). */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('RemotePluginClient: health', () => {
  it('200 → true, запрос идёт без Authorization', async () => {
    let authHeader: string | undefined = 'sentinel';
    const url = await startStub((req, res) => {
      authHeader = req.headers.authorization;
      expect(req.url).toBe('/health');
      sendJson(res, 200, { status: 'ok' });
    });
    expect(await makeClient(url).health()).toBe(true);
    expect(authHeader).toBeUndefined();
  });

  it('500 → false (процесс ответил, но не жив)', async () => {
    const url = await startStub((_req, res) => sendJson(res, 500, { error: { reason: 'internal_error' } }));
    expect(await makeClient(url).health()).toBe(false);
  });

  it('недоступный порт → false (health не бросает)', async () => {
    const port = await deadPort();
    expect(await makeClient(`http://127.0.0.1:${port}`).health()).toBe(false);
  });
});

describe('RemotePluginClient: capabilities', () => {
  it('валидный ответ → снимок точек; Bearer-токен отправлен', async () => {
    let authHeader: string | undefined;
    const url = await startStub((req, res) => {
      authHeader = req.headers.authorization;
      expect(req.url).toBe('/capabilities');
      sendJson(res, 200, capabilities());
    });

    const caps = await makeClient(url).capabilities();
    expect(authHeader).toBe(`Bearer ${TOKEN}`);
    expect(caps.points.promptBlocks?.[0]).toMatchObject({ key: 'plugin.demo.memory', tier: 'context' });
    expect(caps.points.llmFilters?.[0]).toMatchObject({ id: 'plugin:demo-plugin:dlp' });
  });

  it('чужая версия протокола → protocol_mismatch', async () => {
    const url = await startStub((_req, res) =>
      sendJson(res, 200, capabilities({ protocol: PLUGIN_PROTOCOL_VERSION + 1 })),
    );
    await expectUnavailable(makeClient(url).capabilities(), 'protocol_mismatch');
  });

  it('чужое имя плагина → protocol_mismatch', async () => {
    const url = await startStub((_req, res) => sendJson(res, 200, capabilities({ name: 'other' })));
    await expectUnavailable(makeClient(url).capabilities(), 'protocol_mismatch');
  });

  it('мусор вместо /capabilities → invalid_request', async () => {
    const url = await startStub((_req, res) => sendJson(res, 200, { hello: 'world' }));
    await expectUnavailable(makeClient(url).capabilities(), 'invalid_request');
  });

  it('не-JSON тело → internal_error', async () => {
    const url = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not json');
    });
    await expectUnavailable(makeClient(url).capabilities(), 'internal_error');
  });
});

describe('RemotePluginClient: invoke', () => {
  it('успешный вызов → output; тело соответствует протоколу', async () => {
    let received: Record<string, unknown> | undefined;
    const url = await startStub((req, res, body) => {
      expect(req.url).toBe('/invoke');
      expect(req.method).toBe('POST');
      expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
      received = JSON.parse(body) as Record<string, unknown>;
      sendJson(res, 200, { ok: true, output: { content: 'ПАМЯТЬ' } });
    });

    const client = makeClient(url);
    const output = await client.invoke('promptBlocks', 'plugin.demo.memory', { sessionId: 's1' });
    expect(output).toEqual({ content: 'ПАМЯТЬ' });
    expect(received).toMatchObject({
      protocol: PLUGIN_PROTOCOL_VERSION,
      point: 'promptBlocks',
      id: 'plugin.demo.memory',
      input: { sessionId: 's1' },
    });
  });

  it('{ok:false} в 200 → ошибка с причиной из тела', async () => {
    const url = await startStub((_req, res) =>
      sendJson(res, 200, { ok: false, error: { reason: 'unknown_point' } }),
    );
    const err = await expectUnavailable(
      makeClient(url).invoke('llmFilters', 'x', {}),
      'unknown_point',
    );
    expect(err.status).toBe(200);
  });

  it('404 с телом ошибки → reason/status из ответа', async () => {
    const url = await startStub((_req, res) =>
      sendJson(res, 404, {
        error: { reason: 'unknown_id', code: 'NO_FILTER', message: 'фильтр не найден' },
      }),
    );
    const err = await expectUnavailable(
      makeClient(url).invoke('llmFilters', 'plugin:demo-plugin:nope', {}),
      'unknown_id',
    );
    expect(err.status).toBe(404);
    expect(err.message).toBe('фильтр не найден');
  });

  it('401 без тела → unauthorized', async () => {
    const url = await startStub((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    await expectUnavailable(makeClient(url).invoke('promptBlocks', 'x', {}), 'unauthorized');
  });

  it('ответ не по протоколу → internal_error', async () => {
    const url = await startStub((_req, res) => sendJson(res, 200, { ok: 'yes' }));
    await expectUnavailable(makeClient(url).invoke('promptBlocks', 'x', {}), 'internal_error');
  });

  it('таймаут (сервер не отвечает 100 мс при timeoutMs=20) → timeout', async () => {
    const url = await startStub((_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded && !res.destroyed) sendJson(res, 200, { ok: true, output: null });
      }, 100);
    });
    const client = makeClient(url, { timeoutMs: 20 });
    await expectUnavailable(client.invoke('promptBlocks', 'x', {}), 'timeout');
  });

  it('недоступный порт → connection_failed', async () => {
    const port = await deadPort();
    await expectUnavailable(
      makeClient(`http://127.0.0.1:${port}`).invoke('promptBlocks', 'x', {}),
      'connection_failed',
    );
  });
});

describe('RemotePluginClient: защита', () => {
  it('внешний хост запрещён (loopback-only)', () => {
    expect(
      () =>
        new RemotePluginClient({
          baseUrl: 'http://example.com:8080',
          token: TOKEN,
          name: NAME,
          version: VERSION,
        }),
    ).toThrowError(RemotePluginUnavailableError);
    try {
      new RemotePluginClient({
        baseUrl: 'http://example.com:8080',
        token: TOKEN,
        name: NAME,
        version: VERSION,
      });
    } catch (err) {
      expect((err as RemotePluginUnavailableError).reason).toBe('connection_failed');
    }
  });

  it('https/креды/query в адресе запрещены', () => {
    for (const baseUrl of [
      'https://127.0.0.1:1234',
      'http://user:pass@127.0.0.1:1234',
      'http://127.0.0.1:1234/?x=1',
      'not-a-url',
    ]) {
      expect(
        () =>
          new RemotePluginClient({ baseUrl, token: TOKEN, name: NAME, version: VERSION }),
        baseUrl,
      ).toThrowError(RemotePluginUnavailableError);
    }
  });

  it('localhost и [::1] принимаются как loopback', () => {
    for (const baseUrl of ['http://localhost:1234', 'http://[::1]:1234', 'http://127.0.0.1:1234']) {
      expect(
        () => new RemotePluginClient({ baseUrl, token: TOKEN, name: NAME, version: VERSION }),
        baseUrl,
      ).not.toThrow();
    }
  });

  it('пустой токен и неверный таймаут — отказ конструкции', () => {
    expect(
      () =>
        new RemotePluginClient({ baseUrl: 'http://127.0.0.1:1', token: '  ', name: NAME, version: VERSION }),
    ).toThrowError(RemotePluginUnavailableError);
    expect(
      () =>
        new RemotePluginClient({
          baseUrl: 'http://127.0.0.1:1',
          token: TOKEN,
          name: NAME,
          version: VERSION,
          timeoutMs: 0,
        }),
    ).toThrowError(RemotePluginUnavailableError);
  });

  it('токен не попадает в текст ошибки, даже если сервер его эхом вернул', async () => {
    const url = await startStub((req, res) => {
      sendJson(res, 500, {
        error: {
          reason: 'internal_error',
          message: `internal failure (authorization: ${req.headers.authorization ?? ''})`,
        },
      });
    });
    const err = await expectUnavailable(
      makeClient(url).invoke('promptBlocks', 'x', {}),
      'internal_error',
    );
    expect(err.message).toContain('***');
    expect(err.message).not.toContain(TOKEN);
  });
});
