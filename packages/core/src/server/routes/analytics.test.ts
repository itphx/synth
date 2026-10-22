import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { AnalyticsService } from '../../analytics/service.js';
import { MemoryAnalyticsRollupRepository } from '../../storage/memory/analytics-rollup.js';
import { createAnalyticsRoutes } from './analytics.js';
import type { AnalyticsRoutesAuth, AnalyticsRoutesOptions } from './analytics.js';

const auth = {
  requireAuth: async (_c: Context, next: Next) => {
    await next();
  },
} as unknown as AnalyticsRoutesAuth;

/** Тестовый скоуп: роль и id пользователя приходят заголовками. */
const opts: AnalyticsRoutesOptions = {
  resolveElevated: (c) => ['admin', 'lead'].includes(c.req.header('x-role') ?? 'user'),
  resolveAuditor: (c) => c.req.header('x-role') === 'auditor',
  resolveUserId: (c) => c.req.header('x-user') ?? 'u1',
  messages: {
    invalidPeriod: () => 'period!',
    invalidRange: () => 'range!',
    invalidGroupBy: () => 'groupBy!',
    invalidOption: () => 'option!',
    forbidden: () => 'forbidden!',
  },
};

describe('Analytics API Routes (ADR-102 §4/§7)', () => {
  let repo: MemoryAnalyticsRollupRepository;
  let app: Hono;

  const request = (path: string, role = 'admin', user?: string) => {
    const headers: Record<string, string> = { 'x-role': role };
    if (user) headers['x-user'] = user;
    return app.request(path, { headers });
  };

  beforeEach(async () => {
    repo = new MemoryAnalyticsRollupRepository();
    app = new Hono();
    app.route('/api/v2/analytics', createAnalyticsRoutes(auth, { service: new AnalyticsService({ repo }) }, opts));

    await repo.increment({
      family: 'usage',
      day: '2026-03-01',
      dimensions: { user: 'u1', model: 'm1' },
      measures: { input_tokens: 100, output_tokens: 40, duration_ms: 2000 },
      costByCurrency: { USD: 0.5 },
    });
    await repo.increment({
      family: 'usage',
      day: '2026-03-01',
      dimensions: { user: 'u2', model: 'm2' },
      measures: { input_tokens: 10, output_tokens: 5, duration_ms: 1000 },
      costByCurrency: { USD: 0.1 },
    });
    await repo.increment({ family: 'activity', day: '2026-03-01', dimensions: {}, measures: { tool_calls: 3 } });
    await repo.increment({ family: 'decision', day: '2026-03-01', dimensions: {}, measures: { calls: 2 } });
  });

  it('GET /usage — 200 с отчётом и дериватами', async () => {
    const res = await request('/api/v2/analytics/usage?from=2026-03-01&to=2026-03-01&groupBy=day');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: string;
      groupBy: string[];
      rows: { dimensions: Record<string, string>; measures: Record<string, number> }[];
    };
    expect(body.report).toBe('usage');
    expect(body.groupBy).toEqual(['day']);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.measures).toMatchObject({ input_tokens: 110, output_tokens: 45, total_tokens: 155 });
  });

  it('GET /activity и /decision — сырые меры', async () => {
    const activity = await request('/api/v2/analytics/activity?from=2026-03-01&to=2026-03-01');
    expect(activity.status).toBe(200);
    expect(((await activity.json()) as { rows: { measures: unknown }[] }).rows[0]!.measures).toEqual({ tool_calls: 3 });

    const decision = await request('/api/v2/analytics/decision?from=2026-03-01&to=2026-03-01');
    expect(decision.status).toBe(200);
    expect(((await decision.json()) as { rows: { measures: unknown }[] }).rows[0]!.measures).toEqual({ calls: 2 });
  });

  it('GET /prompt — производное usage с группировкой по умолчанию', async () => {
    const res = await request('/api/v2/analytics/prompt?from=2026-03-01&to=2026-03-01&groupBy=model');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: string; groupBy: string[]; rows: unknown[] };
    expect(body.report).toBe('prompt');
    expect(body.groupBy).toEqual(['model']);
    expect(body.rows).toHaveLength(2);
  });

  it('GET /summary — 200 для elevated, агрегаты по семействам', async () => {
    const res = await request('/api/v2/analytics/summary?from=2026-03-01&to=2026-03-01', 'lead');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usage: Record<string, number>; activity: Record<string, number>; decision: Record<string, number>; costByCurrency: Record<string, number> };
    expect(body.usage.total_tokens).toBe(155);
    expect(body.activity).toEqual({ tool_calls: 3 });
    expect(body.decision).toEqual({ calls: 2 });
    expect(body.costByCurrency).toEqual({ USD: 0.6 });
  });

  it('некорректный период → 400 VALIDATION_ERROR', async () => {
    const res = await request('/api/v2/analytics/usage?from=01-01-2026');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'period!' } });
  });

  it('from > to → 400 VALIDATION_ERROR (range)', async () => {
    const res = await request('/api/v2/analytics/usage?from=2026-03-05&to=2026-03-01');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('range!');
  });

  it('неизвестная ось groupBy → 400 VALIDATION_ERROR (groupBy)', async () => {
    const res = await request('/api/v2/analytics/usage?groupBy=model,bogus');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('groupBy!');
  });

  describe('скоуп (ADR-102 §7)', () => {
    it('обычный пользователь: принудительный фильтр оси user по себе', async () => {
      const own = await request('/api/v2/analytics/usage?from=2026-03-01&to=2026-03-01&groupBy=user', 'user', 'u1');
      expect(own.status).toBe(200);
      const body = (await own.json()) as { rows: { dimensions: Record<string, string>; measures: Record<string, number> }[] };
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0]!.dimensions).toEqual({ user: 'u1' });
      expect(body.rows[0]!.measures.input_tokens).toBe(100);
    });

    it('обычный пользователь: чужой userId в query игнорируется', async () => {
      const res = await request('/api/v2/analytics/usage?from=2026-03-01&to=2026-03-01&groupBy=user&userId=u2', 'user', 'u1');
      const body = (await res.json()) as { rows: { dimensions: Record<string, string> }[] };
      expect(body.rows[0]!.dimensions).toEqual({ user: 'u1' });
    });

    it('обычный пользователь: decision и summary → 403 FORBIDDEN', async () => {
      const decision = await request('/api/v2/analytics/decision', 'user', 'u1');
      expect(decision.status).toBe(403);
      expect(((await decision.json()) as { error: { message: string } }).error.message).toBe('forbidden!');

      const summary = await request('/api/v2/analytics/summary', 'user', 'u1');
      expect(summary.status).toBe(403);
    });

    it('AUDITOR: decision и summary доступны', async () => {
      expect((await request('/api/v2/analytics/decision', 'auditor')).status).toBe(200);
      expect((await request('/api/v2/analytics/summary', 'auditor')).status).toBe(200);
    });

    it('ADMIN/LEAD: сквозной обзор без фильтра по себе', async () => {
      const res = await request('/api/v2/analytics/usage?from=2026-03-01&to=2026-03-01&groupBy=user', 'admin');
      const body = (await res.json()) as { rows: unknown[] };
      expect(body.rows).toHaveLength(2);
    });
  });

  describe('GET /export (ADR-102 §6)', () => {
    it('CSV — BOM, Content-Disposition, строки и TOTAL', async () => {
      const res = await request('/api/v2/analytics/export?report=usage&format=csv&from=2026-03-01&to=2026-03-01&groupBy=day');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(res.headers.get('content-disposition')).toBe(
        'attachment; filename="analytics-usage-2026-03-01_2026-03-01.csv"',
      );
      const buffer = await res.arrayBuffer();
      // `Response.text()` снимает BOM, поэтому проверяем байты ответа, затем декодируем.
      const bytes = new Uint8Array(buffer);
      expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
      const csv = new TextDecoder('utf-8').decode(buffer);
      expect(csv).toContain('TOTAL');
    });

    it('JSON — приложение/json и Content-Disposition', async () => {
      const res = await request('/api/v2/analytics/export?report=activity&format=json');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(res.headers.get('content-disposition')).toContain('attachment; filename="analytics-activity-');
      const body = (await res.json()) as { report: string };
      expect(body.report).toBe('activity');
    });

    it('некорректный report/format → 400 VALIDATION_ERROR (option)', async () => {
      const badReport = await request('/api/v2/analytics/export?report=bogus&format=csv');
      expect(badReport.status).toBe(400);
      expect(((await badReport.json()) as { error: { message: string } }).error.message).toBe('option!');

      const badFormat = await request('/api/v2/analytics/export?report=usage&format=xlsx');
      expect(badFormat.status).toBe(400);
    });

    it('обычный пользователь: экспорт decision → 403', async () => {
      const res = await request('/api/v2/analytics/export?report=decision&format=json', 'user', 'u1');
      expect(res.status).toBe(403);
    });
  });
});
