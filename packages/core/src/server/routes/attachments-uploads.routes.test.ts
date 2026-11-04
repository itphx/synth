/**
 * ADR-115 (B2a): HTTP-контур chunked-загрузки — инициализация, части,
 * завершение и отмена (контур сессии и staging-контур).
 *
 * Проверяются коды/форматы: 201 init/complete, 200 часть, 204 отмена, а также
 * 404/400/413/415 и аудит staging-контура.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachmentsConfig, Session } from '@itphx/synth-shared';
import { defaultConfig } from '@itphx/synth-shared';
import { FileBlobStore } from '../../storage/file-blob-store.js';
import { AttachmentService } from '../../engine/attachments/service.js';
import {
  UploadSessionError,
  type UploadSessionStore,
} from '../../engine/attachments/uploads.js';
import type { SessionManager } from '../../sessions/manager.js';
import { createAttachmentRoutes } from './attachments.js';
import {
  createStagingAttachmentRoutes,
  type StagingAttachmentAuditInfo,
  type StagingAttachmentRoutesAuth,
} from './attachments-staging.js';

function attachmentsConfig(overrides: Partial<AttachmentsConfig> = {}): AttachmentsConfig {
  return {
    enabled: true,
    modalities: { image: true, pdf: true, audio: true, video: true },
    maxBytesPerFile: 1024,
    maxFilesPerMessage: 10,
    maxBytesPerSession: 10 * 1024 * 1024,
    allowedMimePrefixes: ['image/', 'audio/', 'video/', 'application/pdf', 'text/'],
    workspaceFallback: true,
    gcDays: 30,
    compression: defaultConfig.attachments.compression,
    thumbnail: defaultConfig.attachments.thumbnail,
    maxChunkBytes: 64,
    maxActiveUploadsPerSession: 16,
    maxActiveUploads: 256,
    ...overrides,
  };
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

function pngBytes(fill = 1, pad = 0): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.alloc(13, fill)),
    pngChunk('IEND', Buffer.alloc(pad)),
  ]);
}

const mockAuth: StagingAttachmentRoutesAuth = {
  requireAuth: async (_c: Context, next: Next) => {
    await next();
  },
};

describe('HTTP: chunked-загрузка вложений (B2a)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-attachment-upload-routes-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createService(config: AttachmentsConfig): { service: AttachmentService; blobs: FileBlobStore } {
    const blobs = new FileBlobStore({ root: join(tmpDir, 'blobs') });
    return { service: new AttachmentService({ blobs, config }), blobs };
  }

  function sessionApp(service: AttachmentService, session: Session | null): Hono {
    const app = new Hono();
    const sessionManager = {
      getSession: async (id: string) => (session && id === session.id ? session : null),
    } as unknown as SessionManager;
    app.route('/', createAttachmentRoutes({ sessionManager, service, config: service.config }));
    return app;
  }

  function stagingApp(service: AttachmentService, audit?: (info: StagingAttachmentAuditInfo) => void): Hono {
    const app = new Hono();
    app.route(
      '/api/v2/attachments',
      createStagingAttachmentRoutes(
        mockAuth,
        { service, config: service.config, ...(audit ? { audit } : {}) },
      ),
    );
    return app;
  }

  async function init(
    app: Hono,
    base: string,
    body: Record<string, unknown> = { name: 'photo.png', mime: 'image/png' },
  ): Promise<Response> {
    return app.request(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function putChunk(
    app: Hono,
    url: string,
    offset: number,
    bytes: Buffer,
  ): Promise<Response> {
    return app.request(`${url}?offset=${offset}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    });
  }

  /** Полный цикл: init → 2 части → complete; возвращает метаданные вложения. */
  async function uploadInChunks(
    app: Hono,
    base: string,
    bytes: Buffer,
  ): Promise<{ id: string; blobPath: string; sha256: string; mime: string; size: number }> {
    const initRes = await init(app, base);
    expect(initRes.status).toBe(201);
    const { uploadId, maxChunkBytes } = (await initRes.json()) as {
      uploadId: string;
      maxChunkBytes: number;
    };
    expect(maxChunkBytes).toBe(64);

    const split = Math.min(50, bytes.length);
    const first = await putChunk(app, `${base}/${uploadId}`, 0, bytes.subarray(0, split));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: split, nextOffset: split });

    const second = await putChunk(
      app,
      `${base}/${uploadId}`,
      split,
      bytes.subarray(split),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      received: bytes.length,
      nextOffset: bytes.length,
    });

    const done = await app.request(`${base}/${uploadId}/complete`, { method: 'POST' });
    expect(done.status).toBe(201);
    return (await done.json()) as {
      id: string;
      blobPath: string;
      sha256: string;
      mime: string;
      size: number;
    };
  }

  describe('контур сессии (/:id/attachments/uploads)', () => {
    const base = '/s1/attachments/uploads';

    it('полный цикл: init → 2 части → complete, объект в blob', async () => {
      const config = attachmentsConfig();
      const { service, blobs } = createService(config);
      const session = { id: 's1', messages: [] } as unknown as Session;
      const app = sessionApp(service, session);

      const bytes = pngBytes(1, 40);
      const meta = await uploadInChunks(app, base, bytes);

      expect(meta.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(meta.mime).toBe('image/png');
      expect(meta.size).toBe(bytes.length);
      expect(meta.id).toBe(meta.blobPath);
      expect(await blobs.exists(meta.blobPath)).toBe(true);
      expect(await blobs.list('attachments/.uploads')).toHaveLength(0);
    });

    it('404: неизвестная сессия загрузки', async () => {
      const { service } = createService(attachmentsConfig());
      const app = sessionApp(service, { id: 's1', messages: [] } as unknown as Session);

      const res = await upChunk(app, `${base}/missing`, 0, Buffer.from('x'));
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');

      const done = await app.request(`${base}/missing/complete`, { method: 'POST' });
      expect(done.status).toBe(404);
    });

    it('404: сессии нет (guard-эквивалент в фабрике)', async () => {
      const { service } = createService(attachmentsConfig());
      const app = sessionApp(service, null);
      const res = await init(app, base);
      expect(res.status).toBe(404);
    });

    it('400: offset не совпал с принятым объёмом', async () => {
      const { service } = createService(attachmentsConfig());
      const app = sessionApp(service, { id: 's1', messages: [] } as unknown as Session);
      const initRes = await init(app, base);
      const { uploadId } = (await initRes.json()) as { uploadId: string };

      await putChunk(app, `${base}/${uploadId}`, 0, Buffer.from('abc'));
      const res = await putChunk(app, `${base}/${uploadId}`, 5, Buffer.from('x'));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('413: часть больше maxChunkBytes (content-length и факт)', async () => {
      const { service } = createService(attachmentsConfig());
      const app = sessionApp(service, { id: 's1', messages: [] } as unknown as Session);
      const initRes = await init(app, base);
      const { uploadId } = (await initRes.json()) as { uploadId: string };

      const res = await putChunk(app, `${base}/${uploadId}`, 0, Buffer.alloc(65, 1));
      expect(res.status).toBe(413);
      const body = (await res.json()) as {
        error: { code: string; details?: { maxChunkBytes?: number } };
      };
      expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(body.error.details?.maxChunkBytes).toBe(64);
    });

    it('413: суммарно больше maxBytesPerFile', async () => {
      const { service } = createService(
        attachmentsConfig({ maxBytesPerFile: 100, maxChunkBytes: 64 }),
      );
      const app = sessionApp(service, { id: 's1', messages: [] } as unknown as Session);
      const initRes = await init(app, base);
      const { uploadId } = (await initRes.json()) as { uploadId: string };

      expect((await putChunk(app, `${base}/${uploadId}`, 0, Buffer.alloc(60, 1))).status).toBe(200);
      const res = await putChunk(app, `${base}/${uploadId}`, 60, Buffer.alloc(60, 1));
      expect(res.status).toBe(413);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('413: квота сессии по активным chunked-загрузкам', async () => {
      const { service } = createService(
        attachmentsConfig({ maxBytesPerFile: 1000, maxBytesPerSession: 100, maxChunkBytes: 64 }),
      );
      const app = sessionApp(service, { id: 's1', messages: [] } as unknown as Session);
      const first = (await (await init(app, base)).json()) as { uploadId: string };
      const second = (await (await init(app, base)).json()) as { uploadId: string };

      expect(
        (await putChunk(app, `${base}/${first.uploadId}`, 0, Buffer.alloc(60, 1))).status,
      ).toBe(200);
      const res = await putChunk(
        app,
        `${base}/${second.uploadId}`,
        0,
        Buffer.alloc(60, 1),
      );
      expect(res.status).toBe(413);
      const body = (await res.json()) as {
        error: { code: string; details?: { maxBytesPerSession?: number } };
      };
      expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(body.error.details?.maxBytesPerSession).toBe(100);
    });

    it('413: заявленный size больше maxBytesPerFile на инициализации', async () => {
      const { service } = createService(attachmentsConfig());
      const app = sessionApp(service, { id: 's1', messages: [] } as unknown as Session);
      const res = await init(app, base, { size: 2048 });
      expect(res.status).toBe(413);
    });

    it('400: некорректное тело инициализации', async () => {
      const { service } = createService(attachmentsConfig());
      const app = sessionApp(service, { id: 's1', messages: [] } as unknown as Session);
      const res = await init(app, base, { size: -5 });
      expect(res.status).toBe(400);
    });

    it('400: отказ стора invalid (некорректный size в обход парсера) → VALIDATION_ERROR', async () => {
      const { service } = createService(attachmentsConfig());
      const session = { id: 's1', messages: [] } as unknown as Session;
      // Публичный шов стора зовут и другие контуры: маппинг `invalid` — 400.
      const uploads = {
        create: async () => {
          throw new UploadSessionError('invalid', 'некорректный размер');
        },
      } as unknown as UploadSessionStore;
      const app = new Hono();
      app.route(
        '/',
        createAttachmentRoutes({
          sessionManager: {
            getSession: async (id: string) => (id === session.id ? session : null),
          } as unknown as SessionManager,
          service,
          config: service.config,
          uploads,
        }),
      );

      const res = await init(app, base);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('415 attachments_disabled', async () => {
      const { service } = createService(attachmentsConfig({ enabled: false }));
      const app = sessionApp(service, { id: 's1', messages: [] } as unknown as Session);
      const res = await init(app, base);
      expect(res.status).toBe(415);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('attachments_disabled');
    });

    it('DELETE: 204 и последующее завершение — 404', async () => {
      const { service } = createService(attachmentsConfig());
      const app = sessionApp(service, { id: 's1', messages: [] } as unknown as Session);
      const initRes = await init(app, base);
      const { uploadId } = (await initRes.json()) as { uploadId: string };
      await putChunk(app, `${base}/${uploadId}`, 0, Buffer.from('abc'));

      const del = await app.request(`${base}/${uploadId}`, { method: 'DELETE' });
      expect(del.status).toBe(204);
      // Идемпотентно.
      expect((await app.request(`${base}/${uploadId}`, { method: 'DELETE' })).status).toBe(204);

      const done = await app.request(`${base}/${uploadId}/complete`, { method: 'POST' });
      expect(done.status).toBe(404);
    });

    it('multi-replica: сессия загрузки с одной реплики завершается на другой', async () => {
      const { service, blobs } = createService(attachmentsConfig());
      const session = { id: 's1', messages: [] } as unknown as Session;
      const replicaA = sessionApp(service, session);
      const replicaB = sessionApp(service, session);

      const initRes = await init(replicaA, base);
      expect(initRes.status).toBe(201);
      const { uploadId } = (await initRes.json()) as { uploadId: string };

      // Часть и завершение — на другой реплике (общий том `blobs`).
      const payload = pngBytes(1, 10);
      const chunk = await putChunk(replicaB, `${base}/${uploadId}`, 0, payload);
      expect(chunk.status).toBe(200);
      expect(await chunk.json()).toEqual({
        received: payload.length,
        nextOffset: payload.length,
      });

      const done = await replicaB.request(`${base}/${uploadId}/complete`, { method: 'POST' });
      expect(done.status).toBe(201);
      expect(await blobs.list('attachments/.uploads')).toHaveLength(0);
    });

    it('404: загрузка сессии s1 не завершается из сессии s2', async () => {
      const { service } = createService(attachmentsConfig());
      const app = sessionApp(service, { id: 's1', messages: [] } as unknown as Session);
      const initRes = await init(app, base);
      const { uploadId } = (await initRes.json()) as { uploadId: string };
      await putChunk(app, `${base}/${uploadId}`, 0, Buffer.from('abc'));

      // Другая сессия (тот же том) — загрузка не видна (fail-closed).
      const other = sessionApp(service, { id: 's2', messages: [] } as unknown as Session);
      const done = await other.request(`${base}/${uploadId}/complete`, { method: 'POST' });
      expect(done.status).toBe(404);
      const chunk = await upChunk(other, `${base}/${uploadId}`, 3, Buffer.from('x'));
      expect(chunk.status).toBe(404);
    });
  });

  describe('staging-контур (/api/v2/attachments/uploads)', () => {
    const base = '/api/v2/attachments/uploads';

    it('полный цикл и аудит после complete', async () => {
      const config = attachmentsConfig();
      const { service } = createService(config);
      const audit = vi.fn();
      const app = stagingApp(service, audit);

      const bytes = pngBytes(7, 30);
      const meta = await uploadInChunks(app, base, bytes);
      expect(meta.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));

      expect(audit).toHaveBeenCalledTimes(1);
      const info = audit.mock.calls[0]![0] as StagingAttachmentAuditInfo;
      expect(info.meta.blobPath).toBe(meta.blobPath);
    });

    it('404/400/413 на staging-контуре', async () => {
      const { service } = createService(attachmentsConfig());
      const app = stagingApp(service);

      expect((await app.request(`${base}/missing/complete`, { method: 'POST' })).status).toBe(404);

      const initRes = await init(app, base);
      const { uploadId } = (await initRes.json()) as { uploadId: string };
      expect(
        (await putChunk(app, `${base}/${uploadId}`, 3, Buffer.from('x'))).status,
      ).toBe(400);
      expect(
        (await putChunk(app, `${base}/${uploadId}`, 0, Buffer.alloc(65, 1))).status,
      ).toBe(413);
    });
  });
});

/** Хелпер, чтобы не дублировать форму запроса части в негативных тестах. */
async function upChunk(app: Hono, url: string, offset: number, bytes: Buffer): Promise<Response> {
  return app.request(`${url}?offset=${offset}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(bytes),
  });
}
