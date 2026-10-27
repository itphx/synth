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
    allowedMimePrefixes: ['image/', 'audio/', 'application/pdf', 'text/'],
    workspaceFallback: true,
    gcDays: 30,
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
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('413 PAYLOAD_TOO_LARGE: файл больше maxBytesPerFile', async () => {
    const { app } = createHarness({ config: { maxBytesPerFile: 32 } });
    const res = await upload(app, pngBytes());

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
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

  it('400 VALIDATION_ERROR: тело не multipart', async () => {
    const { app } = createHarness();
    const res = await app.request('/api/v2/attachments', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'нет файла',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
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
});
