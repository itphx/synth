/**
 * ADR-115 (B2a): chunked-загрузка — stateless-реестр сессий и финализация
 * временного объекта (`AttachmentService.ingestPath`).
 *
 * Проверяется: инициализация/части/завершение/отмена, смещение и лимиты,
 * TTL с инъекцией времени, дедуп, sidecar и уборка временного объекта.
 *
 * Отдельно — **multi-replica**: состояние сессии лежит на томе (temp + sidecar),
 * поэтому создание в одном экземпляре стора продолжается в другом (реплики
 * control plane над общим томом `blobs`).
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
  UPLOAD_SESSION_SIDECAR_SUFFIX,
  UPLOAD_SESSION_SIDECAR_VERSION,
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

  /** Временные объекты загрузки (без sidecar'ов). */
  async function tempObjects(): Promise<Array<{ path: string; size: number }>> {
    const entries = await blobs.list(ATTACHMENT_UPLOAD_DIR);
    return entries.filter((e) => !e.path.endsWith(UPLOAD_SESSION_SIDECAR_SUFFIX));
  }

  /** Sidecar'ы сессий загрузки. */
  async function sidecars(): Promise<Array<{ path: string; size: number }>> {
    const entries = await blobs.list(ATTACHMENT_UPLOAD_DIR);
    return entries.filter((e) => e.path.endsWith(UPLOAD_SESSION_SIDECAR_SUFFIX));
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

  it('create: sidecar на томе рядом с temp (version/sessionId/name/mime/createdAt)', async () => {
    const created = await store.create({
      sessionId: 's1',
      name: 'photo.png',
      declaredMime: 'image/png',
    });

    const [sidecar] = await sidecars();
    expect(sidecar).toBeDefined();
    expect(sidecar!.path).toBe(
      `${ATTACHMENT_UPLOAD_DIR}/${created.uploadId}${UPLOAD_SESSION_SIDECAR_SUFFIX}`,
    );
    const parsed = JSON.parse((await blobs.read(sidecar!.path))!.toString('utf-8')) as {
      version: number;
      sessionId?: string;
      name?: string;
      mime?: string;
      createdAt: number;
    };
    expect(parsed.version).toBe(UPLOAD_SESSION_SIDECAR_VERSION);
    expect(parsed.sessionId).toBe('s1');
    expect(parsed.name).toBe('photo.png');
    expect(parsed.mime).toBe('image/png');
    expect(parsed.createdAt).toBe(clock.value);
  });

  it('create: заявленный size больше maxBytesPerFile → too_large без временного объекта', async () => {
    await expect(store.create({ size: 2048 })).rejects.toMatchObject({
      name: 'UploadSessionError',
      code: 'too_large',
    });
    expect(await tempObjects()).toHaveLength(0);
    expect(await sidecars()).toHaveLength(0);
  });

  it.each<[string, number]>([
    ['-1', -1],
    ['NaN', Number.NaN],
    ['1.5', 1.5],
  ])('create: некорректный size (%s) → invalid без temp/sidecar', async (_label, size) => {
    const err = await store.create({ size }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadSessionError);
    expect((err as UploadSessionError).code).toBe('invalid');
    expect(await tempObjects()).toHaveLength(0);
    expect(await sidecars()).toHaveLength(0);
  });

  it('create: size 0 и ровно maxBytesPerFile — допустимы', async () => {
    await expect(store.create({ sessionId: 's1', size: 0 })).resolves.toBeDefined();
    await expect(store.create({ sessionId: 's2', size: 1024 })).resolves.toBeDefined();
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

  it('квота сессии: активные загрузки + declaredSize на create → too_large', async () => {
    config = testConfig({
      maxBytesPerFile: 1000,
      maxBytesPerSession: 100,
      maxChunkBytes: 64,
    });
    const first = await store.create({ sessionId: 's1' });
    await store.append(first.uploadId, 0, Buffer.alloc(60, 1), { sessionId: 's1' });

    // 60 Б уже занято активной загрузкой сессии + 60 Б заявлено → 120 > 100.
    await expect(store.create({ sessionId: 's1', size: 60 })).rejects.toMatchObject({
      name: 'UploadSessionError',
      code: 'too_large',
    });
    // Другая сессия квотой первой не ограничена.
    await expect(store.create({ sessionId: 's2', size: 60 })).resolves.toBeDefined();
    // Без declaredSize сессию можно открыть: рост проверит append.
    await expect(store.create({ sessionId: 's1' })).resolves.toBeDefined();
  });

  it('квота сессии: фактический рост на append → too_large', async () => {
    config = testConfig({
      maxBytesPerFile: 1000,
      maxBytesPerSession: 100,
      maxChunkBytes: 64,
    });
    const first = await store.create({ sessionId: 's1' });
    const second = await store.create({ sessionId: 's1' });
    await store.append(first.uploadId, 0, Buffer.alloc(60, 1), { sessionId: 's1' });

    // 60 Б в первой загрузке + 60 Б во второй = 120 > 100.
    await expect(
      store.append(second.uploadId, 0, Buffer.alloc(60, 1), { sessionId: 's1' }),
    ).rejects.toMatchObject({ name: 'UploadSessionError', code: 'too_large' });

    // Другая сессия не страдает от квоты первой.
    const other = await store.create({ sessionId: 's2' });
    await expect(
      store.append(other.uploadId, 0, Buffer.alloc(60, 1), { sessionId: 's2' }),
    ).resolves.toEqual({ received: 60, nextOffset: 60 });
  });

  it('квота сессии: complete проверяет сумму активных загрузок той же сессии', async () => {
    config = testConfig({
      maxBytesPerFile: 1000,
      maxBytesPerSession: 100,
      maxChunkBytes: 64,
    });
    const first = await store.create({ sessionId: 's1' });
    const second = await store.create({ sessionId: 's1' });
    await store.append(first.uploadId, 0, Buffer.alloc(60, 1), { sessionId: 's1' });
    await store.append(second.uploadId, 0, Buffer.alloc(30, 1), { sessionId: 's1' });

    // Лимит снижен после append: 60 + 30 = 90 > 80.
    config = testConfig({
      maxBytesPerFile: 1000,
      maxBytesPerSession: 80,
      maxChunkBytes: 64,
    });
    await expect(store.complete(second.uploadId, { sessionId: 's1' })).rejects.toMatchObject({
      name: 'UploadSessionError',
      code: 'too_large',
    });
  });

  it('лимит числа активных загрузок на сессию', async () => {
    config = testConfig({ maxActiveUploadsPerSession: 2 });
    await store.create({ sessionId: 's1' });
    await store.create({ sessionId: 's1' });
    await expect(store.create({ sessionId: 's1' })).rejects.toMatchObject({
      name: 'UploadSessionError',
      code: 'too_large',
    });
    // Другая сессия не блокируется лимитом первой.
    await expect(store.create({ sessionId: 's2' })).resolves.toBeDefined();
  });

  it('глобальный лимит активных загрузок включает staging без sessionId', async () => {
    config = testConfig({ maxActiveUploads: 2 });
    await store.create({ sessionId: 's1' });
    await store.create(); // staging: привязки к сессии нет
    await expect(store.create({ sessionId: 's2' })).rejects.toMatchObject({
      name: 'UploadSessionError',
      code: 'too_large',
    });
    await expect(store.create()).rejects.toMatchObject({
      name: 'UploadSessionError',
      code: 'too_large',
    });
  });

  it('протухшие загрузки не занимают квоту и число активных', async () => {
    config = testConfig({
      maxBytesPerFile: 1000,
      maxBytesPerSession: 100,
      maxChunkBytes: 64,
      maxActiveUploadsPerSession: 1,
      maxActiveUploads: 1,
    });
    const stale = await store.create({ sessionId: 's1' });
    await store.append(stale.uploadId, 0, Buffer.alloc(60, 1), { sessionId: 's1' });

    clock.value += UPLOAD_SESSION_TTL_MS + 1;
    await expect(store.create({ sessionId: 's1', size: 60 })).resolves.toBeDefined();
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
    expect(await sidecars()).toHaveLength(0);

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
    expect(await sidecars()).toHaveLength(0);
  });

  it('cancel: удаляет temp и sidecar, повтор идемпотентен', async () => {
    const created = await store.create();
    await store.append(created.uploadId, 0, Buffer.from('abc'));
    await store.cancel(created.uploadId);
    expect(await tempObjects()).toHaveLength(0);
    expect(await sidecars()).toHaveLength(0);
    await expect(store.cancel(created.uploadId)).resolves.toBeUndefined();
    await expect(store.complete(created.uploadId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('TTL: протухшая сессия и её temp удаляются', async () => {
    const created = await store.create();
    await store.append(created.uploadId, 0, Buffer.from('abc'));

    clock.value += UPLOAD_SESSION_TTL_MS + 1;
    await expect(
      store.append(created.uploadId, 3, Buffer.from('x')),
    ).rejects.toMatchObject({ name: 'UploadSessionError', code: 'not_found' });
    expect(await tempObjects()).toHaveLength(0);
    expect(await sidecars()).toHaveLength(0);
  });

  it('TTL: активная сессия переживает срок (активность обновляет sidecar)', async () => {
    const created = await store.create();
    clock.value += UPLOAD_SESSION_TTL_MS - 1;
    await store.append(created.uploadId, 0, Buffer.from('a'));
    clock.value += UPLOAD_SESSION_TTL_MS - 1;
    // append обновляет время активности — сессия ещё жива.
    const result = await store.append(created.uploadId, 1, Buffer.from('b'));
    expect(result.received).toBe(2);
  });

  it('pruneExpired: удаляет протухшие temp и sidecar', async () => {
    const stale = await store.create();
    await store.append(stale.uploadId, 0, Buffer.from('abc'));

    clock.value += Math.floor(UPLOAD_SESSION_TTL_MS / 2);
    const fresh = await store.create();
    clock.value += Math.floor(UPLOAD_SESSION_TTL_MS / 2) + 1;

    const removed = await store.pruneExpired();
    expect(removed).toBe(1);
    expect(await tempObjects()).toHaveLength(1);
    expect(await blobs.exists(`${ATTACHMENT_UPLOAD_DIR}/${stale.uploadId}`)).toBe(false);
    expect(await blobs.exists(`${ATTACHMENT_UPLOAD_DIR}/${fresh.uploadId}`)).toBe(true);
  });
});

describe('UploadSessionStore: multi-replica (состояние на томе)', () => {
  let tmpDir: string;
  let blobs: FileBlobStore;
  let config: AttachmentsConfig;
  let service: AttachmentService;
  let clock: { value: number };
  /** Реплика 1 — создаёт сессию. */
  let replicaA: UploadSessionStore;
  /** Реплика 2 — продолжает и завершает загрузку. */
  let replicaB: UploadSessionStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-attachment-uploads-mr-'));
    blobs = new FileBlobStore({ root: join(tmpDir, 'blobs') });
    config = testConfig();
    service = new AttachmentService({ blobs, config: () => config });
    clock = { value: 1_000 };
    const deps = { service, config: () => config, now: () => clock.value };
    replicaA = new UploadSessionStore(deps);
    replicaB = new UploadSessionStore(deps);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('create в одной реплике, append/complete — в другой', async () => {
    const bytes = pngBytes(9, 12);
    const created = await replicaA.create({ name: 'photo.png', declaredMime: 'image/png' });

    // Смещение — фактический размер объекта на томе: вторая реплика его знает.
    const first = await replicaB.append(created.uploadId, 0, bytes.subarray(0, 20));
    expect(first).toEqual({ received: 20, nextOffset: 20 });
    const second = await replicaB.append(created.uploadId, 20, bytes.subarray(20));
    expect(second).toEqual({ received: bytes.length, nextOffset: bytes.length });

    const meta = await replicaB.complete(created.uploadId);
    expect(meta.sha256).toBe(sha256(bytes));
    expect(await blobs.exists(meta.blobPath)).toBe(true);
    expect(await blobs.list(ATTACHMENT_UPLOAD_DIR)).toHaveLength(0);
  });

  it('сессия, созданная в другой реплике, не «не найдена»', async () => {
    const created = await replicaA.create();
    await expect(
      replicaB.append(created.uploadId, 0, Buffer.from('abc')),
    ).resolves.toEqual({ received: 3, nextOffset: 3 });
  });

  it('привязка к сессии: чужая сессия не видит загрузку (not_found)', async () => {
    const created = await replicaA.create({ sessionId: 's1' });

    await expect(
      replicaB.append(created.uploadId, 0, Buffer.from('abc'), { sessionId: 's2' }),
    ).rejects.toMatchObject({ name: 'UploadSessionError', code: 'not_found' });
    await expect(
      replicaB.complete(created.uploadId, { sessionId: 's2' }),
    ).rejects.toMatchObject({ name: 'UploadSessionError', code: 'not_found' });

    // Своя сессия — работает.
    await expect(
      replicaB.append(created.uploadId, 0, Buffer.from('abc'), { sessionId: 's1' }),
    ).resolves.toEqual({ received: 3, nextOffset: 3 });
  });

  it('привязка к сессии: отмена чужой загрузки не удаляет temp', async () => {
    const created = await replicaA.create({ sessionId: 's1' });
    await replicaA.append(created.uploadId, 0, Buffer.from('abc'), { sessionId: 's1' });

    await replicaB.cancel(created.uploadId, { sessionId: 's2' });
    expect(await blobs.exists(`${ATTACHMENT_UPLOAD_DIR}/${created.uploadId}`)).toBe(true);

    await replicaB.cancel(created.uploadId, { sessionId: 's1' });
    expect(await blobs.exists(`${ATTACHMENT_UPLOAD_DIR}/${created.uploadId}`)).toBe(false);
  });

  it('staging-контур: загрузка без sessionId доступна без области', async () => {
    const created = await replicaA.create({ declaredMime: 'text/plain' });
    await expect(
      replicaB.append(created.uploadId, 0, Buffer.from('abc')),
    ).resolves.toEqual({ received: 3, nextOffset: 3 });
    await expect(replicaB.complete(created.uploadId)).resolves.toMatchObject({ size: 3 });
  });

  it('offset сверяется с фактическим размером файла (не со счётчиком в памяти)', async () => {
    const created = await replicaA.create();
    await replicaA.append(created.uploadId, 0, Buffer.from('abc'));

    // Вторая реплика не знает счётчика первой — offset берётся из размера файла.
    await expect(
      replicaB.append(created.uploadId, 3, Buffer.from('de')),
    ).resolves.toEqual({ received: 5, nextOffset: 5 });
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
