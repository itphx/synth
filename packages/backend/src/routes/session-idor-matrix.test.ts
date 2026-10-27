/**
 * IDOR-класс: авторизация сессий — инвариант на ПРЕФИКСЕ роутера, а не вызов
 * «по списку» в каждом хендлере.
 *
 * Что проверяет этот файл:
 *
 * 1) **Тест-перепись по СМОНТИРОВАННОМУ приложению.** Перечень `:id`/`:sessionId`-
 *    маршрутов ресурса сессий снимается с реально смонтированного приложения
 *    (`createBackendApp()`), а не с отдельных фабрик. Собранная для матрицы
 *    песочница (`buildWorld`) монтирует ровно тот же полный перечень фабрик
 *    (`/api/v2/{sessions,messages,queue}`) — равенство наборов маршрутов с
 *    `createBackendApp` утверждается тестом. Добавили фабрику/маршрут — тест падает.
 *
 * 2) **Негативная матрица** — чужой USER → 403 на КАЖДОМ маршруте ресурса.
 *
 * 3) **Позитивная матрица** — явный ожидаемый код по столбцам:
 *    `владелец сессии | VIEWER-участник | EDITOR-участник | OWNER проекта |
 *     ADMIN | LEAD | AUDITOR | чужой USER`.
 *
 *    Правило доступа (в ЕДИНОЙ точке — prefix-guard, метод-зависимо):
 *    - чтение (`GET`/`HEAD`): владелец сессии, ADMIN/LEAD (сквозной обзор) либо
 *      проектное чтение (`canReadProject`: owner проекта или любой участник);
 *    - мутация (`POST`/`PATCH`/`PUT`/`DELETE`): владелец сессии, ADMIN/LEAD либо
 *      проектное редактирование (`canEditProjectContent`: owner/EDITOR проекта).
 *
 *    Явные исключения (не «проектное» правило, задокументированы в коде):
 *    - `/:id/mcp` — владелец сессии|ADMIN (ADR-071 §2.4): настройка MCP-скоупа
 *      сессии, не проектные данные;
 *    - `/:id/secrets` — ADMIN|AUDITOR (карта обфускации);
 *    - `/:id/export` — маршрут ПОД prefix-guard'ом (доступ к сессии решает он,
 *      отдельного правила в обработчике нет — инвариант 16), привилегия карты
 *      обфускации — route-level guard core (`createSessionExportGuard`):
 *      владелец сессии|ADMIN|AUDITOR получают полный экспорт
 *      (с картой обфускации LLM Gateway и `messages[].metadata.secrets` — тот
 *      же набор привилегий, что у `GET /:id/secrets`); прочие ЧИТАТЕЛИ сессии
 *      (участник проекта VIEWER/EDITOR, владелец проекта, LEAD) — 200 с
 *      ОЧИЩЕННЫМ экспортом (секретов в ответе нет, разговор переносится —
 *      publish/fork не ломается); без доступа на чтение → 403
 *      (security-фикс 0.11.3).
 *
 *    Поведение LEAD/ADMIN (мутация чужих сессий) — осознанное решение, НЕ менялось.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionManager,
  EventBus,
  FileStore,
  ProjectStore,
  createSessionSkillScopeRoutes,
  MemoryQuestionRepository,
  QuestionService,
  // ADR-115: вложения сообщений — файловые порты (blob-хранилище + `blob_refs`).
  FileBlobStore,
  FileBlobRefRepository,
} from '@itphx/synth-core';
import type { ChatOrchestrator } from '@itphx/synth-core';
import type { Message, Project, User } from '@itphx/synth-shared';
import { MessageRole, ProjectRole, nowISO, generateId, makeTextPart } from '@itphx/synth-shared';
import { createSessionRoutes as createBackendSessionRoutes } from './sessions.js';
import { createMessageRoutes as createBackendMessageRoutes } from './messages.js';
import { createQueueRoutes as createBackendQueueRoutes } from './queue.js';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

// ---------------------------------------------------------------------------
// Типы матрицы
// ---------------------------------------------------------------------------

type Actor =
  | 'owner' // владелец сессии
  | 'viewer' // участник проекта (VIEWER)
  | 'editor' // участник проекта (EDITOR)
  | 'projectOwner' // владелец проекта (не владелец сессии)
  | 'admin'
  | 'lead'
  | 'auditor'
  | 'stranger'; // чужой USER

type Base = 'sessions' | 'messages' | 'queue';

interface Row {
  base: Base;
  method: string;
  path: string;
  expected: Record<Actor, number>;
}

const ALL_ACTORS: Actor[] = [
  'owner',
  'viewer',
  'editor',
  'projectOwner',
  'admin',
  'lead',
  'auditor',
  'stranger',
];

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * Базовые ожидания: чтение — владелец/VIEWER/EDITOR/owner проекта/ADMIN/LEAD;
 * мутация — владелец/EDITOR/owner проекта/ADMIN/LEAD; прочие (вне elevated и
 * проектных ролей) — 403. `status` переопределяет код РАЗРЕШЁННЫХ акторов;
 * явные per-actor значения — поверх.
 */
