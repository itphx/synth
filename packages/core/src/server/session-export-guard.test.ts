// ADR-036 / security-фикс 0.11.3: route-level guard экспорта сессии.
//
// Guard решает ОДНУ привилегию — «карта обфускации LLM Gateway»: полный
// экспорт (владелец сессии, `ADMIN`, `AUDITOR`) или очищенный (остальные
// читатели сессии). Доступ к сессии (403/404) решает общий prefix-guard
// (`session-access-guard.ts`) — в обработчике проверок доступа нет.
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { MessageRole } from '@itphx/synth-shared';
import type { Session } from '@itphx/synth-shared';
import { createSessionAccessGuard, createSessionAccessPredicate } from './session-access-guard.js';
import { createSessionExportGuard, getSessionExportDecision, isSessionExportPath } from './session-export-guard.js';
import { stripSessionSecrets } from '../engine/gateway/obfuscation-map-store.js';

/** Реальный секрет в карте обфускации сессии (плейсхолдер → значение). */
const REAL_SECRET = 'sk-live-DO-NOT-LEAK';
const PLACEHOLDER = '⟦SYNTH_SECRET_1⟧';

interface Actor {
  id: string;
  roles: string[];
}

const ACTORS: Record<string, Actor> = {
  owner: { id: 'owner', roles: [] },
  reader: { id: 'reader', roles: [] },
  lead: { id: 'lead', roles: ['LEAD'] },
  admin: { id: 'admin', roles: ['ADMIN'] },
  auditor: { id: 'auditor', roles: ['AUDITOR'] },
  stranger: { id: 'stranger', roles: [] },
};

/** Сессия владельца `owner` с картой обфускации и секретом в сообщении. */
function session(): Session {
  return {
    id: 's1',
    sessionOrigin: 'user',
    projectId: 'p1',
    ownerId: 'owner',
    userId: 'owner',
    obfuscationMap: { [PLACEHOLDER]: REAL_SECRET },
    messages: [
      {
        id: 'm1',
        role: MessageRole.ASSISTANT,
        seq: 1,
        origin: 'local',
        parts: [],
        content: 'ответ с секретом',
        createdAt: '2026-01-01T00:00:00.000Z',
        disabled: false,
        pinned: false,
        hidden: false,
        metadata: { secrets: { [PLACEHOLDER]: REAL_SECRET } },
      } as unknown as Session['messages'][number],
    ],
    pendingMessages: [],
    checkpoints: [],
    stickyNotes: [],
    references: [],
    todos: [],
    status: {},
    settings: {} as Session['settings'],
    summarizationPending: false,
    canSummarize: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
  } as unknown as Session;
}

interface TestApp {
  app: Hono;
  /** Счётчик вызовов резолвера сессии в ROUTE-level guard'е экспорта. */
  exportGuardCalls: () => number;
}

