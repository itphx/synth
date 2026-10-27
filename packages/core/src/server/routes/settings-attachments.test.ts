/**
 * ADR-115: админ-раздел «Вложения» — `/api/v2/settings/attachments`.
 *
 * Проверяем контракт: приоритет источников (env > runtime > config > default),
 * `envLocked` (409 на попытку перекрыть env-поле), частичный патч (в т.ч.
 * вложенный `modalities`), `restartRequired:false`, сброс, применение в живом
 * резолвере без рестарта, аудит `scope:'attachments'` и guard'ы.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecurityAuditEntry } from '@itphx/synth-shared';
import type { Context as HonoContext } from 'hono';
import type { AttachmentsConfig } from '@itphx/synth-shared';
import { RuntimeSettingsStore } from '../../storage/runtime-settings.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import { createLiveAttachmentsSettings } from '../../storage/runtime-settings.js';
import { createAttachmentsSettingsRoutes } from './settings-attachments.js';

const requireAuth = async (_c: Context, next: Next) => { await next(); };
const deny = async (c: HonoContext) => c.json({ error: { code: 'FORBIDDEN', message: 'deny' } }, 403);

/** Аудит в памяти: пишем записи, читаем для проверки scope/action. */
function createAudit(): SecurityAuditRepository & { entries: SecurityAuditEntry[] } {
  const entries: SecurityAuditEntry[] = [];
  return {
    entries,
    append: async (entry) => {
      entries.push(entry);
    },
    list: async () => [...entries].reverse(),
    clear: async () => {
      const count = entries.length;
      entries.length = 0;
      return count;
    },
  };
}

interface AppOptions {
  dataDir: string;
  config?: Partial<AttachmentsConfig>;
  env?: NodeJS.ProcessEnv;
  audit?: SecurityAuditRepository;
  writeGuard?: (c: Context, next: Next) => Promise<Response | void>;
  readGuard?: (c: Context, next: Next) => Promise<Response | void>;
}

function createApp(options: AppOptions) {
  const app = new Hono();
  const settingsStore = new RuntimeSettingsStore({ dataDir: options.dataDir });
  const live = createLiveAttachmentsSettings({ config: options.config, env: options.env ?? {} });
  app.route('/api/v2/settings', createAttachmentsSettingsRoutes(
    { requireAuth },
    {
      settingsStore,
      config: options.config,
      live,
      env: options.env ?? {},
      ...(options.audit ? { securityAudit: options.audit } : {}),
    },
    {
      ...(options.readGuard ? { readGuard: options.readGuard as never } : {}),
      ...(options.writeGuard ? { writeGuard: options.writeGuard as never } : {}),
    },
  ));
  return { app, live, settingsStore };
}

async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

