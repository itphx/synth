/**
 * ADR-115: staging-загрузка без сессии — `POST /api/v2/attachments`.
 *
 * Проверяется корневой контур (не `/sessions/:id/...`): метаданные ответа,
 * отсутствие требования сессии, ранние лимиты (`content-length` и фактический
 * размер), коды `413`/`415`/`400`, дедуп по сырым байтам.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachmentsConfig } from '@itphx/synth-shared';
import { defaultConfig } from '@itphx/synth-shared';
import { FileBlobStore } from '../../storage/file-blob-store.js';
import { AttachmentService } from '../../engine/attachments/service.js';
import {
  createStagingAttachmentRoutes,
  type StagingAttachmentAuditInfo,
  type StagingAttachmentRoutesAuth,
} from './attachments-staging.js';
import { MULTIPART_OVERHEAD_BYTES } from './attachments.js';

/** Мок auth: requireAuth — no-op (тест контура, не аутентификации). */
function createMockAuth(): StagingAttachmentRoutesAuth {
  return {
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  };
}

function attachmentsConfig(overrides: Partial<AttachmentsConfig> = {}): AttachmentsConfig {
  return {
    enabled: true,
    modalities: { image: true, pdf: true, audio: true, video: true },
    maxBytesPerFile: 1024 * 1024,
    maxFilesPerMessage: 10,
    maxBytesPerSession: 10 * 1024 * 1024,
    allowedMimePrefixes: ['image/', 'audio/', 'video/', 'application/pdf', 'text/'],
    workspaceFallback: true,
    gcDays: 30,
    // ADR-115: сжатие/миниатюры/chunked-загрузка — дефолты схемы.
    compression: defaultConfig.attachments.compression,
    thumbnail: defaultConfig.attachments.thumbnail,
    maxChunkBytes: defaultConfig.attachments.maxChunkBytes,
    maxActiveUploadsPerSession: defaultConfig.attachments.maxActiveUploadsPerSession,
    maxActiveUploads: defaultConfig.attachments.maxActiveUploads,
    ...overrides,
  };
}

/** PNG-чанк (CRC-заглушка: парсер не вызывается — байты хранятся как есть). */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

function pngBytes(fill = 1): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.alloc(13, fill)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

interface HarnessOptions {
  config?: Partial<AttachmentsConfig>;
  configResolver?: () => AttachmentsConfig;
  audit?: (info: StagingAttachmentAuditInfo) => void | Promise<void>;
  /** Переопределить auth (проверка, что `requireAuth` реально навешан). */
  auth?: StagingAttachmentRoutesAuth;
  /** Дополнительный guard (backend — scope service-key). */
  guard?: StagingAttachmentRoutesAuth['requireAuth'];
}

