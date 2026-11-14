/**
 * PROP-132 (Ф3в): мастер-выключатель терминалов — `/api/v2/settings/terminal`.
 *
 * Проверяем контракт: приоритет источников (env > runtime > config > default),
 * env-фиксацию (409 на PUT/DELETE), runtime-override с **live-применением**
 * (`terminalService.setEnabled`), сброс по DELETE, валидацию тела и
 * разделение guard'ов чтения/записи.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeSettingsStore } from '../../storage/runtime-settings.js';
import type { TerminalService } from '../../engine/terminal/service.js';
import { createTerminalSettingsRoutes } from './settings-terminal.js';

const requireAuth = async (_c: Context, next: Next) => { await next(); };
const deny = async (c: Context) => c.json({ error: { code: 'FORBIDDEN', message: 'deny' } }, 403);

interface AppOptions {
  dataDir: string;
  configEnabled?: boolean;
  env?: NodeJS.ProcessEnv;
  writeGuard?: (c: Context, next: Next) => Promise<Response | void>;
}

/** Мок сервиса терминалов: важно только live-применение выключателя. */
function createTerminalServiceMock(): { service: TerminalService; setEnabled: ReturnType<typeof vi.fn> } {
  const setEnabled = vi.fn();
  const service = { setEnabled, isEnabled: () => true } as unknown as TerminalService;
  return { service, setEnabled };
}

function createApp(options: AppOptions): { app: Hono; setEnabled: ReturnType<typeof vi.fn> } {
  const app = new Hono();
  const settingsStore = new RuntimeSettingsStore({ dataDir: options.dataDir });
  const { service, setEnabled } = createTerminalServiceMock();
  app.route('/api/v2/settings', createTerminalSettingsRoutes(
    { requireAuth },
    {
      settingsStore,
      ...(options.configEnabled !== undefined ? { configEnabled: options.configEnabled } : {}),
      terminalService: service,
      env: options.env ?? {},
    },
    options.writeGuard ? { writeGuard: options.writeGuard as never } : {},
  ));
  return { app, setEnabled };
}

/** Тело ответа роута: значения настроек либо код ошибки. */
interface SettingsResponse {
  enabled?: boolean;
  source?: string;
  defaults?: { enabled: boolean };
  envLocked?: boolean;
  restartRequired?: boolean;
  error?: { code: string; message: string };
}

async function json(res: Response): Promise<SettingsResponse> {
  return (await res.json()) as SettingsResponse;
}

async function put(app: Hono, body: unknown): Promise<Response> {
  return app.request('/api/v2/settings/terminal', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('createTerminalSettingsRoutes', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-terminal-settings-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET: дефолт — терминалы включены, source=default', async () => {
    const { app } = createApp({ dataDir });
    const body = await json(await app.request('/api/v2/settings/terminal'));
    expect(body).toEqual({
      enabled: true,
      source: 'default',
      defaults: { enabled: true },
      envLocked: false,
      restartRequired: false,
    });
  });

  it('GET: config.yaml — source=config', async () => {
    const { app } = createApp({ dataDir, configEnabled: false });
    const body = await json(await app.request('/api/v2/settings/terminal'));
    expect(body.enabled).toBe(false);
    expect(body.source).toBe('config');
    expect(body.defaults).toEqual({ enabled: false });
  });

  it('env фиксирует выключатель: source=env, envLocked, PUT/DELETE → 409', async () => {
    const { app, setEnabled } = createApp({
      dataDir,
      env: { SYNTH_TERMINAL_ENABLED: 'false' },
    });

    const body = await json(await app.request('/api/v2/settings/terminal'));
    expect(body.enabled).toBe(false);
    expect(body.source).toBe('env');
    expect(body.envLocked).toBe(true);

    const putRes = await put(app, { enabled: true });
    expect(putRes.status).toBe(409);
    expect((await json(putRes)).error?.code).toBe('CONFLICT');

    const delRes = await app.request('/api/v2/settings/terminal', { method: 'DELETE' });
    expect(delRes.status).toBe(409);
    expect((await json(delRes)).error?.code).toBe('CONFLICT');

    // Live-применения не было — значение из env не перебито.
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('PUT: runtime-override + live-применение (setEnabled)', async () => {
    const { app, setEnabled } = createApp({ dataDir });

    const res = await put(app, { enabled: false });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.enabled).toBe(false);
    expect(body.source).toBe('runtime');
    expect(body.defaults).toEqual({ enabled: true });
    expect(body.restartRequired).toBe(false);

    expect(setEnabled).toHaveBeenCalledTimes(1);
    expect(setEnabled).toHaveBeenCalledWith(false);

    // Значение переживает рестарт (runtime в settings.json).
    const after = await json(await app.request('/api/v2/settings/terminal'));
    expect(after.enabled).toBe(false);
    expect(after.source).toBe('runtime');
  });

  it('DELETE: сброс runtime к config/default + live-применение', async () => {
    const { app, setEnabled } = createApp({ dataDir });

    await put(app, { enabled: false });
    expect(setEnabled).toHaveBeenCalledWith(false);

    const res = await app.request('/api/v2/settings/terminal', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.enabled).toBe(true);
    expect(body.source).toBe('default');
    expect(body.defaults).toEqual({ enabled: true });

    expect(setEnabled).toHaveBeenCalledTimes(2);
    expect(setEnabled).toHaveBeenLastCalledWith(true);
  });

  it('DELETE: сброс возвращает к значению config.yaml', async () => {
    const { app, setEnabled } = createApp({ dataDir, configEnabled: false });

    await put(app, { enabled: true });
    const res = await app.request('/api/v2/settings/terminal', { method: 'DELETE' });
    const body = await json(res);
    expect(body.enabled).toBe(false);
    expect(body.source).toBe('config');
    expect(setEnabled).toHaveBeenLastCalledWith(false);
  });

  it('PUT: не-boolean → 400 VALIDATION_ERROR', async () => {
    const { app, setEnabled } = createApp({ dataDir });
    for (const body of [{}, { enabled: 'yes' }, { enabled: 1 }, { enabled: null }]) {
      const res = await put(app, body);
      expect(res.status).toBe(400);
      expect((await json(res)).error?.code).toBe('VALIDATION_ERROR');
    }
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('guard: чтение и запись разделены (writeGuard)', async () => {
    const { app } = createApp({ dataDir, writeGuard: deny });
    expect((await app.request('/api/v2/settings/terminal')).status).toBe(200);
    expect((await put(app, { enabled: false })).status).toBe(403);
    expect((await app.request('/api/v2/settings/terminal', { method: 'DELETE' })).status).toBe(403);
  });
});