async function put(app: Hono, body: unknown): Promise<Response> {
  return app.request('/api/v2/settings/attachments', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('createAttachmentsSettingsRoutes (ADR-115)', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-attachments-settings-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET: дефолты схемы, источник default, без envLocked', async () => {
    const { app } = createApp({ dataDir });
    const body = await json(await app.request('/api/v2/settings/attachments'));
    expect(body.attachments).toEqual({
      enabled: true,
      modalities: { image: true, pdf: true, audio: true, video: true },
      maxBytesPerFile: 25 * 1024 * 1024,
      maxFilesPerMessage: 10,
      maxBytesPerSession: 1024 * 1024 * 1024,
      allowedMimePrefixes: ['image/', 'audio/', 'application/pdf', 'text/'],
      workspaceFallback: true,
      gcDays: 30,
    });
    expect(body.defaults).toEqual(body.attachments);
    expect(body.isOverridden).toBe(false);
    expect(body.source).toBe('default');
    expect(body.envLocked).toEqual([]);
    // ADR-115: применяется сразу — рестарт не требуется.
    expect(body.restartRequired).toBe(false);
    expect(body.running).toEqual(body.attachments);
  });

  it('GET: config как источник эффективного значения', async () => {
    const { app } = createApp({
      dataDir,
      config: { enabled: false, maxFilesPerMessage: 3 },
      env: {},
    });
    const body = await json(await app.request('/api/v2/settings/attachments'));
    expect(body.source).toBe('config');
    expect(body.attachments.enabled).toBe(false);
    expect(body.attachments.maxFilesPerMessage).toBe(3);
    expect(body.isOverridden).toBe(false);
  });

  it('PUT: частичный патч (вложенный modalities) → ответ и живой резолвер', async () => {
    const audit = createAudit();
    const { app, live } = createApp({ dataDir, audit, env: {} });

    const res = await put(app, {
      attachments: { enabled: false, gcDays: 7, modalities: { video: false } },
    });
    expect(res.status).toBe(200);
    const saved = await json(res);
    expect(saved.attachments.enabled).toBe(false);
    expect(saved.attachments.gcDays).toBe(7);
    // Незаданные поля — из дефолтов; вложенный merge с дефолтами.
    expect(saved.attachments.modalities).toEqual({
      image: true,
      pdf: true,
      audio: true,
      video: false,
    });
    expect(saved.isOverridden).toBe(true);
    expect(saved.source).toBe('runtime');
    expect(saved.restartRequired).toBe(false);
    // Живое состояние применилось без рестарта.
    expect(live.getConfig().enabled).toBe(false);
    expect(live.getConfig().gcDays).toBe(7);
    expect(live.getConfig().modalities.video).toBe(false);

    // PUT заменяет секцию целиком (как остальные `/settings/*`): патч — это
    // новое runtime-значение, незаданные поля возвращаются к config/default.
    const second = await json(await put(app, { attachments: { maxFilesPerMessage: 2 } }));
    expect(second.attachments.maxFilesPerMessage).toBe(2);
    expect(second.attachments.enabled).toBe(true);
    expect(second.attachments.modalities.video).toBe(true);

    // Аудит: scope/action записи.
    expect(audit.entries).toHaveLength(2);
    expect(audit.entries[0]).toMatchObject({ scope: 'attachments', action: 'update', source: 'runtime' });
  });

  it('PUT переживает рестарт процесса (порт настроек)', async () => {
    const { app } = createApp({ dataDir, env: {} });
    await put(app, { attachments: { enabled: false } });

    const restartedStore = new RuntimeSettingsStore({ dataDir });
    expect((await restartedStore.getAttachments()).enabled).toBe(false);
  });

  it('DELETE: сброс runtime к config/default', async () => {
    const audit = createAudit();
    const { app, live } = createApp({
      dataDir,
      audit,
      config: { maxFilesPerMessage: 4 },
      env: {},
    });

    await put(app, { attachments: { enabled: false } });
    const restored = await json(await app.request('/api/v2/settings/attachments', { method: 'DELETE' }));
    expect(restored.attachments.enabled).toBe(true);
    expect(restored.attachments.maxFilesPerMessage).toBe(4);
    expect(restored.isOverridden).toBe(false);
    expect(restored.source).toBe('config');
    expect(restored.restartRequired).toBe(false);
    expect(live.getConfig().enabled).toBe(true);

    expect(audit.entries.some((e) => e.scope === 'attachments' && e.action === 'reset')).toBe(true);
  });

  it('PUT: валидация полей → 400 VALIDATION_ERROR', async () => {
    const { app } = createApp({ dataDir, env: {} });
    const invalid = [
      {},
      { attachments: true },
      { attachments: { enabled: 'yes' } },
      { attachments: { maxBytesPerFile: 0 } },
      { attachments: { maxFilesPerMessage: 1.5 } },
      { attachments: { gcDays: -1 } },
      { attachments: { modalities: { image: 'no' } } },
      { attachments: { allowedMimePrefixes: ['image/', ''] } },
    ];
    for (const body of invalid) {
      const res = await put(app, body);
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('PUT: неизвестные ключи игнорируются', async () => {
    const { app } = createApp({ dataDir, env: {} });
    const saved = await json(await put(app, { attachments: { unknown: 1, gcDays: 3 } }));
    expect(saved.attachments.gcDays).toBe(3);
    expect(saved.attachments).not.toHaveProperty('unknown');
  });

  it('env-поле: GET отдаёт envLocked + source=env, PUT другим значением → 409', async () => {
    const env = { SYNTH_ATTACHMENTS_ENABLED: 'false' };
    const { app } = createApp({ dataDir, env });

    const view = await json(await app.request('/api/v2/settings/attachments'));
    expect(view.source).toBe('env');
    expect(view.envLocked).toEqual(['enabled']);
    expect(view.attachments.enabled).toBe(false);
    // `defaults` — база config/default (без env): показывает, что зафиксировано env.
    expect(view.defaults.enabled).toBe(true);

    // Иное значение → конфликт.
    const conflict = await put(app, { attachments: { enabled: true } });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error.code).toBe('CONFLICT');

    // То же значение (идемпотентно) — не конфликт.
    const same = await put(app, { attachments: { enabled: false } });
    expect(same.status).toBe(200);

    // Поле не из env — меняется свободно.
    const free = await put(app, { attachments: { gcDays: 1 } });
    expect(free.status).toBe(200);
    expect((await json(free)).attachments.gcDays).toBe(1);
  });

  it('envLocked.modalities: PUT modalities другим значением → 409', async () => {
    const { app } = createApp({ dataDir, env: { SYNTH_ATTACHMENTS_MODALITIES: 'image,pdf' } });
    const view = await json(await app.request('/api/v2/settings/attachments'));
    expect(view.envLocked).toEqual(['modalities']);
    expect(view.attachments.modalities).toEqual({
      image: true,
      pdf: true,
      audio: false,
      video: false,
    });

    const conflict = await put(app, { attachments: { modalities: { image: true } } });
    expect(conflict.status).toBe(409);
  });

  it('guard: read/write разделены (readGuard/writeGuard)', async () => {
    const readDenied = createApp({ dataDir, readGuard: deny, env: {} });
    expect((await readDenied.app.request('/api/v2/settings/attachments')).status).toBe(403);

    const writeDenied = createApp({ dataDir, writeGuard: deny, env: {} });
    expect((await writeDenied.app.request('/api/v2/settings/attachments')).status).toBe(200);
    expect((await put(writeDenied.app, { attachments: { gcDays: 1 } })).status).toBe(403);
    expect(
      (await writeDenied.app.request('/api/v2/settings/attachments', { method: 'DELETE' })).status,
    ).toBe(403);
  });

  it('аудит недоступен (ошибка записи) — операция всё равно успешна', async () => {
    const failingAudit: SecurityAuditRepository = {
      append: async () => { throw new Error('audit down'); },
      list: async () => [],
      clear: async () => 0,
    };
    const { app } = createApp({ dataDir, audit: failingAudit, env: {} });
    expect((await put(app, { attachments: { gcDays: 2 } })).status).toBe(200);
  });
});
