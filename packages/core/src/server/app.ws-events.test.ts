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
import { MessageRole, nowISO } from '@itphx/synth-shared';
import { createStandaloneApp } from './app.js';
import { FileStore, SessionManager } from '../index.js';
import { prepareChildSession } from '../engine/tools/task/fork.js';
import type { TaskExtra } from '../engine/tools/task/types.js';
import type { ContextOptimizer } from '../engine/context/optimizer.js';

const API_KEY = 'ws-events-test-key';

type WsMessage = Record<string, unknown>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type StandaloneApp = Awaited<ReturnType<typeof createStandaloneApp>>;

/** Поднять standalone-приложение на эфемерном порту + закрытие с очисткой. */
async function startApp(): Promise<{ app: StandaloneApp; port: number; dir: string; close: () => Promise<void> }> {
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

  return { app, port, dir, close };
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

  it('внешний отправитель в standalone нормализуется к владельцу `local` — события доставляются (ADR-089)', async () => {
    const { app, port, close } = await startApp();
    const client = connect(port);
    try {
      await client.ready;
      await waitForMessage(client.received, (m) => m.type === 'connected');

      // Отправитель `tg:42` сопоставлен через `identityMap` (напр. Telegram-чат).
      // В single-user инстансе человек-владелец один — `local`: источник-маппинг
      // нормализуется к нему, поэтому сессия не «висит» на неизвестном UUID и
      // клиент `local` на неё подписан (регресс: было `0 subscribers`).
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

      // Сессия принадлежит `local` — события приходят подключённому клиенту `local`.
      await waitForMessage(client.received, (m) => m.type === 'event.routed' && m.sessionId === sessionId);
      expect(app.eventBus.subscriberCount(sessionId)).toBeGreaterThan(0);

      const sessions = await req(app, '/api/v2/sessions');
      expect(sessions.status).toBe(200);
      const list = (await sessions.json()) as Array<{ id: string; owner_id: string | null }>;
      const found = list.find((s) => s.id === sessionId);
      expect(found?.owner_id).toBe('local');
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

/** Создать дочернюю сессию тем же путём, что тул `task` (реальный `prepareChildSession`). */
async function runTaskFork(
  dir: string,
  eventBus: StandaloneApp['eventBus'],
  parentId: string,
  mode: 'inherit' | 'last_n' | 'summary',
): Promise<string> {
  // Второй SessionManager на том же dataDir: читает родителя с диска (app-менеджер
  // сессию не отдаёт наружу), пишет ребёнка и публикует события в шину приложения.
  const sm = new SessionManager(new FileStore({ dataDir: dir }));
  const optimizer = mode === 'summary'
    ? ({
        summarize: async () => ({
          id: 'sum', role: MessageRole.SUMMARY, seq: 0, origin: 'local',
          parts: [{ id: 'sp', type: 'text', data: 'sum' }], content: 'sum',
          createdAt: nowISO(), disabled: false, pinned: false, hidden: false,
        }),
      } as unknown as ContextOptimizer)
    : undefined;
  const extra = {
    sessionManager: sm,
    eventBus,
    sessionId: parentId,
    ...(optimizer ? { contextOptimizer: optimizer } : {}),
  } as unknown as TaskExtra;
  const state = { childSessionId: undefined as string | undefined, childMessages: [], parentNotesText: '' };
  await prepareChildSession(state, {
    extra,
    description: `task-${mode}`,
    subagentType: 'developer',
    contextMode: mode,
    contextCount: 2,
    childRoutingOverrides: {},
  });
  expect(state.childSessionId).toBeTruthy();
  return state.childSessionId!;
}

describe('createStandaloneApp: WS /ws/events — авто-подписка на дочерние сессии саб-агента (ADR-089)', () => {
  for (const mode of ['inherit', 'last_n', 'summary'] as const) {
    it(`task (${mode}): клиент до вызова получает события дочерней сессии без переподключения`, async () => {
      const { app, port, dir, close } = await startApp();
      const client = connect(port);
      try {
        // Родитель создан до подключения — покрыт снимком `listSessions`.
        const created = await req(app, '/api/v2/sessions', { method: 'POST', body: { name: `parent-${mode}` } });
        expect(created.status).toBe(201);
        const parent = (await created.json()) as { id: string };

        await client.ready;
        await waitForMessage(client.received, (m) => m.type === 'connected');
        await waitForCondition(() => app.eventBus.subscriberCount(parent.id) > 0);

        // Клиент подключён ДО вызова task — хаб подписывает его на ребёнка по
        // `session.created` в канал родителя (payload `serializeSession(child)`).
        const childId = await runTaskFork(dir, app.eventBus, parent.id, mode);
        await waitForCondition(() => app.eventBus.subscriberCount(childId) > 0);

        // События ребёнка (стрим саб-агента) приходят на живой WS без переподключения.
        app.eventBus.publish(childId, 'stream.usage', { session_id: childId, outputTokens: 1 });
        app.eventBus.publish(childId, 'stream.done', { session_id: childId });
        await waitForMessage(client.received, (m) => m.type === 'stream.usage' && m.sessionId === childId);
        await waitForMessage(client.received, (m) => m.type === 'stream.done' && m.sessionId === childId);
      } finally {
        client.ws.terminate();
        await close();
      }
    });
  }

  it('resume-subagent: resume-событие в канал родителя подписывает клиента на ребёнка вне снимка', async () => {
    const { app, port, dir, close } = await startApp();
    const client = connect(port);
    try {
      const created = await req(app, '/api/v2/sessions', { method: 'POST', body: { name: 'resume-parent' } });
      expect(created.status).toBe(201);
      const parent = (await created.json()) as { id: string };

      await client.ready;
      await waitForMessage(client.received, (m) => m.type === 'connected');
      await waitForCondition(() => app.eventBus.subscriberCount(parent.id) > 0);

      // Ребёнок создан напрямую (не в снимке подключения) — как оборванный саб-агент.
      const sm = new SessionManager(new FileStore({ dataDir: dir }));
      const child = await sm.createSession({ title: 'resume-child', parentId: parent.id, userId: 'local' });
      expect(app.eventBus.subscriberCount(child.id)).toBe(0);

      // `runSubagentResume` публикует `subagent.resume.started` в канал родителя
      // (в т.ч. ребёнка) — этого достаточно для авто-подписки.
      app.eventBus.publish(parent.id, 'subagent.resume.started', {
        child_session_id: child.id,
        parent_session_id: parent.id,
      });
      await waitForCondition(() => app.eventBus.subscriberCount(child.id) > 0);

      app.eventBus.publish(child.id, 'stream.usage', { session_id: child.id });
      await waitForMessage(client.received, (m) => m.type === 'stream.usage' && m.sessionId === child.id);
    } finally {
      client.ws.terminate();
      await close();
    }
  });
});

describe('createStandaloneApp: WS /ws/events — авто-подписка по session.created в собственном канале (импорт/перенос, ADR-089)', () => {
  it('сессия, созданная вне HTTP-роута (перенос), доставляется предподключённому клиенту', async () => {
    const { app, port, close } = await startApp();
    const client = connect(port);
    try {
      await client.ready;
      await waitForMessage(client.received, (m) => m.type === 'connected');

      // Так публикует `remote/transfer.ts` после импорта сессии: `session.created`
      // в собственный канал сессии (владелец — `local`). Клиент заранее не подписан.
      app.eventBus.publish('imported-1', 'session.created', { id: 'imported-1', owner_id: 'local', name: 'Imported' });

      // Кадр `session.created` доставлен форвардом авто-подписки.
      await waitForMessage(client.received, (m) => m.type === 'session.created' && m.sessionId === 'imported-1');
      expect(app.eventBus.subscriberCount('imported-1')).toBeGreaterThan(0);

      // Последующие события импортированной сессии тоже доходят.
      app.eventBus.publish('imported-1', 'stream.usage', { session_id: 'imported-1' });
      await waitForMessage(client.received, (m) => m.type === 'stream.usage' && m.sessionId === 'imported-1');
    } finally {
      client.ws.terminate();
      await close();
    }
  });

  it('негативный контроль видимости: сессия другого владельца не подписывается и не доставляется', async () => {
    const { app, port, close } = await startApp();
    const client = connect(port);
    try {
      await client.ready;
      await waitForMessage(client.received, (m) => m.type === 'connected');

      // Владелец `other-user` — клиент `local` не должен ни подписаться, ни получить событие.
      app.eventBus.publish('foreign-1', 'session.created', { id: 'foreign-1', owner_id: 'other-user' });
      app.eventBus.publish('foreign-1', 'stream.usage', { session_id: 'foreign-1' });
      await sleep(150);

      expect(app.eventBus.subscriberCount('foreign-1')).toBe(0);
      expect(client.received.some((m) => m.sessionId === 'foreign-1')).toBe(false);
    } finally {
      client.ws.terminate();
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
