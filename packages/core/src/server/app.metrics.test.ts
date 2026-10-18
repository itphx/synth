/**
 * ADR-094 (проводка standalone-core): `/ready` публичный, `/metrics` при
 * `metrics.enabled=false` → 404 и серии не создаются; при `enabled=true`
 * скрейп отдаёт HTTP/процессные и доменные метрики (ready/storage/sessions/
 * decision), а маршрут сессии — шаблоном `/api/v2/sessions/:id` (не сырым id).
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneApp } from './app.js';

const API_KEY = 'test-key-123';

async function withApp<T>(
  opts: { metricsEnabled?: boolean },
  fn: (app: Awaited<ReturnType<typeof createStandaloneApp>>) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'synth-core-metrics-'));
  const app = await createStandaloneApp({
    port: 0,
    dataDir,
    apiKey: API_KEY,
    storageBackend: 'memory',
    metricsConfig: { enabled: opts.metricsEnabled ?? false },
  });
  try {
    return await fn(app);
  } finally {
    app.stopMetrics?.();
    await app.closeStorage?.().catch(() => {});
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

describe('createStandaloneApp: ADR-094 (metrics/ready)', () => {
  it('metrics.enabled=false → /metrics 404, /ready 200, серии не создаются', async () => {
    await withApp({}, async (app) => {
      expect((await app.app.request('/ready')).status).toBe(200);
      expect((await app.app.request('/api/v2/sessions/whatever', {
        headers: { Authorization: `Bearer ${API_KEY}` },
      })).status).toBe(404);

      const res = await app.app.request('/metrics');
      expect(res.status).toBe(404);
      expect(app.metrics.render().series).toBe(0);
      // Доменные коллекторы не подключены — `synth_ready` не регистрируется.
      expect(app.metrics.render().text).not.toContain('synth_ready');
    });
  });

  it('metrics.enabled=true → /metrics 200, HTTP route-шаблон и служебные метрики', async () => {
    await withApp({ metricsEnabled: true }, async (app) => {
      expect((await app.app.request('/api/v2/sessions/whatever', {
        headers: { Authorization: `Bearer ${API_KEY}` },
      })).status).toBe(404);

      const res = await app.app.request('/metrics');
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('# TYPE synth_http_requests_total counter');
      // Шаблон маршрута, а не сырой id (`/api/v2/sessions/whatever`).
      expect(body).toContain('route="/api/v2/sessions/:id"');
      expect(body).not.toContain('route="/api/v2/sessions/whatever"');
      expect(body).toContain('# TYPE synth_metrics_series gauge');
      expect(body).toContain('# TYPE synth_metrics_scrape_duration_seconds gauge');
      expect(body).toContain('# TYPE synth_process_uptime_seconds gauge');
      // ADR-094: доменные коллекторы подключены (ready/storage/sessions/decision).
      expect(body).toContain('synth_ready 1');
      expect(body).toContain('synth_storage_backend_info{backend="memory"} 1');
      expect(body).toContain('synth_storage_degraded 0');
      expect(body).toContain('# TYPE synth_sessions_active gauge');
      expect(body).toContain('# TYPE synth_decision_calls_total counter');
      expect(body).toContain('# TYPE synth_hybrid_connected gauge');
    });
  });
});
