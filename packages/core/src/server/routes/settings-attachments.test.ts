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
import {
  createAttachmentsSettingsRoutes,
  type ModalityModelLookup,
} from './settings-attachments.js';

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
  /** Каталог моделей для проверки `modalityModels` (ADR-115). */
  lookupModel?: ModalityModelLookup;
  writeGuard?: (c: Context, next: Next) => Promise<Response | void>;
  readGuard?: (c: Context, next: Next) => Promise<Response | void>;
}

/**
 * Каталог в памяти: провайдер → модель → модальности (`undefined` — неизвестны,
 * как если модель ещё не синхронизирована через `POST /models/fetch`).
 */
function createCatalog(
  providers: Record<string, Record<string, string[] | undefined>>,
): ModalityModelLookup {
  return async (provider, model) => {
    const models = providers[provider];
    if (!models) return { found: false, reason: 'provider' };
    if (!(model in models)) return { found: false, reason: 'model' };
    return { found: true, modalities: models[model] };
  };
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
      ...(options.lookupModel ? { lookupModel: options.lookupModel } : {}),
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
      allowedMimePrefixes: ['image/', 'audio/', 'video/', 'application/pdf', 'text/'],
      workspaceFallback: true,
      modalityModels: {},
      gcDays: 30,
    });
    expect(body.defaults).toEqual(body.attachments);
    // ADR-115: сохранённого runtime-патча нет.
    expect(body.saved).toEqual({});
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
  // --- ADR-115: модели обработки по модальностям (aux-модели) ---

  it('PUT modalityModels: валидная модель сохраняется, живой резолвер её видит', async () => {
    const catalog = createCatalog({ openai: { 'gpt-4o': ['text', 'image'] } });
    const { app, live } = createApp({ dataDir, lookupModel: catalog, env: {} });

    const res = await put(app, {
      attachments: { modalityModels: { image: { provider: 'openai', model: 'gpt-4o' } } },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.attachments.modalityModels).toEqual({
      image: { provider: 'openai', model: 'gpt-4o' },
    });
    // `saved` — сохранённый runtime-патч (как есть).
    expect(body.saved.modalityModels).toEqual({ image: { provider: 'openai', model: 'gpt-4o' } });
    expect(body.source).toBe('runtime');
    expect(live.getConfig().modalityModels).toEqual({
      image: { provider: 'openai', model: 'gpt-4o' },
    });

    // Настройки вложений при этом не меняются.
    expect(body.attachments.enabled).toBe(true);
    expect(body.attachments.modalities).toEqual({ image: true, pdf: true, audio: true, video: true });
  });

  it('PUT modalityModels: runtime дополняет config, null снимает запись семейства', async () => {
    const catalog = createCatalog({
      openai: { 'gpt-4o': ['text', 'image'] },
      local: { whisper: ['text', 'audio'] },
    });
    const { app } = createApp({
      dataDir,
      lookupModel: catalog,
      config: {
        modalityModels: {
          image: { provider: 'openai', model: 'gpt-4o' },
          pdf: { provider: 'openai', model: 'gpt-4o' },
        },
      },
      env: {},
    });

    // Добавляем audio — image/pdf из config остаются.
    const added = await json(await put(app, {
      attachments: { modalityModels: { audio: { provider: 'local', model: 'whisper' } } },
    }));
    expect(added.attachments.modalityModels).toEqual({
      image: { provider: 'openai', model: 'gpt-4o' },
      pdf: { provider: 'openai', model: 'gpt-4o' },
      audio: { provider: 'local', model: 'whisper' },
    });

    // `null` снимает семейство (в т.ч. заданное в config).
    const removed = await json(await put(app, {
      attachments: { modalityModels: { image: null } },
    }));
    expect(removed.attachments.modalityModels).toEqual({
      pdf: { provider: 'openai', model: 'gpt-4o' },
    });
    expect(removed.saved.modalityModels).toEqual({ image: null });
  });

  it('PUT modalityModels: пустой объект — эквивалент null (снять настройку)', async () => {
    const catalog = createCatalog({ openai: { 'gpt-4o': ['text', 'image'] } });
    const { app } = createApp({
      dataDir,
      lookupModel: catalog,
      config: { modalityModels: { image: { provider: 'openai', model: 'gpt-4o' } } },
      env: {},
    });
    const body = await json(await put(app, { attachments: { modalityModels: { image: {} } } }));
    expect(body.attachments.modalityModels).toEqual({});
    expect(body.saved.modalityModels).toEqual({ image: null });
  });

  it('PUT modalityModels: неизвестный провайдер → 400, запись не меняется', async () => {
    const catalog = createCatalog({ openai: { 'gpt-4o': ['text', 'image'] } });
    const { app, live } = createApp({ dataDir, lookupModel: catalog, env: {} });

    const ok = await put(app, {
      attachments: { modalityModels: { image: { provider: 'openai', model: 'gpt-4o' } } },
    });
    expect(ok.status).toBe(200);

    const res = await put(app, {
      attachments: { modalityModels: { audio: { provider: 'ghost', model: 'x' } } },
    });
    expect(res.status).toBe(400);
    const err = (await json(res)).error;
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toContain('modalityModels.audio');
    expect(err.message).toContain('провайдер "ghost" не найден');

    // Частичной записи нет: и runtime, и живой резолвер — прежние.
    const view = await json(await app.request('/api/v2/settings/attachments'));
    expect(view.saved.modalityModels).toEqual({ image: { provider: 'openai', model: 'gpt-4o' } });
    expect(live.getConfig().modalityModels).toEqual({ image: { provider: 'openai', model: 'gpt-4o' } });
  });

  it('PUT modalityModels: неизвестная модель → 400 с ключом provider/model', async () => {
    const catalog = createCatalog({ openai: { 'gpt-4o': ['text', 'image'] } });
    const { app } = createApp({ dataDir, lookupModel: catalog, env: {} });
    const res = await put(app, {
      attachments: { modalityModels: { image: { provider: 'openai', model: 'ghost-vision' } } },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toContain('модель "openai/ghost-vision" не найдена');
  });

  it('PUT modalityModels: модель не принимает модальность → 400 со списком её модальностей', async () => {
    const catalog = createCatalog({ openai: { 'gpt-3.5-turbo': ['text', 'pdf'] } });
    const { app, live } = createApp({ dataDir, lookupModel: catalog, env: {} });
    const res = await put(app, {
      attachments: { modalityModels: { image: { provider: 'openai', model: 'gpt-3.5-turbo' } } },
    });
    expect(res.status).toBe(400);
    const message = (await json(res)).error.message;
    expect(message).toContain('modalityModels.image');
    expect(message).toContain('openai/gpt-3.5-turbo');
    expect(message).toContain('не принимает модальность image');
    expect(message).toContain('text, pdf');
    // Ничего не записали.
    expect(live.getConfig().modalityModels).toEqual({});
  });

  it('PUT modalityModels: модальности модели неизвестны → 400 с просьбой синхронизировать каталог', async () => {
    const catalog = createCatalog({ openai: { 'gpt-4o': undefined } });
    const { app } = createApp({ dataDir, lookupModel: catalog, env: {} });
    const res = await put(app, {
      attachments: { modalityModels: { image: { provider: 'openai', model: 'gpt-4o' } } },
    });
    expect(res.status).toBe(400);
    const message = (await json(res)).error.message;
    expect(message).toContain('неизвестны модальности');
    expect(message).toContain('POST /api/v2/models/fetch');
  });

  it('PUT modalityModels: ошибки формата → 400 (неизвестная модальность, пустой ref)', async () => {
    const catalog = createCatalog({ openai: { 'gpt-4o': ['text', 'image'] } });
    const { app } = createApp({ dataDir, lookupModel: catalog, env: {} });

    const invalid = [
      { attachments: { modalityModels: true } },
      { attachments: { modalityModels: { text: { provider: 'openai', model: 'gpt-4o' } } } },
      { attachments: { modalityModels: { image: 'gpt-4o' } } },
      { attachments: { modalityModels: { image: { provider: 'openai', model: '' } } } },
    ];
    for (const body of invalid) {
      const res = await put(app, body);
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('DELETE сбрасывает и modalityModels (возврат к config)', async () => {
    const catalog = createCatalog({
      openai: { 'gpt-4o': ['text', 'image'] },
      local: { whisper: ['text', 'audio'] },
    });
    const { app, live } = createApp({
      dataDir,
      lookupModel: catalog,
      config: { modalityModels: { image: { provider: 'openai', model: 'gpt-4o' } } },
      env: {},
    });

    await put(app, { attachments: { modalityModels: { audio: { provider: 'local', model: 'whisper' } } } });
    expect(live.getConfig().modalityModels).toEqual({
      image: { provider: 'openai', model: 'gpt-4o' },
      audio: { provider: 'local', model: 'whisper' },
    });

    const restored = await json(await app.request('/api/v2/settings/attachments', { method: 'DELETE' }));
    expect(restored.attachments.modalityModels).toEqual({
      image: { provider: 'openai', model: 'gpt-4o' },
    });
    expect(restored.saved).toEqual({});
    expect(live.getConfig().modalityModels).toEqual({
      image: { provider: 'openai', model: 'gpt-4o' },
    });
  });

  it('аудит: в before/after попадает modalityModels', async () => {
    const catalog = createCatalog({ openai: { 'gpt-4o': ['text', 'image'] } });
    const audit = createAudit();
    const { app } = createApp({ dataDir, lookupModel: catalog, audit, env: {} });
    await put(app, {
      attachments: { modalityModels: { image: { provider: 'openai', model: 'gpt-4o' } } },
    });

    const entry = audit.entries[0] as {
      before: { modalityModels?: unknown };
      after: { modalityModels?: unknown };
    };
    expect(entry.after.modalityModels).toEqual({ image: { provider: 'openai', model: 'gpt-4o' } });
    expect(entry.before.modalityModels).toEqual({});
  });
});
