/**
 * ADR-115 (B2a): chunked-загрузка — реестр сессий и финализация временного
 * объекта (`AttachmentService.ingestPath`).
 *
 * Проверяется: инициализация/части/завершение/отмена, смещение и лимиты,
 * TTL с инъекцией времени, дедуп, sidecar и уборка временного объекта.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachmentsConfig } from '@itphx/synth-shared';
import { defaultConfig } from '@itphx/synth-shared';
import { FileBlobStore } from '../../storage/file-blob-store.js';
import {
  ATTACHMENT_DIR,
  ATTACHMENT_UPLOAD_DIR,
  AttachmentError,
  AttachmentService,
} from './service.js';
import {
  UploadSessionError,
  UploadSessionStore,
  UPLOAD_SESSION_TTL_MS,
} from './uploads.js';

function testConfig(overrides: Partial<AttachmentsConfig> = {}): AttachmentsConfig {
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

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('UploadSessionStore (ADR-115, B2a)', () => {
  let tmpDir: string;
  let blobs: FileBlobStore;
  let config: AttachmentsConfig;
  let service: AttachmentService;
  let clock: { value: number };
  let store: UploadSessionStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-attachment-uploads-'));
    blobs = new FileBlobStore({ root: join(tmpDir, 'blobs') });
    config = testConfig();
    service = new AttachmentService({ blobs, config: () => config });
    clock = { value: 1_000 };
    store = new UploadSessionStore({
      service,
      config: () => config,
      now: () => clock.value,
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Все временные объекты загрузки (после успешного завершения/уборки — пусто). */
  async function tempObjects(): Promise<Array<{ path: string; size: number }>> {
    return blobs.list(ATTACHMENT_UPLOAD_DIR);
  }

  it('create: пустой временный объект и maxChunkBytes из конфига', async () => {
    const created = await store.create({ sessionId: 's1', name: 'photo.png' });
    expect(created.uploadId).toMatch(/[0-9a-f-]{36}/);
    expect(created.maxChunkBytes).toBe(64);

    const temps = await tempObjects();
    expect(temps).toHaveLength(1);
    expect(temps[0]!.size).toBe(0);
    expect(temps[0]!.path.startsWith(`${ATTACHMENT_UPLOAD_DIR}/`)).toBe(true);
  });

  it('create: заявленный size больше maxBytesPerFile → too_large без временного объекта', async () => {
    await expect(store.create({ size: 2048 })).rejects.toMatchObject({
      name: 'UploadSessionError',
      code: 'too_large',
    });
    expect(await tempObjects()).toHaveLength(0);
  });

  it('create: вложения выключены → AttachmentError attachments_disabled', async () => {
    config = testConfig({ enabled: false });
    const err = await store.create().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentError);
    expect((err as AttachmentError).code).toBe('attachments_disabled');
  });

  it('append: обновляет received/nextOffset и дописывает байты', async () => {
    const created = await store.create();
    const first = await store.append(created.uploadId, 0, Buffer.from('abc'));
    expect(first).toEqual({ received: 3, nextOffset: 3 });
    const second = await store.append(created.uploadId, 3, Buffer.from('def'));
    expect(second).toEqual({ received: 6, nextOffset: 6 });

    const [temp] = await tempObjects();
    expect(await blobs.read(temp!.path)).toEqual(Buffer.from('abcdef'));
  });

  it('append: offset не совпал с принятым объёмом → offset_mismatch', async () => {
    const created = await store.create();
    await store.append(created.uploadId, 0, Buffer.from('abc'));
    await expect(store.append(created.uploadId, 1, Buffer.from('x'))).rejects.toMatchObject({
      name: 'UploadSessionError',
      code: 'offset_mismatch',
    });
  });

  it('append: часть больше maxChunkBytes → too_large_chunk', async () => {
    const created = await store.create();
    await expect(
      store.append(created.uploadId, 0, Buffer.alloc(65, 1)),
    ).rejects.toMatchObject({ name: 'UploadSessionError', code: 'too_large_chunk' });
  });

  it('append: суммарно больше maxBytesPerFile → too_large', async () => {
    config = testConfig({ maxChunkBytes: 600, maxBytesPerFile: 100 });
    const created = await store.create();
    await store.append(created.uploadId, 0, Buffer.alloc(60, 1));
    await expect(
      store.append(created.uploadId, 60, Buffer.alloc(60, 1)),
    ).rejects.toMatchObject({ name: 'UploadSessionError', code: 'too_large' });
  });

  it('append: неизвестная сессия → not_found (404 на границе)', async () => {
    await expect(store.append('nope', 0, Buffer.from('x'))).rejects.toBeInstanceOf(
      UploadSessionError,
    );
  });

  it('complete: публикует content-addressed объект, пишет sidecar, убирает temp', async () => {
    const bytes = pngBytes(1, 10);
    const created = await store.create({ name: 'photo.png', declaredMime: 'image/png' });
    await store.append(created.uploadId, 0, bytes);

    const meta = await store.complete(created.uploadId);
    const sha = sha256(bytes);
    expect(meta.sha256).toBe(sha);
    expect(meta.blobPath).toBe(`${ATTACHMENT_DIR}/${sha.slice(0, 2)}/${sha}`);
    expect(meta.mime).toBe('image/png');
    expect(meta.size).toBe(bytes.length);
    expect(meta.name).toBe('photo.png');
    expect(await blobs.exists(meta.blobPath)).toBe(true);
    expect(await blobs.exists(`${meta.blobPath}.json`)).toBe(true);
    expect(await tempObjects()).toHaveLength(0);

    // Повторное завершение — сессии уже нет.
    await expect(store.complete(created.uploadId)).rejects.toMatchObject({
      name: 'UploadSessionError',
      code: 'not_found',
    });
  });

  it('complete: дедуп — объект уже есть, temp удаляется, объект не перезаписывается', async () => {
    const bytes = pngBytes(2, 10);
    const sha = sha256(bytes);
    const blobPath = `${ATTACHMENT_DIR}/${sha.slice(0, 2)}/${sha}`;
    await blobs.write(blobPath, bytes);

    const created = await store.create();
    await store.append(created.uploadId, 0, bytes);
    const meta = await store.complete(created.uploadId);

    expect(meta.blobPath).toBe(blobPath);
    expect(await tempObjects()).toHaveLength(0);
    expect(await blobs.read(blobPath)).toEqual(bytes);
  });

  it('complete: пустая загрузка → AttachmentError empty, temp убран', async () => {
    const created = await store.create();
    const err = await store.complete(created.uploadId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentError);
    expect((err as AttachmentError).code).toBe('empty');
    expect(await tempObjects()).toHaveLength(0);
  });

  it('cancel: удаляет temp и запись, повтор идемпотентен', async () => {
    const created = await store.create();
    await store.append(created.uploadId, 0, Buffer.from('abc'));
    await store.cancel(created.uploadId);
    expect(await tempObjects()).toHaveLength(0);
    await expect(store.cancel(created.uploadId)).resolves.toBeUndefined();
    await expect(store.complete(created.uploadId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('TTL: протухшая сессия и её temp удаляются лениво', async () => {
    const created = await store.create();
    await store.append(created.uploadId, 0, Buffer.from('abc'));

    clock.value += UPLOAD_SESSION_TTL_MS + 1;
    await expect(
      store.append(created.uploadId, 3, Buffer.from('x')),
    ).rejects.toMatchObject({ name: 'UploadSessionError', code: 'not_found' });
    expect(await tempObjects()).toHaveLength(0);
  });

  it('TTL: активная сессия переживает уборку (updatedAt обновляется append-ом)', async () => {
    const created = await store.create();
    clock.value += UPLOAD_SESSION_TTL_MS - 1;
    await store.append(created.uploadId, 0, Buffer.from('a'));
    clock.value += UPLOAD_SESSION_TTL_MS - 1;
    // append обновляет updatedAt — сессия ещё жива.
    const result = await store.append(created.uploadId, 1, Buffer.from('b'));
    expect(result.received).toBe(2);
  });
});

describe('AttachmentService.ingestPath (ADR-115, B2a)', () => {
  let tmpDir: string;
  let blobs: FileBlobStore;
  let service: AttachmentService;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-attachment-ingest-path-'));
    blobs = new FileBlobStore({ root: join(tmpDir, 'blobs') });
    service = new AttachmentService({
      blobs,
      config: testConfig({ maxBytesPerFile: 1024 * 1024 }),
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTemp(bytes: Buffer): Promise<string> {
    const path = `${ATTACHMENT_UPLOAD_DIR}/${randomUUID()}`;
    await blobs.write(path, bytes);
    return path;
  }

  it('переносит temp в content-addressed путь, пишет sidecar и зовёт миниатюру', async () => {
    const ensure = vi.fn(async () => ({ status: 'none' as const }));
    service = new AttachmentService({
      blobs,
      config: testConfig({ maxBytesPerFile: 1024 * 1024 }),
      thumbnails: { ensure, get: async () => null },
    });
    const bytes = pngBytes(3, 25);
    const temp = await writeTemp(bytes);

    const meta = await service.ingestPath(temp, { name: 'pic.png', declaredMime: 'image/png' });
    const sha = sha256(bytes);
    expect(meta.sha256).toBe(sha);
    expect(meta.mime).toBe('image/png');
    expect(meta.size).toBe(bytes.length);
    expect(meta.name).toBe('pic.png');
    expect(await blobs.exists(temp)).toBe(false);
    expect(await blobs.exists(meta.blobPath)).toBe(true);
    const sidecar = JSON.parse((await blobs.read(`${meta.blobPath}.json`))!.toString('utf-8')) as {
      mime?: string;
      sha256?: string;
    };
    expect(sidecar.mime).toBe('image/png');
    expect(sidecar.sha256).toBe(sha);
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(1));
  });

  it('дедуп: объект с таким sha уже есть — temp удаляется', async () => {
    const bytes = pngBytes(4, 5);
    const sha = sha256(bytes);
    const blobPath = `${ATTACHMENT_DIR}/${sha.slice(0, 2)}/${sha}`;
    await blobs.write(blobPath, bytes);
    const temp = await writeTemp(bytes);

    const meta = await service.ingestPath(temp);
    expect(meta.blobPath).toBe(blobPath);
    expect(await blobs.exists(temp)).toBe(false);
  });

  it('пустой temp → AttachmentError empty, temp убран', async () => {
    const temp = await writeTemp(Buffer.alloc(0));
    const err = await service.ingestPath(temp).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentError);
    expect((err as AttachmentError).code).toBe('empty');
    expect(await blobs.exists(temp)).toBe(false);
  });

  it('temp больше maxBytesPerFile → AttachmentError too_large, temp убран', async () => {
    service = new AttachmentService({ blobs, config: testConfig({ maxBytesPerFile: 32 }) });
    const temp = await writeTemp(pngBytes(5, 100));
    const err = await service.ingestPath(temp).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentError);
    expect((err as AttachmentError).code).toBe('too_large');
    expect(await blobs.exists(temp)).toBe(false);
  });

  it('MIME вне allowlist → 415-код сервиса, temp убран', async () => {
    service = new AttachmentService({
      blobs,
      config: testConfig({ maxBytesPerFile: 1024 * 1024, allowedMimePrefixes: ['image/'] }),
    });
    const temp = await writeTemp(Buffer.from('просто текст', 'utf-8'));
    const err = await service.ingestPath(temp).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentError);
    expect((err as AttachmentError).code).toBe('unsupported_mime');
    expect(await blobs.exists(temp)).toBe(false);
  });
});
