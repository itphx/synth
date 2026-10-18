/**
 * ADR-094: `GET /metrics` — выключенность (404), открытый режим, bearer-токен
 * из env и файла, служебные метрики скрейпа.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetricsRegistry } from '../../metrics/registry.js';
import { metricsTokenPath, resolveMetricsToken } from '../../metrics/token.js';
import { createMetricsRoutes } from './metrics.js';

async function makeDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'synth-metrics-'));
}

afterEach(() => {
  delete process.env.SYNTH_METRICS_TOKEN;
});

describe('resolveMetricsToken', () => {
  it('env приоритетнее файла, значения trim; файл не создаётся', async () => {
    const dataDir = await makeDataDir();
    try {
      expect(resolveMetricsToken(dataDir)).toBeUndefined();

      await mkdir(join(dataDir, 'secrets'), { recursive: true });
      await writeFile(metricsTokenPath(dataDir), '  file-token\n', 'utf-8');
      expect(resolveMetricsToken(dataDir)).toBe('file-token');

      process.env.SYNTH_METRICS_TOKEN = '  env-token  ';
      expect(resolveMetricsToken(dataDir)).toBe('env-token');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('createMetricsRoutes', () => {
  it('enabled=false → 404 (не 401)', async () => {
    const registry = new MetricsRegistry();
    const app = createMetricsRoutes({
      registry,
      enabled: false,
      token: 'secret',
    });
    const res = await app.request('/metrics');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('enabled=true без токена → 200, Content-Type exposition 0.0.4, no-store', async () => {
    const registry = new MetricsRegistry();
    const app = createMetricsRoutes({ registry, enabled: true });
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = await res.text();
    expect(body).toContain('# HELP synth_metrics_series');
    expect(body).toContain('# TYPE synth_metrics_series gauge');
    expect(body).toContain('# HELP synth_metrics_scrape_duration_seconds');
    expect(body).toContain('synth_metrics_series 2');
  });

  it('токен из env: без заголовка/с неверным → 401, с верным → 200', async () => {
    process.env.SYNTH_METRICS_TOKEN = 'env-secret';
    const dataDir = await makeDataDir();
    try {
      const token = resolveMetricsToken(dataDir);
      expect(token).toBe('env-secret');
      const app = createMetricsRoutes({ registry: new MetricsRegistry(), enabled: true, token });

      const missing = await app.request('/metrics');
      expect(missing.status).toBe(401);
      expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');

      const wrong = await app.request('/metrics', { headers: { Authorization: 'Bearer nope' } });
      expect(wrong.status).toBe(401);

      const ok = await app.request('/metrics', { headers: { Authorization: 'Bearer env-secret' } });
      expect(ok.status).toBe(200);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('токен из файла {dataDir}/secrets/metrics-token (trim) — 200/401', async () => {
    const dataDir = await makeDataDir();
    try {
      await mkdir(join(dataDir, 'secrets'), { recursive: true });
      await writeFile(metricsTokenPath(dataDir), '  file-secret\n', 'utf-8');
      const token = resolveMetricsToken(dataDir);
      expect(token).toBe('file-secret');

      const app = createMetricsRoutes({ registry: new MetricsRegistry(), enabled: true, token });
      expect((await app.request('/metrics')).status).toBe(401);
      expect(
        (await app.request('/metrics', { headers: { Authorization: 'Bearer file-secret' } })).status,
      ).toBe(200);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('enabled=true и токен не задан → 200 (открытый скрейп)', async () => {
    const app = createMetricsRoutes({ registry: new MetricsRegistry(), enabled: true, token: undefined });
    expect((await app.request('/metrics')).status).toBe(200);
  });
});
