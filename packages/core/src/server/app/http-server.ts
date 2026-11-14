// HTTP-адаптер standalone-core: Node-запрос → web `Request`, раздача статики UI,
// прокачка ответа Hono в Node-ответ (включая SSE/долгоживущие стримы).
// Вынесено из `server/app.ts` (ADR-095, шаг 4a) — «вынос по швам», без изменения поведения.
import { createServer, IncomingMessage } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import type { Hono } from 'hono';
import { serveStatic } from './static.js';

export interface StandaloneHttpServerOptions {
  /** Hono-приложение (роуты монтируются до создания сервера). */
  app: Hono;
  /** Каталог собранного UI; не задан/отсутствует — статика не раздаётся. */
  uiDistPath?: string;
}

/**
 * Node `IncomingMessage` → web `Request` (для `app.fetch`).
 *
 * `signal` — сигнал отключения клиента: transport абортит его, когда
 * соединение закрывается, и хендлеры долгоживущих потоков (терминал, SSE) по
 * нему снимают подписки. Без сигнала `c.req.raw.signal` не абортится никогда.
 */
export function toWebRequest(req: IncomingMessage, signal?: AbortSignal): Request {
  const protocol = 'http';
  const host = req.headers.host || 'localhost';
  const url = `${protocol}://${host}${req.url || '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const method = req.method || 'GET';
  const noBody = ['GET', 'HEAD'].includes(method) || !req.headers['content-length'];
  return new Request(url, {
    method,
    headers,
    body: noBody ? undefined : (Readable.toWeb(req) as ReadableStream),
    duplex: 'half',
    ...(signal ? { signal } : {}),
  } as RequestInit);
}

/**
 * Создать Node HTTP-сервер: статика UI для GET-запросов без API-префиксов,
 * иначе — Hono (`app.fetch`); ответ прокачивается в Node-ответ.
 */
export function createStandaloneHttpServer(opts: StandaloneHttpServerOptions): Server {
  const { app } = opts;

  const staticHandler = opts.uiDistPath && existsSync(opts.uiDistPath)
    ? serveStatic(opts.uiDistPath)
    : null;

  return createServer(async (req, res) => {
    try {
      // Сигнал отключения клиента для `c.req.raw.signal`: Node сообщает о
      // закрытии соединения событием `close` ответа (в т.ч. по таймауту
      // `curl -m`). Без этого хендлеры долгоживущих потоков (терминал, SSE)
      // не узнают об уходе клиента и не снимают подписки.
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      const webReq = toWebRequest(req, abort.signal);
      const url = new URL(webReq.url);

      // Статика UI для GET-запросов без префиксов API
      if (staticHandler && webReq.method === 'GET'
        && !url.pathname.startsWith('/api/')
        && !url.pathname.startsWith('/auth/')
        && !url.pathname.startsWith('/admin/')
        && !url.pathname.startsWith('/ws')
        && !url.pathname.startsWith('/health')
        // ADR-094: `/metrics` и `/ready` — не SPA-статика (иначе index.html).
        && !url.pathname.startsWith('/metrics')
        && !url.pathname.startsWith('/ready')) {
        const staticResp = await staticHandler(webReq);
        if (staticResp) {
          const headers = Object.fromEntries(staticResp.headers.entries());
          res.writeHead(staticResp.status, headers);
          if (staticResp.body) {
            const reader = staticResp.body.getReader();
            pumpBody(reader, res);
          } else {
            res.end();
          }
          return;
        }
      }

      const response = await app.fetch(webReq, {});
      if (!response) {
        res.writeHead(500);
        res.end();
        return;
      }
      const headers = Object.fromEntries(response.headers.entries());
      res.writeHead(response.status, headers);
      // SSE/долгоживущие стримы: при chunked-кодировании Node не сбрасывает
      // заголовки в сокет до первого write()/end(). Для пустого начала стрима
      // (SSE до первого события/keepalive) клиент иначе не получит заголовки
      // вовсе — сбрасываем head принудительно.
      res.flushHeaders();
      if (response.body) {
        pumpBody(response.body.getReader(), res);
      } else {
        res.end();
      }
    } catch {
      // После аборта клиента ответ уже может быть частично отправлен —
      // повторный `writeHead` дал бы `ERR_HEADERS_SENT` в обработчике.
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}

/**
 * Прокачать web-поток в Node-ответ.
 *
 * При закрытии соединения клиентом читатель **отменяется**: иначе цикл
 * `reader.read()` висит вечно, `ReadableStream.cancel()` исходного потока не
 * вызывается, и подписка на стороне хендлера (терминал, SSE) остаётся живой.
 */
function pumpBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: ServerResponse,
): void {
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  res.on('close', cancel);
  const pump = async (): Promise<void> => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || res.destroyed) break;
        res.write(value);
      }
      res.end();
    } catch {
      res.end();
    } finally {
      res.off('close', cancel);
    }
  };
  void pump();
}
