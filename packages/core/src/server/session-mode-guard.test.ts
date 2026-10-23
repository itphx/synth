/**
 * ADR-106 Ф4 (шаг C): смена режима сессии — привилегия на границе.
 *
 * Guard решает, **чью** сессию меняет режим (`session-mode-guard.ts`):
 * одиночная сессия — общий режим (прежнее поведение), многопользовательская —
 * режим только принципала, который его выставил; `viewer` и неучастник —
 * 403 FORBIDDEN. Тело запроса после guard'а остаётся читаемым (режим
 * применяет обработчик по решению — инвариант 16).
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import type { Session, SessionParticipant } from '@itphx/synth-shared';

import { createSessionModeGuard, getSessionModeDecision } from './session-mode-guard.js';

const PARTICIPANTS: SessionParticipant[] = [
  { userId: 'owner-1', role: 'owner' },
  { userId: 'editor-1', role: 'editor' },
  { userId: 'viewer-1', role: 'viewer' },
];

function makeSession(participants: SessionParticipant[] = PARTICIPANTS): Session {
  return {
    id: 's1',
    sessionOrigin: 'user',
    ownerId: 'owner-1',
    messages: [],
    pendingMessages: [],
    status: {},
    settings: {} as Session['settings'],
    participants,
  } as unknown as Session;
}

function makeApp(opts: {
  session?: Session | null;
  participants?: SessionParticipant[];
  userId?: string;
  elevated?: boolean;
}) {
  const app = new Hono();
  const session = opts.session === undefined ? makeSession() : opts.session;
  const guard = createSessionModeGuard({
    param: 'id',
    resolveSession: async () => session,
    resolveUserId: async () => opts.userId ?? 'editor-1',
    resolveParticipants: async () => opts.participants ?? PARTICIPANTS,
    resolveElevated: async () => opts.elevated ?? false,
    messages: {
      sessionNotFound: () => 'Сессия не найдена',
      forbidden: () => 'Доступ к сессии запрещён',
    },
  });
  app.patch('/:id', guard, async (c) => {
    // Обработчик читает тело — guard его не съел.
    const body = (await c.req.json().catch(() => ({}))) as { mode?: string };
    const decision = getSessionModeDecision(c);
    return c.json({ mode: body.mode ?? null, scope: decision?.scope ?? null });
  });
  return app;
}

async function patch(
  app: Hono,
  body: Record<string, unknown>,
  path = '/s1',
): Promise<{ status: number; body: { error?: { code?: string }; scope?: unknown; mode?: unknown } }> {
  const res = await app.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as never };
}

describe('ADR-106 Ф4 (шаг C) — guard смены режима сессии', () => {
  it('режим участника — область «principal» (только его ходы)', async () => {
    const app = makeApp({ userId: 'editor-1' });

    const res = await patch(app, { mode: 'yolo' });

    expect(res.status).toBe(200);
    expect(res.body.scope).toEqual({ kind: 'principal', userId: 'editor-1' });
    // Тело дошло до обработчика (guard не съел его).
    expect(res.body.mode).toBe('yolo');
  });

  it('viewer не меняет режим — 403 FORBIDDEN', async () => {
    const app = makeApp({ userId: 'viewer-1' });

    const res = await patch(app, { mode: 'yolo' });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('неучастник не меняет режим — 403 FORBIDDEN (fail-closed)', async () => {
    const app = makeApp({ userId: 'stranger' });

    const res = await patch(app, { mode: 'yolo' });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('одиночная сессия (участников нет) — прежнее поведение: режим сессии', async () => {
    const app = makeApp({ userId: 'local', participants: [] });

    const res = await patch(app, { mode: 'yolo' });

    expect(res.status).toBe(200);
    expect(res.body.scope).toEqual({ kind: 'session' });
  });

  it('одиночная сессия (участник один) — режим сессии', async () => {
    const app = makeApp({
      userId: 'local',
      participants: [{ userId: 'local', role: 'owner' }],
    });

    const res = await patch(app, { mode: 'yolo' });

    expect(res.status).toBe(200);
    expect(res.body.scope).toEqual({ kind: 'session' });
  });

  it('сквозной доступ (ADMIN/LEAD) — режим сессии', async () => {
    const app = makeApp({ userId: 'admin', elevated: true });

    const res = await patch(app, { mode: 'act' });

    expect(res.status).toBe(200);
    expect(res.body.scope).toEqual({ kind: 'session' });
  });

  it('запрос без mode — правило смены режима не применяется', async () => {
    const app = makeApp({ userId: 'viewer-1' });

    const res = await patch(app, { name: 'переименование' });

    // `viewer` не меняет режим, но переименование — не режим: guard молчит.
    expect(res.status).toBe(200);
    expect(res.body.scope).toBeNull();
  });

  it('нет сессии — 404 NOT_FOUND', async () => {
    const app = makeApp({ session: null });

    const res = await patch(app, { mode: 'yolo' });

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });
});
