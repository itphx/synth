/**
 * Решение владельца (вариант A): сквозной срез **транспорта** для инстансных
 * событий в managed-режиме (backend). Матрица хаба — `src/events/instance-delivery.test.ts`;
 * здесь проверяем, что правило доезжает до реальных клиентов:
 *
 *  - WS `/ws/events`: обычный `USER` получает `agents.updated`
 *    (пользовательский тип) и **не** получает административный тип;
 *    `ADMIN` (watch-all) получает оба;
 *  - SSE `GET /api/v2/events`: тот же фильтр у обычного `USER`
 *    (оба транспорта подписываются через `EventHub.registerClient`, поэтому
 *    правило одно — `instance-events.ts`);
 *  - изоляция сессий не изменилась: событие чужой сессии `USER` не получает.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';
import { closeTestServer } from '../test-helpers/close-server.js';
import { USER_FACING_INSTANCE_EVENTS } from '../events/instance-events.js';

const ADMIN_KEY = 'admin-key-123';
const USER_KEY = 'user-key-456';

/** Пользовательский тип-представитель (реестр агентов). */
const USER_FACING_TYPE = 'agents.updated';
/** Не-пользовательский инстансный тип (административные `EventType` пока нет). */
const ADMIN_ONLY_TYPE = 'event.received';

interface WsFrame {
  type?: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

describe('Инстансные события — транспорт managed-хаба (вариант A)', () => {
  let dataDir: string;
  let backend: BackendAppHandle;
  let server: Server;
  let wss: WebSocketServer;
  let port: number;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-instance-events-'));
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
    await closeTestServer(server);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Подключить WS-клиента `/ws/events`; `connected` — хаб зарегистрировал клиента. */
  async function connectWs(token: string): Promise<{ frames: WsFrame[] }> {
    // ADR-118 §8: клиент обязан заявить модель сообщений (`messageModel=2`).
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events?messageModel=2`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    sockets.push(ws);
    const frames: WsFrame[] = [];
    const connected = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      ws.on('message', (raw: Buffer) => {
        try {
          const frame = JSON.parse(raw.toString()) as WsFrame;
          frames.push(frame);
          if (frame.type === 'connected') done(true);
        } catch {
          // ignore
        }
      });
      ws.once('error', () => done(false));
      setTimeout(() => done(false), 2000);
    });
    expect(connected).toBe(true);
    return { frames };
  }

  /** Дождаться кадра по условию (или вернуть `undefined` по таймауту). */
  async function waitForFrame(
    frames: WsFrame[],
    predicate: (f: WsFrame) => boolean,
    timeoutMs = 2000,
  ): Promise<WsFrame | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = frames.find(predicate);
      if (found) return found;
      await sleep(20);
    }
    return undefined;
  }

  it('WS: USER получает пользовательское инстансное событие', async () => {
    const { frames } = await connectWs(USER_KEY);

    backend.eventBus.publishInstance(USER_FACING_TYPE, { action: 'save', id: 'agent-1' });

    const frame = await waitForFrame(frames, (f) => f.type === USER_FACING_TYPE);
    expect(frame).toBeDefined();
    expect(frame!.sessionId).toBe('instance');
    expect(frame!.data).toEqual({ action: 'save', id: 'agent-1' });
  });

  it('WS: USER не получает административное инстансное событие', async () => {
    const { frames } = await connectWs(USER_KEY);

    backend.eventBus.publishInstance(ADMIN_ONLY_TYPE, { note: 'admin-only' });
    // Контроль: пользовательское событие до клиента доходит — значит канал жив,
    // а отсутствие административного не объясняется таймаутом/отключением.
    backend.eventBus.publishInstance(USER_FACING_TYPE, { action: 'probe' });

    expect(await waitForFrame(frames, (f) => f.type === USER_FACING_TYPE)).toBeDefined();
    expect(frames.some((f) => f.type === ADMIN_ONLY_TYPE)).toBe(false);
  });

  it('WS: ADMIN (watch-all) получает и пользовательское, и административное', async () => {
    const { frames } = await connectWs(ADMIN_KEY);

    backend.eventBus.publishInstance(USER_FACING_TYPE, { action: 'save', id: 'agent-2' });
    backend.eventBus.publishInstance(ADMIN_ONLY_TYPE, { note: 'admin-only' });

    expect(await waitForFrame(frames, (f) => f.type === USER_FACING_TYPE)).toBeDefined();
    expect(await waitForFrame(frames, (f) => f.type === ADMIN_ONLY_TYPE)).toBeDefined();
  });

  it('WS: изоляция сессий не изменилась — USER не получает событие чужой сессии', async () => {
    const { frames } = await connectWs(USER_KEY);

    backend.eventBus.publish('session-foreign-instance-test', 'turn.finished', {
      turnId: 'turn-foreign',
      status: 'completed',
    });
    backend.eventBus.publishInstance(USER_FACING_TYPE, { action: 'probe' });

    expect(await waitForFrame(frames, (f) => f.type === USER_FACING_TYPE)).toBeDefined();
    expect(frames.some((f) => f.sessionId === 'session-foreign-instance-test')).toBe(false);
  });

  it('SSE: USER получает пользовательское и не получает административное', async () => {
    const abort = new AbortController();
    // Подключение — до публикации: подписка регистрируется в `start()` стрима.
    const res = await backend.app.request('/api/v2/events?messageModel=2', {
      headers: { Authorization: `Bearer ${USER_KEY}` },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);

    await sleep(60);
    backend.eventBus.publishInstance(ADMIN_ONLY_TYPE, { note: 'admin-only' });
    backend.eventBus.publishInstance(USER_FACING_TYPE, { action: 'save', id: 'agent-sse' });

    const text = await readSseFrom(res, ['agents.updated'], 2500);
    abort.abort();

    expect(text).toContain(USER_FACING_TYPE);
    expect(text).not.toContain(ADMIN_ONLY_TYPE);
  });

  it('SSE: ADMIN (watch-all) получает административное инстансное событие', async () => {
    const abort = new AbortController();
    const res = await backend.app.request('/api/v2/events?messageModel=2', {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);

    await sleep(60);
    backend.eventBus.publishInstance(ADMIN_ONLY_TYPE, { note: 'admin-only' });

    const text = await readSseFrom(res, [ADMIN_ONLY_TYPE], 2500);
    abort.abort();

    expect(text).toContain(ADMIN_ONLY_TYPE);
  });

  it('список пользовательских типов — источник истины (реестры + прогоны)', () => {
    expect(USER_FACING_INSTANCE_EVENTS.has(USER_FACING_TYPE)).toBe(true);
    expect(USER_FACING_INSTANCE_EVENTS.has(ADMIN_ONLY_TYPE)).toBe(false);
  });
});

/**
 * Дочитать открытый SSE-ответ до появления всех `needles` (или таймаута).
 * Кадр SSE — строка `data: <json>`; проверяем состав по подстрокам.
 */
async function readSseFrom(res: Response, needles: string[], timeoutMs: number): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let acc = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: boolean; value?: Uint8Array }>((resolve) =>
          setTimeout(() => resolve({ done: true }), remaining),
        ),
      ]);
      if (result.done) break;
      acc += decoder.decode(result.value);
      if (needles.every((n) => acc.includes(n))) break;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return acc;
}