function row(
  base: Base,
  method: string,
  path: string,
  opts: { status?: number } & Partial<Record<Actor, number>> = {},
): Row {
  const write = !READ_METHODS.has(method.toUpperCase());
  const allowed: Actor[] = write
    ? ['owner', 'editor', 'projectOwner', 'admin', 'lead']
    : ['owner', 'viewer', 'editor', 'projectOwner', 'admin', 'lead'];
  const expected = {} as Record<Actor, number>;
  for (const a of ALL_ACTORS) expected[a] = allowed.includes(a) ? (opts.status ?? 200) : 403;
  for (const a of ALL_ACTORS) if (opts[a] !== undefined) expected[a] = opts[a]!;
  return { base, method, path, expected };
}

/**
 * Единственный источник правды — перечень маршрутов ресурса сессий и их
 * ожидаемые коды. Пропуск маршрута или расхождение кода роняет тест.
 */
const MATRIX: Row[] = [
  // --- core session routes (backend-mounted) ---
  row('sessions', 'GET', '/:id'),
  row('sessions', 'PATCH', '/:id'),
  row('sessions', 'DELETE', '/:id', { status: 204 }),
  row('sessions', 'GET', '/:id/status'),
  row('sessions', 'GET', '/:id/prompt'),
  // ADR-107: агрегаты памяти для вкладки «Память» — чтение сессии.
  row('sessions', 'GET', '/:id/memory'),
  // Этап 1 roadmap 0.13 (блок 3): вопросы пользователю (`ask_user`).
  // Чтение — по правилу чтения сессии; ответ/отмена — по правилу мутации
  // (владелец/участник с правом изменения): ответ — действие пользователя.
  row('sessions', 'GET', '/:id/questions'),
  row('sessions', 'POST', '/:id/questions/:qid/answer', { status: 404 }),
  row('sessions', 'POST', '/:id/questions/:qid/cancel', { status: 404 }),
  row('sessions', 'GET', '/:id/stats'),
  row('sessions', 'POST', '/:id/prompt', { status: 400 }), // пустое тело → VALIDATION_ERROR
  row('sessions', 'GET', '/:id/messages'),
  row('sessions', 'POST', '/:id/clear'),
  row('sessions', 'POST', '/:id/abort'),
  row('sessions', 'POST', '/:id/resume-subagent', { status: 202 }),
  row('sessions', 'POST', '/:id/summarize', { status: 400 }),
  row('sessions', 'GET', '/:id/children'),
  row('sessions', 'GET', '/:id/tree'),
  row('sessions', 'POST', '/:id/fork', { status: 201 }),
  row('sessions', 'GET', '/:id/references'),
  row('sessions', 'POST', '/:id/references', { status: 201 }),
  row('sessions', 'DELETE', '/:id/references/:refSid', { status: 204 }),
  row('sessions', 'POST', '/:id/messages/merge', { status: 400 }), // пустое тело → VALIDATION_ERROR

  // --- ADR-115: вложения сообщений (core-фабрика внутри приложения сессий) ---
  // Чтение байтов — правило чтения сессии; неизвестная часть → 404 (объект не
  // раскрывается). Загрузка — мутация; тело не multipart → 400 валидации.
  row('sessions', 'GET', '/:id/attachments/:partId', { status: 404 }),
  row('sessions', 'POST', '/:id/attachments', { status: 400 }),

  // --- backend-only session routes ---
  // MCP-скоуп сессии: владелец|ADMIN (ADR-071 §2.4) — участники/LEAD НЕ имеют доступа.
  row('sessions', 'GET', '/:id/mcp', { viewer: 403, editor: 403, projectOwner: 403, lead: 403 }),
  // PUT с пустым телом у разрешённых (владелец/ADMIN) → 400 (валидация схемы).
  row('sessions', 'PUT', '/:id/mcp', { status: 400, viewer: 403, editor: 403, projectOwner: 403, lead: 403 }),
  // Карта обфускации — только ADMIN/AUDITOR (ролевой guard раньше доступа).
  row('sessions', 'GET', '/:id/secrets', {
    owner: 403, viewer: 403, editor: 403, projectOwner: 403, lead: 403, admin: 200, auditor: 200,
  }),
  // security-фикс 0.11.3: экспорт сессии — доступ на ЧТЕНИЕ + различие по
  // привилегии. Читатели сессии (участник проекта VIEWER/EDITOR, владелец
  // проекта, LEAD) получают 200 с ОЧИЩЕННЫМ ответом (без карты обфускации
  // `obfuscationMap` и `messages[].metadata.secrets`); полный экспорт с картой —
  // владельцу сессии, ADMIN и AUDITOR (тот же набор привилегий, что у
  // `GET /:id/secrets`); без доступа на чтение (посторонний) → 403.
  // Матрица фиксирует КОДЫ доступа; очистку ответа проверяет
  // `sessions-access.test.ts`.
  row('sessions', 'GET', '/:id/export', { auditor: 200 }),
  row('sessions', 'POST', '/:id/debug-system-message'),
  row('sessions', 'GET', '/:id/optimization'),
  row('sessions', 'PATCH', '/:id/optimization'),
  row('sessions', 'POST', '/:id/optimization/check'),
  row('sessions', 'POST', '/:id/optimization/cancel-summarization'),
  row('sessions', 'GET', '/:id/notes'),
  row('sessions', 'POST', '/:id/notes', { status: 201 }),
  row('sessions', 'PATCH', '/:id/notes/:noteId'),
  row('sessions', 'DELETE', '/:id/notes/:noteId'),

  // --- session skill-scope routes (отдельная фабрика на том же префиксе) ---
  // Та же семантика, что у ресурса сессии: GET — проектное чтение (VIEWER ок),
  // PUT — проектное редактирование (VIEWER → 403).
  row('sessions', 'GET', '/:id/skills'),
  row('sessions', 'GET', '/:id/skills/effective'),
  row('sessions', 'PUT', '/:id/skills'),

  // --- core message routes ---
  row('messages', 'POST', '/:sessionId/batch'),
  row('messages', 'PATCH', '/:sessionId/:index/toggle'),
  row('messages', 'PATCH', '/:sessionId/:index/pin'),
  row('messages', 'DELETE', '/:sessionId/:index'),
  row('messages', 'POST', '/:sessionId/:index/retry'),
  row('messages', 'GET', '/:sessionId/:index/debug'),

  // --- core queue routes ---
  row('queue', 'POST', '/:sessionId/clear'),
  row('queue', 'POST', '/:sessionId/return'),
  row('queue', 'POST', '/:sessionId/resume'),
  row('queue', 'POST', '/:sessionId/retry-now'),
  row('queue', 'POST', '/:sessionId/cancel-retry'),
];

