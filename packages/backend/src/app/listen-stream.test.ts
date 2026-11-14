/**
 * `createBackendListen` (`src/app/listen.ts`) — **отмена долгоживущих стримов**.
 *
 * Инвариант (тот же, что у standalone-core `server/app/http-server.ts`):
 * обрыв соединения клиентом обязан доходить до хендлера — сигнал запроса
 * (`c.req.raw.signal`) абортится по `close` ответа, а читатель тела ответа
 * **отменяется** (`reader.cancel()`). Без этого хендлеры стримов (терминал,
 * SSE) не узнают об уходе клиента и не снимают подписки — `attached_clients`
 * растёт, idle-reaper не закрывает терминал.
 *
 * Проверяется на **реальном HTTP** (`createBackendListen`, порт 0) и реальном
 * обрыве сокета (`req.destroy()`), а не через `app.request` — баг жил именно в
 * Node-адаптере, а не в роутах:
 *  - поток терминала (`GET /api/v2/terminals/:id/stream`): обрыв клиента →
 *    `attached_clients` → 0, DTO терминала подтверждает то же;
 *  - SSE-подобный долгий стрим (полагается только на `abort` сигнала) —
 *    хендлер получает отмену;
 *  - стрим, который `abort` не слушает (полагается только на `cancel()` тела) —
 *    читатель отменяется (`pumpBody`), иначе цикл `read()` висит вечно;
 *  - обычный короткий ответ не считается обрывом (`writableFinished` → сигнал
 *    не абортится).
 *
 * Изолированно: fake-порт исполнения (никакого реального PTY), без записи на
 * диск.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { WebSocketServer } from 'ws';
import {
  createTerminalRoutes,
  EventBus,
  TerminalService,
} from '@itphx/synth-core';
import type {
  ExecRequest,
  ExecResult,
  ExecutionPort,
  PtyHandle,
  PtyOpenRequest,
} from '@itphx/synth-core';
import { ProjectRole, resolveProjectAccess } from '@itphx/synth-shared';
import type { Project, Session } from '@itphx/synth-shared';
import { createBackendListen } from './listen.js';
import type { BackendListenDeps } from './listen.js';
import { closeTestServer } from '../test-helpers/close-server.js';

// ---------------------------------------------------------------------------
// Эмулятор PTY и порта исполнения (как в core `server/routes/terminals.test.ts`)
// ---------------------------------------------------------------------------

interface PtyExitInfo {
  exitCode?: number;
  signal?: string;
}

/** Эмулятор PTY-сессии: куски вывода отдаёт тест. */
class FakePtyHandle implements PtyHandle {
  readonly id: string;
  readonly pid = 4242;

  private _dataCbs = new Set<(chunk: string) => void>();
  private _exitCbs = new Set<(e: PtyExitInfo) => void>();

  constructor(id: string) {
    this.id = id;
  }

  write(): void {
    // Ввод в этом тесте не проверяется.
  }

  resize(): void {
    // Размер в этом тесте не проверяется.
  }

  onData(cb: (chunk: string) => void): () => void {
    this._dataCbs.add(cb);
    return () => {
      this._dataCbs.delete(cb);
    };
  }

