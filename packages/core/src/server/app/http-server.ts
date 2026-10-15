// HTTP-адаптер standalone-core: Node-запрос → web `Request`, раздача статики UI,
// прокачка ответа Hono в Node-ответ (включая SSE/долгоживущие стримы).
// Вынесено из `server/app.ts` (ADR-095, шаг 4a) — «вынос по швам», без изменения поведения.
import { createServer, IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
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

/** Node `IncomingMessage` → web `Request` (для `app.fetch`). */
export function toWebRequest(req: IncomingMessage): Request {
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
      const webReq = toWebRequest(req);
      const url = new URL(webReq.url);

      // Статика UI для GET-запросов без префиксов API
      if (staticHandler && webReq.method === 'GET'
        && !url.pathname.startsWith('/api/')
        && !url.pathname.startsWith('/auth/')
        && !url.pathname.startsWith('/admin/')
        && !url.pathname.startsWith('/ws')
        && !url.pathname.startsWith('/health')) {
        const staticResp = await staticHandler(webReq);
        if (staticResp) {
          const headers = Object.fromEntries(staticResp.headers.entries());
          res.writeHead(staticResp.status, headers);
          if (staticResp.body) {
            const reader = staticResp.body.getReader();
            const pump = async () => {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
              res.end();
            };
            pump().catch(() => res.end());
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
        const reader = response.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        };
        pump().catch(() => res.end());
      } else {
        res.end();
      }
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
}