const PREFIX: Record<Base, string> = {
  sessions: '/api/v2/sessions',
  messages: '/api/v2/messages',
  queue: '/api/v2/queue',
};

function fullPath(r: Row): string {
  return `${PREFIX[r.base]}${r.path}`;
}

function declaredRoutes(): string[] {
  return MATRIX.map((r) => `${r.method} ${fullPath(r)}`).sort();
}

// ---------------------------------------------------------------------------
// Интроспекция Hono по смонтированному приложению
// ---------------------------------------------------------------------------

interface HonoRoute {
  method: string;
  path: string;
}

function routesOf(app: Hono): HonoRoute[] {
  return (app as unknown as { routes: HonoRoute[] }).routes;
}

/** `:id`/`:sessionId`-маршруты ресурса сессий с СМОНТИРОВАННОГО приложения. */
function resourceRoutes(app: Hono): string[] {
  const set = new Set<string>();
  for (const r of routesOf(app)) {
    if (r.method === 'ALL') continue;
    if (!/^\/api\/v2\/(sessions|messages|queue)\//.test(r.path)) continue;
    if (!r.path.includes(':id') && !r.path.includes(':sessionId')) continue;
    set.add(`${r.method} ${r.path}`);
  }
  return [...set].sort();
}

function allMiddlewarePaths(app: Hono): string[] {
  return routesOf(app)
    .filter((r) => r.method === 'ALL')
    .map((r) => r.path);
}

// ---------------------------------------------------------------------------
// Акторы
// ---------------------------------------------------------------------------

type MockUser = User & { roles: string[] };

const USERS: Record<string, MockUser> = {
  owner: { id: 'owner', username: 'owner', roles: ['USER'] } as MockUser,
  viewer: { id: 'viewer', username: 'viewer', roles: ['USER'] } as MockUser,
  editor: { id: 'editor', username: 'editor', roles: ['USER'] } as MockUser,
  projectOwner: { id: 'projectOwner', username: 'projectOwner', roles: ['USER'] } as MockUser,
  admin: { id: 'admin', username: 'admin', roles: ['ADMIN'] } as MockUser,
  lead: { id: 'lead', username: 'lead', roles: ['LEAD'] } as MockUser,
  auditor: { id: 'auditor', username: 'auditor', roles: ['AUDITOR'] } as MockUser,
  stranger: { id: 'stranger', username: 'stranger', roles: ['USER'] } as MockUser,
};

function userFromHeader(header: string | undefined): MockUser | null {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return m ? USERS[m[1]!] ?? null : null;
}

/** Мок-AuthKit: пользователь из `Authorization`, роли из фикстуры. */
function createMockKit() {
  const requireAuth = async (c: Context, next: Next) => {
    const user = userFromHeader(c.req.header('Authorization'));
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
    c.set('user' as never, user as never);
    await next();
  };
  return {
    requireAuth,
    requirePermission: (...roles: string[]) => async (c: Context, next: Next) => {
      const user = c.get('user') as MockUser | undefined;
      if (!user || !roles.some((r) => user.roles.includes(r))) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
      }
      await next();
    },
    getCurrentUser: async (c: Context) => userFromHeader(c.req.header('Authorization')),
    isAdmin: (c: { get(key: 'user'): unknown }) =>
      ((c.get('user') as User | undefined)?.roles ?? []).includes('ADMIN'),
    hasRole: (c: { get(key: 'user'): unknown }, ...roles: string[]) =>
      roles.some((r) => ((c.get('user') as User | undefined)?.roles ?? []).includes(r)),
  };
}

