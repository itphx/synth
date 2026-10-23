/**
 * PROP-108 Ф3: WS-контракт подтверждений (backend) + **перепись мест принятия
 * решений**.
 *
 * Что проверяет этот файл:
 *
 * 1) **Перепись мест принятия решений.** Ответ на `permission_reply` принимает
 *    **носитель покрывающего гранта** — единственная точка решения — реестр
 *    подтверждений (`ApprovalRegistry.claim`). Перепись: все места публикации
 *    `permission.replied` в `packages/core/src` и `packages/backend/src`
 *    перечислены явно (`DECISION_POINTS`); новый путь без реестра роняет тест.
 *    (Инструментации «по смонтированному приложению» здесь нет: WS-обработчик
 *    не является Hono-роутом, поэтому перепись снимается по исходникам — так же,
 *    как инвариант 17 требует перечислять места, а не «чинить по списку».)
 *
 * 2) **Матрица подтверждений на транспорте.** `VIEWER` (участник проекта с
 *    правом чтения) получает кадр `error/APPROVAL_DENIED` и НЕ подтверждает
 *    мутирующий тул; владелец сессии подтверждает; повторный ответ — отказ
 *    (`already_consumed`); посторонний (сессия не видна) — ответа нет вовсе.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readdir, readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { WebSocket } from 'ws';
import type { Server } from 'node:http';

import {
  ApprovalRegistry,
  EventBus,
  FileStore,
  ProjectStore,
  SessionManager,
  buildApprovalResponderProfile,
  createApprovalCoverageResolver,
  computeAuthorityApprovalDigest,
} from '@itphx/synth-core';
import type { AuthorityTarget, User } from '@itphx/synth-shared';
import { ProjectRole } from '@itphx/synth-shared';

import { EventHub } from '../events/hub.js';
import { createBackendListen } from './listen.js';
import { closeTestServer } from '../test-helpers/close-server.js';

// ---------------------------------------------------------------------------
// Фикстуры
// ---------------------------------------------------------------------------

const APPROVAL_ID = 'approval_1';
const TURN_ID = 'turn_1';
const TARGET: AuthorityTarget = { kind: 'path', ref: 'src/app.ts' };

type Actor = 'owner' | 'viewer' | 'editor' | 'admin' | 'stranger';

const USERS: Record<string, User> = {
  owner: { id: 'owner', username: 'owner', roles: ['USER'] } as User,
  viewer: { id: 'viewer', username: 'viewer', roles: ['USER'] } as User,
  editor: { id: 'editor', username: 'editor', roles: ['USER'] } as User,
  admin: { id: 'admin', username: 'admin', roles: ['ADMIN'] } as User,
  stranger: { id: 'stranger', username: 'stranger', roles: ['USER'] } as User,
};

function userFromHeader(header: string | undefined): User | null {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return m ? USERS[m[1]!] ?? null : null;
}

/** Мок-AuthKit: пользователь по `Authorization`, роли — из фикстуры. */
const auth = {
  getCurrentUser: async (c: { req: { header(name: string): string | undefined } }) =>
    userFromHeader(c.req.header('Authorization')),
  hasRole: (c: { get(key: string): unknown }, ...roles: string[]) => {
    const user = c.get('user') as User | undefined;
    return roles.some((r) => (user?.roles ?? []).includes(r));
  },
} as unknown as Parameters<typeof createBackendListen>[0]['auth'];

interface Sandbox {
  port: number;
  server: Server;
  eventBus: EventBus;
  registry: ApprovalRegistry;
  sessionManager: SessionManager;
  sessionId: string;
  close: () => Promise<void>;
}

let tmpDir: string;
let sandbox: Sandbox;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-approval-ws-'));

  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const eventBus = new EventBus();
  const eventHub = new EventHub(eventBus, sessionManager);

  // Проект: владелец `owner`, участник `viewer` (VIEWER) и `editor` (EDITOR).
  const project = projectStore.create('Shared', 'owner');
  project.members['viewer'] = ProjectRole.VIEWER;
  project.members['editor'] = ProjectRole.EDITOR;
  await projectStore.save(project);

  const session = await sessionManager.createSession({
    title: 'S',
    userId: 'owner',
    ownerId: 'owner',
    projectId: project.id,
  });
  expect(session.id).toBeTruthy();

  // Реестр подтверждений: покрытие — как в проде (`app/deps.ts`).
  const registry = new ApprovalRegistry({
    coverage: createApprovalCoverageResolver({
      policy: null,
      profile: async (sessionId, principal) => {
        const s = await sessionManager.getSession(sessionId);
        const p = s?.projectId ? await projectStore.load(s.projectId) : null;
        return buildApprovalResponderProfile({ principal, sources: { session: s, project: p } });
      },
    }),
  });

  const app = new Hono();
  app.get('/health', (c: Context) => c.json({ status: 'healthy' }));
  app.use('*', async (_c: Context, next: Next) => {
    await next();
  });

  const queueManager = {
    isRunning: () => false,
    stop: () => {},
    createProcessor: () => {},
    requestStop: () => false,
    retryNow: () => true,
    cancelRetry: async () => true,
  };

  const orchestrator = {
    obfuscateUserMessageForHistory: async () => ({ content: '' }),
  };

  const listen = createBackendListen({
    app,
    auth,
    eventHub,
    sessionManager,
    projectStore,
    eventBus,
    queueManager: queueManager as never,
    processMessage: (async () => ({})) as never,
    orchestrator: orchestrator as never,
    defaultPort: 0,
    approvalRegistry: registry,
  });

  const started = await listen(0, '127.0.0.1');
  sandbox = {
    port: started.port,
    server: started.server,
    eventBus,
    registry,
    sessionManager,
    sessionId: session.id,
    close: async () => {
      await closeTestServer(started.server);
    },
  };
});

