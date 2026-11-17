/**
 * Ф3б: HTTP-контур терминалов (`server/routes/terminals.ts`).
 *
 * Проверяется:
 *   • создание/список/деталь терминала (постраничный список — ADR-118);
 *   • **права на границе**: `VIEWER` читает терминал, но не пишет в него
 *     (инвариант 21), чужой пользователь не видит терминал вовсе;
 *   • рабочий каталог вычисляется сервером (`session.worktree.directory` →
 *     `project.workspace`), `cwd` из тела игнорируется;
 *   • догон вывода: `GET /:id/output?since=` отдаёт только новые фрагменты;
 *   • поток `GET /:id/stream` отдаёт кадры NDJSON и закрывается по abort;
 *   • лимиты сервиса → HTTP-коды (`TERMINAL_LIMIT` → 409/429/413);
 *   • инстансный выключатель → `403 TERMINALS_DISABLED` на всех маршрутах.
 *
 * Изолированно: fake-порт исполнения (никакого реального PTY), без сети и
 * без записи на диск.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { EventBus } from '../../events/bus.js';
import {
  ExecutionError,
  type ExecRequest,
  type ExecResult,
  type ExecutionPort,
  type PtyForeground,
  type PtyHandle,
  type PtyOpenRequest,
} from '../../execution/ports/index.js';
import { TerminalService } from '../../engine/terminal/service.js';
import { createTerminalRoutes } from './terminals.js';
import { createStandaloneHttpServer } from '../app/http-server.js';
import { ProjectRole, resolveProjectAccess } from '@itphx/synth-shared';
import type { Project, Session } from '@itphx/synth-shared';

// ---------------------------------------------------------------------------
// Эмулятор PTY и порта
// ---------------------------------------------------------------------------

/** Выход PTY-сессии (совпадает с контрактом порта). */
interface PtyExitInfo {
  exitCode?: number;
  signal?: string;
}

/** Эмулятор PTY-сессии: пишет куски по команде теста. */
class FakePtyHandle implements PtyHandle {
  readonly id: string;
  readonly pid = 4242;
  /** Всё, что ушло в терминал. */
  readonly writes: string[] = [];
  /** Все изменения размера. */
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  /**
   * Факт переднего плана (протокол исполнителя 9): `null` — «неизвестно»
   * (старый исполнитель/проба не дала ответа).
   */
  foreground: PtyForeground | null = null;

  private _dataCbs = new Set<(chunk: string) => void>();
  private _exitCbs = new Set<(e: PtyExitInfo) => void>();

  constructor(id: string) {
    this.id = id;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
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

  /** Проба переднего плана (как у настоящего PTY-хэндла). */
  async inspect(): Promise<PtyForeground | null> {
    return this.foreground;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Выдать кусок вывода (как из PTY). */
  emitData(chunk: string): void {
    for (const cb of [...this._dataCbs]) cb(chunk);
  }

  /** Завершить сессию (как из PTY). */
  emitExit(info: PtyExitInfo): void {
    for (const cb of [...this._exitCbs]) cb(info);
  }
}

/** Эмулятор порта исполнения: отдаёт эмулятор PTY. */
class FakeExecutionPort implements ExecutionPort {
  readonly pty = true;
  readonly handles: FakePtyHandle[] = [];
  readonly requests: PtyOpenRequest[] = [];

  async execute(_req: ExecRequest): Promise<ExecResult> {
    throw new Error('execute не используется в тестах терминалов');
  }

  async openPty(req: PtyOpenRequest): Promise<PtyHandle> {
    this.requests.push(req);
    const handle = new FakePtyHandle(`pty_${this.handles.length + 1}`);
    this.handles.push(handle);
    return handle;
  }

  /** Последний открытый терминал. */
  get lastHandle(): FakePtyHandle {
    const handle = this.handles[this.handles.length - 1];
    if (!handle) throw new Error('PTY ещё не открывался');
    return handle;
  }
}

// ---------------------------------------------------------------------------
// Фикстуры
// ---------------------------------------------------------------------------

/** Проект с владельцем и участниками. */
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Проект',
    ownerId: 'owner',
    members: {
      viewer: ProjectRole.VIEWER,
      editor: ProjectRole.EDITOR,
    },
    description: '',
    currentTask: '',
    invariants: '',
    statusMessages: [],
    workspace: '/work/proj-1',
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
    ...overrides,
  } as Project;
}