// ---------------------------------------------------------------------------
// Песочница: полный перечень фабрик, смонтированных на /api/v2/{sessions,messages,queue}
// ---------------------------------------------------------------------------

interface World {
  app: Hono;
  sessionManager: SessionManager;
  projectStore: ProjectStore;
  projectId: string;
  sourceSessionId: string;
}

function createMockQueueManager() {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    stop: vi.fn(),
    createProcessor: vi.fn(),
    requestStop: vi.fn().mockReturnValue(false),
    retryNow: vi.fn().mockReturnValue(true),
    cancelRetry: vi.fn().mockResolvedValue(true),
  };
}

function createMockContextOptimizer() {
  return {
    canSummarize: vi.fn().mockReturnValue(false),
    shouldApplySlidingWindow: vi.fn().mockReturnValue({ triggered: false }),
    shouldSummarize: vi.fn().mockReturnValue({ triggered: false }),
  };
}

function createMockOrchestrator() {
  const processMessage = vi.fn().mockResolvedValue({});
  return {
    agentRegistry: { get: () => undefined },
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
    getPromptInfo: vi.fn().mockResolvedValue({}),
    getModelPricing: vi.fn().mockReturnValue(null),
    resolveMcpServers: vi.fn().mockResolvedValue([]),
    startSubagentResume: vi.fn().mockResolvedValue({ status: 'resumed' }),
  };
}

