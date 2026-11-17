/**
 * PROP-141 (этап 5, B-2): HTTP-контур таймеров и будильников.
 *
 * Проверяем:
 * 1. Список — страницы-сводки (ADR-118 §4) + фильтры (`sessionId`/`projectId`/
 *    `status`/`kind`); невалидный фильтр/пагинация → 400 `VALIDATION_ERROR`.
 * 2. Создание — проект выводится из сессии; переданный несовпадающий `projectId`
 *    → 400; лимит активных таймеров сессии (50) → 409 `TIMER_LIMIT_EXCEEDED`;
 *    комментарий 501 символ → 400; `everySec < 10` → 400.
 * 3. Мутации — pause/resume/delete; правка `repeat` пересчитывает `firesAt`
 *    (движок).
 * 4. История срабатываний — `GET /:id/firings` (страницы-сводки).
 * 5. Доступ — граничная проверка прав на проект таймера: чужой проект → 403,
 *    несуществующий таймер → 404.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import { TIMER_MAX_ACTIVE_PER_SESSION } from '@itphx/synth-shared';
import type { Timer } from '@itphx/synth-shared';
import { createTimerRoutes } from './timers.js';
import type { TimerRoutesAuth, TimerRoutesOptions } from './timers.js';
import { FileTimerStore } from '../../storage/file-timer-store.js';
import { FileTimerFiringStore } from '../../storage/file-timer-firing-store.js';
import { TimerService } from '../../engine/timers/service.js';

const auth = {
  requireAuth: async (_c: Context, next: Next) => {
    await next();
  },
} as unknown as TimerRoutesAuth;

/** Резолвер «сессия → проект»: `s1` — проект `proj_1`, `s2` — `proj_2`. */
const resolveSessionProject = async (sessionId: string): Promise<string | undefined> => {
  if (sessionId === 's1') return 'proj_1';
  if (sessionId === 's2') return 'proj_2';
  return undefined;
};

