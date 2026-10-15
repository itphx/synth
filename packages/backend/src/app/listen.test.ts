/**
 * `createBackendListen` (`src/app/listen.ts`) — HTTP-адаптер приложения и
 * WebSocket-апгрейд `/ws/events`. Проверяем:
 *  - HTTP-сервер раздаёт Hono-приложение (`GET /health` → 200);
 *  - апгрейд `/ws/events` без креды отклоняется (сокет не становится WS);
 *  - апгрейд на неизвестный путь отклоняется (только `/ws/events` — единственный канал);
 *  - с валидной debug-кредой клиент получает кадр `connected`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

const USER = 'user-key-456';

describe('createBackendListen: HTTP + WebSocket /ws/events', () => {
  let dataDir: string;
  let backend: BackendAppHandle;
  let server: Server;
  let wss: WebSocketServer;
  let port: number;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-listen-'));
    backend = await createBackendApp({ dataDir, authDebug: true });
    const started = await backend.listen(0, '127.0.0.1');
    server = started.server;
    wss = started.wss;
    port = started.port;
  });

  afterAll(async () => {
    backend.stopScheduler();
    backend.stopEphemeralSweeper();
    backend.stopEventJournalPruner();
    backend.stopWebhookService();
    backend.stopWebhookDeliveryPruner();
    for (const ws of sockets) ws.close();
    wss.close();
    await new Promise<void>((resolve) => {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close(() => resolve());
    });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** Попытка WS-апгрейда: `opened` — стал ли сокет WebSocket; `status` — код отказа. */
  function openWs(path: string, token?: string): Promise<{ opened: boolean; status?: number }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}${path}`,
        token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
      );
      sockets.push(ws);
      let done = false;
      const finish = (v: { opened: boolean; status?: number }): void => {
        if (done) return;
        done = true;
        resolve(v);
      };
      ws.once('open', () => finish({ opened: true }));
      ws.once('unexpected-response', (_req, res) => finish({ opened: false, status: res.statusCode }));
      ws.once('error', () => finish({ opened: false }));
    });
  }

  it('HTTP-сервер раздаёт Hono-приложение (порт 0 → эфемерный)', async () => {
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('healthy');
  });

  it('/ws/events без креды — апгрейд отклоняется', async () => {
    const res = await openWs('/ws/events');
    expect(res.opened).toBe(false);
    if (res.status !== undefined) expect(res.status).toBe(401);
  });

  it('неизвестный путь апгрейда — отклоняется (единственный WS-канал)', async () => {
    const res = await openWs('/ws/other', USER);
    expect(res.opened).toBe(false);
    if (res.status !== undefined) expect(res.status).toBe(404);
  });

  it('/ws/events с валидной кредой — апгрейд принят, приходит кадр connected', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, {
      headers: { Authorization: `Bearer ${USER}` },
    });
    sockets.push(ws);

    const connected = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      ws.on('message', (raw) => {
        try {
          if ((JSON.parse(raw.toString()) as { type?: string }).type === 'connected') done(true);
        } catch {
          // ignore
        }
      });
      ws.once('error', () => done(false));
      setTimeout(() => done(false), 2000);
    });

    expect(connected).toBe(true);
    ws.close();
  });
});
