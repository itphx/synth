// ADR-089: доставка WS-событий по сессиям, созданным ПОСЛЕ подключения клиента
// (standalone `/ws/events`).
//
// Регресс: подписка WS-хаба бралась **снимком** `listSessions` на момент
// `connect`, поэтому сессия, материализованная позже (`events-funnel`
// `ephemeral`/`bind`, явный `POST /api/v2/sessions`, тул `task`), оставалась без
// подписчиков — `event.routed`/`session.created`/стрим ответа терялись
// («0 subscribers — EVENT LOST»), и дерево сессий в UI обновлялось только после
// перезагрузки страницы. Фикс: funnel уведомляет хаб (`onSessionMaterialized` →
// `EventWebSocketSubscriptions.subscribeToSession`), как managed `EventHub`.
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createStandaloneApp } from './app.js';

const API_KEY = 'ws-events-test-key';

type WsMessage = Record<string, unknown>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type StandaloneApp = Awaited<ReturnType<typeof createStandaloneApp>>;

/** Поднять standalone-приложение на эфемерном порту + закрытие с очисткой. */
async function startApp(): Promise<{ app: StandaloneApp; port: number; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-ws-events-'));
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

/**
 * Клиент `/ws/events`: listener вешаем сразу (до `open`), иначе кадр `connected`
 * может прийти между `open` и подпиской и потеряться (ws не буферизует).
 */
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

/** Запрос к приложению с локальным API-ключом. */
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

/** Материализовать сессию внешним событием (`defaultMode: ephemeral`) → её id. */
async function materializeByEvent(
  app: StandaloneApp,
  event: WsMessage,
): Promise<string> {
  const res = await req(app, '/api/v2/events', { method: 'POST', body: event });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { sessionId: string | null };
  expect(body.sessionId).toBeTruthy();
  return body.sessionId!;
}

describe('createStandaloneApp: WS /ws/events — сессии, созданные после подключения (ADR-089)', () => {
  it('сессия из events-funnel доставляет события подключённому клиенту (без переподключения)', async () => {
    const { app, port, close } = await startApp();
    const client = connect(port);
    const second = connect(port);
    try {
      await client.ready;
      await second.ready;
      await waitForMessage(client.received, (m) => m.type === 'connected');
      await waitForMessage(second.received, (m) => m.type === 'connected');

      // Событие без привязки: `ephemeral` → материализация сессии funnel'ом.
      const settings = await req(app, '/api/v2/settings/events', {
        method: 'PUT',
        body: { events: { defaultMode: 'ephemeral' } },
      });
      expect(settings.status).toBe(200);

      const sessionId = await materializeByEvent(app, {
        source: 'test',
        type: 'message',
        payload: { text: 'hi' },
      });

      // Подписка поставлена до доставки события — `event.routed` приходит на живой WS.
      await waitForMessage(client.received, (m) => m.type === 'event.routed' && m.sessionId === sessionId);
      // Все клиенты владельца подписаны (реестр — множество, не «один клиент»).
      await waitForMessage(second.received, (m) => m.type === 'event.routed' && m.sessionId === sessionId);
      expect(app.eventBus.subscriberCount(sessionId)).toBeGreaterThan(0);
    } finally {
      client.ws.terminate();
      second.ws.terminate();
      await close();
    }
  });

  it('события сессии чужого владельца клиенту не приходят (подписка по владельцу)', async () => {
    const { app, port, close } = await startApp();
    const client = connect(port);
    try {
      await client.ready;
      await waitForMessage(client.received, (m) => m.type === 'connected');

      // Отправитель `tg:42` сопоставлен (identityMap) другому человеку инстанса.
      const settings = await req(app, '/api/v2/settings/events', {
        method: 'PUT',
        body: {
          events: { defaultMode: 'ephemeral', identityMap: { 'tg:42': 'other-user' } },
        },
      });
      expect(settings.status).toBe(200);

      const sessionId = await materializeByEvent(app, {
        source: 'test',
        type: 'message',
        payload: { text: 'hi' },
        identity: { principalId: 'tg:42' },
      });

      // Сессия принадлежит `other-user` — клиент `local` на неё не подписан.
      await sleep(300);
      expect(client.received.some((m) => m.sessionId === sessionId)).toBe(false);
      expect(app.eventBus.subscriberCount(sessionId)).toBe(0);
    } finally {
      client.ws.terminate();
      await close();
    }
  });

  it('отключение клиента снимает подписки (события не текут)', async () => {
    const { app, port, close } = await startApp();
    const client = connect(port);
    try {
      await client.ready;
      await waitForMessage(client.received, (m) => m.type === 'connected');

      await req(app, '/api/v2/settings/events', {
        method: 'PUT',
        body: { events: { defaultMode: 'ephemeral' } },
      });
      const sessionId = await materializeByEvent(app, {
        source: 'test',
        type: 'message',
        payload: { text: 'hi' },
      });
      await waitForCondition(() => app.eventBus.subscriberCount(sessionId) > 0);

      client.ws.terminate();
      // `close` снимает и точечные подписки, и регистрацию в реестре хаба.
      await waitForCondition(() => app.eventBus.subscriberCount(sessionId) === 0);
    } finally {
      client.ws.terminate();
      await close();
    }
  });

  it('сессия из POST /api/v2/sessions доставляет session.created ровно один раз', async () => {
    const { app, port, close } = await startApp();
    const client = connect(port);
    try {
      await client.ready;
      await waitForMessage(client.received, (m) => m.type === 'connected');

      const res = await req(app, '/api/v2/sessions', { method: 'POST', body: { name: 'ws-new' } });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };

      await waitForMessage(client.received, (m) => m.type === 'session.created' && m.sessionId === id);
      // Схема подписки одна: точечная подписка идемпотентна — дублей нет.
      await sleep(200);
      expect(client.received.filter((m) => m.type === 'session.created' && m.sessionId === id)).toHaveLength(1);
    } finally {
      client.ws.terminate();
      await close();
    }
  });

  it('сессия, существовавшая до подключения, по-прежнему покрыта снимком (регресс не внесён)', async () => {
    const { app, port, close } = await startApp();
    let client: ReturnType<typeof connect> | null = null;
    try {
      // Сессия создана ДО подключения клиента — её покрывает снимок `listSessions`.
      const created = await req(app, '/api/v2/sessions', { method: 'POST', body: { name: 'pre-ws' } });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };

      client = connect(port);
      await client.ready;
      await waitForMessage(client.received, (m) => m.type === 'connected');

      app.eventBus.publish(id, 'stream.usage', { session_id: id });
      await waitForMessage(client.received, (m) => m.type === 'stream.usage' && m.sessionId === id);
    } finally {
      client?.ws.terminate();
      await close();
    }
  });

  it('форк сессии доставляет session.fork.created подключённому клиенту (fork мимо funnel, ADR-089)', async () => {
    const { app, port, close } = await startApp();
    let client: ReturnType<typeof connect> | null = null;
    try {
      // Источник создан ДО подключения — покрыт снимком `listSessions`; форк
      // появится ПОСЛЕ и должен доставляться точечной подпиской (`onSessionForked`),
      // а не снимком (fork/import — materialization мимо funnel'а).
      const created = await req(app, '/api/v2/sessions', { method: 'POST', body: { name: 'fork-src' } });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };

      client = connect(port);
      await client.ready;
      await waitForMessage(client.received, (m) => m.type === 'connected');

      const forked = await req(app, `/api/v2/sessions/${id}/fork`, { method: 'POST', body: {} });
      expect(forked.status).toBe(201);
      const fork = (await forked.json()) as { id: string };

      // Событие новой (форкнутой) сессии приходит без переподключения клиента.
      await waitForMessage(client.received, (m) => m.type === 'session.fork.created' && m.sessionId === fork.id);
      expect(app.eventBus.subscriberCount(fork.id)).toBeGreaterThan(0);
    } finally {
      client?.ws.terminate();
      await close();
    }
  });
});

/** Дождаться сообщения по предикату (без создания таймеров дольше теста). */
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

/** Дождаться условия. */
async function waitForCondition(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error('Условие не выполнено за отведённое время');
}
