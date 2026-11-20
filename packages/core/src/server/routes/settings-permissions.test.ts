/**
 * Правила подтверждений **по умолчанию** — `/api/v2/settings/permissions`.
 *
 * Контракт: приоритет runtime > `config.permission.rules` > пустая карта,
 * runtime **заменяет** карту целиком (снять правило из UI можно), `{}` —
 * валидное «правил нет» (отличается от «не задано»), `askTimeoutMs` секцией не
 * управляется, живое применение (`refresh()` + депс-хук в оркестратор), аудит
 * `scope:'permission'`/`action:'update'` с before/after.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionConfig, SecurityAuditEntry } from '@itphx/synth-shared';
import {
  RuntimeSettingsStore,
  createLivePermissionSettings,
  resolvePermissionRules,
  type LivePermissionSettings,
} from '../../storage/runtime-settings.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import { createPermissionSettingsRoutes } from './settings-permissions.js';

const requireAuth = async (_c: Context, next: Next) => { await next(); };

/** Фейк журнала security-аудита: собирает записи (и умеет падать). */
function createAuditRepo(options: { fail?: boolean } = {}): {
  repo: SecurityAuditRepository;
  entries: SecurityAuditEntry[];
} {
  const entries: SecurityAuditEntry[] = [];
  const repo: SecurityAuditRepository = {
    append: async (entry) => {
      if (options.fail === true) throw new Error('хранилище недоступно');
      entries.push(entry);
    },
    list: async () => [...entries].reverse(),
    clear: async () => 0,
  };
  return { repo, entries };
}

interface CreatedApp {
  app: Hono;
  live: LivePermissionSettings;
  settingsStore: RuntimeSettingsStore;
  /** Карты, полученные депс-хуком (живое применение в оркестратор). */
  applied: Array<Record<string, unknown>>;
}

