/**
 * Детерминированный fake HTTP-прокси для тестов ADR-099 (D1): без внешней сети.
 *
 * Поддерживает:
 * - `tunnel` — `CONNECT`-туннель к локальной цели (плюс absolute-URI-запросы);
 * - `407` — отвечает `407 Proxy Authentication Required` с `Proxy-Authenticate`;
 * - `502` — отвечает `502` на `CONNECT`;
 * - `close` — сразу закрывает соединение (недоступный прокси);
 * - `silent` — принимает TCP, но не отвечает (таймаут).
 *
 * Счётчики `connects`/`absoluteRequests` — доказательство, что запрос реально
 * ушёл через прокси (а не напрямую).
 */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export type FakeProxyMode = 'tunnel' | '407' | '502' | 'close' | 'silent';

export interface FakeProxyOptions {
  mode?: FakeProxyMode;
  /** Значение `Proxy-Authenticate` для режима `407`. */
  authChallenge?: string;
}

export interface FakeProxy {
  url: string;
  port: number;
  /** Число полученных `CONNECT`-запросов. */
  readonly connects: number;
  /** Число absolute-URI HTTP-запросов. */
  readonly absoluteRequests: number;
  close(): Promise<void>;
}

/** Поднимает fake-прокси на 127.0.0.1 со случайным портом. */
export async function startFakeProxy(options: FakeProxyOptions = {}): Promise<FakeProxy> {
  const mode = options.mode ?? 'tunnel';
  let connects = 0;
  let absoluteRequests = 0;
  const sockets = new Set<net.Socket>();

  const server = http.createServer((req, res) => {
    absoluteRequests += 1;
    if (mode === '407') {
      res.writeHead(407, {
        'Proxy-Authenticate': options.authChallenge ?? 'Basic realm="fake"',
        'Content-Length': '0',
      });
      res.end();
      return;
    }
    if (mode === '502') {
      res.writeHead(502);
      res.end('bad gateway');
      return;
    }
    if (mode === 'close') {
      req.destroy();
      return;
    }
    if (mode === 'silent') return;

    // absolute-URI: прокси открывает соединение с целью и ретранслирует ответ.
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400);
      res.end('absolute URI required');
      return;
    }
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end('upstream error');
    });
    req.pipe(upstream);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('connect', (req, clientSocket, head) => {
    connects += 1;
    if (mode === '407') {
      clientSocket.end(
        `HTTP/1.1 407 Proxy Authentication Required\r\n` +
          `Proxy-Authenticate: ${options.authChallenge ?? 'Basic realm="fake"'}\r\n` +
          `Content-Length: 0\r\n\r\n`,
      );
      return;
    }
    if (mode === '502') {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (mode === 'close') {
      clientSocket.destroy();
      return;
    }
    if (mode === 'silent') return;

    const [host, portRaw] = splitHostPort(req.url ?? '');
    const port = Number(portRaw);
    if (!host || !Number.isInteger(port)) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    clientSocket.on('error', () => upstream.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    get connects() {
      return connects;
    },
    get absoluteRequests() {
      return absoluteRequests;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Разбирает `host:port` из CONNECT-запроса (IPv6 — в скобках). */
function splitHostPort(value: string): [string, string] {
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return ['', ''];
    return [value.slice(1, end), value.slice(end + 2)];
  }
  const idx = value.lastIndexOf(':');
  if (idx <= 0) return ['', ''];
  return [value.slice(0, idx), value.slice(idx + 1)];
}

/** Простой локальный HTTP-target с счётчиком запросов (для проверки direct/fallback). */
export interface FakeTarget {
  url: string;
  port: number;
  readonly requests: number;
  close(): Promise<void>;
}

export async function startFakeTarget(): Promise<FakeTarget> {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    get requests() {
      return requests;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