/** Проектное чтение: owner проекта или любой участник. */
function projectRead(project: Project, userId: string): boolean {
  return project.ownerId === userId || userId in (project.members ?? {});
}
/** Проектное редактирование: owner проекта, OWNER/EDITOR участник. */
function projectWrite(project: Project, userId: string): boolean {
  const role = project.members?.[userId];
  return project.ownerId === userId || role === ProjectRole.OWNER || role === ProjectRole.EDITOR;
}

async function buildWorld(tmpDir: string): Promise<World> {
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const eventBus = new EventBus();
  const queueManager = createMockQueueManager();
  const orchestrator = createMockOrchestrator();
  const contextOptimizer = createMockContextOptimizer();
  const eventHub = {
    subscribeToSession: vi.fn().mockResolvedValue(undefined),
    unsubscribeFromSession: vi.fn(),
  };
  // Этап 1 roadmap 0.13 (блок 3): сервис «вопрос пользователю» — те же
  // маршруты, что и в реальном приложении (`GET /:id/questions`,
  // `POST /:id/questions/:qid/answer|cancel`).
  const questionService = new QuestionService({
    repository: new MemoryQuestionRepository(),
    eventBus,
    timeoutMs: 60_000,
  });

  // Проект: владелец `projectOwner`, участники `viewer` (VIEWER) и `editor` (EDITOR).
  const project = projectStore.create('Shared', 'projectOwner');
  project.members['viewer'] = ProjectRole.VIEWER;
  project.members['editor'] = ProjectRole.EDITOR;
  await projectStore.save(project);

  const app = new Hono();
  const kit = createMockKit();

  // Паритет с production `attachUser`: пользователь в контексте глобально, чтобы
  // ролевые guard'ы (`requirePermission('ADMIN','AUDITOR')`) его видели.
  app.use('*', async (c, next) => {
    const user = userFromHeader(c.req.header('Authorization'));
    if (user) c.set('user' as never, user as never);
    await next();
  });

  // Полный перечень фабрик на трёх префиксах — ровно как в `mount-routes.ts`.
  app.route('/api/v2/sessions', createBackendSessionRoutes(
    kit as never,
    sessionManager,
    eventBus,
    queueManager as never,
    orchestrator.createProcessMessage(),
    orchestrator as unknown as ChatOrchestrator,
    eventHub as never,
    contextOptimizer as never,
    projectStore,
    // profilesStore / resolveDefaultAgent / requestSessionService / analytics /
    // memory — в песочнице не заданы.
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // Этап 1 roadmap 0.13 (блок 3): сервис вопросов пользователю.
    questionService,
    // ADR-114: сервис worktree'ов в песочнице не задан.
    undefined,
    // ADR-115: вложения — тот же контур, что в production (`POST/GET :id/attachments`).
    {
      blobs: new FileBlobStore({ root: join(tmpDir, 'blobs') }),
      blobRefs: new FileBlobRefRepository({ dataDir: tmpDir }),
      config: {
        maxBytesPerFile: 1024 * 1024,
        maxFilesPerMessage: 10,
        maxBytesPerSession: 10 * 1024 * 1024,
        allowedMimePrefixes: ['image/', 'audio/', 'application/pdf', 'text/'],
        gcDays: 30,
      },
    },
  ));
  app.route('/api/v2/messages', createBackendMessageRoutes(
    kit as never,
    sessionManager,
    contextOptimizer as never,
    eventBus,
    projectStore,
  ));
  app.route('/api/v2/queue', createBackendQueueRoutes(
    kit as never,
    sessionManager,
    queueManager as never,
    eventBus,
    orchestrator.createProcessMessage(),
    projectStore,
  ));
  app.route('/api/v2/sessions', createSessionSkillScopeRoutes(
    { requireAuth: kit.requireAuth } as never,
    { sessionManager, projectStore },
    {
      writeGuard: kit.requireAuth,
      resolveUserId: async (c) => userFromHeader(c.req.header('Authorization'))?.id ?? '',
      canAccess: (session, _c, userId) =>
        (session.ownerId ?? session.userId) === userId || userId === 'admin',
      resolveElevated: (c) => {
        const u = userFromHeader(c.req.header('Authorization'));
        return !!u && (u.roles.includes('ADMIN') || u.roles.includes('LEAD'));
      },
      resolveCanAccessExtra: async (session, _c, userId, access) => {
        if (!session.projectId) return false;
        const p = await projectStore.load(session.projectId);
        if (!p) return false;
        return access === 'read' ? projectRead(p, userId) : projectWrite(p, userId);
      },
    },
  ));

  const source = await sessionManager.createSession({ title: 'Source', userId: 'owner', ownerId: 'owner' });

  return { app, sessionManager, projectStore, projectId: project.id, sourceSessionId: source.id };
}