/** Сессия проекта (только нужные поля). */
function makeSession(overrides: Partial<Session> = {}): Session {
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
    ...overrides,
  } as unknown as Session;
}

// ---------------------------------------------------------------------------
// Песочница
// ---------------------------------------------------------------------------

interface Harness {
  app: Hono;
  service: TerminalService;
  /**
   * Эмулятор порта по умолчанию (`options.port` не задан). Если тест подставил
   * свой порт (PTY не поддерживается/падает), сервис работает с ним, а этот
   * остаётся пустым — на него не опираться.
   */
  port: FakeExecutionPort;
  events: { type: string; data: Record<string, unknown> }[];
  /** Создать терминал (owner) — вернуть его id. */
  openTerminal: (overrides?: Record<string, unknown>) => Promise<string>;
}

/** Текущий пользователь запроса — из заголовка `X-Test-User`. */
function userOf(c: Context): string {
  return c.req.header('X-Test-User') ?? 'owner';
}

/** Собрать приложение с контуром терминалов. */
function createHarness(
  options: { limits?: Record<string, number>; port?: ExecutionPort } = {},
): Harness {
  const app = new Hono();
  const defaultPort = new FakeExecutionPort();
  const port = options.port ?? defaultPort;
  const eventBus = new EventBus();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  eventBus.subscribeAll((event) => {
    events.push({ type: event.type, data: event.data });
  });

  const projects = new Map<string, Project>([['proj-1', makeProject()]]);
  const sessions = new Map<string, Session>([
    ['sess-1', makeSession()],
    // Сессия чужого проекта: привязать терминал к ней нельзя.
    ['sess-other', makeSession({ id: 'sess-other', projectId: 'proj-2' })],
  ]);

  const service = new TerminalService({
    port,
    eventBus,
    ...(options.limits ? { limits: options.limits } : {}),
  });

  const requireAuth = async (c: Context, next: Next) => {
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
        getCurrentUserId: (c) => userOf(c),
        // Правила проекта — единый резолвер `shared` (PROP-133).
        canReadProject: (c, project, userId) => {
          const access = resolveProjectAccess(project, { userId, roles: [] });
          return access.read;
        },
        canEditProjectContent: (c, project, userId) => {
          const access = resolveProjectAccess(project, { userId, roles: [] });
          return access.role === 'owner' || access.role === 'editor';
        },
        workspacesRoot: '/work',
      },
    ),
  );

  /** Открыть терминал от имени владельца проекта. */
  const openTerminal = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const res = await app.request('/api/v2/terminals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-User': 'owner' },
      body: JSON.stringify({ project_id: 'proj-1', cols: 80, rows: 24, ...overrides }),
    });
    const body = (await res.json()) as { terminal?: { id?: string } };
    const id = body.terminal?.id;
    if (!id) throw new Error(`терминал не создан: ${res.status}`);
    return id;
  };

  return { app, service, port: defaultPort, events, openTerminal };
}

