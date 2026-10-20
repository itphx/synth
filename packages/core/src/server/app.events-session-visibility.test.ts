// ADR-089 (standalone): сессия, материализованная внешним событием от
// **сопознанного** (linked через claim-flow) отправителя, должна принадлежать
// локальному пользователю `local`.
//
// Регресс: резолвер внешней идентичности возвращал `ProfileData.id` (UUID
// профиля, а не `local`), поэтому такая сессия:
//   - выпадала из `GET /api/v2/sessions` (`listSessions({ userId: 'local' })`);
//   - была недоступна по id — `GET /api/v2/sessions/:id` → 403;
//   - не доставлялась WS-клиенту `local` (`0 subscribers`).
// Фикс: в standalone резолвер нормализует внешнего владельца к `local`
// (`createExternalIdentityResolver({ localUserId: 'local' })`), внешний
// идентификатор (`tg:<id>`) при этом остаётся внешним (routing/attribution).
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createStandaloneApp } from './app.js';
import { closeTestServer } from '../test-helpers/close-server.js';

const API_KEY = 'events-visibility-key';

type WsMessage = Record<string, unknown>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type StandaloneApp = Awaited<ReturnType<typeof createStandaloneApp>>;

async function startApp(): Promise<{ app: StandaloneApp; port: number; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-events-visibility-'));
  const app = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: API_KEY });
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const close = async (): Promise<void> => {
    app.stopScheduler?.();
    app.stopEphemeralSweeper?.();
    app.stopEventJournalPruner?.();
    await closeTestServer(app.server);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  return { app, port, close };
}

/** Клиент `/ws/events` (listener вешается до `open`, иначе кадр теряется). */
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
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return await app.app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
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

describe('standalone: видимость сессии из внешнего события (ADR-089)', () => {
  it('linked-отправитель → сессия принадлежит `local`: список, GET /:id, WS-доставка', async () => {
    const { app, port, close } = await startApp();
    const client = connect(port);
    try {
      await client.ready;
      await waitForMessage(client.received, (m) => m.type === 'connected');

      // Событие без привязки: `ephemeral` → материализация сессии funnel'ом.
      const settings = await req(app, '/api/v2/settings/events', {
        method: 'PUT',
        body: { events: { defaultMode: 'ephemeral' } },
      });
      expect(settings.status).toBe(200);

      // 1) Неизвестный отправитель — claim-flow выдаёт одноразовый код.
      const first = await req(app, '/api/v2/events', {
        method: 'POST',
        body: {
          source: 'telegram',
          type: 'message',
          payload: { text: 'hi' },
          identity: { principalId: 'tg:123' },
          dedupKey: 'evt-1',
        },
      });
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as { sessionId: string | null; identityHint?: { code: string } };
      expect(firstBody.sessionId).toBeTruthy();
      expect(firstBody.identityHint?.code).toBeTruthy();

      // 2) Подтверждаем владение идентичностью — `tg:123` линкуется к профилю.
      const claim = await req(app, '/api/v2/me/identities/claim', {
        method: 'POST',
        body: { code: firstBody.identityHint!.code },
      });
      expect(claim.status).toBe(201);

      // 3) Повторное событие от того же (теперь сопознанного) отправителя.
      const second = await req(app, '/api/v2/events', {
        method: 'POST',
        body: {
          source: 'telegram',
          type: 'message',
          payload: { text: 'hi again' },
          identity: { principalId: 'tg:123' },
          dedupKey: 'evt-2',
        },
      });
      expect(second.status).toBe(201);
      const secondBody = (await second.json()) as { sessionId: string | null; identityHint?: unknown };
      const sessionId = secondBody.sessionId!;
      expect(sessionId).toBeTruthy();
      // Сопознанный отправитель — код подтверждения больше не выдаётся.
      expect(secondBody.identityHint).toBeUndefined();

      // 4) Сессия видна в списке локального пользователя и принадлежит `local`.
      const listRes = await req(app, '/api/v2/sessions');
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as Array<{ id: string; owner_id: string | null }>;
      const found = list.find((s) => s.id === sessionId);
      expect(found).toBeTruthy();
      expect(found?.owner_id).toBe('local');

      // 5) Доступна по id (было 403 при владельце-UUID).
      const detail = await req(app, `/api/v2/sessions/${sessionId}`);
      expect(detail.status).toBe(200);

      // 6) Событие доставлено WS-клиенту `local`, подключённому ДО события.
      await waitForMessage(client.received, (m) => m.type === 'event.routed' && m.sessionId === sessionId);
      expect(app.eventBus.subscriberCount(sessionId)).toBeGreaterThan(0);
    } finally {
      client.ws.terminate();
      await close();
    }
  });
});