// ---------------------------------------------------------------------------
// Матрица — единый прогон по всем клеткам
// ---------------------------------------------------------------------------

function urlFor(base: Base, path: string, sessionId: string): string {
  const replaced = path
    .replace(':qid', 'qst-none')
    .replace(':sessionId', sessionId)
    .replace(':id', sessionId)
    .replace(':index', '0')
    .replace(':refSid', 'ref-1')
    .replace(':noteId', 'note-1');
  return `${PREFIX[base]}${replaced}`;
}

/** Тело запроса по маршруту (чтобы «разрешённый» путь доходил до осмысленного кода). */
function bodyFor(row: Row, world: World): string | undefined {
  if (row.method === 'GET' || row.method === 'DELETE') return undefined;
  const p = row.path;
  if (row.base === 'messages' && p.endsWith('/batch')) {
    return JSON.stringify({ action: 'pin', indices: [0] });
  }
  if (p.endsWith('/references')) return JSON.stringify({ source_session_id: world.sourceSessionId });
  if (p.endsWith('/notes')) return JSON.stringify({ content: 'note' });
  if (p.includes('/notes/')) return JSON.stringify({ content: 'updated' });
  if (p.endsWith('/skills')) return JSON.stringify({ name: 'skill-x', enabled: true });
  // Этап 1 roadmap 0.13 (блок 3): ответ на вопрос (вопроса с таким id нет →
  // 404, а не 400 валидации).
  if (p.includes('/questions/') && p.endsWith('/answer')) {
    return JSON.stringify({ answers: [['a']] });
  }
  if (p.endsWith('/optimization')) return JSON.stringify({ summarization_enabled: true });
  return JSON.stringify({});
}

function makeMessage(): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 1,
    origin: 'local',
    parts: [makeTextPart('hi')],
    content: 'hi',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
  };
}

/** Свежая сессия владельца `owner` в общем проекте; при необходимости — с сообщением/заметкой. */
async function seedSession(world: World, row: Row | null): Promise<string> {
  const session = await world.sessionManager.createSession({
    title: 'S',
    userId: 'owner',
    ownerId: 'owner',
    projectId: world.projectId,
  });
  if (row?.base === 'messages') {
    await world.sessionManager.addMessage(session.id, makeMessage());
  }
  if (row && row.method !== 'POST' && row.path.includes('/notes/')) {
    await world.sessionManager.withLock(session.id, async (s) => {
      s.stickyNotes.push({
        id: 'note-1',
        content: 'note',
        createdAt: nowISO(),
        updatedAt: nowISO(),
        disabled: false,
      } as never);
      await world.sessionManager.saveSession(s);
    });
  }
  return session.id;
}

