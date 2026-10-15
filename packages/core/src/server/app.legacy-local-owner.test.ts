// ADR-089 (standalone): legacy-сессии, созданные до фикса нормализации владельца.
//
// До фикса резолвера внешней идентичности сопознанный отправитель становился
// владельцем сессии под id **профиля** `local` (`ProfileData.id` — UUID), а не под
// литерал `local`. Такие сессии уже лежат в `{dataDir}/sessions/*.json` и выпадали
// из списка (`listSessions({ userId: 'local' })`), `GET /:id` (403) и WS-подписки.
//
// Фикс: нормализация владельца **при чтении** (одна точка — `LocalOwnerResolver`
// в `server/local-owner.ts`) — UUID профиля `local` трактуется как `local`.
// Данные не перезаписываются (проверяется побайтовым сравнением файла сессии).
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createStandaloneApp } from './app.js';
import { FileProfileStore } from '../storage/profile-store.js';
import { FileStore } from '../storage/file-store.js';
import { SessionManager } from '../sessions/manager.js';

const API_KEY = 'legacy-local-owner-key';

type WsMessage = Record<string, unknown>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type StandaloneApp = Awaited<ReturnType<typeof createStandaloneApp>>;

async function startApp(dir: string): Promise<{ app: StandaloneApp; port: number; close: () => Promise<void> }> {
  const app = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: API_KEY });
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const close = async (): Promise<void> => {
    app.stopScheduler?.();
    app.stopEphemeralSweeper?.();
    app.stopEventJournalPruner?.();
    await new Promise<void>((resolve) => {
      (app.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      app.server.close(() => resolve());
    });
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  return { app, port, close };
}

function connect(port: number): { ws: WebSocket; received: WsMessage[]; ready: Promise<void> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const received: WsMessage[] = [];
  ws.on('message', (raw: Buffer) => {
    try {
      received.push(JSON.parse(raw.toString()) as WsMessage);
    } catch {
      // ignore
    }
  });
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  return { ws, received, ready };
}

async function req(
  app: StandaloneApp,
  path: string,
  init: { method?: string } = {},
): Promise<Response> {
  return await app.app.request(path, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
}

async function waitForMessage(
  received: WsMessage[],
  pred: (m: WsMessage) => boolean,
  timeoutMs = 3000,
): Promise<WsMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = received.find(pred);
    if (found) return found;
    await sleep(20);
  }
  throw new Error('WS-сообщение не получено за отведённое время');
}

/** Создать профиль `local` и сессию с заданным владельцем в том же dataDir. */
async function seed(
  dir: string,
  ownerId: string,
): Promise<{ sessionId: string; path: string }> {
  const sm = new SessionManager(new FileStore({ dataDir: dir }));
  const session = await sm.createSession({ title: 'legacy', userId: ownerId, ownerId });
  return { sessionId: session.id, path: join(dir, 'sessions', `${session.id}.json`) };
}

describe('standalone: legacy-владелец (UUID профиля `local`) — видимость при чтении (ADR-089)', () => {
  it('сессия с владельцем = id профиля `local` видна в списке, доступна по id, WS-подписка работает, файл не перезаписан', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-legacy-owner-'));
    const profiles = new FileProfileStore({ dataDir: dir });
    const localProfile = await profiles.getOrCreateProfile({ username: 'local' });
    const { sessionId, path } = await seed(dir, localProfile.id);
    const { app, port, close } = await startApp(dir);
    const client = connect(port);
    try {
      // Файл читаем ПОСЛЕ старта приложения (стартовые миграции снапшотов скоупа
      // могли его тронуть) — далее сравниваем до/после наших read-запросов.
      const before = await readFile(path, 'utf-8');

      await client.ready;
      await waitForMessage(client.received, (m) => m.type === 'connected');

      // 1) Видна в списке локального пользователя `local`.
      const listRes = await req(app, '/api/v2/sessions');
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as Array<{ id: string }>;
      expect(list.find((s) => s.id === sessionId)).toBeTruthy();

      // 2) Доступна по id (было 403 при владельце-UUID).
      const detail = await req(app, `/api/v2/sessions/${sessionId}`);
      expect(detail.status).toBe(200);

      // 3) Под-ресурс (messages) — та же единая точка доступа: не 403.
      //    Сессии нет сообщений → handler отдаёт 404, а не 403 (доступ пройден).
      const debug = await req(app, `/api/v2/messages/${sessionId}/0/debug`);
      expect(debug.status).toBe(404);

      // 4) WS-подписка: снимок `connect` покрывает legacy-сессию.
      expect(app.eventBus.subscriberCount(sessionId)).toBeGreaterThan(0);
      app.eventBus.publish(sessionId, 'session.updated', { session_id: sessionId });
      await waitForMessage(
        client.received,
        (m) => m.type === 'session.updated' && m.sessionId === sessionId,
      );

      // 5) Ноль записи: файл сессии побайтово не изменился.
      const after = await readFile(path, 'utf-8');
      expect(after).toBe(before);
    } finally {
      client.ws.terminate();
      await close();
    }
  });

  it('негатив: владелец-UUID, НЕ являющийся локальным профилем, по-прежнему невидим', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-legacy-foreign-'));
    // Профиль `local` существует, но у сессии — чужой UUID (не его id).
    await new FileProfileStore({ dataDir: dir }).getOrCreateProfile({ username: 'local' });
    const { sessionId } = await seed(dir, 'foreign-uuid-not-local');
    const { app, port, close } = await startApp(dir);
    const client = connect(port);
    try {
      await client.ready;
      await waitForMessage(client.received, (m) => m.type === 'connected');

      const listRes = await req(app, '/api/v2/sessions');
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as Array<{ id: string }>;
      expect(list.find((s) => s.id === sessionId)).toBeFalsy();

      const detail = await req(app, `/api/v2/sessions/${sessionId}`);
      expect(detail.status).toBe(403);

      // Не подписан на WS: событие не доставляется.
      expect(app.eventBus.subscriberCount(sessionId)).toBe(0);
      app.eventBus.publish(sessionId, 'session.updated', { session_id: sessionId });
      await sleep(150);
      expect(client.received.find((m) => m.type === 'session.updated' && m.sessionId === sessionId)).toBeUndefined();
    } finally {
      client.ws.terminate();
      await close();
    }
  });
});
