/**
 * ADR-094: админ-раздел «Наблюдаемость» — `/api/v2/settings/metrics*`.
 *
 * Проверяем контракт: приоритет источников (env > runtime > config > default),
 * `restartRequired`, PUT/DELETE, валидацию, live-статус (exposition), токен
 * (write-only, 409 при env, 400 на короткий) и применение токена без рестарта.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MetricsRegistry } from '../../metrics/registry.js';
import { MetricsRegistry as Registry } from '../../metrics/registry.js';
import { metricsTokenPath, resolveMetricsToken } from '../../metrics/token.js';
import { RuntimeSettingsStore } from '../../storage/runtime-settings.js';
import { createMetricsRoutes } from './metrics.js';
import { createMetricsSettingsRoutes, resolveMetricsEnabled } from './metrics-settings.js';

const requireAuth = async (_c: Context, next: Next) => { await next(); };
const deny = async (c: Context) => c.json({ error: { code: 'FORBIDDEN', message: 'deny' } }, 403);

interface AppOptions {
  dataDir: string;
  configEnabled?: boolean;
  runningEnabled?: boolean;
  env?: NodeJS.ProcessEnv;
  getRegistry?: () => MetricsRegistry | undefined;
  readiness?: { ready: boolean; storage: 'ok' | 'degraded' };
  writeGuard?: (c: Context, next: Next) => Promise<Response | void>;
}

function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const settingsStore = new RuntimeSettingsStore({ dataDir: options.dataDir });
  app.route('/api/v2/settings', createMetricsSettingsRoutes(
    { requireAuth },
    {
      settingsStore,
      dataDir: options.dataDir,
      configEnabled: options.configEnabled ?? false,
      runningEnabled: options.runningEnabled ?? false,
      getRegistry: options.getRegistry,
      getReadiness: () => options.readiness ?? { ready: true, storage: 'ok' },
      getStorageBackend: () => 'file',
      getUptimeSec: () => 123,
      version: '0.10.3',
      env: options.env ?? {},
    },
    options.writeGuard ? { writeGuard: options.writeGuard as never } : {},
  ));
  return app;
}

async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

async function put(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(`/api/v2/settings${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const TOKEN = 'test-metrics-token-0123456789';

describe('resolveMetricsEnabled (приоритет источников)', () => {
  it('env > runtime > config > default', () => {
    expect(resolveMetricsEnabled({ configEnabled: false, env: {} })).toEqual({ enabled: false, source: 'default' });
    expect(resolveMetricsEnabled({ configEnabled: true, env: {} })).toEqual({ enabled: true, source: 'config' });
    expect(resolveMetricsEnabled({ configEnabled: false, runtimeEnabled: true, env: {} }))
      .toEqual({ enabled: true, source: 'runtime' });
    expect(resolveMetricsEnabled({ configEnabled: true, runtimeEnabled: false, env: {} }))
      .toEqual({ enabled: false, source: 'runtime' });
    expect(resolveMetricsEnabled({ configEnabled: true, runtimeEnabled: false, env: { SYNTH_METRICS_ENABLED: 'true' } }))
      .toEqual({ enabled: true, source: 'env' });
    expect(resolveMetricsEnabled({ configEnabled: true, env: { SYNTH_METRICS_ENABLED: 'false' } }))
      .toEqual({ enabled: false, source: 'env' });
    // Нераспознанное/пустое значение env — «не задано».
    expect(resolveMetricsEnabled({ configEnabled: true, env: { SYNTH_METRICS_ENABLED: 'maybe' } }))
      .toEqual({ enabled: true, source: 'config' });
    expect(resolveMetricsEnabled({ configEnabled: true, env: { SYNTH_METRICS_ENABLED: '' } }))
      .toEqual({ enabled: true, source: 'config' });
  });
});

describe('createMetricsSettingsRoutes', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-metrics-settings-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET: default false, без override, без токена, endpoints', async () => {
    const app = createApp({ dataDir });
    const body = await json(await app.request('/api/v2/settings/metrics'));
    expect(body).toEqual({
      metrics: { enabled: false },
      defaults: { enabled: false },
      isOverridden: false,
      source: 'default',
      running: false,
      restartRequired: false,
      token: { configured: false, source: 'none' },
      endpoints: { metrics: '/metrics', ready: '/ready' },
    });
  });

  it('GET: config как источник эффективного значения', async () => {
    const app = createApp({ dataDir, configEnabled: true, runningEnabled: true });
    const body = await json(await app.request('/api/v2/settings/metrics'));
    expect(body.metrics).toEqual({ enabled: true });
    expect(body.defaults).toEqual({ enabled: true });
    expect(body.source).toBe('config');
    expect(body.isOverridden).toBe(false);
    expect(body.restartRequired).toBe(false);
  });

  it('PUT runtime: source=runtime, restartRequired=true; DELETE сбрасывает', async () => {
    const app = createApp({ dataDir, configEnabled: false, runningEnabled: false });

    const res = await put(app, '/metrics', { metrics: { enabled: true } });
    expect(res.status).toBe(200);
    const saved = await json(res);
    expect(saved.metrics).toEqual({ enabled: true });
    expect(saved.defaults).toEqual({ enabled: false });
    expect(saved.isOverridden).toBe(true);
    expect(saved.source).toBe('runtime');
    expect(saved.running).toBe(false);
    expect(saved.restartRequired).toBe(true);

    const restored = await json(await app.request('/api/v2/settings/metrics', { method: 'DELETE' }));
    expect(restored.metrics).toEqual({ enabled: false });
    expect(restored.isOverridden).toBe(false);
    expect(restored.source).toBe('default');
    expect(restored.restartRequired).toBe(false);
  });

  it('env приоритетнее runtime (source=env), running остаётся стартовым', async () => {
    const app = createApp({ dataDir, env: { SYNTH_METRICS_ENABLED: '1' }, runningEnabled: false });
    await put(app, '/metrics', { metrics: { enabled: false } });
    const body = await json(await app.request('/api/v2/settings/metrics'));
    expect(body.metrics).toEqual({ enabled: true });
    expect(body.source).toBe('env');
    expect(body.isOverridden).toBe(true);
    expect(body.restartRequired).toBe(true);
  });

  it('PUT: валидация {metrics:{enabled:boolean}} → 400 VALIDATION_ERROR', async () => {
    const app = createApp({ dataDir });
    for (const body of [{}, { metrics: {} }, { metrics: { enabled: 'yes' } }, { metrics: true }]) {
      const res = await put(app, '/metrics', body);
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('guard: read/write разделены (writeGuard)', async () => {
    const app = createApp({ dataDir, writeGuard: deny });
    expect((await app.request('/api/v2/settings/metrics')).status).toBe(200);
    expect((await put(app, '/metrics', { metrics: { enabled: true } })).status).toBe(403);
    expect((await app.request('/api/v2/settings/metrics', { method: 'DELETE' })).status).toBe(403);
  });

  it('status: live-снимок (series/bytes/droppedSeries/readiness/storage/version/uptime)', async () => {
    const registry = new Registry({ maxSeriesPerMetric: 1 });
    registry.counter('synth_test_total', 'test', ['kind']);
    registry.counter('synth_test_total', 'test', ['kind']).inc({ kind: 'a' });
    registry.counter('synth_test_total', 'test', ['kind']).inc({ kind: 'b' }); // серия отброшена
    const app = createApp({
      dataDir,
      getRegistry: () => registry,
      readiness: { ready: true, storage: 'degraded' },
    });

    const res = await app.request('/api/v2/settings/metrics/status');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.enabled).toBe(false);
    expect(body.running).toBe(false);
    expect(body.source).toBe('default');
    expect(body.restartRequired).toBe(false);
    expect(body.ready).toBe(true);
    expect(body.storage).toBe('degraded');
    expect(body.storageBackend).toBe('file');
    expect(body.version).toBe('0.10.3');
    expect(body.uptimeSec).toBe(123);
    expect(body.exposition.series).toBeGreaterThan(0);
    expect(body.exposition.bytes).toBeGreaterThan(0);
    expect(body.exposition.droppedSeries).toBe(1);
    expect(body.token).toEqual({ configured: false, source: 'none' });
    expect(body.endpoints).toEqual({ metrics: '/metrics', ready: '/ready' });
  });

  it('status без реестра: series/bytes/droppedSeries = 0', async () => {
    const app = createApp({ dataDir });
    const body = await json(await app.request('/api/v2/settings/metrics/status'));
    expect(body.exposition).toEqual({ series: 0, bytes: 0, droppedSeries: 0 });
  });

  it('токен: PUT короткий/пустой → 400, валидный → файл 0600, DELETE → none', async () => {
    const app = createApp({ dataDir });
    for (const token of ['', 'short', '              ']) {
      const res = await put(app, '/metrics/token', { token });
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
    }

    const saved = await json(await put(app, '/metrics/token', { token: TOKEN }));
    expect(saved).toEqual({ token: { configured: true, source: 'file' } });
    const mode = (await stat(metricsTokenPath(dataDir))).mode & 0o777;
    expect(mode).toBe(0o600);

    const removed = await json(await app.request('/api/v2/settings/metrics/token', { method: 'DELETE' }));
    expect(removed).toEqual({ token: { configured: false, source: 'none' } });
    // Идемпотентно.
    expect((await app.request('/api/v2/settings/metrics/token', { method: 'DELETE' })).status).toBe(200);
  });

  it('токен из env: PUT/DELETE → 409 CONFLICT', async () => {
    const app = createApp({ dataDir, env: { SYNTH_METRICS_TOKEN: 'env-secret-token-1234567890' } });
    const status = await json(await app.request('/api/v2/settings/metrics'));
    expect(status.token).toEqual({ configured: true, source: 'env' });

    const putRes = await put(app, '/metrics/token', { token: TOKEN });
    expect(putRes.status).toBe(409);
    expect((await json(putRes)).error.code).toBe('CONFLICT');
    const delRes = await app.request('/api/v2/settings/metrics/token', { method: 'DELETE' });
    expect(delRes.status).toBe(409);
  });

  it('смена токена применяется к /metrics без рестарта', async () => {
    const registry = new Registry();
    const metricsApp = new Hono();
    metricsApp.route('/', createMetricsRoutes({
      registry,
      enabled: true,
      getToken: () => resolveMetricsToken(dataDir, {}),
    }));
    const settingsApp = createApp({ dataDir, runningEnabled: true });

    // Токена нет — скрейп открыт.
    expect((await metricsApp.request('/metrics')).status).toBe(200);

    expect((await put(settingsApp, '/metrics/token', { token: TOKEN })).status).toBe(200);
    expect((await metricsApp.request('/metrics')).status).toBe(401);
    expect((await metricsApp.request('/metrics', { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await metricsApp.request('/metrics', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);

    expect((await settingsApp.request('/api/v2/settings/metrics/token', { method: 'DELETE' })).status).toBe(200);
    expect((await metricsApp.request('/metrics')).status).toBe(200);
  });

  it('после смены токена старый не действует', async () => {
    const registry = new Registry();
    const metricsApp = new Hono();
    metricsApp.route('/', createMetricsRoutes({ registry, enabled: true, getToken: () => resolveMetricsToken(dataDir, {}) }));
    const settingsApp = createApp({ dataDir });

    await put(settingsApp, '/metrics/token', { token: TOKEN });
    await put(settingsApp, '/metrics/token', { token: `${TOKEN}-next` });
    expect((await metricsApp.request('/metrics', { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(401);
    expect(
      (await metricsApp.request('/metrics', { headers: { Authorization: `Bearer ${TOKEN}-next` } })).status,
    ).toBe(200);
  });
});
