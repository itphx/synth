/**
 * ADR-115: HTTP-раздача миниатюры — `GET …?variant=thumb`.
 *
 * Проверяется оба контура (вложение сессии и staging по sha): 200 JPEG с
 * ETag/суточным кэшем, 404 без миниатюры и неизменность полного варианта.
 */

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { AttachmentsConfig, Session } from '@itphx/synth-shared';
import { defaultConfig } from '@itphx/synth-shared';
import type { AuthKit } from '../../auth/local.js';
import { MemoryBlobStore } from '../../storage/memory/content.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { MediaRunnerLike } from '../../engine/media/runner.js';
import { AttachmentService } from '../../engine/attachments/service.js';
import { ThumbnailService } from '../../engine/attachments/thumbnails.js';
import { createAttachmentRoutes } from './attachments.js';
import { createStagingAttachmentRoutes } from './attachments-staging.js';

const SHA = 'b'.repeat(64);
const BLOB_PATH = `attachments/${SHA.slice(0, 2)}/${SHA}`;
const ORIGINAL = Buffer.from('original-image');
const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function config(): AttachmentsConfig {
  return {
    enabled: true,
    modalities: { image: true, pdf: true, audio: true, video: true },
    maxBytesPerFile: 1024 * 1024,
    maxFilesPerMessage: 10,
    maxBytesPerSession: 10 * 1024 * 1024,
    allowedMimePrefixes: ['image/'],
    workspaceFallback: true,
    gcDays: 30,
    // ADR-115: сжатие/миниатюры/chunked-загрузка — дефолты схемы.
    compression: defaultConfig.attachments.compression,
    thumbnail: defaultConfig.attachments.thumbnail,
    maxChunkBytes: defaultConfig.attachments.maxChunkBytes,
  };
}

const noopRunner: MediaRunnerLike = {
  isRemote: false,
  run: vi.fn(async () => ({ ok: false, outputs: [], reason: 'no_ffmpeg' as const })),
};

async function setup(withThumb: boolean, runner: MediaRunnerLike = noopRunner): Promise<{
  service: AttachmentService;
  blobs: MemoryBlobStore;
  session: Session;
}> {
  const blobs = new MemoryBlobStore();
  await blobs.write(BLOB_PATH, ORIGINAL);
  await blobs.write(`${BLOB_PATH}.json`, JSON.stringify({ mime: 'image/png', size: ORIGINAL.length, sha256: SHA }));
  if (withThumb) await blobs.write(`attachments/.thumbs/${SHA}.jpg`, THUMB);
  const service = new AttachmentService({
    blobs,
    config,
    thumbnails: new ThumbnailService({ blobs, runner }),
  });
  const session = {
    id: 's1',
    messages: [
      { id: 'm1', parts: [{ id: 'p1', type: 'image', data: { blobPath: BLOB_PATH } }] },
    ],
  } as unknown as Session;
  return { service, blobs, session };
}

function sessionApp(service: AttachmentService, session: Session): Hono {
  const app = new Hono();
  const sessionManager = { getSession: async () => session } as unknown as SessionManager;
  app.route('/', createAttachmentRoutes({ sessionManager, service, config }));
  return app;
}

describe('GET /:id/attachments/:partId?variant=thumb', () => {
  it('200: JPEG миниатюры с ETag и суточным кэшем', async () => {
    const { service, session } = await setup(true);
    const res = await sessionApp(service, session).request('/s1/attachments/p1?variant=thumb');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(res.headers.get('etag')).toBe(`"thumb-${SHA}-512"`);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(THUMB);
  });

  it('404: миниатюры нет', async () => {
    const { service, session } = await setup(false);
    const res = await sessionApp(service, session).request('/s1/attachments/p1?variant=thumb');
    expect(res.status).toBe(404);
  });

  it('ETag зависит от ширины: смена maxWidthPx даёт другой ETag', async () => {
    const blobs = new MemoryBlobStore();
    await blobs.write(BLOB_PATH, ORIGINAL);
    await blobs.write(
      `${BLOB_PATH}.json`,
      JSON.stringify({ mime: 'image/png', size: ORIGINAL.length, sha256: SHA }),
    );
    await blobs.write(`attachments/.thumbs/${SHA}-512.jpg`, THUMB);
    await blobs.write(`attachments/.thumbs/${SHA}-256.jpg`, THUMB);

    let width = 512;
    const service = new AttachmentService({
      blobs,
      config,
      thumbnails: new ThumbnailService({
        blobs,
        runner: noopRunner,
        config: () => ({ enabled: true, maxWidthPx: width }),
      }),
    });
    const session = {
      id: 's1',
      messages: [
        { id: 'm1', parts: [{ id: 'p1', type: 'image', data: { blobPath: BLOB_PATH } }] },
      ],
    } as unknown as Session;
    const app = sessionApp(service, session);

    const first = await app.request('/s1/attachments/p1?variant=thumb');
    expect(first.status).toBe(200);
    expect(first.headers.get('etag')).toBe(`"thumb-${SHA}-512"`);

    width = 256;
    const second = await app.request('/s1/attachments/p1?variant=thumb');
    expect(second.status).toBe(200);
    expect(second.headers.get('etag')).toBe(`"thumb-${SHA}-256"`);
    expect(second.headers.get('etag')).not.toBe(first.headers.get('etag'));
  });

  it('ленивая генерация: первый GET создаёт миниатюру, повторный берёт кэш', async () => {
    const runner: MediaRunnerLike = {
      isRemote: false,
      run: vi.fn(async () => ({ ok: true, outputs: [THUMB] })),
    };
    const { service, session } = await setup(false, runner);
    const app = sessionApp(service, session);

    const first = await app.request('/s1/attachments/p1?variant=thumb');
    expect(first.status).toBe(200);
    expect(Buffer.from(await first.arrayBuffer())).toEqual(THUMB);

    const second = await app.request('/s1/attachments/p1?variant=thumb');
    expect(second.status).toBe(200);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('без variant — прежняя раздача оригинала', async () => {
    const { service, session } = await setup(true);
    const res = await sessionApp(service, session).request('/s1/attachments/p1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(ORIGINAL);
  });
});

describe('GET /api/v2/attachments/:sha256?variant=thumb (staging)', () => {
  const auth = {
    requireAuth: async (_c: Context, next: Next) => {
      await next();
    },
  } as unknown as AuthKit;

  it('200: миниатюра по sha', async () => {
    const { service } = await setup(true);
    const app = new Hono();
    app.route(
      '/api/v2/attachments',
      createStagingAttachmentRoutes(auth, { service, config }),
    );
    const res = await app.request(`/api/v2/attachments/${SHA}?variant=thumb`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(THUMB);
  });

  it('404: миниатюры нет', async () => {
    const { service } = await setup(false);
    const app = new Hono();
    app.route(
      '/api/v2/attachments',
      createStagingAttachmentRoutes(auth, { service, config }),
    );
    const res = await app.request(`/api/v2/attachments/${SHA}?variant=thumb`);
    expect(res.status).toBe(404);
  });
});