function makeApp(): TestApp {
  const app = new Hono();
  const sessions = new Map<string, Session>([['s1', session()]]);
  let exportGuardCalls = 0;

  const requireAuth = async (c: Context, next: Next) => {
    const token = (c.req.header('Authorization') ?? '').replace(/^Bearer /, '');
    const actor = ACTORS[token];
    if (!actor) return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
    c.set('user', actor);
    await next();
  };
  const currentUser = (c: Context): Actor => c.get('user') as Actor;
  const resolveUserId = async (c: Context): Promise<string> => currentUser(c).id;

  // Единое правило доступа (как в backend): владелец | elevated | проектное чтение.
  // Плюс документированное исключение политики: `AUDITOR` — читатель сессии на
  // маршруте экспорта (карта обфускации любой сессии ему доступна и так).
  const predicate = createSessionAccessPredicate({
    canAccess: (s, _c, userId) => (s.ownerId ?? s.userId) === userId,
    resolveCanAccessExtra: async (s, _c, userId) => s.projectId === 'p1' && userId === 'reader',
  });
  const accessGuard = createSessionAccessGuard({
    param: 'id',
    resolveSession: async (id) => sessions.get(id) ?? null,
    resolveUserId,
    isAllowed: async (s, c, userId, access) => {
      const roles = currentUser(c).roles;
      if (roles.includes('ADMIN') || roles.includes('LEAD')) return true;
      if (access === 'read' && roles.includes('AUDITOR') && isSessionExportPath(c.req.path)) return true;
      return predicate(s, c, userId, access);
    },
    messages: { sessionNotFound: () => 'not found', forbidden: () => 'forbidden' },
  });

  // Префикс-guard — ДО маршрутов (инвариант 16).
  app.use('/:id', requireAuth, accessGuard as never);
  app.use('/:id/*', requireAuth, accessGuard as never);

  const exportGuard = createSessionExportGuard({
    param: 'id',
    resolveSession: async (id) => {
      exportGuardCalls++;
      return sessions.get(id) ?? null;
    },
    resolveUserId,
    isAdmin: (c) => currentUser(c).roles.includes('ADMIN'),
    isAuditor: (c) => currentUser(c).roles.includes('AUDITOR'),
    messages: { sessionNotFound: () => 'not found' },
  });

  app.get('/:id/export', requireAuth, exportGuard as never, (c) => {
    const decision = getSessionExportDecision(c);
    if (!decision) return c.json({ error: { code: 'INTERNAL_ERROR', message: 'no decision' } }, 500);
    return c.json(decision.withSecrets ? decision.session : stripSessionSecrets(decision.session));
  });

  return { app, exportGuardCalls: () => exportGuardCalls };
}

function request(app: Hono, actor: string, id = 's1') {
  return app.request(`/${id}/export`, { headers: { Authorization: `Bearer ${actor}` } });
}

describe('createSessionExportGuard (привилегия карты обфускации)', () => {
  it('владелец сессии → полный экспорт (карта обфускации на месте)', async () => {
    const { app } = makeApp();
    const res = await request(app, 'owner');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { obfuscationMap?: Record<string, string> };
    expect(body.obfuscationMap).toEqual({ [PLACEHOLDER]: REAL_SECRET });
  });

  it('ADMIN/AUDITOR → полный экспорт', async () => {
    for (const actor of ['admin', 'auditor']) {
      const { app } = makeApp();
      const res = await request(app, actor);
      expect(res.status, actor).toBe(200);
      const body = (await res.json()) as { obfuscationMap?: Record<string, string> };
      expect(body.obfuscationMap, actor).toEqual({ [PLACEHOLDER]: REAL_SECRET });
    }
  });

  it('прочие читатели сессии (проектный участник, LEAD) → 200 с очищенным экспортом', async () => {
    for (const actor of ['reader', 'lead']) {
      const { app } = makeApp();
      const res = await request(app, actor);
      expect(res.status, actor).toBe(200);
      const body = (await res.json()) as {
        obfuscationMap?: unknown;
        messages?: Array<{ content?: string; metadata?: Record<string, unknown> }>;
      };
      expect(body.obfuscationMap, actor).toBeUndefined();
      expect(JSON.stringify(body), actor).not.toContain(REAL_SECRET);
      // Разговор цел — экспорт остаётся payload'ом переноса.
      expect(body.messages?.[0]?.content, actor).toBe('ответ с секретом');
      expect(body.messages?.[0]?.metadata?.secrets, actor).toBeUndefined();
    }
  });

  it('нет доступа → 403 от prefix-guard\'а; route-level guard и обработчик НЕ отработали', async () => {
    const { app, exportGuardCalls } = makeApp();
    const res = await request(app, 'stranger');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    // Рoute-level guard не запускался — значит и обработчик не запускался.
    expect(exportGuardCalls()).toBe(0);
  });

  it('несуществующая сессия → 404 (не смешиваем коды)', async () => {
    const { app, exportGuardCalls } = makeApp();
    const res = await request(app, 'owner', 'nope');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    expect(exportGuardCalls()).toBe(0);
  });
});