  onExit(cb: (e: PtyExitInfo) => void): () => void {
    this._exitCbs.add(cb);
    return () => {
      this._exitCbs.delete(cb);
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Выдать кусок вывода (как из PTY). */
  emitData(chunk: string): void {
    for (const cb of [...this._dataCbs]) cb(chunk);
  }
}

/** Эмулятор порта исполнения: отдаёт эмулятор PTY. */
class FakeExecutionPort implements ExecutionPort {
  readonly pty = true;
  readonly handles: FakePtyHandle[] = [];

  async execute(_req: ExecRequest): Promise<ExecResult> {
    throw new Error('execute не используется в тестах терминалов');
  }

  async openPty(_req: PtyOpenRequest): Promise<PtyHandle> {
    const handle = new FakePtyHandle(`pty_${this.handles.length + 1}`);
    this.handles.push(handle);
    return handle;
  }

  get lastHandle(): FakePtyHandle {
    const handle = this.handles[this.handles.length - 1];
    if (!handle) throw new Error('PTY ещё не открывался');
    return handle;
  }
}

// ---------------------------------------------------------------------------
// Фикстуры приложения
// ---------------------------------------------------------------------------

function makeProject(): Project {
  return {
    id: 'proj-1',
    name: 'Проект',
    ownerId: 'owner',
    members: {},
    description: '',
    currentTask: '',
    invariants: '',
    statusMessages: [],
    workspace: '/work/proj-1',
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
  } as Project;
}

function makeSession(): Session {
  return {
    id: 'sess-1',
    projectId: 'proj-1',
    ownerId: 'owner',
    status: 'idle',
    messages: [],
    pendingMessages: [],
    settings: {},
    checkpoints: [],
    stickyNotes: [],
    references: [],
    summarizationPending: false,
    canSummarize: false,
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
  } as unknown as Session;
}

/** Счётчики отмены для стримов-проб. */
interface StreamProbes {
  /** Сколько раз хендлер полагался на `abort` сигнала (SSE-подобный стрим). */
  aborted: number;
  /** Сколько раз отменили тело ответа (`ReadableStream.cancel`). */
  cancelled: number;
  /** Сколько раз абортился сигнал в обычном (коротком) ответе. */
  finiteAborted: number;
}

/**
 * Собрать приложение с контуром терминалов и стримами-пробами и поднять его
 * **настоящим** адаптером backend (`createBackendListen`).
 */
async function createHarness(): Promise<{
  server: Server;
  wss: WebSocketServer;
  port: number;
  service: TerminalService;
  port_: FakeExecutionPort;
  probes: StreamProbes;
}> {
  const probes: StreamProbes = { aborted: 0, cancelled: 0, finiteAborted: 0 };

  const app = new Hono();

  // Обычный короткий ответ: сигнал абортиться не должен.
  app.get('/api/v2/finite', (c) => {
    c.req.raw.signal.addEventListener('abort', () => {
      probes.finiteAborted += 1;
    });
    return c.json({ ok: true });
  });

  // SSE-подобный долгий стрим: выход — только по `abort` сигнала (так живёт
  // реальный `GET /api/v2/events`). `cancel()` он не обрабатывает.
  app.get('/api/v2/sse-like', (c) => {
    const signal = c.req.raw.signal;
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          try {
            controller.enqueue(encoder.encode('data: {"seq":1}\n\n'));
          } catch {
            // клиент ушёл
          }
          signal.addEventListener('abort', () => {
            probes.aborted += 1;
            try {
              controller.close();
            } catch {
              // уже закрыт
            }
          });
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } },
    );
  });

  // Стрим, который `abort` не слушает: единственный путь снятия — отмена
  // читателя адаптером (`reader.cancel()`), иначе `read()` висит вечно.
  app.get('/api/v2/cancel-only', () => {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          try {
            controller.enqueue(encoder.encode('frame\n'));
          } catch {
            // клиент ушёл
          }
        },
        cancel() {
          probes.cancelled += 1;
        },
      }),
      { headers: { 'Content-Type': 'application/x-ndjson' } },
    );
  });

  const projects = new Map<string, Project>([['proj-1', makeProject()]]);
  const sessions = new Map<string, Session>([['sess-1', makeSession()]]);
  const eventBus = new EventBus();
  const port_ = new FakeExecutionPort();
  const service = new TerminalService({ port: port_, eventBus });

  const requireAuth = async (_c: Context, next: Next): Promise<void> => {
    await next();
  };

  app.route(
    '/api/v2/terminals',
    createTerminalRoutes(
      { requireAuth },
      {
        terminal: service,
        projects: { load: async (id: string) => projects.get(id) ?? null },
        sessions: { getSession: async (id: string) => sessions.get(id) ?? null },
      },
      {
        getCurrentUserId: () => 'owner',
        canReadProject: (_c, project, userId) =>
          resolveProjectAccess(project, { userId, roles: [] }).read,
        canEditProjectContent: (_c, project, userId) => {
          const access = resolveProjectAccess(project, { userId, roles: [] });
          return access.role === ProjectRole.OWNER || access.role === ProjectRole.EDITOR;
        },
        workspacesRoot: '/work',
      },
    ),
  );

  // WS-апгрейд этим тестом не проверяется (`listen.test.ts`) — заглушки
  // достаточны: HTTP-ветка адаптера использует только `app`.
  const listen = createBackendListen({
    app,
    defaultPort: 0,
  } as unknown as BackendListenDeps);
  const started = await listen(0, '127.0.0.1');

  return {
    server: started.server,
    wss: started.wss,
    port: started.port,
    service,
    port_,
    probes,
  };
}

