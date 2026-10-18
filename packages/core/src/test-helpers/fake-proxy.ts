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
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export type FakeProxyMode = 'tunnel' | '407' | '502' | 'close' | 'silent';

export interface FakeProxyTlsOptions {
  key: string | Buffer;
  cert: string | Buffer;
  /** CA для проверки клиентского сертификата (mTLS). */
  ca?: string | Buffer;
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
  /** Требовать клиентский сертификат (эмуляция mTLS: без него — destroy). */
  requireClientCert?: boolean;
}

export interface FakeProxyOptions {
  mode?: FakeProxyMode;
  /** Значение `Proxy-Authenticate` для режима `407`. */
  authChallenge?: string;
  /** Ожидаемый `Proxy-Authorization`; иначе/неверный → `407` (Basic-проверка). */
  requireAuth?: string;
  /** HTTPS-прокси (TLS + mTLS) — иначе plain HTTP. */
  tls?: FakeProxyTlsOptions;
}

export interface FakeProxy {
  url: string;
  port: number;
  /** Число полученных `CONNECT`-запросов. */
  readonly connects: number;
  /** Число absolute-URI HTTP-запросов. */
  readonly absoluteRequests: number;
  /** `Proxy-Authorization` каждого CONNECT (в порядке поступления). */
  readonly connectAuthHeaders: string[];
  /** `host:port` каждого CONNECT (в порядке поступления) — проверка маршрута. */
  readonly connectTargets: string[];
  /** `Proxy-Authorization` каждого absolute-URI-запроса. */
  readonly absoluteAuthHeaders: string[];
  /** Subject клиентских сертификатов (mTLS), в порядке подключений. */
  readonly clientCertSubjects: string[];
  close(): Promise<void>;
}

/** Поднимает fake-прокси на 127.0.0.1 со случайным портом. */
export async function startFakeProxy(options: FakeProxyOptions = {}): Promise<FakeProxy> {
  const mode = options.mode ?? 'tunnel';
  let connects = 0;
  let absoluteRequests = 0;
  const connectAuthHeaders: string[] = [];
  const connectTargets: string[] = [];
  const absoluteAuthHeaders: string[] = [];
  const clientCertSubjects: string[] = [];
  const sockets = new Set<net.Socket>();

  const authHeaderOf = (req: http.IncomingMessage): string | undefined => {
    const raw = req.headers['proxy-authorization'];
    return Array.isArray(raw) ? raw[0] : raw;
  };

  const authRejected = (header: string | undefined): boolean =>
    options.requireAuth !== undefined && header !== options.requireAuth;

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    absoluteRequests += 1;
    absoluteAuthHeaders.push(authHeaderOf(req) ?? '');
    if (mode === '407' || authRejected(authHeaderOf(req))) {
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
  };

  const server: http.Server = options.tls
    ? (https.createServer(options.tls, handler) as unknown as http.Server)
    : http.createServer(handler);

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  if (options.tls?.requireClientCert) {
    // Эмуляция «mTLS обязателен»: TLS-хендшейк завершаем, но без клиентского
    // сертификата рвём соединение (детерминированно, без ожидания таймаута).
    (server as unknown as import('node:tls').Server).on('secureConnection', (socket) => {
      const cert = (socket as import('node:tls').TLSSocket).getPeerCertificate();
      const commonName = cert && Object.keys(cert).length > 0 ? cert.subject?.CN : undefined;
      const subject = Array.isArray(commonName) ? commonName[0] : commonName;
      clientCertSubjects.push(subject ?? '');
      if (!subject) socket.destroy();
    });
  }

  server.on('connect', (req, clientSocket, head) => {
    connects += 1;
    const auth = authHeaderOf(req);
    connectAuthHeaders.push(auth ?? '');
    connectTargets.push(req.url ?? '');
    if (mode === '407' || authRejected(auth)) {
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
    get connectAuthHeaders() {
      return connectAuthHeaders;
    },
    get connectTargets() {
      return connectTargets;
    },
    get absoluteAuthHeaders() {
      return absoluteAuthHeaders;
    },
    get clientCertSubjects() {
      return clientCertSubjects;
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
