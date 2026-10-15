// ADR-089 (P0): авторизация WebSocket `/ws/events`. До фикса любой
// аутентифицированный USER мог писать промпты в чужую сессию (`send_message`),
// отменять её (`cancel`) и подтверждать запросы прав (`permission_reply`/
// `permission_hold`) — без проверки видимости сессии. Тест проверяет, что
// доступ ограничен `isSessionVisible` (владелец/участник проекта; ADMIN/LEAD и
// service-key — сквозной обзор), а недоступная сессия неотличима от несуществующей.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

const ADMIN_KEY = 'admin-key-123';
const USER_KEY = 'user-key-456';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Клиент-обёртка: копит входящие WS-сообщения и умеет ждать по предикату. */
function makeClient(ws: WebSocket) {
  const messages: any[] = [];
  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()));
    } catch {
      // ignore
    }
  });
  return {
    messages,
    async waitFor(pred: (m: any) => boolean, timeoutMs = 1500): Promise<any | undefined> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find(pred);
        if (found) return found;
        await sleep(20);
      }
      return undefined;
    },
  };
}

describe('ADR-089 (P0): авторизация WebSocket /ws/events (backend)', () => {
  let dataDir: string;
  let backend: BackendAppHandle;
  let server: Server;
  let wss: WebSocketServer;
  let port: number;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-ws-auth-'));
    backend = await createBackendApp({ dataDir, authDebug: true });
    const started = await backend.listen(0);
    server = started.server;
    wss = started.wss;
    port = started.port;
  });

  afterAll(async () => {
    backend.stopScheduler();
    backend.stopEphemeralSweeper();
    backend.stopEventJournalPruner();
    for (const ws of sockets) ws.close();
    wss.close();
    await new Promise<void>((resolve) => {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close(() => resolve());
    });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const req = async (path: string, init: RequestInit = {}, token?: string): Promise<Response> =>
    backend.app.request(path, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });

  async function createSession(token: string): Promise<string> {
    const res = await req(
      '/api/v2/sessions',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ws-auth' }) },
      token,
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function connect(token: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    sockets.push(ws);
    const client = makeClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await client.waitFor((m) => m.type === 'connected', 2000);
    return { ws, client };
  }

  it('USER не может send_message в сессию ADMIN (error, без постановки в очередь)', async () => {
    const adminSession = await createSession(ADMIN_KEY);
    const { ws, client } = await connect(USER_KEY);

    const busTypes: string[] = [];
    const unsub = backend.eventBus.subscribe(adminSession, (e) => busTypes.push(e.type));

    ws.send(JSON.stringify({ type: 'send_message', session_id: adminSession, content: 'pwn' }));

    const err = await client.waitFor((m) => m.type === 'error' && m.session_id === adminSession);
    expect(err).toBeTruthy();
    // Существование чужой сессии не раскрывается — тот же ответ, что для несуществующей.
    expect(err.data?.error).toBe('Session not found');

    // Никакого ack `queued` и никакой постановки в очередь (message.queued на шине).
    expect(client.messages.some((m) => m.type === 'queued' && m.session_id === adminSession)).toBe(false);
    await sleep(150);
    expect(busTypes).not.toContain('message.queued');

    const session = await backend.sessionManager.getSession(adminSession);
    expect(session?.pendingMessages ?? []).toHaveLength(0);

    unsub();
    ws.close();
  });

  it('USER не может permission_reply в чужую сессию (permission.replied не публикуется)', async () => {
    const adminSession = await createSession(ADMIN_KEY);
    const { ws } = await connect(USER_KEY);

    const busTypes: string[] = [];
    const unsub = backend.eventBus.subscribe(adminSession, (e) => busTypes.push(e.type));

    ws.send(JSON.stringify({
      type: 'permission_reply',
      session_id: adminSession,
      approval_id: 'approval-1',
      action: 'allow',
    }));
    ws.send(JSON.stringify({
      type: 'permission_hold',
      session_id: adminSession,
      approval_id: 'approval-1',
    }));

    await sleep(200);
    expect(busTypes).not.toContain('permission.replied');
    expect(busTypes).not.toContain('permission.hold');

    unsub();
    ws.close();
  });

  it('ADMIN может send_message в свою сессию и permission_reply проходит', async () => {
    const adminSession = await createSession(ADMIN_KEY);
    const { ws, client } = await connect(ADMIN_KEY);

    ws.send(JSON.stringify({ type: 'send_message', session_id: adminSession, content: 'hello' }));
    const ack = await client.waitFor((m) => m.type === 'queued' && m.session_id === adminSession);
    expect(ack).toBeTruthy();

    const busTypes: string[] = [];
    const unsub = backend.eventBus.subscribe(adminSession, (e) => busTypes.push(e.type));
    ws.send(JSON.stringify({
      type: 'permission_reply',
      session_id: adminSession,
      approval_id: 'approval-2',
      action: 'allow',
    }));
    await sleep(150);
    expect(busTypes).toContain('permission.replied');

    unsub();
    ws.close();
  });

  it('владелец (USER) может send_message в свою сессию', async () => {
    const ownSession = await createSession(USER_KEY);
    const { ws, client } = await connect(USER_KEY);

    ws.send(JSON.stringify({ type: 'send_message', session_id: ownSession, content: 'own message' }));
    const ack = await client.waitFor((m) => m.type === 'queued' && m.session_id === ownSession);
    expect(ack).toBeTruthy();

    ws.close();
  });
});