afterAll(async () => {
  await sandbox?.close();
  await rm(tmpDir, { recursive: true, force: true });
});

/** Открыть привязку подтверждения (как это делает оркестратор при `ask`). */
function openBinding(approvalId = APPROVAL_ID): string {
  const digest = computeAuthorityApprovalDigest({ turnId: TURN_ID, action: 'write', target: TARGET });
  sandbox.registry.open(approvalId, {
    principal: { kind: 'user', id: 'owner', roles: [] },
    turnId: TURN_ID,
    action: 'write',
    target: TARGET,
    digest,
  });
  return digest;
}

interface WsFrame {
  type?: string;
  data?: { code?: string; error?: string };
}

/** Клиент `/ws/events`: кадры собираются в массив. */
function connect(actor: Actor): { ws: WebSocket; frames: WsFrame[]; ready: Promise<void> } {
  const ws = new WebSocket(`ws://127.0.0.1:${sandbox.port}/ws/events`, {
    headers: { Authorization: `Bearer ${actor}` },
  });
  const frames: WsFrame[] = [];
  ws.on('message', (raw: Buffer) => {
    try {
      frames.push(JSON.parse(raw.toString()) as WsFrame);
    } catch {
      // ignore
    }
  });
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  return { ws, frames, ready };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Ждать кадр по условию (с таймаутом). */
async function waitForFrame(
  frames: WsFrame[],
  predicate: (f: WsFrame) => boolean,
  timeoutMs = 3000,
): Promise<WsFrame | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = frames.find(predicate);
    if (found) return found;
    await sleep(20);
  }
  return undefined;
}

/** Ответ на запрос подтверждения (`permission_reply`). */
function replyFrame(actor: Actor, approvalId: string, digest?: string): string {
  return JSON.stringify({
    type: 'permission_reply',
    session_id: sandbox.sessionId,
    approval_id: approvalId,
    action: 'allow',
    ...(digest ? { digest } : {}),
  });
}

// ---------------------------------------------------------------------------
// 1. Перепись мест принятия решений
// ---------------------------------------------------------------------------

/**
 * Места, где принимается решение по ответу на подтверждение. Новый путь
 * (например, второй WS-канал или HTTP-эндпоинт ответа) обязан попасть в
 * список **и** проходить через реестр (`claim`).
 */
const DECISION_POINTS = [
  'packages/backend/src/app/listen.ts',
  'packages/core/src/server/app/ws-events.ts',
];

/** Корень монорепозитория (по расположению этого файла). */
const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

/** Все `.ts`-файлы пакета (без тестов). */
async function sourceFiles(pkg: string): Promise<string[]> {
  const root = join(REPO_ROOT, 'packages', pkg, 'src');
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      out.push(relative(REPO_ROOT, full).split(sep).join('/'));
    }
  };
  await walk(root);
  return out;
}