function createApp(options: {
  dataDir: string;
  config?: PermissionConfig;
  securityAudit?: SecurityAuditRepository;
  withLive?: boolean;
  withHook?: boolean;
} = { dataDir: '' }): CreatedApp {
  const app = new Hono();
  const settingsStore = new RuntimeSettingsStore({ dataDir: options.dataDir });
  const live = createLivePermissionSettings({
    store: settingsStore,
    ...(options.config !== undefined ? { config: options.config } : {}),
  });
  const applied: Array<Record<string, unknown>> = [];
  app.route('/api/v2/settings', createPermissionSettingsRoutes(
    { requireAuth },
    {
      settingsStore,
      ...(options.config !== undefined ? { config: options.config } : {}),
      ...(options.withLive === false ? {} : { live }),
      ...(options.withHook === false
        ? {}
        : {
            onRulesChange: (rules: Record<string, unknown>) => {
              applied.push(rules);
            },
          }),
      ...(options.securityAudit ? { securityAudit: options.securityAudit } : {}),
    },
  ));
  return { app, live, settingsStore, applied };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function put(app: Hono, body: unknown): Promise<Response> {
  return app.request('/api/v2/settings/permissions', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function del(app: Hono): Promise<Response> {
  return app.request('/api/v2/settings/permissions', { method: 'DELETE' });
}

describe('createPermissionSettingsRoutes', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-permission-settings-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET: по умолчанию правил нет (source=default), askTimeoutMs из базы', async () => {
    const { app } = createApp({ dataDir, config: { rules: {}, askTimeoutMs: 45_000 } });
    expect(await json(await app.request('/api/v2/settings/permissions'))).toEqual({
      rules: {},
      source: 'default',
      defaults: { rules: {} },
      // askTimeoutMs этой секцией не управляется — только для контекста.
      askTimeoutMs: 45_000,
    });
  });

  it('GET: база из config даёт source=config и defaults с правилами', async () => {
    const { app } = createApp({
      dataDir,
      config: { rules: { read_file: 'allow' }, askTimeoutMs: 30_000 },
    });
    expect(await json(await app.request('/api/v2/settings/permissions'))).toEqual({
      rules: { read_file: 'allow' },
      source: 'config',
      defaults: { rules: { read_file: 'allow' } },
      askTimeoutMs: 30_000,
    });
  });

  it('PUT заменяет карту целиком: старое правило исчезает, живой держатель и хук получают новые', async () => {
    const { app, live, settingsStore, applied } = createApp({
      dataDir,
      config: { rules: { read_file: 'allow' }, askTimeoutMs: 30_000 },
    });

    const first = await json(await put(app, { rules: { read_file: 'deny', write_file: 'ask' } }));
    expect(first).toEqual({
      rules: { read_file: 'deny', write_file: 'ask' },
      source: 'runtime',
      defaults: { rules: { read_file: 'allow' } },
      askTimeoutMs: 30_000,
    });
    // Живое состояние (его читает оркестратор) обновилось сразу.
    expect(live.getConfig().rules).toEqual({ read_file: 'deny', write_file: 'ask' });
    // Депс-хук применён к оркестратору (live-применение).
    expect(applied.at(-1)).toEqual({ read_file: 'deny', write_file: 'ask' });

    // Вторая правка присылает только одно правило — предыдущие **исчезают**
    // (замена карты, а не слияние): снять правило из UI возможно.
    const second = await json(await put(app, { rules: { glob: 'allow' } }));
    expect(second).toMatchObject({ rules: { glob: 'allow' }, source: 'runtime' });
    expect(await settingsStore.getPermissionRules()).toEqual({ glob: 'allow' });
    expect(live.getConfig().rules).toEqual({ glob: 'allow' });
    expect(applied.at(-1)).toEqual({ glob: 'allow' });

    // Повторный GET отдаёт сохранённый runtime-снимок.
    expect(await json(await app.request('/api/v2/settings/permissions'))).toMatchObject({
      rules: { glob: 'allow' },
      source: 'runtime',
    });
    // askTimeoutMs не тронут правкой правил.
    expect(live.getConfig().askTimeoutMs).toBe(30_000);
  });

  it('{} — валидное «правил нет» (не «не задано») и перекрывает базу config', async () => {
    const { app, live, settingsStore, applied } = createApp({
      dataDir,
      config: { rules: { read_file: 'allow' }, askTimeoutMs: 30_000 },
    });

    const res = await put(app, { rules: {} });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      rules: {},
      source: 'runtime',
      defaults: { rules: { read_file: 'allow' } },
      askTimeoutMs: 30_000,
    });
    // Записано именно пустое значение, а не «не задано».
    expect(await settingsStore.getPermissionRules()).toEqual({});
    expect(live.getConfig().rules).toEqual({});
    expect(applied.at(-1)).toEqual({});
  });

  it('DELETE сбрасывает runtime к базе config и применяет её живьём', async () => {
    const { app, live, settingsStore, applied } = createApp({
      dataDir,
      config: { rules: { read_file: 'allow' }, askTimeoutMs: 30_000 },
    });
    await put(app, { rules: { read_file: 'deny' } });

    const reset = await json(await del(app));
    expect(reset).toEqual({
      rules: { read_file: 'allow' },
      source: 'config',
      defaults: { rules: { read_file: 'allow' } },
      askTimeoutMs: 30_000,
    });
    expect(await settingsStore.getPermissionRules()).toBeUndefined();
    expect(live.getConfig().rules).toEqual({ read_file: 'allow' });
    expect(applied.at(-1)).toEqual({ read_file: 'allow' });

    // Без базы config сброс возвращает пустую карту (source=default).
    const bare = createApp({ dataDir });
    await put(bare.app, { rules: { glob: 'deny' } });
    expect(await json(await del(bare.app))).toEqual({
      rules: {},
      source: 'default',
      defaults: { rules: {} },
      askTimeoutMs: 300_000,
    });
    expect(bare.live.getConfig().rules).toEqual({});
  });

  it('400 VALIDATION_ERROR: неверные формы правил и тела', async () => {
    const { app, settingsStore, applied } = createApp({ dataDir });
    const bodies: unknown[] = [
      // Нет `rules`.
      {},
      // Неизвестный ключ тела.
      { rules: {}, extra: true },
      // `rules` — не объект.
      { rules: 'allow' },
      { rules: ['allow'] },
      { rules: null },
      // Значение не из `allow|deny|ask`.
      { rules: { read_file: 'maybe' } },
      { rules: { read_file: 42 } },
      { rules: { read_file: null } },
      // Массив вместо значения правила.
      { rules: { read_file: ['allow'] } },
      // Вложенный объект глубже одного уровня.
      { rules: { read_file: { '*.env': { '*.secret': 'deny' } } } },
      { rules: { glob: { '*.ts': 'nope' } } },
    ];
    for (const body of bodies) {
      const res = await put(app, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const payload = await json(res);
      expect((payload.error as Record<string, unknown>).code).toBe('VALIDATION_ERROR');
    }
    // Ни один невалидный запрос не записал runtime-секцию и не тронул живое.
    expect(await settingsStore.getPermissionRules()).toBeUndefined();
    expect(applied).toEqual([]);
  });

  it('400: сообщение перечисляет ключи невалидных правил', async () => {
    const { app } = createApp({ dataDir });
    const res = await put(app, { rules: { read_file: 'nope', write_file: 'ask', glob: 7 } });
    expect(res.status).toBe(400);
    const message = String(
      ((await json(res)).error as Record<string, unknown>).message,
    );
    expect(message).toContain('read_file');
    expect(message).toContain('glob');
    // Валидное правило в перечне ошибок не упоминается.
    expect(message).not.toContain('write_file');
  });

  it('аудит update: scope=permission, before/after — карты правил, actor — пользователь', async () => {
    const { repo, entries } = createAuditRepo();
    const app = new Hono();
    const settingsStore = new RuntimeSettingsStore({ dataDir });
    const config: PermissionConfig = { rules: { read_file: 'allow' }, askTimeoutMs: 30_000 };
    app.route('/api/v2/settings', createPermissionSettingsRoutes(
      { requireAuth },
      {
        settingsStore,
        config,
        securityAudit: repo,
        resolveActor: () => 'user-7',
      },
    ));

    const res = await put(app, { rules: { write_file: 'deny' } });
    expect(res.status).toBe(200);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      scope: 'permission',
      action: 'update',
      actor: 'user-7',
      source: 'runtime',
      before: { read_file: 'allow' },
      after: { write_file: 'deny' },
    });

    // DELETE тоже пишет update: after — база config.
    await del(app);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      scope: 'permission',
      action: 'update',
      actor: 'user-7',
      before: { write_file: 'deny' },
      after: { read_file: 'allow' },
    });
  });

  it('ошибка журнала не ломает PUT (аудит best-effort)', async () => {
    const { repo } = createAuditRepo({ fail: true });
    const { app, settingsStore } = createApp({ dataDir, securityAudit: repo });

    const res = await put(app, { rules: { glob: 'allow' } });
    expect(res.status).toBe(200);
    expect(await settingsStore.getPermissionRules()).toEqual({ glob: 'allow' });
  });

  it('без живого состояния работает по порту (PUT/DELETE не падают)', async () => {
    const { app, settingsStore } = createApp({ dataDir, withLive: false, withHook: false });
    const res = await put(app, { rules: { glob: 'ask' } });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ rules: { glob: 'ask' }, source: 'runtime' });
    expect(await settingsStore.getPermissionRules()).toEqual({ glob: 'ask' });

    const reset = await del(app);
    expect(reset.status).toBe(200);
    expect(await json(reset)).toMatchObject({ rules: {}, source: 'default' });
  });

  it('resolvePermissionRules: runtime заменяет карту, {} перекрывает config', () => {
    const config: PermissionConfig = { rules: { read_file: 'allow' }, askTimeoutMs: 1_000 };
    expect(resolvePermissionRules({ config })).toEqual({
      rules: { read_file: 'allow' },
      source: 'config',
      defaults: { read_file: 'allow' },
    });
    // runtime заменяет карту целиком (не сливается с config).
    expect(resolvePermissionRules({ config, runtime: { rules: { glob: 'deny' } } })).toEqual({
      rules: { glob: 'deny' },
      source: 'runtime',
      defaults: { read_file: 'allow' },
    });
    // Пустая карта — валидное «правил нет», а не «не задано».
    expect(resolvePermissionRules({ config, runtime: { rules: {} } })).toEqual({
      rules: {},
      source: 'runtime',
      defaults: { read_file: 'allow' },
    });
    // Без config — пустая база.
    expect(resolvePermissionRules()).toEqual({ rules: {}, source: 'default', defaults: {} });
  });
});