/** Запрос к приложению от имени пользователя. */
function req(
  app: Hono,
  path: string,
  init: RequestInit & { user?: string } = {},
): Promise<Response> {
  const { user, ...rest } = init;
  return Promise.resolve(
    app.request(path, {
      ...rest,
      headers: {
        ...(user ? { 'X-Test-User': user } : {}),
        ...((rest.headers as Record<string, string>) ?? {}),
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

describe('HTTP-контур терминалов (PROP-132, Ф3б)', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(() => {
    harness.service.dispose();
  });

  it('создаёт терминал и отдаёт его снимок', async () => {
    const res = await req(harness.app, '/api/v2/terminals', {
      method: 'POST',
      user: 'owner',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: 'proj-1',
        session_id: 'sess-1',
        cols: 100,
        rows: 30,
        title: 'Сборка',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { terminal: Record<string, unknown> };
    expect(body.terminal['id']).toMatch(/^term_/);
    expect(body.terminal['project_id']).toBe('proj-1');
    expect(body.terminal['session_id']).toBe('sess-1');
    expect(body.terminal['cols']).toBe(100);
    expect(body.terminal['rows']).toBe(30);
    expect(body.terminal['title']).toBe('Сборка');
    expect(body.terminal['can_write']).toBe(true);
    expect(body.terminal['attached_clients']).toBe(0);
    // DTO — целиком snake_case: camelCase-полей записи в ответе нет.
    expect(body.terminal['projectId']).toBeUndefined();
    expect(body.terminal['createdAt']).toBeUndefined();
    expect(body.terminal['lastActivityAt']).toBeUndefined();
    expect(typeof body.terminal['created_at']).toBe('number');
    // Событие `terminal.created` ушло в шину (общий `EventType`); канал —
    // сессия терминала (у терминала без привязки событий нет).
    expect(harness.events.some((event) => event.type === 'terminal.created')).toBe(true);
  });

  it('требует project_id и не принимает чужой проект', async () => {
    const noProject = await req(harness.app, '/api/v2/terminals', {
      method: 'POST',
      user: 'owner',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    expect(noProject.status).toBe(400);

    const unknownProject = await req(harness.app, '/api/v2/terminals', {
      method: 'POST',
      user: 'owner',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: 'proj-unknown', cols: 80, rows: 24 }),
    });
    expect(unknownProject.status).toBe(404);
  });

  it('игнорирует cwd из тела: каталог терминала вычисляет сервер', async () => {
    await harness.openTerminal({ cwd: '/etc' });
    expect(harness.port.requests[0]?.cwd).toBe('/work/proj-1');
  });

  it('берёт каталог из worktree сессии, если она привязана', async () => {
    await harness.openTerminal({ session_id: 'sess-1' });
    expect(harness.port.requests[0]?.cwd).toBe('/work/proj-1');
  });

  it('не привязывает терминал к сессии чужого проекта', async () => {
    const unknown = await req(harness.app, '/api/v2/terminals', {
      method: 'POST',
      user: 'owner',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: 'proj-1', session_id: 'sess-unknown', cols: 80, rows: 24 }),
    });
    expect(unknown.status).toBe(404);

    const foreign = await req(harness.app, '/api/v2/terminals', {
      method: 'POST',
      user: 'owner',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: 'proj-1', session_id: 'sess-other', cols: 80, rows: 24 }),
    });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('отвергает некорректный размер терминала', async () => {
    const res = await req(harness.app, '/api/v2/terminals', {
      method: 'POST',
      user: 'owner',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: 'proj-1', cols: 'wide', rows: 24 }),
    });
    expect(res.status).toBe(400);
  });

  it('валидирует размеры при создании (400 VALIDATION_ERROR, без клампа)', async () => {
    for (const body of [
      { cols: 0, rows: 24 },
      { cols: 80, rows: -1 },
      { cols: 100000, rows: 24 },
      { cols: 80, rows: 100000 },
      { cols: '80', rows: 24 },
      { cols: 80.5, rows: 24 },
    ]) {
      const res = await req(harness.app, '/api/v2/terminals', {
        method: 'POST',
        user: 'owner',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 'proj-1', ...body }),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'VALIDATION_ERROR',
      );
    }
    // Ни один терминал не открылся: размер не «подправлен» молча.
    expect(harness.port.handles).toHaveLength(0);
  });

  it('отдаёт список постранично (ADR-118)', async () => {
    await harness.openTerminal();
    const res = await req(harness.app, '/api/v2/terminals?project_id=proj-1&limit=10&offset=0', {
      user: 'owner',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      terminals: Array<Record<string, unknown>>;
      total: number;
      offset: number;
      limit: number;
      next_offset: number | null;
    };
    expect(body.terminals).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(10);
    expect(body.next_offset).toBeNull();
    expect(body.terminals[0]?.['can_write']).toBe(true);
  });

  it('отвергает нецелочисленный limit (400 VALIDATION_ERROR)', async () => {
    const res = await req(harness.app, '/api/v2/terminals?limit=abc', { user: 'owner' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('include_exited отдаёт завершённые терминалы, без флага — только живые', async () => {
    const id = await harness.openTerminal();
    // Оболочка вышла — терминал завершён (как терминал, восстановленный из
    // снимка после рестарта ядра: статус `exited`, PTY не поднят).
    harness.port.handles[0]?.emitExit({ exitCode: 0 });

    const live = await req(harness.app, '/api/v2/terminals?project_id=proj-1', { user: 'owner' });
    expect(live.status).toBe(200);
    const liveBody = (await live.json()) as { terminals: unknown[]; total: number };
    expect(liveBody.terminals).toHaveLength(0);
    expect(liveBody.total).toBe(0);

    for (const flag of ['include_exited=true', 'include_exited=1']) {
      const res = await req(harness.app, `/api/v2/terminals?project_id=proj-1&${flag}`, {
        user: 'owner',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        terminals: Array<Record<string, unknown>>;
        total: number;
      };
      expect(body.terminals).toHaveLength(1);
      expect(body.terminals[0]?.['id']).toBe(id);
      expect(body.terminals[0]?.['status']).toBe('exited');
      expect(body.total).toBe(1);
    }
  });

  it('include_exited работает и с фильтром по сессии', async () => {
    const id = await harness.openTerminal({ session_id: 'sess-1' });
    harness.port.handles[0]?.emitExit({ exitCode: 0 });

    const res = await req(harness.app, '/api/v2/terminals?session_id=sess-1&include_exited=true', {
      user: 'owner',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { terminals: Array<Record<string, unknown>> };
    expect(body.terminals).toHaveLength(1);
    expect(body.terminals[0]?.['id']).toBe(id);
  });

  it('include_exited не обходит права: чужой пользователь не видит терминал', async () => {
    await harness.openTerminal();
    harness.port.handles[0]?.emitExit({ exitCode: 0 });

    // Явный `project_id` + нет права на проект → 403 (как и без флага).
    const stranger = await req(
      harness.app,
      '/api/v2/terminals?project_id=proj-1&include_exited=true',
      { user: 'stranger' },
    );
    expect(stranger.status).toBe(403);
    expect(((await stranger.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    // Без явного проекта чужой терминал просто не попадает в выдачу.
    const strangerAll = await req(
      harness.app,
      '/api/v2/terminals?include_exited=true',
      { user: 'stranger' },
    );
    expect(strangerAll.status).toBe(200);
    expect(((await strangerAll.json()) as { terminals: unknown[] }).terminals).toHaveLength(0);

    // Участник с ролью просмотра читает завершённый терминал (но не пишет).
    const viewer = await req(
      harness.app,
      '/api/v2/terminals?project_id=proj-1&include_exited=true',
      { user: 'viewer' },
    );
    expect(viewer.status).toBe(200);
    const body = (await viewer.json()) as { terminals: Array<Record<string, unknown>> };
    expect(body.terminals).toHaveLength(1);
    expect(body.terminals[0]?.['can_write']).toBe(false);
  });

  it('участник с ролью просмотра читает терминал, но не пишет в него', async () => {
    const id = await harness.openTerminal();

    const read = await req(harness.app, `/api/v2/terminals/${id}`, { user: 'viewer' });
    expect(read.status).toBe(200);
    const body = (await read.json()) as { terminal: Record<string, unknown> };
    expect(body.terminal['can_write']).toBe(false);

    const input = await req(harness.app, `/api/v2/terminals/${id}/input`, {
      method: 'POST',
      user: 'viewer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'ls\n' }),
    });
    expect(input.status).toBe(403);
    expect(harness.port.lastHandle.writes).toHaveLength(0);
  });

  it('чужой пользователь не видит терминал и не может его создать', async () => {
    const id = await harness.openTerminal();

    const read = await req(harness.app, `/api/v2/terminals/${id}`, { user: 'stranger' });
    expect(read.status).toBe(403);

    const list = await req(harness.app, '/api/v2/terminals', { user: 'stranger' });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { terminals: unknown[] }).terminals).toHaveLength(0);

    const create = await req(harness.app, '/api/v2/terminals', {
      method: 'POST',
      user: 'stranger',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: 'proj-1', cols: 80, rows: 24 }),
    });
    expect(create.status).toBe(403);
  });

  it('несуществующий терминал — 404 TERMINAL_NOT_FOUND', async () => {
    const res = await req(harness.app, '/api/v2/terminals/term_missing', { user: 'owner' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('TERMINAL_NOT_FOUND');
  });

  it('отдаёт факт переднего плана терминала (foreground)', async () => {
    const id = await harness.openTerminal();
    harness.port.lastHandle.foreground = {
      shellPid: 4242,
      foregroundPgid: 4300,
      command: 'vim',
      isShell: false,
    };

    const res = await req(harness.app, `/api/v2/terminals/${id}/foreground`, { user: 'owner' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      foreground: {
        shell_pid?: number;
        foreground_pgid?: number;
        command?: string;
        is_shell: boolean;
      } | null;
    };
    expect(body.foreground).toEqual({
      shell_pid: 4242,
      foreground_pgid: 4300,
      command: 'vim',
      is_shell: false,
    });
  });

  it('foreground без ответа пробы — {foreground: null} (неизвестно, а не ошибка)', async () => {
    const id = await harness.openTerminal();
    // Проба не дала ответа (старый исполнитель/не Linux) — «неизвестно».
    harness.port.lastHandle.foreground = null;

    const res = await req(harness.app, `/api/v2/terminals/${id}/foreground`, { user: 'owner' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { foreground: unknown };
    expect(body.foreground).toBeNull();
  });

  it('foreground завершённого терминала — {foreground: null}', async () => {
    const id = await harness.openTerminal();
    harness.port.lastHandle.emitExit({ exitCode: 0 });

    const res = await req(harness.app, `/api/v2/terminals/${id}/foreground`, { user: 'owner' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { foreground: unknown }).foreground).toBeNull();
  });

  it('foreground чужого терминала — 403, несуществующего — 404 TERMINAL_NOT_FOUND', async () => {
    const id = await harness.openTerminal();

    const stranger = await req(harness.app, `/api/v2/terminals/${id}/foreground`, {
      user: 'stranger',
    });
    expect(stranger.status).toBe(403);
    expect(((await stranger.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    const missing = await req(harness.app, '/api/v2/terminals/term_missing/foreground', {
      user: 'owner',
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('TERMINAL_NOT_FOUND');
  });

  it('догоняет вывод по курсору (output?since=)', async () => {
    const id = await harness.openTerminal();
    harness.port.lastHandle.emitData('первый');
    await new Promise((r) => setTimeout(r, 30));

    const all = await req(harness.app, `/api/v2/terminals/${id}/output`, { user: 'owner' });
    expect(all.status).toBe(200);
    const body = (await all.json()) as {
      data: string;
      seq: number;
      next_seq: number;
      chunks: Array<{ seq: number; data: string }>;
    };
    expect(body.data).toBe('первый');
    expect(body.seq).toBe(1);
    expect(body.next_seq).toBe(1);
    expect(body.chunks).toHaveLength(1);

    const tail = await req(harness.app, `/api/v2/terminals/${id}/output?since=1`, { user: 'owner' });
    const tailBody = (await tail.json()) as { data: string; chunks: unknown[] };
    expect(tailBody.data).toBe('');
    expect(tailBody.chunks).toHaveLength(0);
  });

  it('отдаёт поток NDJSON и снимает подписку по abort', async () => {
    const id = await harness.openTerminal();
    harness.port.lastHandle.emitData('кадр');
    await new Promise((r) => setTimeout(r, 30));

    const controller = new AbortController();
    const res = await harness.app.request(`/api/v2/terminals/${id}/stream?since=0`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    const line = decoder.decode(first.value ?? new Uint8Array());
    expect(line.trim().split('\n')[0]).toBe('{"seq":1,"data":"кадр"}');
    expect(harness.service.attachedClients(id)).toBe(1);

    // Клиент отключился — поток закрывается, подписка снята.
    controller.abort();
    const closed = await reader.read();
    expect(closed.done).toBe(true);
    await vi.waitFor(() => expect(harness.service.attachedClients(id)).toBe(0));
    // DTO подтверждает то же число: терминал снова без клиентов.
    const snapshot = await req(harness.app, `/api/v2/terminals/${id}`, { user: 'owner' });
    const body = (await snapshot.json()) as { terminal: { attached_clients: number } };
    expect(body.terminal.attached_clients).toBe(0);
  });

  it('снимает подписку по cancel() читателя (клиент закрыл поток)', async () => {
    const id = await harness.openTerminal();
    const res = await harness.app.request(`/api/v2/terminals/${id}/stream?since=0`, {});
    expect(harness.service.attachedClients(id)).toBe(1);

    await res.body!.cancel();
    await vi.waitFor(() => expect(harness.service.attachedClients(id)).toBe(0));

    // Вывод после отмены не держит подписку и не бросает наружу.
    harness.port.lastHandle.emitData('после отмены');
    await new Promise((r) => setTimeout(r, 40));
    expect(harness.service.attachedClients(id)).toBe(0);
  });

  it('шлёт heartbeat раз в 15 с (пустой кадр)', async () => {
    const id = await harness.openTerminal();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const res = await harness.app.request(`/api/v2/terminals/${id}/stream?since=0`, {});
      const reader = res.body!.getReader();
      await vi.advanceTimersByTimeAsync(15_000);
      const frame = await reader.read();
      const line = new TextDecoder().decode(frame.value ?? new Uint8Array()).trim();
      expect(line).toBe('{"seq":0,"data":""}');
      expect(harness.service.attachedClients(id)).toBe(1);
      await reader.cancel();
      await vi.waitFor(() => expect(harness.service.attachedClients(id)).toBe(0));
    } finally {
      vi.useRealTimers();
    }
  });

  it('подписка снимается и по реальному обрыву соединения (standalone-адаптер)', async () => {
    // Регресс D1: адаптер `server/app/http-server.ts` не отменял читателя и не
    // абортил сигнал запроса — подписка оставалась в реестре навсегда.
    const server = createStandaloneHttpServer({ app: harness.app });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const created = await fetch(`${base}/api/v2/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 'proj-1', cols: 80, rows: 24 }),
      });
      const { terminal } = (await created.json()) as { terminal: { id: string } };
      harness.port.lastHandle.emitData('обрыв');
      await new Promise((r) => setTimeout(r, 30));

      const controller = new AbortController();
      const stream = await fetch(`${base}/api/v2/terminals/${terminal.id}/stream?since=0`, {
        signal: controller.signal,
      });
      const reader = stream.body!.getReader();
      await reader.read();
      expect(harness.service.attachedClients(terminal.id)).toBe(1);

      controller.abort();
      await vi.waitFor(() => expect(harness.service.attachedClients(terminal.id)).toBe(0), {
        timeout: 2000,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('снимает подписку по abort — терминал снова простаивает и убирается reaper-ом', async () => {
    const limited = createHarness({ limits: { idleMs: 0, reaperIntervalMs: 300 } });
    try {
      const id = await limited.openTerminal();
      const controller = new AbortController();
      const res = await limited.app.request(`/api/v2/terminals/${id}/stream?since=0`, {
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      expect(limited.service.attachedClients(id)).toBe(1);

      controller.abort();
      await reader.read().catch(() => ({ done: true }));
      // Подписчик снят → терминал простаивает → idle-reaper его закрывает.
      await vi.waitFor(() => expect(limited.service.get(id)).toBeNull(), { timeout: 3000 });
    } finally {
      limited.service.dispose();
    }
  });

  it('переименовывает терминал и меняет привязку к сессии', async () => {
    const id = await harness.openTerminal();
    const res = await req(harness.app, `/api/v2/terminals/${id}`, {
      method: 'PATCH',
      user: 'owner',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Логи', session_id: 'sess-1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { terminal: Record<string, unknown> };
    expect(body.terminal['title']).toBe('Логи');
    expect(body.terminal['session_id']).toBe('sess-1');
  });

  it('закрывает терминал (DELETE → 204)', async () => {
    const id = await harness.openTerminal();
    const res = await req(harness.app, `/api/v2/terminals/${id}`, {
      method: 'DELETE',
      user: 'owner',
    });
    expect(res.status).toBe(204);
    expect(harness.service.get(id)).toBeNull();
  });

  it('меняет размер терминала', async () => {
    const id = await harness.openTerminal();
    const res = await req(harness.app, `/api/v2/terminals/${id}/resize`, {
      method: 'POST',
      user: 'owner',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols: 120, rows: 40 }),
    });
    expect(res.status).toBe(204);
    expect(harness.port.lastHandle.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('маппит лимиты сервиса в HTTP-коды', async () => {
    const limited = createHarness({ limits: { maxPerProject: 1 } });
    try {
      await limited.openTerminal();
      const res = await req(limited.app, '/api/v2/terminals', {
        method: 'POST',
        user: 'owner',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 'proj-1', cols: 80, rows: 24 }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; details?: { scope?: string } } };
      expect(body.error.code).toBe('TERMINAL_LIMIT');
      expect(body.error.details?.scope).toBe('project');
    } finally {
      limited.service.dispose();
    }
  });

  it('отвергает кадр ввода больше капа (413)', async () => {
    const id = await harness.openTerminal();
    const res = await req(harness.app, `/api/v2/terminals/${id}/input`, {
      method: 'POST',
      user: 'owner',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(16 * 1024 + 1) }),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('TERMINAL_LIMIT');
    expect(harness.port.lastHandle.writes).toHaveLength(0);
  });

  it('отвергает кадр ввода 20 КиБ (413 TERMINAL_LIMIT, scope input)', async () => {
    const id = await harness.openTerminal();
    const res = await req(harness.app, `/api/v2/terminals/${id}/input`, {
      method: 'POST',
      user: 'owner',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(20 * 1024) }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      error: { code: string; details?: { scope?: string; limit?: number } };
    };
    expect(body.error.code).toBe('TERMINAL_LIMIT');
    expect(body.error.details?.scope).toBe('input');
    expect(body.error.details?.limit).toBe(16 * 1024);
    expect(harness.port.lastHandle.writes).toHaveLength(0);
  });

  it('валидирует размер в resize (400 VALIDATION_ERROR)', async () => {
    const id = await harness.openTerminal();
    for (const body of [
      { cols: 0, rows: 24 },
      { cols: 80, rows: -1 },
      { cols: 100000, rows: 24 },
      { cols: '80', rows: 24 },
    ]) {
      const res = await req(harness.app, `/api/v2/terminals/${id}/resize`, {
        method: 'POST',
        user: 'owner',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'VALIDATION_ERROR',
      );
    }
    // Размер терминала не менялся (сервис не вызывался).
    expect(harness.port.lastHandle.resizes).toHaveLength(0);
  });

  it('DELETE закрывает терминал: повторный GET — 404', async () => {
    const id = await harness.openTerminal();
    const removed = await req(harness.app, `/api/v2/terminals/${id}`, {
      method: 'DELETE',
      user: 'owner',
    });
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');

    const after = await req(harness.app, `/api/v2/terminals/${id}`, { user: 'owner' });
    expect(after.status).toBe(404);
    expect(((await after.json()) as { error: { code: string } }).error.code).toBe(
      'TERMINAL_NOT_FOUND',
    );
  });

  it('перезапускает завершённый терминал (POST /:id/restart)', async () => {
    const id = await harness.openTerminal();
    harness.port.handles[0]?.emitExit({ exitCode: 0 });

    const res = await req(harness.app, `/api/v2/terminals/${id}/restart`, {
      method: 'POST',
      user: 'owner',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      terminal: { id: string; status: string; restored?: boolean };
    };
    expect(body.terminal.id).toBe(id);
    expect(body.terminal.status).toBe('running');
    expect(body.terminal.restored).toBe(false);
    // Новый PTY поднят.
    expect(harness.port.requests).toHaveLength(2);
  });

  it('живой терминал перезапустить нельзя (409 TERMINAL_ALREADY_RUNNING)', async () => {
    const id = await harness.openTerminal();

    const res = await req(harness.app, `/api/v2/terminals/${id}/restart`, {
      method: 'POST',
      user: 'owner',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'TERMINAL_ALREADY_RUNNING',
    );
    // Второй PTY не открывался.
    expect(harness.port.requests).toHaveLength(1);
  });

  it('перезапуск требует прав на изменение содержимого проекта', async () => {
    const id = await harness.openTerminal();
    harness.port.handles[0]?.emitExit({ exitCode: 0 });

    const res = await req(harness.app, `/api/v2/terminals/${id}/restart`, {
      method: 'POST',
      user: 'viewer',
    });
    expect(res.status).toBe(403);
  });

  it('PTY не поддерживается исполнителем (EPTY) → 503 TERMINAL_UNAVAILABLE, reason pty_unsupported', async () => {
    // Браузерный профиль/старый образ (protocol ≤ 7): `features.pty` нет,
    // `openPty` отвечает `EPTY` — сервис пробрасывает ошибку порта, роут
    // обязан объяснить причину, а не отдавать общий 500.
    const unsupported: ExecutionPort = {
      async execute(): Promise<ExecResult> {
        throw new Error('execute не используется в тестах терминалов');
      },
      async openPty(): Promise<PtyHandle> {
        throw new ExecutionError({
          message: 'Исполнитель не поддерживает PTY-сессии: нет features.pty',
          code: 'EPTY',
          reason: 'dependency_missing',
        });
      },
    };
    const ptyHarness = createHarness({ port: unsupported });
    try {
      const res = await req(ptyHarness.app, '/api/v2/terminals', {
        method: 'POST',
        user: 'owner',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 'proj-1', cols: 80, rows: 24 }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        error: {
          code: string;
          message: string;
          details?: { reason?: string; code?: string; detail?: string };
        };
      };
      expect(body.error.code).toBe('TERMINAL_UNAVAILABLE');
      expect(body.error.details?.reason).toBe('pty_unsupported');
      expect(body.error.details?.code).toBe('EPTY');
      expect(body.error.message).toContain('PTY');
    } finally {
      ptyHarness.service.dispose();
    }
  });

  it('спавн PTY на исполнителе упал (spawn_failed) → 503, reason executor', async () => {
    const broken: ExecutionPort = {
      async execute(): Promise<ExecResult> {
        throw new Error('execute не используется в тестах терминалов');
      },
      async openPty(): Promise<PtyHandle> {
        throw new ExecutionError({
          message: 'не удалось запустить оболочку на исполнителе',
          code: 'ESPAWN',
          reason: 'spawn_failed',
        });
      },
    };
    const brokenHarness = createHarness({ port: broken });
    try {
      const res = await req(brokenHarness.app, '/api/v2/terminals', {
        method: 'POST',
        user: 'owner',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 'proj-1', cols: 80, rows: 24 }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        error: { code: string; details?: { reason?: string; code?: string } };
      };
      expect(body.error.code).toBe('TERMINAL_UNAVAILABLE');
      expect(body.error.details?.reason).toBe('executor');
      expect(body.error.details?.code).toBe('ESPAWN');
    } finally {
      brokenHarness.service.dispose();
    }
  });

  it('выключатель инстанса закрывает контур (403 TERMINALS_DISABLED)', async () => {
    const id = await harness.openTerminal();
    harness.service.setEnabled(false);

    for (const [method, path, body] of [
      ['GET', '/api/v2/terminals', undefined],
      ['POST', '/api/v2/terminals', JSON.stringify({ project_id: 'proj-1', cols: 80, rows: 24 })],
      ['GET', `/api/v2/terminals/${id}`, undefined],
      ['GET', `/api/v2/terminals/${id}/stream`, undefined],
      ['POST', `/api/v2/terminals/${id}/input`, JSON.stringify({ data: 'x' })],
      ['POST', `/api/v2/terminals/${id}/resize`, JSON.stringify({ cols: 80, rows: 24 })],
      ['POST', `/api/v2/terminals/${id}/restart`, undefined],
      ['DELETE', `/api/v2/terminals/${id}`, undefined],
    ] as const) {
      const res = await req(harness.app, path, {
        method,
        user: 'owner',
        ...(body !== undefined
          ? { headers: { 'Content-Type': 'application/json' }, body }
          : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'TERMINALS_DISABLED',
      );
    }
  });
});