describe('HTTP: staging-загрузка вложений (ADR-115)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-attachment-staging-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createHarness(options: HarnessOptions = {}) {
    const app = new Hono();
    const blobs = new FileBlobStore({ root: join(tmpDir, 'blobs') });
    const config = options.configResolver ?? attachmentsConfig(options.config);
    const service = new AttachmentService({ blobs, config });
    app.route('/api/v2/attachments', createStagingAttachmentRoutes(
      options.auth ?? createMockAuth(),
      {
        service,
        config,
        ...(options.audit ? { audit: options.audit } : {}),
      },
      options.guard ? { guard: options.guard } : {},
    ));
    return { app, blobs, service };
  }

  /** Загрузить файл через HTTP (multipart, поле `file`). */
  async function upload(
    app: Hono,
    bytes: Buffer,
    name = 'photo.png',
    type = 'image/png',
  ): Promise<Response> {
    const form = new FormData();
    form.set('file', new File([new Uint8Array(bytes)], name, { type }));
    form.set('name', name);
    return app.request('/api/v2/attachments', { method: 'POST', body: form });
  }

  it('201: метаданные вложения без сессии', async () => {
    const { app, blobs } = createHarness();
    const res = await upload(app, pngBytes());

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string; blobPath: string; sha256: string; mime: string; size: number; name?: string;
    };
    expect(body.id).toBe(body.blobPath);
    expect(body.blobPath.startsWith('attachments/')).toBe(true);
    expect(body.mime).toBe('image/png');
    expect(body.name).toBe('photo.png');
    expect(body.size).toBe(pngBytes().length);
    expect(await blobs.exists(body.blobPath)).toBe(true);
  });

  it('дедуп: две загрузки одних байтов — один blob', async () => {
    const { app, blobs } = createHarness();
    const first = (await (await upload(app, pngBytes())).json()) as { blobPath: string };
    const second = (await (await upload(app, pngBytes(), 'copy.png')).json()) as { blobPath: string };

    expect(second.blobPath).toBe(first.blobPath);
    const entries = await blobs.list('attachments');
    expect(entries.filter((entry) => !entry.path.endsWith('.json'))).toHaveLength(1);
  });

  it('413 PAYLOAD_TOO_LARGE: ранняя проверка по content-length', async () => {
    const { app } = createHarness();
    const res = await app.request('/api/v2/attachments', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=staging',
        'content-length': String(1024 * 1024 + MULTIPART_OVERHEAD_BYTES + 1),
      },
      body: '--staging--',
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      error: { code: string; details?: { maxBytesPerFile?: number } };
    };
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    // ADR-115: фактический предел инстанса — в error.details.
    expect(body.error.details?.maxBytesPerFile).toBe(1024 * 1024);
  });

  it('413 PAYLOAD_TOO_LARGE: файл больше maxBytesPerFile', async () => {
    const { app } = createHarness({ config: { maxBytesPerFile: 32 } });
    const res = await upload(app, pngBytes());

    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      error: { code: string; details?: { maxBytesPerFile?: number } };
    };
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.error.details?.maxBytesPerFile).toBe(32);
  });

  it('415 attachments_disabled: мастер-выключатель вложений', async () => {
    const { app } = createHarness({ config: { enabled: false } });
    const res = await upload(app, pngBytes());

    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('attachments_disabled');
  });

  it('415 UNSUPPORTED_MEDIA_TYPE: MIME вне белого списка', async () => {
    const { app } = createHarness({ config: { allowedMimePrefixes: ['image/'] } });
    const res = await upload(app, Buffer.from('просто текст'), 'note.txt', 'text/plain');

    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('400 VALIDATION_ERROR: в multipart нет поля file', async () => {
    const { app } = createHarness();
    const form = new FormData();
    form.set('name', 'photo.png');
    const res = await app.request('/api/v2/attachments', { method: 'POST', body: form });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('raw-body: тело не multipart — файл (ADR-115 этап B1)', async () => {
    const { app } = createHarness();
    const res = await app.request('/api/v2/attachments', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'нет файла',
    });

    // Multipart больше не обязателен: тело запроса трактуется как сам файл.
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mime: string; size: number };
    expect(body.mime).toBe('text/plain');
    expect(body.size).toBe(Buffer.byteLength('нет файла'));
  });

  it('401 UNAUTHORIZED: requireAuth навешан на staging-роут', async () => {
    const { app } = createHarness({
      auth: {
        requireAuth: async (c) => c.json({ error: { code: 'UNAUTHORIZED' } }, 401),
      },
    });
    const res = await upload(app, pngBytes());
    expect(res.status).toBe(401);
  });

  it('403 SCOPE_REQUIRED: дополнительный guard (service-key scope) применяется', async () => {
    const { app } = createHarness({
      guard: async (c) => c.json({ error: { code: 'SCOPE_REQUIRED' } }, 403),
    });
    const res = await upload(app, pngBytes());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SCOPE_REQUIRED');
  });

  it('аудит вызывается после успешной загрузки (best-effort)', async () => {    const seen: StagingAttachmentAuditInfo[] = [];
    const { app } = createHarness({ audit: (info) => { seen.push(info); } });
    const res = await upload(app, pngBytes());

    expect(res.status).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.meta.mime).toBe('image/png');
  });

  it('ошибка аудита не отменяет загруженный объект', async () => {
    const { app } = createHarness({ audit: () => { throw new Error('audit down'); } });
    const res = await upload(app, pngBytes());

    expect(res.status).toBe(201);
  });

  describe('POST /api/v2/attachments — raw-body (ADR-115 этап B1)', () => {
    /** Прямая raw-загрузка: тело запроса — сам файл (не multipart). */
    async function uploadRaw(
      app: Hono,
      bytes: Buffer,
      opts: { name?: string; mime?: string | null; headers?: Record<string, string> } = {},
    ): Promise<Response> {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.mime !== null) headers['content-type'] = opts.mime ?? 'application/octet-stream';
      const query = opts.name ? `?name=${encodeURIComponent(opts.name)}` : '';
      return app.request(`/api/v2/attachments${query}`, {
        method: 'POST',
        headers,
        body: new Uint8Array(bytes),
      });
    }

    it('201: метаданные без сессии, MIME по сигнатуре', async () => {
      const { app, blobs } = createHarness();
      const res = await uploadRaw(app, pngBytes(), {
        name: 'фото.png',
        mime: 'application/octet-stream',
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string; blobPath: string; sha256: string; mime: string; size: number; name?: string;
      };
      expect(body.id).toBe(body.blobPath);
      expect(body.mime).toBe('image/png');
      expect(body.name).toBe('фото.png');
      expect(body.blobPath.startsWith('attachments/')).toBe(true);
      expect(await blobs.exists(body.blobPath)).toBe(true);
    });

    it('201: имя из x-file-name (percent-encoding), без content-type', async () => {
      const { app } = createHarness();
      const res = await uploadRaw(app, pngBytes(2), {
        mime: null,
        headers: { 'x-file-name': encodeURIComponent('снимок.png') },
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { name?: string; mime: string };
      expect(body.name).toBe('снимок.png');
      expect(body.mime).toBe('image/png');
    });

    it('дедуп с multipart: одни байты — один объект', async () => {
      const { app, blobs } = createHarness();
      const first = (await (await upload(app, pngBytes())).json()) as { blobPath: string };
      const second = (await (
        await uploadRaw(app, pngBytes(), { name: 'copy.png' })
      ).json()) as { blobPath: string };

      expect(second.blobPath).toBe(first.blobPath);
      const entries = await blobs.list('attachments');
      expect(entries.filter((entry) => !entry.path.endsWith('.json'))).toHaveLength(1);
    });

    it('400 VALIDATION_ERROR: тело отсутствует', async () => {
      const { app } = createHarness();
      const res = await app.request('/api/v2/attachments', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('400 VALIDATION_ERROR: пустой поток', async () => {
      const { app } = createHarness();
      const res = await uploadRaw(app, Buffer.alloc(0));

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('413: content-length больше предела (до чтения тела)', async () => {
      const { app } = createHarness({ config: { maxBytesPerFile: 32 } });
      const res = await uploadRaw(app, pngBytes(), { headers: { 'content-length': '1000' } });

      expect(res.status).toBe(413);
      const body = (await res.json()) as {
        error: { code: string; details?: { maxBytesPerFile?: number } };
      };
      expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(body.error.details?.maxBytesPerFile).toBe(32);
    });

    it('413: поток больше предела обрывается по ходу', async () => {
      const { app, blobs } = createHarness({ config: { maxBytesPerFile: 32 } });
      const res = await uploadRaw(app, Buffer.concat([pngBytes(), Buffer.alloc(64, 1)]));

      expect(res.status).toBe(413);
      expect(await blobs.list('attachments')).toEqual([]);
    });

    it('415 UNSUPPORTED_MEDIA_TYPE: SVG отклоняется по сигнатуре', async () => {
      const { app, blobs } = createHarness();
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      const res = await uploadRaw(app, svg, { name: 'pic.svg', mime: 'image/png' });

      expect(res.status).toBe(415);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(await blobs.list('attachments')).toEqual([]);
    });

    it('аудит вызывается и для raw-загрузки', async () => {
      const seen: StagingAttachmentAuditInfo[] = [];
      const { app } = createHarness({ audit: (info) => { seen.push(info); } });
      const res = await uploadRaw(app, pngBytes());

      expect(res.status).toBe(201);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.meta.mime).toBe('image/png');
    });
  });

  describe('GET /api/v2/attachments/:sha256 — раздача по sha (outbound шлюзов)', () => {
    /** Загрузить байты и вернуть их sha256 + blobPath. */
    async function uploadedSha(app: Hono, bytes = pngBytes()): Promise<{ sha256: string; blobPath: string }> {
      const res = await upload(app, bytes);
      expect(res.status).toBe(201);
      return (await res.json()) as { sha256: string; blobPath: string };
    }

    it('200: байты, Content-Type и Content-Length по существующему sha', async () => {
      const { app } = createHarness();
      const { sha256 } = await uploadedSha(app);

      const res = await app.request(`/api/v2/attachments/${sha256}`);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('content-length')).toBe(String(pngBytes().length));
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(Buffer.from(await res.arrayBuffer())).toEqual(pngBytes());
    });

    it('sha в верхнем регистре нормализуется (адресация content-addressed)', async () => {
      const { app } = createHarness();
      const { sha256 } = await uploadedSha(app);

      const res = await app.request(`/api/v2/attachments/${sha256.toUpperCase()}`);

      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(pngBytes());
    });

    it('HEAD: те же заголовки без тела', async () => {
      const { app } = createHarness();
      const { sha256 } = await uploadedSha(app);

      const res = await app.request(`/api/v2/attachments/${sha256}`, { method: 'HEAD' });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('content-length')).toBe(String(pngBytes().length));
      expect(await res.text()).toBe('');
    });

    it('404 NOT_FOUND: неизвестный (но валидный по форме) sha', async () => {
      const { app } = createHarness();

      const res = await app.request(`/api/v2/attachments/${'a'.repeat(64)}`);

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('404 NOT_FOUND: не-hex и неполный sha — объект не ищется', async () => {
      const { app } = createHarness();

      for (const bad of ['zz', 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
        const res = await app.request(`/api/v2/attachments/${bad}`);
        expect(res.status, `sha=${bad}`).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code, `sha=${bad}`).toBe('NOT_FOUND');
      }
    });

    it('404 NOT_FOUND: произвольный blob вне контура вложений не раздаётся', async () => {
      const { app, blobs } = createHarness();
      // Объект лежит вне `attachments/`, но его sha всё равно запрашивается
      // по адресу вложений — контур ограничен каталогом.
      const sha256 = 'b'.repeat(64);
      await blobs.write(`logs/${sha256}`, Buffer.from('секрет'));

      const res = await app.request(`/api/v2/attachments/${sha256}`);

      expect(res.status).toBe(404);
    });

    it('401 UNAUTHORIZED: гейт покрывает и раздачу по sha', async () => {
      const { app } = createHarness({
        auth: { requireAuth: async (c) => c.json({ error: { code: 'UNAUTHORIZED' } }, 401) },
      });

      const res = await app.request(`/api/v2/attachments/${'a'.repeat(64)}`);

      expect(res.status).toBe(401);
    });

    it('403 SCOPE_REQUIRED: scope-гейт service-key покрывает раздачу', async () => {
      const { app } = createHarness({
        guard: async (c) => c.json({ error: { code: 'SCOPE_REQUIRED' } }, 403),
      });

      const res = await app.request(`/api/v2/attachments/${'a'.repeat(64)}`);

      expect(res.status).toBe(403);
    });
  });
});