/** Открытый поток: `req` — клиентский запрос (его `destroy()` рвёт сокет). */
interface OpenStream {
  req: ReturnType<typeof httpRequest>;
  res: IncomingMessage;
  /** Первый кусок тела (дождались, что хендлер реально пишет в поток). */
  firstChunk: () => Promise<string>;
}

/** Подключиться к стриму по настоящему HTTP и дождаться первого кадра. */
function openStream(port: number, path: string): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`unexpected status ${res.statusCode ?? 0}`));
        return;
      }
      res.setEncoding('utf8');
      let buffered = '';
      const waiters: Array<(chunk: string) => void> = [];
      res.on('data', (chunk: string) => {
        buffered += chunk;
        for (const waiter of waiters.splice(0)) waiter(buffered);
      });
      resolve({
        req,
        res,
        firstChunk: () =>
          new Promise<string>((done, fail) => {
            if (buffered !== '') {
              done(buffered);
              return;
            }
            const timer = setTimeout(() => fail(new Error('нет кадра потока')), 2000);
            waiters.push((chunk) => {
              clearTimeout(timer);
              done(chunk);
            });
          }),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

describe('createBackendListen: отмена долгоживущих стримов (утечка подписок)', () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    harness.wss.close();
    await closeTestServer(harness.server);
  });

  /** Открыть терминал от имени владельца проекта. */
  async function openTerminal(): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${harness.port}/api/v2/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: 'proj-1', cols: 80, rows: 24 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { terminal: { id: string } };
    return body.terminal.id;
  }

  /** `attached_clients` из DTO терминала. */
  async function attachedClientsOf(id: string): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${harness.port}/api/v2/terminals/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { terminal: { attached_clients: number } };
    return body.terminal.attached_clients;
  }

  it('обрыв клиента снимает подписку: attached_clients 1 → 0', async () => {
    const id = await openTerminal();
    expect(harness.service.attachedClients(id)).toBe(0);

    const stream = await openStream(harness.port, `/api/v2/terminals/${id}/stream?since=0`);
    harness.port_.lastHandle.emitData('привет\n');
    const first = await stream.firstChunk();
    expect(first).toContain('привет');
    expect(harness.service.attachedClients(id)).toBe(1);

    // Клиент оборвал соединение (закрыл вкладку / потерял сеть).
    stream.req.destroy();

    await vi.waitFor(() => expect(harness.service.attachedClients(id)).toBe(0), { timeout: 3000 });
    expect(await attachedClientsOf(id)).toBe(0);

    // Вывод после обрыва подписку не возвращает и наружу не бросает.
    harness.port_.lastHandle.emitData('после обрыва\n');
    await new Promise((r) => setTimeout(r, 50));
    expect(harness.service.attachedClients(id)).toBe(0);
  });

  it('долгий стрим не течёт: обрыв → abort сигнала и cancel читателя', async () => {
    // SSE-подобный стрим живёт только на `abort` сигнала — как `GET /api/v2/events`.
    const sse = await openStream(harness.port, '/api/v2/sse-like');
    await sse.firstChunk();
    expect(harness.probes.aborted).toBe(0);
    sse.req.destroy();
    await vi.waitFor(() => expect(harness.probes.aborted).toBe(1), { timeout: 3000 });

    // Стрим, который `abort` не слушает: адаптер обязан отменить читателя.
    const cancelOnly = await openStream(harness.port, '/api/v2/cancel-only');
    await cancelOnly.firstChunk();
    expect(harness.probes.cancelled).toBe(0);
    cancelOnly.req.destroy();
    await vi.waitFor(() => expect(harness.probes.cancelled).toBe(1), { timeout: 3000 });
  });

  it('нормальный короткий ответ не считается обрывом (writableFinished)', async () => {
    const res = await fetch(`http://127.0.0.1:${harness.port}/api/v2/finite`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Ответ записан целиком — сигнал абортиться не должен даже после закрытия
    // соединения (иначе хендлер принял бы штатный конец за уход клиента).
    await new Promise((r) => setTimeout(r, 50));
    expect(harness.probes.finiteAborted).toBe(0);
  });
});