describe('PROP-108 Ф3: перепись мест принятия решений по подтверждениям', () => {
  it('все места публикации `permission.replied` перечислены (новый путь → тест падает)', async () => {
    const found: string[] = [];
    for (const pkg of ['core', 'backend']) {
      for (const file of await sourceFiles(pkg)) {
        const content = await readFile(join(REPO_ROOT, file), 'utf-8');
        if (/publish\(\s*[\w.]+\s*,\s*'permission\.replied'/.test(content)) found.push(file);
      }
    }
    expect(found.sort()).toEqual([...DECISION_POINTS].sort());
  });

  it('каждое место решения проходит через реестр подтверждений (claim)', async () => {
    for (const file of DECISION_POINTS) {
      const content = await readFile(join(REPO_ROOT, file), 'utf-8');
      expect(content, file).toMatch(/approvalRegistry/);
      expect(content, file).toMatch(/\.claim\(/);
      // Отказ должен быть виден клиенту машинным кодом.
      expect(content, file).toMatch(/APPROVAL_DENIED/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Матрица подтверждений на транспорте
// ---------------------------------------------------------------------------

describe('PROP-108 Ф3: WS-ответ на подтверждение — только носитель покрывающего гранта', () => {
  beforeEach(() => {
    sandbox.registry.close(APPROVAL_ID);
  });

  it('владелец сессии подтверждает (ответ принят)', async () => {
    const digest = openBinding();
    const replied: Array<Record<string, unknown>> = [];
    sandbox.eventBus.subscribe(sandbox.sessionId, (e) => {
      if (e.type === 'permission.replied') replied.push(e.data as Record<string, unknown>);
    });

    const client = connect('owner');
    await client.ready;
    await waitForFrame(client.frames, (f) => f.type === 'connected');
    client.ws.send(replyFrame('owner', APPROVAL_ID, digest));

    const reply = await waitForFrame(client.frames, (f) => f.type === 'error');
    expect(reply, 'ошибки быть не должно').toBeUndefined();
    await sleep(50);
    expect(replied.length).toBe(1);
    expect(replied[0]?.approved).toBe(true);
    expect(replied[0]?.action).toBe('allow');
    // Привязка — из реестра (серверный источник истины).
    expect(replied[0]?.turn_id).toBe(TURN_ID);
    expect(replied[0]?.digest).toBe(digest);
    client.ws.close();
  });

  it('VIEWER (правом чтения) НЕ подтверждает мутирующий тул → APPROVAL_DENIED', async () => {
    const digest = openBinding();
    const replied: Array<Record<string, unknown>> = [];
    sandbox.eventBus.subscribe(sandbox.sessionId, (e) => {
      if (e.type === 'permission.replied') replied.push(e.data as Record<string, unknown>);
    });

    const client = connect('viewer');
    await client.ready;
    await waitForFrame(client.frames, (f) => f.type === 'connected');
    client.ws.send(replyFrame('viewer', APPROVAL_ID, digest));

    const err = await waitForFrame(client.frames, (f) => f.type === 'error');
    expect(err?.data?.code).toBe('APPROVAL_DENIED');
    await sleep(50);
    expect(replied.length).toBe(1);
    expect(replied[0]?.approved).toBe(false);
    expect(replied[0]?.action).toBe('deny');
    expect(replied[0]?.reason).toBe('no_grant');
    client.ws.close();
  });

  it('повторный ответ на тот же approval_id → deny (already_consumed)', async () => {
    const digest = openBinding();
    const client = connect('owner');
    await client.ready;
    await waitForFrame(client.frames, (f) => f.type === 'connected');
    client.ws.send(replyFrame('owner', APPROVAL_ID, digest));
    await sleep(100);

    client.ws.send(replyFrame('owner', APPROVAL_ID, digest));
    const err = await waitForFrame(client.frames, (f) => f.type === 'error');
    expect(err?.data?.code).toBe('APPROVAL_DENIED');
    client.ws.close();
  });

  it('чужой пользователь (сессия не видна) — ответа нет вовсе', async () => {
    const digest = openBinding();
    const replied: Array<Record<string, unknown>> = [];
    sandbox.eventBus.subscribe(sandbox.sessionId, (e) => {
      if (e.type === 'permission.replied') replied.push(e.data as Record<string, unknown>);
    });

    const client = connect('stranger');
    await client.ready;
    await waitForFrame(client.frames, (f) => f.type === 'connected');
    client.ws.send(replyFrame('stranger', APPROVAL_ID, digest));
    await sleep(200);

    expect(replied.length).toBe(0);
    client.ws.close();
  });
});

// ---------------------------------------------------------------------------
// 3. PROP-098: инъекция/interrupt не создаёт новый ход
// ---------------------------------------------------------------------------

describe('PROP-098: interrupt не создаёт новый ход', () => {
  it('режим interrupt отклонён машинным кодом, ход не создан', async () => {
    const client = connect('owner');
    await client.ready;
    await waitForFrame(client.frames, (f) => f.type === 'connected');
    client.ws.send(
      JSON.stringify({
        type: 'send_message',
        session_id: sandbox.sessionId,
        content: 'перебить',
        mode: 'interrupt',
      }),
    );

    const err = await waitForFrame(client.frames, (f) => f.type === 'error');
    expect(err?.data?.code).toBe('STEERING_INTERRUPT_UNSUPPORTED');

    // Ход не создан: поток прежний, в очередь ничего не встало.
    const session = await sandbox.sessionManager.getSession(sandbox.sessionId);
    expect(session?.currentStream).toBeUndefined();
    expect(session?.pendingMessages?.length ?? 0).toBe(0);
    client.ws.close();
  });
});
