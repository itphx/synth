/**
 * Минимальный fake SOCKS5-прокси (RFC 1928/1929) для тестов ADR-099 (D2b).
 * Без внешних зависимостей: greeting/methods, no-auth и user/pass, CONNECT + pipe.
 */
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { closeTestServer } from './close-server.js';

export interface FakeSocks5Options {
  /** Требовать user/pass (метод 0x02); иначе — no-auth (0x00). */
  auth?: { username: string; password: string };
}

export interface FakeSocks5Proxy {
  url: string;
  port: number;
  /** Всего TCP-соединений к SOCKS-серверу. */
  readonly connections: number;
  /** Выбранные методы аутентификации (0x00/0x02/0xff). */
  readonly methods: number[];
  /** Попытки user/pass (для проверки кред). */
  readonly authAttempts: number;
  /** Запрошенные цели CONNECT (`host:port`). */
  readonly targets: string[];
  close(): Promise<void>;
}

const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

export async function startFakeSocks5Proxy(options: FakeSocks5Options = {}): Promise<FakeSocks5Proxy> {
  let connections = 0;
  const methods: number[] = [];
  let authAttempts = 0;
  const targets: string[] = [];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let stage: 'greeting' | 'auth' | 'request' | 'tunnel' = 'greeting';

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        processBuffer();
      } catch {
        socket.destroy();
      }
    };

    const processBuffer = (): void => {
      if (stage === 'tunnel') return;
      // Greeting: VER, NMETHODS, METHODS.
      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        const n = buffer[1]!;
        if (buffer.length < 2 + n) return;
        const offered = [...buffer.subarray(2, 2 + n)];
        buffer = buffer.subarray(2 + n);

        let method = 0xff;
        if (options.auth) {
          method = offered.includes(0x02) ? 0x02 : 0xff;
        } else if (offered.includes(0x00)) {
          method = 0x00;
        }
        methods.push(method);
        socket.write(Buffer.from([0x05, method]));
        if (method === 0x02) {
          stage = 'auth';
        } else if (method === 0x00) {
          stage = 'request';
        } else {
          socket.end();
          return;
        }
      }

      // RFC 1929: VER=1, ULEN, USER, PLEN, PASS.
      if (stage === 'auth') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x01) {
          socket.end(Buffer.from([0x01, 0x01]));
          return;
        }
        const ulen = buffer[1]!;
        if (buffer.length < 2 + ulen + 1) return;
        const plen = buffer[2 + ulen]!;
        if (buffer.length < 3 + ulen + plen) return;
        const username = buffer.subarray(2, 2 + ulen).toString('utf8');
        const password = buffer.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
        buffer = buffer.subarray(3 + ulen + plen);
        authAttempts += 1;
        const ok = options.auth && username === options.auth.username && password === options.auth.password;
        socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
        if (!ok) {
          socket.end();
          return;
        }
        stage = 'request';
      }

      // CONNECT: VER, CMD, RSV, ATYP, ADDR, PORT.
      if (stage === 'request') {
        if (buffer.length < 4) return;
        if (buffer[0] !== 0x05 || buffer[1] !== 0x01) {
          socket.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const atyp = buffer[3]!;
        let offset = 4;
        let host = '';
        if (atyp === ATYP_IPV4) {
          if (buffer.length < offset + 4 + 2) return;
          host = [...buffer.subarray(offset, offset + 4)].join('.');
          offset += 4;
        } else if (atyp === ATYP_DOMAIN) {
          if (buffer.length < offset + 1) return;
          const len = buffer[offset]!;
          if (buffer.length < offset + 1 + len + 2) return;
          host = buffer.subarray(offset + 1, offset + 1 + len).toString('utf8');
          offset += 1 + len;
        } else if (atyp === ATYP_IPV6) {
          if (buffer.length < offset + 16 + 2) return;
          const parts: string[] = [];
          for (let i = 0; i < 16; i += 2) parts.push(buffer.readUInt16BE(offset + i).toString(16));
          host = parts.join(':');
          offset += 16;
        } else {
          socket.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const port = buffer.readUInt16BE(offset);
        const rest = buffer.subarray(offset + 2);
        buffer = Buffer.alloc(0);
        targets.push(`${host}:${port}`);
        // Дальше — прозрачный туннель: HTTP-трафик не парсим.
        stage = 'tunnel';
        socket.off('data', onData);

        const upstream = net.connect(port, host, () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (rest.length > 0) upstream.write(rest);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on('error', () => {
          socket.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        });
        socket.on('error', () => upstream.destroy());
      }
    };

    socket.on('data', onData);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: `socks5://127.0.0.1:${address.port}`,
    port: address.port,
    get connections() {
      return connections;
    },
    get methods() {
      return methods;
    },
    get authAttempts() {
      return authAttempts;
    },
    get targets() {
      return targets;
    },
    async close() {
      await closeTestServer(server, { sockets });
    },
  };
}