async function call(world: World, row: Row, sessionId: string, actor: Actor): Promise<number> {
  const body = bodyFor(row, world);
  const res = await world.app.request(urlFor(row.base, row.path, sessionId), {
    method: row.method,
    headers: {
      Authorization: `Bearer ${actor}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body } : {}),
  });
  return res.status;
}

let tmpDir: string;
let world: World;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-idor-matrix-'));
  world = await buildWorld(tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Перепись: смонтированное приложение + полный перечень фабрик
// ---------------------------------------------------------------------------

describe('IDOR: перепись :id-маршрутов (защита от «фикса по списку»)', () => {
  it('песочница монтирует ровно тот же перечень, что и реальный createBackendApp()', async () => {
    const backendDir = await mkdtemp(join(tmpdir(), 'synth-idor-backend-'));
    let backend: BackendAppHandle | undefined;
    try {
      backend = await createBackendApp({ dataDir: backendDir, authDebug: true });
      expect(resourceRoutes(world.app)).toEqual(resourceRoutes(backend.app));
    } finally {
      backend?.stopScheduler();
      backend?.stopEphemeralSweeper();
      backend?.stopEventJournalPruner();
      backend?.stopWebhookService();
      backend?.stopWebhookDeliveryPruner();
      await rm(backendDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('перечень :id-маршрутов песочницы === матрица', () => {
    expect(resourceRoutes(world.app)).toEqual(declaredRoutes());
  });

  it('на префиксе зарегистрированы guard-middleware `/:id`, `/:id/*`, `/:sessionId`', () => {
    const all = allMiddlewarePaths(world.app);
    expect(all).toContain('/api/v2/sessions/:id');
    expect(all).toContain('/api/v2/sessions/:id/*');
    expect(all).toContain('/api/v2/messages/:sessionId');
    expect(all).toContain('/api/v2/messages/:sessionId/*');
    expect(all).toContain('/api/v2/queue/:sessionId');
    expect(all).toContain('/api/v2/queue/:sessionId/*');
  });

  it('перепись ловит искусственно добавленный `:id`-маршрут', () => {
    world.app.get('/api/v2/sessions/:id/__probe', (c) => c.text('probe'));
    expect(resourceRoutes(world.app)).not.toEqual(declaredRoutes());
  });
});

// ---------------------------------------------------------------------------
// 2. Негативная матрица: чужой USER → 403 на каждом маршруте
// ---------------------------------------------------------------------------

describe('IDOR: негативная матрица — чужой USER → 403', () => {
  it('каждый :id-маршрут ресурса защищён', async () => {
    for (const r of MATRIX) {
      const sessionId = await seedSession(world, r);
      const status = await call(world, r, sessionId, 'stranger');
      expect(status, `${r.method} ${fullPath(r)}`).toBe(403);
    }
  });

  it('несуществующая сессия → 404, а не 403 (не смешиваем коды)', async () => {
    const res = await world.app.request('/api/v2/sessions/non-existent/messages', {
      headers: { Authorization: 'Bearer owner' },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// 3. Позитивная матрица: ожидаемый код на каждую клетку
// ---------------------------------------------------------------------------

describe('IDOR: позитивная матрица — ожидаемый код по ролям', () => {
  for (const r of MATRIX) {
    it(`${r.method} ${fullPath(r)}`, async () => {
      for (const actor of ALL_ACTORS) {
        const sessionId = await seedSession(world, r);
        const status = await call(world, r, sessionId, actor);
        expect(status, `${actor} → ${r.method} ${fullPath(r)}`).toBe(r.expected[actor]);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Регресс F1: LEAD (сквозной обзор) получает тот же ответ, что владелец/ADMIN
// ---------------------------------------------------------------------------

describe('F1: LEAD не заблокирован на status/prompt/stats/prompt', () => {
  it('владелец/ADMIN/LEAD — один и тот же ответ на всех маршрутах ресурса', async () => {
    const routes: Array<[string, string, number]> = [
      ['GET', '/:id/status', 200],
      ['GET', '/:id/prompt', 200],
      ['GET', '/:id/stats', 200],
      ['POST', '/:id/prompt', 400],
    ];
    for (const [method, path, expectedStatus] of routes) {
      const r = MATRIX.find((m) => m.base === 'sessions' && m.method === method && m.path === path)!;
      for (const actor of ['owner', 'admin', 'lead'] as Actor[]) {
        const sessionId = await seedSession(world, r);
        const status = await call(world, r, sessionId, actor);
        expect(status, `${actor} ${method} ${path}`).toBe(expectedStatus);
      }
    }
  });

  it('LEAD/ADMIN мутируют чужую сессию (решение пользователя, поведение НЕ изменено)', async () => {
    for (const actor of ['lead', 'admin'] as Actor[]) {
      const sessionId = await seedSession(world, null);
      const res = await world.app.request(`/api/v2/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${actor}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'renamed-by-elevated' }),
      });
      expect(res.status, actor).toBe(200);
      const session = await world.sessionManager.getSession(sessionId);
      expect(session?.title, actor).toBe('renamed-by-elevated');
    }
  });
});
