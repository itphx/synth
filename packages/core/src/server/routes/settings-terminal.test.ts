/**
 * PROP-132 (Ф3в): настройки терминалов — `/api/v2/settings/terminal`.
 *
 * Проверяем контракт секции целиком: 7 полей (`enabled`, `autoRestore`,
 * `idleMinutes`, `maxPerProject`, `maxPerInstance`, `shell`, `auditInput`),
 * приоритет источников (env > runtime > config > default) **по каждому полю**
 * (`sources`), env-фиксацию (409 `ENV_LOCKED` с `fields` — по полю, частичный
 * отказ без применения), runtime-override с **live-применением**
 * (`setEnabled`/`setAutoRestore`/`setLimits`/`setDefaultShell`/`setAuditInput`),
 * сброс по DELETE, частичное обновление по PUT, валидацию тела (типы, границы,
 * оболочка, неизвестные ключи) и разделение guard'ов чтения/записи.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalConfig } from '@itphx/synth-shared/config';
import { RuntimeSettingsStore } from '../../storage/runtime-settings.js';
import type { TerminalService } from '../../engine/terminal/service.js';
import { createTerminalSettingsRoutes } from './settings-terminal.js';

const requireAuth = async (_c: Context, next: Next) => { await next(); };
const deny = async (c: Context) => c.json({ error: { code: 'FORBIDDEN', message: 'deny' } }, 403);

interface AppOptions {
  dataDir: string;
  config?: Partial<TerminalConfig>;
  env?: NodeJS.ProcessEnv;
  writeGuard?: (c: Context, next: Next) => Promise<Response | void>;
}

/** Шпионы live-применения: важно только, что и с чем вызвали. */
interface ServiceSpies {
  setEnabled: ReturnType<typeof vi.fn>;
  setAutoRestore: ReturnType<typeof vi.fn>;
  setLimits: ReturnType<typeof vi.fn>;
  setDefaultShell: ReturnType<typeof vi.fn>;
  setAuditInput: ReturnType<typeof vi.fn>;
}

/** Мок сервиса терминалов: все точки live-применения. */
function createTerminalServiceMock(): { service: TerminalService; spies: ServiceSpies } {
  const spies: ServiceSpies = {
    setEnabled: vi.fn(),
    setAutoRestore: vi.fn(),
    setLimits: vi.fn(),
    setDefaultShell: vi.fn(),
    setAuditInput: vi.fn(),
  };
  const service = { ...spies, isEnabled: () => true } as unknown as TerminalService;
  return { service, spies };
}

function createApp(options: AppOptions): { app: Hono; spies: ServiceSpies } {
  const app = new Hono();
  const settingsStore = new RuntimeSettingsStore({ dataDir: options.dataDir });
  const { service, spies } = createTerminalServiceMock();
  app.route('/api/v2/settings', createTerminalSettingsRoutes(
    { requireAuth },
    {
      settingsStore,
      ...(options.config !== undefined ? { config: options.config } : {}),
      terminalService: service,
      env: options.env ?? {},
    },
    options.writeGuard ? { writeGuard: options.writeGuard as never } : {},
  ));
  return { app, spies };
}

