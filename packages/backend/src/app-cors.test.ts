// CORS fail-closed (backend): пустой белый список НЕ отражает произвольный
// origin; явный dev-флаг SYNTH_CORS_ALLOW_ALL — единственный способ открыть CORS.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackendApp } from './app.js';
import type { BackendAppHandle } from './app.js';

const stopHandle = (b: BackendAppHandle): void => {
  b.stopScheduler();
  b.stopEphemeralSweeper();
  b.stopEventJournalPruner();
  b.stopWebhookService();
  b.stopWebhookDeliveryPruner();
};

const ACAO = 'access-control-allow-origin';

// CORS-заголовки CORS-middleware ставит до роута; берём любой роут после него.
const probe = (base: BackendAppHandle, origin: string): Promise<Response> =>
  Promise.resolve(base.app.request('/api/v2/i18n/current', { headers: { Origin: origin } }));

describe('backend CORS (fail-closed)', () => {
  let rootDir: string;
  let emptyApp: BackendAppHandle;
  let allowedApp: BackendAppHandle;

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'synth-backend-cors-'));
    const emptyConfig = join(rootDir, 'empty.yaml');
    await writeFile(emptyConfig, 'server:\n  allowedOrigins: []\n');
    const allowedConfig = join(rootDir, 'allowed.yaml');
    await writeFile(allowedConfig, 'server:\n  allowedOrigins:\n    - https://app.example\n');

    // Гасим возможные env-переменные окружения теста (SYNTH_CORS_ORIGIN/ALLOW_ALL).
    const env = { SYNTH_CORS_ORIGIN: '', SYNTH_CORS_ALLOW_ALL: '' };
    emptyApp = await createBackendApp({
      dataDir: join(rootDir, 'data-empty'),
      configPath: emptyConfig,
      authDebug: true,
      env,
    });
    allowedApp = await createBackendApp({
      dataDir: join(rootDir, 'data-allowed'),
      configPath: allowedConfig,
      authDebug: true,
      env,
    });
  });

  afterAll(async () => {
    stopHandle(emptyApp);
    stopHandle(allowedApp);
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('пустой allowlist + чужой Origin → CORS-заголовка нет', async () => {
    const res = await probe(emptyApp, 'https://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers.get(ACAO)).toBeNull();
  });

  it('allowedOrigins содержит origin → эхо', async () => {
    const res = await probe(allowedApp, 'https://app.example');
    expect(res.status).toBe(200);
    expect(res.headers.get(ACAO)).toBe('https://app.example');
  });

  it('origin не из allowlist → CORS-заголовка нет', async () => {
    const res = await probe(allowedApp, 'https://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers.get(ACAO)).toBeNull();
  });

  it('явный SYNTH_CORS_ALLOW_ALL=true → эхо произвольного origin (dev)', async () => {
    const devRoot = await mkdtemp(join(tmpdir(), 'synth-backend-cors-dev-'));
    const devApp = await createBackendApp({
      dataDir: join(devRoot, 'data'),
      authDebug: true,
      env: { SYNTH_CORS_ALLOW_ALL: 'true', SYNTH_CORS_ORIGIN: '' },
    });
    try {
      const res = await probe(devApp, 'https://anything.example');
      expect(res.headers.get(ACAO)).toBe('https://anything.example');
    } finally {
      stopHandle(devApp);
      await rm(devRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