describe('Timers API Routes (PROP-141, этап 5 B-2)', () => {
  let tmpDir: string;
  let timers: FileTimerStore;
  let firings: FileTimerFiringStore;
  let service: TimerService;

  const makeApp = (opts: Partial<TimerRoutesOptions> = {}) => {
    const app = new Hono();
    app.route(
      '/api/v2/timers',
      createTimerRoutes(
        auth,
        { timerService: service, timers, firings },
        { resolveSessionProject, ...opts },
      ),
    );
    return app;
  };

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  /** Тело запроса создания одноразового таймера. */
  const timerBody = (overrides: Record<string, unknown> = {}) => ({
    kind: 'timer',
    comment: 'напомнить про отчёт',
    sessionId: 's1',
    repeat: { mode: 'once' },
    delaySec: 600,
    ...overrides,
  });

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-timer-routes-'));
    timers = new FileTimerStore({ dataDir: tmpDir });
    firings = new FileTimerFiringStore({ dataDir: tmpDir });
    service = new TimerService({
      timers,
      firings,
      deliver: async () => {},
    });
  });

  afterEach(async () => {
    await service.stop();
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Создать таймер напрямую портом (фикстуры фильтров/скоупа). */
  const seed = async (
    overrides: Partial<{
      kind: 'timer' | 'alarm';
      name: string;
      comment: string;
      projectId: string;
      sessionId: string;
      ownerId: string;
      status: Timer['status'];
      repeat: Timer['repeat'];
      firesAt: string;
    }> = {},
  ): Promise<Timer> =>
    timers.create({
      kind: 'timer',
      comment: 'c',
      projectId: 'proj_1',
      sessionId: 's1',
      ownerId: 'user_1',
      repeat: { mode: 'once' },
      status: 'active',
      firesAt: '2030-01-01T00:00:00.000Z',
      ...overrides,
    });

  // ── Список ──────────────────────────────────────────────────────────────

  it('GET / — страницы-сводки: timers/total/offset/limit/next_offset', async () => {
    const app = makeApp();
    await seed({ comment: 'a' });
    await seed({ comment: 'b' });

    const res = await app.request('/api/v2/timers');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      timers: Timer[];
      total: number;
      offset: number;
      limit: number;
      next_offset: number | null;
    };
    expect(body.total).toBe(2);
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(50);
    expect(body.next_offset).toBeNull();
    expect(body.timers).toHaveLength(2);
  });

  it('GET / — пагинация: limit/offset режут страницу, next_offset ведёт дальше', async () => {
    const app = makeApp();
    await seed({ comment: 'a', firesAt: '2030-01-01T00:00:00.000Z' });
    await seed({ comment: 'b', firesAt: '2030-01-02T00:00:00.000Z' });
    await seed({ comment: 'c', firesAt: '2030-01-03T00:00:00.000Z' });

    const first = await app.request('/api/v2/timers?limit=2');
    const firstBody = (await first.json()) as {
      timers: Timer[];
      total: number;
      next_offset: number | null;
    };
    expect(firstBody.total).toBe(3);
    expect(firstBody.timers).toHaveLength(2);
    expect(firstBody.next_offset).toBe(2);

    const second = await app.request('/api/v2/timers?limit=2&offset=2');
    const secondBody = (await second.json()) as { timers: Timer[]; next_offset: number | null };
    expect(secondBody.timers).toHaveLength(1);
    expect(secondBody.next_offset).toBeNull();
  });

  it('GET / — фильтры sessionId/projectId/status/kind', async () => {
    const app = makeApp();
    await seed({ sessionId: 's1', projectId: 'proj_1' });
    await seed({ sessionId: 's2', projectId: 'proj_2', kind: 'alarm', status: 'paused' });

    const bySession = await app.request('/api/v2/timers?sessionId=s2');
    expect(((await bySession.json()) as { timers: Timer[] }).timers).toHaveLength(1);

    const byProject = await app.request('/api/v2/timers?projectId=proj_2');
    expect(((await byProject.json()) as { timers: Timer[] }).timers).toHaveLength(1);

    const byStatus = await app.request('/api/v2/timers?status=paused');
    expect(((await byStatus.json()) as { timers: Timer[] }).timers).toHaveLength(1);

    const byKind = await app.request('/api/v2/timers?kind=alarm');
    expect(((await byKind.json()) as { timers: Timer[] }).timers).toHaveLength(1);
  });

  it('GET / — невалидный фильтр или пагинация → 400 VALIDATION_ERROR', async () => {
    const app = makeApp();
    for (const query of ['sessionId=', 'projectId=', 'status=unknown', 'kind=other', 'limit=abc', 'offset=-1']) {
      const res = await app.request(`/api/v2/timers?${query}`);
      expect(res.status, query).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('GET / — listVisibleProjectIds: чужие таймеры не раскрываются, свои — видны', async () => {
    await seed({ comment: 'visible', projectId: 'proj_1' });
    await seed({ comment: 'foreign', projectId: 'proj_2' });
    await seed({ comment: 'own', projectId: 'proj_2', ownerId: 'u-1' });

    const scoped = new Hono();
    scoped.use('*', async (c, next) => {
      c.set('user' as never, { id: 'u-1' } as never);
      await next();
    });
    scoped.route(
      '/api/v2/timers',
      createTimerRoutes(
        auth,
        { timerService: service, timers, firings },
        { resolveSessionProject, listVisibleProjectIds: async () => ['proj_1'] },
      ),
    );

    const res = await scoped.request('/api/v2/timers');
    const comments = ((await res.json()) as { timers: Timer[] }).timers.map((t) => t.comment);
    expect(comments.sort()).toEqual(['own', 'visible']);
  });

  // ── Создание ────────────────────────────────────────────────────────────

  it('POST / — 201: проект выводится из сессии, владелец — текущий пользователь', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('user' as never, { id: 'u-1' } as never);
      await next();
    });
    app.route(
      '/api/v2/timers',
      createTimerRoutes(
        auth,
        { timerService: service, timers, firings },
        { resolveSessionProject },
      ),
    );

    const res = await app.request('/api/v2/timers', json('POST', timerBody()));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { timer: Timer };
    expect(body.timer.id.startsWith('tmr_')).toBe(true);
    expect(body.timer.projectId).toBe('proj_1');
    expect(body.timer.ownerId).toBe('u-1');
    expect(body.timer.status).toBe('active');
    expect(body.timer.comment).toBe('напомнить про отчёт');
    expect(body.timer.firesAt).toBeTruthy();
  });

  it('POST / — projectId не совпадает с проектом сессии → 400', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/v2/timers',
      json('POST', timerBody({ projectId: 'proj_2' })),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('POST / — сессия вне проекта → 400 (инстансных автоматизаций нет)', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/v2/timers',
      json('POST', timerBody({ sessionId: 's_unknown' })),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('POST / — комментарий 501 символ → 400', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/v2/timers',
      json('POST', timerBody({ comment: 'я'.repeat(501) })),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('POST / — everySec < 10 → 400', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/v2/timers',
      json('POST', timerBody({ repeat: { mode: 'every', everySec: 5 } })),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('POST / — превышен лимит активных таймеров сессии → 409 TIMER_LIMIT_EXCEEDED', async () => {
    const app = makeApp();
    for (let i = 0; i < TIMER_MAX_ACTIVE_PER_SESSION; i += 1) {
      await seed({ sessionId: 's1', projectId: 'proj_1' });
    }
    const res = await app.request('/api/v2/timers', json('POST', timerBody()));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('TIMER_LIMIT_EXCEEDED');
  });

  it('POST / — не-JSON тело → 400', async () => {
    const app = makeApp();
    const res = await app.request('/api/v2/timers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  // ── Правка, пауза, возобновление, удаление ──────────────────────────────

  it('PATCH /:id — правка имени/комментария и смены repeat (firesAt пересчитывает движок)', async () => {
    const app = makeApp();
    const created = await seed({ comment: 'старое', firesAt: '2030-01-01T00:00:00.000Z' });

    const res = await app.request(
      `/api/v2/timers/${created.id}`,
      json('PATCH', { name: 'отчёт', comment: 'новое' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { timer: Timer };
    expect(body.timer.name).toBe('отчёт');
    expect(body.timer.comment).toBe('новое');

    const repeatRes = await app.request(
      `/api/v2/timers/${created.id}`,
      json('PATCH', { repeat: { mode: 'every', everySec: 600 } }),
    );
    expect(repeatRes.status).toBe(200);
    const repeatBody = (await repeatRes.json()) as { timer: Timer };
    expect(repeatBody.timer.repeat).toEqual({ mode: 'every', everySec: 600 });
    // Метка пересчитана движком (движок берёт своё текущее время).
    expect(Date.parse(repeatBody.timer.firesAt)).toBeGreaterThan(Date.now());
  });

  it('PATCH /:id — пустой патч → 400; неизвестный таймер → 404', async () => {
    const app = makeApp();
    const created = await seed();
    expect((await app.request(`/api/v2/timers/${created.id}`, json('PATCH', {}))).status).toBe(400);
    expect((await app.request('/api/v2/timers/tmr_missing', json('PATCH', { comment: 'x' }))).status).toBe(404);
  });

  it('POST /:id/pause и /resume — статус меняется', async () => {
    const app = makeApp();
    const created = await seed();

    const paused = await app.request(`/api/v2/timers/${created.id}/pause`, { method: 'POST' });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { timer: Timer }).timer.status).toBe('paused');

    const resumed = await app.request(`/api/v2/timers/${created.id}/resume`, { method: 'POST' });
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { timer: Timer }).timer.status).toBe('active');
  });

  it('POST /:id/stop — статус cancelled, запись остаётся; повтор идемпотентен', async () => {
    const app = makeApp();
    const created = await seed();

    const stopped = await app.request(`/api/v2/timers/${created.id}/stop`, { method: 'POST' });
    expect(stopped.status).toBe(200);
    expect(((await stopped.json()) as { timer: Timer }).timer.status).toBe('cancelled');
    expect(await timers.get(created.id)).not.toBeNull();

    const repeated = await app.request(`/api/v2/timers/${created.id}/stop`, { method: 'POST' });
    expect(repeated.status).toBe(200);
  });

  it('POST /:id/stop — отработавший таймер идемпотентен (200, статус не меняется)', async () => {
    const app = makeApp();
    const created = await seed({ status: 'fired' });
    const res = await app.request(`/api/v2/timers/${created.id}/stop`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { timer: Timer }).timer.status).toBe('fired');
  });

  it('POST / — семантический дубликат → 409 TIMER_DUPLICATE; allow_duplicate разрешает', async () => {
    const app = makeApp();
    const body = timerBody({ comment: 'дубликат' });
    expect((await app.request('/api/v2/timers', json('POST', body))).status).toBe(201);

    const duplicate = await app.request('/api/v2/timers', json('POST', body));
    expect(duplicate.status).toBe(409);
    const duplicateBody = (await duplicate.json()) as {
      error: { code: string; details?: { existingId?: string } };
    };
    expect(duplicateBody.error.code).toBe('TIMER_DUPLICATE');
    expect(duplicateBody.error.details?.existingId).toBeTruthy();

    const allowed = await app.request(
      '/api/v2/timers',
      json('POST', { ...body, allow_duplicate: true }),
    );
    expect(allowed.status).toBe(201);
  });

  it('POST / — at в прошлом → 400', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/v2/timers',
      json('POST', {
        kind: 'alarm',
        comment: 'прошлое',
        sessionId: 's1',
        repeat: { mode: 'once' },
        at: new Date(Date.now() - 3_600_000).toISOString(),
      }),
    );
    expect(res.status).toBe(400);
  });


  it('PATCH /:id — остановленный таймер → 409, запись не меняется', async () => {
    const app = makeApp();
    const created = await seed({ status: 'cancelled' });
    const res = await app.request(
      `/api/v2/timers/${created.id}`,
      json('PATCH', { comment: 'нельзя' }),
    );
    expect(res.status).toBe(409);
    expect((await timers.get(created.id))?.comment).not.toBe('нельзя');
  });

  it('POST /:id/pause — таймер в терминальном статусе → 409', async () => {
    const app = makeApp();
    const created = await seed({ status: 'fired' });
    const res = await app.request(`/api/v2/timers/${created.id}/pause`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('DELETE /:id — 204, затем 404', async () => {
    const app = makeApp();
    const created = await seed();
    expect((await app.request(`/api/v2/timers/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/api/v2/timers/${created.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  // ── История срабатываний ────────────────────────────────────────────────

  it('GET /:id/firings — страницы-сводки истории', async () => {
    const app = makeApp();
    const created = await seed();
    await firings.append({
      id: 'tmf_1',
      timerId: created.id,
      firedAt: '2026-01-01T00:00:00.000Z',
      scheduledFor: '2026-01-01T00:00:00.000Z',
      lagMs: 12,
      outcome: 'ok',
      sessionId: 's1',
    });

    const res = await app.request(`/api/v2/timers/${created.id}/firings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      firings: { id: string }[];
      total: number;
      next_offset: number | null;
    };
    expect(body.total).toBe(1);
    expect(body.next_offset).toBeNull();
    expect(body.firings[0]?.id).toBe('tmf_1');
  });

  it('GET /:id/firings — неизвестный таймер → 404', async () => {
    const app = makeApp();
    expect((await app.request('/api/v2/timers/tmr_missing/firings')).status).toBe(404);
  });

  // ── Доступ (граница) ────────────────────────────────────────────────────

  it('чужой проект → 403 на мутации и чтении; сбой проверки — fail-closed', async () => {
    const app = makeApp({
      authorizeProject: async (c, projectId) =>
        projectId === 'proj_1'
          ? null
          : c.json({ error: { code: 'FORBIDDEN', message: 'forbidden' } }, 403),
    });
    const created = await seed({ projectId: 'proj_2' });

    expect((await app.request(`/api/v2/timers/${created.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await app.request(`/api/v2/timers/${created.id}/firings`)).status).toBe(403);
    expect(
      (await app.request('/api/v2/timers', json('POST', timerBody({ sessionId: 's2' })))).status,
    ).toBe(403);
  });

  it('сбой граничной проверки → 403 (fail-closed)', async () => {
    const app = makeApp({
      authorizeProject: async () => {
        throw new Error('boom');
      },
    });
    const created = await seed();
    expect((await app.request(`/api/v2/timers/${created.id}`, { method: 'DELETE' })).status).toBe(403);
  });

  it('несуществующий таймер → 404 (ресурса нет)', async () => {
    const app = makeApp();
    expect((await app.request('/api/v2/timers/tmr_missing/firings')).status).toBe(404);
    expect((await app.request('/api/v2/timers/tmr_missing', { method: 'DELETE' })).status).toBe(404);
  });

  // ── Scope service-key (ADR-052) ─────────────────────────────────────────

  it('service-key без scope timers:read → 403 SCOPE_REQUIRED', async () => {
    const app = new Hono();
    app.use(
      '*',
      createMiddleware(async (c, next) => {
        c.set('serviceKey' as never, {
          keyId: 'svk_1',
          label: 'no-scope',
          roles: [],
          scopes: [],
        } as never);
        await next();
      }),
    );
    app.route(
      '/api/v2/timers',
      createTimerRoutes(
        auth,
        { timerService: service, timers, firings },
        { resolveSessionProject },
      ),
    );

    const res = await app.request('/api/v2/timers');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SCOPE_REQUIRED');
  });

  it('service-key со scope timers:read — список доступен', async () => {
    const app = new Hono();
    app.use(
      '*',
      createMiddleware(async (c, next) => {
        c.set('serviceKey' as never, {
          keyId: 'svk_1',
          label: 'reader',
          roles: [],
          scopes: ['timers:read'],
        } as never);
        await next();
      }),
    );
    app.route(
      '/api/v2/timers',
      createTimerRoutes(
        auth,
        { timerService: service, timers, firings },
        { resolveSessionProject },
      ),
    );

    const res = await app.request('/api/v2/timers');
    expect(res.status).toBe(200);
  });
});