/** Тело ответа роута: значения настроек либо код ошибки. */
interface SettingsResponse {
  enabled?: boolean;
  autoRestore?: boolean;
  idleMinutes?: number;
  maxPerProject?: number;
  maxPerInstance?: number;
  shell?: string | null;
  auditInput?: boolean;
  source?: string;
  sources?: Record<string, string>;
  defaults?: Record<string, unknown>;
  envLocked?: boolean;
  envLockedFields?: string[];
  restartRequired?: boolean;
  error?: { code: string; message: string; fields?: string[] };
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

/** Полный набор полей по умолчанию (для `toEqual`). */
const DEFAULT_FIELDS = {
  enabled: true,
  autoRestore: true,
  idleMinutes: 2880,
  maxPerProject: 8,
  maxPerInstance: 32,
  shell: null,
  auditInput: true,
} as const;

const DEFAULT_SOURCES = {
  enabled: 'default',
  autoRestore: 'default',
  idleMinutes: 'default',
  maxPerProject: 'default',
  maxPerInstance: 'default',
  shell: 'default',
  auditInput: 'default',
} as const;

describe('createTerminalSettingsRoutes', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-terminal-settings-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET: дефолт — все 7 полей, source=default, env-фиксаций нет', async () => {
    const { app } = createApp({ dataDir });
    const body = await json(await app.request('/api/v2/settings/terminal'));
    expect(body).toEqual({
      ...DEFAULT_FIELDS,
      source: 'default',
      sources: DEFAULT_SOURCES,
      defaults: DEFAULT_FIELDS,
      envLocked: false,
      envLockedFields: [],
      restartRequired: false,
    });
  });

  it('GET: config.yaml — source=config, defaults из секции (объектная форма)', async () => {
    const { app } = createApp({
      dataDir,
      config: {
        enabled: false,
        autoRestore: false,
        idleMinutes: 120,
        maxPerProject: 4,
        maxPerInstance: 16,
        shell: '/bin/zsh',
        auditInput: false,
      },
    });
    const body = await json(await app.request('/api/v2/settings/terminal'));
    expect(body.enabled).toBe(false);
    expect(body.autoRestore).toBe(false);
    expect(body.idleMinutes).toBe(120);
    expect(body.maxPerProject).toBe(4);
    expect(body.maxPerInstance).toBe(16);
    expect(body.shell).toBe('/bin/zsh');
    expect(body.auditInput).toBe(false);
    expect(body.source).toBe('config');
    expect(body.sources).toEqual({
      enabled: 'config',
      autoRestore: 'config',
      idleMinutes: 'config',
      maxPerProject: 'config',
      maxPerInstance: 'config',
      shell: 'config',
      auditInput: 'config',
    });
    expect(body.defaults).toEqual({
      enabled: false,
      autoRestore: false,
      idleMinutes: 120,
      maxPerProject: 4,
      maxPerInstance: 16,
      shell: '/bin/zsh',
      auditInput: false,
    });
  });

  it('env фиксирует выключатель: source=env, envLockedFields, PUT/DELETE → 409 ENV_LOCKED', async () => {
    const { app, spies } = createApp({
      dataDir,
      env: { SYNTH_TERMINAL_ENABLED: 'false' },
    });

    const body = await json(await app.request('/api/v2/settings/terminal'));
    expect(body.enabled).toBe(false);
    expect(body.source).toBe('env');
    expect(body.sources?.enabled).toBe('env');
    expect(body.envLocked).toBe(true);
    expect(body.envLockedFields).toEqual(['enabled']);

    const putRes = await put(app, { enabled: true });
    expect(putRes.status).toBe(409);
    const putBody = await json(putRes);
    expect(putBody.error?.code).toBe('ENV_LOCKED');
    expect(putBody.error?.fields).toEqual(['enabled']);

    const delRes = await app.request('/api/v2/settings/terminal', { method: 'DELETE' });
    expect(delRes.status).toBe(409);
    expect((await json(delRes)).error?.fields).toEqual(['enabled']);

    // Live-применения не было — значение из env не перебито.
    expect(spies.setEnabled).not.toHaveBeenCalled();
  });

  it('env фиксирует только autoRestore — enabled переключается', async () => {
    const { app, spies } = createApp({
      dataDir,
      env: { SYNTH_TERMINAL_AUTO_RESTORE: 'false' },
    });

    const body = await json(await app.request('/api/v2/settings/terminal'));
    expect(body.autoRestore).toBe(false);
    expect(body.enabled).toBe(true);
    expect(body.envLockedFields).toEqual(['autoRestore']);

    // Зафиксированное поле — 409.
    const locked = await put(app, { autoRestore: true });
    expect(locked.status).toBe(409);
    expect((await json(locked)).error?.fields).toEqual(['autoRestore']);
    expect(spies.setAutoRestore).not.toHaveBeenCalled();

    // Незафиксированное поле — обычная запись.
    const ok = await put(app, { enabled: false });
    expect(ok.status).toBe(200);
    const after = await json(ok);
    expect(after.enabled).toBe(false);
    expect(after.autoRestore).toBe(false);
    expect(spies.setEnabled).toHaveBeenCalledWith(false);
  });

  it('env фиксация в PUT — частичный отказ: ничего из запроса не применяется', async () => {
    const { app, spies } = createApp({
      dataDir,
      env: { SYNTH_TERMINAL_IDLE_MINUTES: '60' },
    });

    const res = await put(app, { idleMinutes: 120, maxPerProject: 4 });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error?.code).toBe('ENV_LOCKED');
    expect(body.error?.fields).toEqual(['idleMinutes']);
    expect(spies.setLimits).not.toHaveBeenCalled();

    // Незафиксированное поле из того же запроса тоже не сохранено.
    const after = await json(await app.request('/api/v2/settings/terminal'));
    expect(after.idleMinutes).toBe(60);
    expect(after.maxPerProject).toBe(8);
    expect(after.sources?.maxPerProject).toBe('default');
  });

  it('PUT: runtime-override + live-применение (setEnabled)', async () => {
    const { app, spies } = createApp({ dataDir });

    const res = await put(app, { enabled: false });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.enabled).toBe(false);
    expect(body.source).toBe('runtime');
    expect(body.sources?.enabled).toBe('runtime');
    expect(body.defaults).toEqual(DEFAULT_FIELDS);
    expect(body.restartRequired).toBe(false);

    expect(spies.setEnabled).toHaveBeenCalledWith(false);

    // Значение переживает рестарт (runtime в settings.json).
    const after = await json(await app.request('/api/v2/settings/terminal'));
    expect(after.enabled).toBe(false);
    expect(after.source).toBe('runtime');
  });

  it('PUT: autoRestore — runtime-override + live-применение (setAutoRestore)', async () => {
    const { app, spies } = createApp({ dataDir });

    const res = await put(app, { autoRestore: false });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.autoRestore).toBe(false);
    expect(body.source).toBe('runtime');

    expect(spies.setAutoRestore).toHaveBeenCalledWith(false);

    const after = await json(await app.request('/api/v2/settings/terminal'));
    expect(after.autoRestore).toBe(false);
    expect(after.source).toBe('runtime');
  });

  it('PUT: параметры выполнения — idleMinutes/maxPerProject/maxPerInstance → setLimits', async () => {
    const { app, spies } = createApp({ dataDir });

    const res = await put(app, { idleMinutes: 120, maxPerProject: 4, maxPerInstance: 16 });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.idleMinutes).toBe(120);
    expect(body.maxPerProject).toBe(4);
    expect(body.maxPerInstance).toBe(16);

    // idleMinutes переводится в миллисекунды — сервис живёт в мс.
    expect(spies.setLimits).toHaveBeenCalledWith({
      idleMs: 120 * 60_000,
      maxPerProject: 4,
      maxPerInstance: 16,
    });
  });

  it('PUT: shell — строка применяется к новым терминалам, пустая → null (дефолт)', async () => {
    const { app, spies } = createApp({ dataDir });

    const set = await put(app, { shell: '/bin/zsh' });
    expect(set.status).toBe(200);
    expect((await json(set)).shell).toBe('/bin/zsh');
    expect(spies.setDefaultShell).toHaveBeenLastCalledWith('/bin/zsh');

    const reset = await put(app, { shell: '' });
    expect(reset.status).toBe(200);
    expect((await json(reset)).shell).toBeNull();
    expect(spies.setDefaultShell).toHaveBeenLastCalledWith(null);

    // trim: пробелы вокруг имени оболочки не значимы.
    const trimmed = await put(app, { shell: '  bash  ' });
    expect(trimmed.status).toBe(200);
    expect((await json(trimmed)).shell).toBe('bash');
  });

  it('PUT: auditInput=false — runtime-override + live-применение', async () => {
    const { app, spies } = createApp({ dataDir });

    const res = await put(app, { auditInput: false });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.auditInput).toBe(false);
    expect(body.sources?.auditInput).toBe('runtime');
    expect(spies.setAuditInput).toHaveBeenCalledWith(false);
  });

  it('PUT: частичное обновление — прочие поля не затираются', async () => {
    const { app } = createApp({ dataDir });

    await put(app, { enabled: false, idleMinutes: 120 });
    const res = await put(app, { autoRestore: false });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.enabled).toBe(false);
    expect(body.autoRestore).toBe(false);
    expect(body.idleMinutes).toBe(120);

    const after = await json(await app.request('/api/v2/settings/terminal'));
    expect(after.enabled).toBe(false);
    expect(after.idleMinutes).toBe(120);
  });

  it('DELETE: сброс runtime всех полей к config/default + live-применение', async () => {
    const { app, spies } = createApp({ dataDir });

    await put(app, {
      enabled: false,
      autoRestore: false,
      idleMinutes: 60,
      maxPerProject: 2,
      maxPerInstance: 3,
      shell: 'zsh',
      auditInput: false,
    });
    expect(spies.setEnabled).toHaveBeenCalledWith(false);

    spies.setEnabled.mockClear();
    spies.setAutoRestore.mockClear();
    spies.setLimits.mockClear();
    spies.setDefaultShell.mockClear();
    spies.setAuditInput.mockClear();

    const res = await app.request('/api/v2/settings/terminal', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toEqual({
      ...DEFAULT_FIELDS,
      source: 'default',
      sources: DEFAULT_SOURCES,
      defaults: DEFAULT_FIELDS,
      envLocked: false,
      envLockedFields: [],
      restartRequired: false,
    });

    expect(spies.setAutoRestore).toHaveBeenCalledWith(true);
    expect(spies.setLimits).toHaveBeenCalledWith({
      idleMs: DEFAULT_FIELDS.idleMinutes * 60_000,
      maxPerProject: DEFAULT_FIELDS.maxPerProject,
      maxPerInstance: DEFAULT_FIELDS.maxPerInstance,
    });
    expect(spies.setDefaultShell).toHaveBeenCalledWith(null);
    expect(spies.setAuditInput).toHaveBeenCalledWith(true);
    expect(spies.setEnabled).toHaveBeenCalledWith(true);
  });

  it('DELETE: сброс возвращает к значению config.yaml', async () => {
    const { app, spies } = createApp({ dataDir, config: { enabled: false, idleMinutes: 120 } });
    await put(app, { enabled: true, idleMinutes: 1440 });
    const res = await app.request('/api/v2/settings/terminal', { method: 'DELETE' });
    const body = await json(res);
    expect(body.enabled).toBe(false);
    expect(body.idleMinutes).toBe(120);
    expect(body.source).toBe('config');
    expect(spies.setEnabled).toHaveBeenLastCalledWith(false);
    expect(spies.setLimits).toHaveBeenLastCalledWith(
      expect.objectContaining({ idleMs: 120 * 60_000 }),
    );
  });

  it('PUT: пустое тело и неизвестные ключи → 400 VALIDATION_ERROR', async () => {
    const { app, spies } = createApp({ dataDir });
    for (const body of [{}, { maxPerProjectt: 4 }, { enabled: true, nope: 1 }]) {
      const res = await put(app, body);
      expect(res.status).toBe(400);
      expect((await json(res)).error?.code).toBe('VALIDATION_ERROR');
    }
    expect(spies.setEnabled).not.toHaveBeenCalled();
    expect(spies.setLimits).not.toHaveBeenCalled();
  });

  it('PUT: неверные типы → 400 VALIDATION_ERROR', async () => {
    const { app, spies } = createApp({ dataDir });
    for (const body of [
      { enabled: 'yes' },
      { enabled: 1 },
      { enabled: null },
      { autoRestore: 'yes' },
      { auditInput: 0 },
      { idleMinutes: '120' },
      { maxPerProject: 1.5 },
      { maxPerInstance: null },
      { shell: 42 },
    ]) {
      const res = await put(app, body);
      expect(res.status).toBe(400);
      expect((await json(res)).error?.code).toBe('VALIDATION_ERROR');
    }
    expect(spies.setEnabled).not.toHaveBeenCalled();
    expect(spies.setLimits).not.toHaveBeenCalled();
    expect(spies.setDefaultShell).not.toHaveBeenCalled();
  });

  it('PUT: числа вне границ → 400 (idleMinutes 30…10080, проект 1…64, инстанс 1…256)', async () => {
    const { app, spies } = createApp({ dataDir });
    const cases: Array<Record<string, number>> = [
      { idleMinutes: 29 },
      { idleMinutes: 10_081 },
      { maxPerProject: 0 },
      { maxPerProject: 65 },
      { maxPerInstance: 0 },
      { maxPerInstance: 257 },
    ];
    for (const body of cases) {
      const res = await put(app, body);
      expect(res.status).toBe(400);
      expect((await json(res)).error?.code).toBe('VALIDATION_ERROR');
    }
    expect(spies.setLimits).not.toHaveBeenCalled();

    // Границы включительно — принимаются.
    expect((await put(app, { idleMinutes: 30 })).status).toBe(200);
    expect((await put(app, { idleMinutes: 10_080 })).status).toBe(200);
    expect((await put(app, { maxPerProject: 1, maxPerInstance: 256 })).status).toBe(200);
  });

  it('PUT: оболочка с пробелами/аргументами → 400 VALIDATION_ERROR', async () => {
    const { app, spies } = createApp({ dataDir });
    for (const body of [{ shell: 'bash -l' }, { shell: 'bash; rm -rf /' }]) {
      const res = await put(app, body);
      expect(res.status).toBe(400);
      expect((await json(res)).error?.code).toBe('VALIDATION_ERROR');
    }
    expect(spies.setDefaultShell).not.toHaveBeenCalled();
  });

  it('guard: чтение и запись разделены (writeGuard)', async () => {
    const { app } = createApp({ dataDir, writeGuard: deny });
    expect((await app.request('/api/v2/settings/terminal')).status).toBe(200);
    expect((await put(app, { enabled: false })).status).toBe(403);
    expect((await app.request('/api/v2/settings/terminal', { method: 'DELETE' })).status).toBe(403);
  });
});
