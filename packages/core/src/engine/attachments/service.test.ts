/**
 * ADR-115: сервис вложений — MIME по сигнатуре, лимиты, вычищение метаданных,
 * content-addressed адресация (дедуп) и метаданные чтения.
 *
 * Байты синтетические: PNG/JPEG собираются вручную (с текстовым чанком/EXIF-
 * сегментом), поэтому тест проверяет именно парсеры, а не внешние файлы.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachmentsConfig } from '@itphx/synth-shared';
import { FileBlobStore } from '../../storage/file-blob-store.js';
import { MetricsRegistry } from '../../metrics/registry.js';
import { createAttachmentMetrics } from '../../metrics/collectors/attachments.js';
import { AttachmentError, AttachmentService, isAttachmentPath, partTypeOf } from './service.js';
import { sniffMime } from './sniff-mime.js';

/** Умолчания схемы `attachments` для тестов (лимиты намеренно небольшие). */
function testConfig(overrides: Partial<AttachmentsConfig> = {}): AttachmentsConfig {
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

/** PNG-чанк: длина + тип + данные + CRC-заглушка (парсер CRC не проверяет). */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

/** PNG с текстовым чанком `tEXt` (метаданные, которые обязаны исчезнуть). */
function pngWithText(text = 'Comment\0секретное-гео'): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.alloc(13, 1)),
    pngChunk('tEXt', Buffer.from(text, 'latin1')),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** JPEG-сегмент: маркер + длина (включая саму длину) + данные. */
function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/** JPEG с EXIF (APP1) и ICC (APP2) — оба сегмента обязаны быть вырезаны. */
function jpegWithExif(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe1, Buffer.from('Exif\0\0GPS', 'latin1')),
    jpegSegment(0xe2, Buffer.from('ICC_PROFILE', 'latin1')),
    jpegSegment(0xdb, Buffer.from([1, 2, 3, 4])), // DQT — остаётся
    jpegSegment(0xda, Buffer.alloc(8, 9)), // SOS — заголовок + «сжатые» данные
    Buffer.from([0x12, 0x34, 0x56, 0x78]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** Минимальный PDF (сигнатура `%PDF-`). */
function pdfBytes(): Buffer {
  return Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n', 'latin1');
}

describe('AttachmentService (ADR-115)', () => {
  let tmpDir: string;
  let blobs: FileBlobStore;
  let service: AttachmentService;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-attachments-'));
    blobs = new FileBlobStore({ root: join(tmpDir, 'blobs') });
    service = new AttachmentService({ blobs, config: testConfig() });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('upload', () => {
    it('пишет объект по content-addressed пути и sidecar с метаданными', async () => {
      const bytes = pngWithText();
      const meta = await service.upload({ sessionId: 's1', bytes, name: 'фото.png' });

      expect(meta.id).toBe(meta.blobPath);
      expect(meta.mime).toBe('image/png');
      expect(meta.blobPath).toMatch(/^attachments\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
      expect(meta.blobPath).toContain(meta.sha256);
      expect(meta.name).toBe('фото.png');
      expect(await blobs.exists(meta.blobPath)).toBe(true);

      const sidecar = await blobs.read(`${meta.blobPath}.json`);
      expect(sidecar).not.toBeNull();
      expect(JSON.parse(sidecar!.toString('utf-8'))).toMatchObject({
        name: 'фото.png',
        mime: 'image/png',
        sha256: meta.sha256,
      });
    });

    it('дедуплицирует одинаковое содержимое (один объект, один путь)', async () => {
      const bytes = pngWithText();
      const first = await service.upload({ sessionId: 's1', bytes });
      const second = await service.upload({ sessionId: 's2', bytes, name: 'другое.png' });

      expect(second.blobPath).toBe(first.blobPath);
      const entries = await blobs.list('attachments');
      expect(entries.filter((e) => !e.path.endsWith('.json'))).toHaveLength(1);
    });

    it('отклоняет файл больше maxBytesPerFile (too_large)', async () => {
      const local = new AttachmentService({ blobs, config: testConfig({ maxBytesPerFile: 16 }) });
      await expect(local.upload({ sessionId: 's1', bytes: pngWithText() })).rejects.toMatchObject({
        code: 'too_large',
      });
    });

    it('запрещает image/svg+xml всегда (unsupported_mime)', async () => {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
      // Заявленный тип «png» не спасает: SVG распознаётся по разметке.
      const err = await service
        .upload({ sessionId: 's1', bytes: svg, declaredMime: 'image/png' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AttachmentError);
      expect((err as AttachmentError).code).toBe('unsupported_mime');
    });

    it('отклоняет MIME вне allowedMimePrefixes (unsupported_mime)', async () => {
      const local = new AttachmentService({ blobs, config: testConfig({ allowedMimePrefixes: ['image/'] }) });
      const bytes = Buffer.from('просто текст');
      await expect(
        local.upload({ sessionId: 's1', bytes, declaredMime: 'text/plain' }),
      ).rejects.toMatchObject({ code: 'unsupported_mime' });
    });

    it('мастер-выключатель enabled=false → attachments_disabled', async () => {
      const local = new AttachmentService({ blobs, config: testConfig({ enabled: false }) });
      await expect(
        local.upload({ sessionId: 's1', bytes: pngWithText() }),
      ).rejects.toMatchObject({ code: 'attachments_disabled' });
    });

    it('выключенное семейство modalities → unsupported_mime', async () => {
      const local = new AttachmentService({
        blobs,
        config: testConfig({ modalities: { image: false, pdf: true, audio: true, video: true } }),
      });
      await expect(
        local.upload({ sessionId: 's1', bytes: pngWithText() }),
      ).rejects.toMatchObject({ code: 'unsupported_mime' });
      // Другие семейства по-прежнему принимаются.
      const pdf = await local.upload({ sessionId: 's1', bytes: pdfBytes() });
      expect(pdf.mime).toBe('application/pdf');
    });

    it('резолвер конфига читается на каждый вызов (runtime без рестарта)', async () => {
      let config = testConfig();
      const live = new AttachmentService({ blobs, config: () => config });
      const first = await live.upload({ sessionId: 's1', bytes: pngWithText() });
      expect(first.mime).toBe('image/png');

      config = testConfig({ enabled: false });
      await expect(
        live.upload({ sessionId: 's1', bytes: pdfBytes() }),
      ).rejects.toMatchObject({ code: 'attachments_disabled' });
    });

    it('неизвестная сигнатура → заявленный тип, затем application/octet-stream', async () => {
      const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      const declared = await service.upload({ sessionId: 's1', bytes, declaredMime: 'application/pdf' });
      expect(declared.mime).toBe('application/pdf');

      const all = new AttachmentService({ blobs, config: testConfig({ allowedMimePrefixes: [] }) });
      const fallback = await all.upload({ sessionId: 's1', bytes });
      expect(fallback.mime).toBe('application/octet-stream');
    });

    it('вычищает EXIF (APP1/APP2) из JPEG, сохраняя остальные сегменты', async () => {
      const meta = await service.upload({ sessionId: 's1', bytes: jpegWithExif(), name: 'photo.jpg' });
      const stored = (await blobs.read(meta.blobPath))!;

      expect(stored.includes(Buffer.from('Exif\0\0GPS', 'latin1'))).toBe(false);
      expect(stored.includes(Buffer.from('ICC_PROFILE', 'latin1'))).toBe(false);
      // SOI, DQT, SOS-данные и EOI на месте.
      expect(stored.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(stored.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
      expect(stored.includes(Buffer.from([0x12, 0x34, 0x56, 0x78]))).toBe(true);
      expect(stored.includes(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toBe(true);
      expect(meta.mime).toBe('image/jpeg');
    });

    it('вычищает текстовые чанки (tEXt) из PNG, сохраняя IHDR/IEND', async () => {
      const meta = await service.upload({ sessionId: 's1', bytes: pngWithText() });
      const stored = (await blobs.read(meta.blobPath))!;

      expect(stored.includes(Buffer.from('секретное-гео', 'latin1'))).toBe(false);
      expect(stored.includes(Buffer.from('tEXt', 'latin1'))).toBe(false);
      expect(stored.includes(Buffer.from('IHDR', 'latin1'))).toBe(true);
      expect(stored.includes(Buffer.from('IEND', 'latin1'))).toBe(true);
      // Размер в метаданных — размер записанного (уже очищенного) объекта.
      expect(meta.size).toBe(stored.length);
    });

    it('не трогает байты форматов без парсера (PDF)', async () => {
      const bytes = pdfBytes();
      const meta = await service.upload({ sessionId: 's1', bytes });
      expect(await blobs.read(meta.blobPath)).toEqual(bytes);
      expect(meta.mime).toBe('application/pdf');
    });
  });

  describe('resolve', () => {
    it('читает метаданные из sidecar (имя и MIME переживают отправку)', async () => {
      const meta = await service.upload({ sessionId: 's1', bytes: pngWithText(), name: 'photo.png' });
      const resolved = await service.resolve(meta.blobPath);

      expect(resolved).not.toBeNull();
      expect(resolved!.mime).toBe('image/png');
      expect(resolved!.name).toBe('photo.png');
      expect(resolved!.sha256).toBe(meta.sha256);
      expect(resolved!.size).toBe(meta.size);
      expect(resolved!.stat.size).toBe(meta.size);
    });

    it('фоллбек на sniff, если sidecar потерян', async () => {
      const meta = await service.upload({ sessionId: 's1', bytes: pngWithText() });
      await blobs.delete(`${meta.blobPath}.json`);

      const resolved = await service.resolve(meta.blobPath);
      expect(resolved?.mime).toBe('image/png');
      expect(resolved?.sha256).toBe(meta.sha256);
    });

    it('null для отсутствующего объекта и для пути вне attachments/', async () => {
      await blobs.write('processes/run.log', 'лог');
      expect(await service.resolve('processes/run.log')).toBeNull();
      expect(await service.resolve('attachments/00/deadbeef')).toBeNull();
      expect(await service.resolve('attachments/../secret')).toBeNull();
    });
  });

  describe('read / buildMediaPart', () => {
    it('отдаёт поток и диапазон', async () => {
      const all = new AttachmentService({ blobs, config: testConfig({ allowedMimePrefixes: [] }) });
      const meta = await all.upload({ sessionId: 's1', bytes: Buffer.from('0123456789') });
      const stream = await service.read(meta.blobPath, { start: 2, end: 4 });
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk as Buffer));
      expect(Buffer.concat(chunks).toString('utf-8')).toBe('234');
      // Чтение вне контура вложений запрещено.
      expect(await service.read('processes/run.log')).toBeNull();
    });

    it('тип части по MIME: image/audio/video/file', async () => {
      expect(partTypeOf('image/png')).toBe('image');
      expect(partTypeOf('audio/mpeg')).toBe('audio');
      expect(partTypeOf('video/mp4')).toBe('video');
      expect(partTypeOf('application/pdf')).toBe('file');

      const meta = await service.upload({ sessionId: 's1', bytes: pngWithText(), name: 'photo.png' });
      const part = await service.buildMediaPart(meta.blobPath);
      expect(part?.type).toBe('image');
      expect(part?.data).toMatchObject({
        blobPath: meta.blobPath,
        sha256: meta.sha256,
        mime: 'image/png',
        size: meta.size,
        name: 'photo.png',
      });
    });

    it('PDF → часть file', async () => {
      const meta = await service.upload({ sessionId: 's1', bytes: pdfBytes(), name: 'doc.pdf' });
      const part = await service.buildMediaPart(meta.blobPath);
      expect(part?.type).toBe('file');
      expect(part?.data.name).toBe('doc.pdf');
    });

    it('null для неизвестного объекта', async () => {
      expect(await service.buildMediaPart('attachments/00/unknown')).toBeNull();
    });
  });
});

describe('sniffMime / isAttachmentPath (ADR-115)', () => {
  it('распознаёт сигнатуры основных форматов', () => {
    expect(sniffMime(pngWithText())).toBe('image/png');
    expect(sniffMime(jpegWithExif())).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('GIF89a....', 'latin1'))).toBe('image/gif');
    expect(sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp');
    expect(sniffMime(pdfBytes())).toBe('application/pdf');
    expect(sniffMime(Buffer.from('OggS....', 'latin1'))).toBe('audio/ogg');
    expect(sniffMime(Buffer.from('ID3....', 'latin1'))).toBe('audio/mpeg');
    expect(sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]))).toBe('audio/wav');
    expect(sniffMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]))).toBe('video/webm');
    // ISO-BMFF: HEIC и MP4 различаются брендом.
    const ftyp = (brand: string) => Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftyp', 'latin1'),
      Buffer.from(brand, 'latin1'),
      Buffer.alloc(4),
    ]);
    expect(sniffMime(ftyp('heic'))).toBe('image/heic');
    expect(sniffMime(ftyp('isom'))).toBe('video/mp4');
    expect(sniffMime(Buffer.from('просто текст'))).toBeUndefined();
  });

  it('контур вложений ограничен префиксом attachments/', () => {
    expect(isAttachmentPath('attachments/ab/cd')).toBe(true);
    expect(isAttachmentPath('processes/run.log')).toBe(false);
    expect(isAttachmentPath('attachments/../etc/passwd')).toBe(false);
    expect(isAttachmentPath('')).toBe(false);
  });
});

/**
 * ADR-094: сервис вложений инкрементирует метрики попыток загрузки
 * (`synth_attachment_uploads_total{outcome,kind}`, `synth_attachment_upload_bytes`).
 */
describe('AttachmentService: метрики загрузки (ADR-094)', () => {
  let tmpDir: string;
  let blobs: FileBlobStore;
  let registry: MetricsRegistry;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-attachments-metrics-'));
    blobs = new FileBlobStore({ root: join(tmpDir, 'blobs') });
    registry = new MetricsRegistry();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('ok: счётчик по исходу/виду и гистограмма размера принятого файла', async () => {
    const service = new AttachmentService({
      blobs,
      config: testConfig(),
      metrics: createAttachmentMetrics(registry),
    });
    const meta = await service.upload({ sessionId: 's1', bytes: pngWithText(), name: 'a.png' });

    const text = registry.render().text;
    expect(text).toContain('synth_attachment_uploads_total{outcome="ok",kind="image"} 1');
    expect(text).toContain(`synth_attachment_upload_bytes_sum{kind="image"} ${meta.size}`);
    expect(text).toContain('synth_attachment_upload_bytes_count{kind="image"} 1');
  });

  it('too_large: исход `too_large`, гистограмма не наблюдает файл', async () => {
    const service = new AttachmentService({
      blobs,
      config: testConfig({ maxBytesPerFile: 16 }),
      metrics: createAttachmentMetrics(registry),
    });
    await expect(service.upload({ sessionId: 's1', bytes: pngWithText() })).rejects.toMatchObject({
      code: 'too_large',
    });

    const text = registry.render().text;
    expect(text).toContain('synth_attachment_uploads_total{outcome="too_large",kind="image"} 1');
    expect(text).not.toContain('synth_attachment_upload_bytes_count');
  });

  it('unsupported: запрещённый MIME (SVG) и пустой файл', async () => {
    const service = new AttachmentService({
      blobs,
      config: testConfig(),
      metrics: createAttachmentMetrics(registry),
    });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await expect(service.upload({ sessionId: 's1', bytes: svg })).rejects.toMatchObject({
      code: 'unsupported_mime',
    });
    await expect(service.upload({ sessionId: 's1', bytes: Buffer.alloc(0) })).rejects.toMatchObject({
      code: 'unsupported_mime',
    });

    const text = registry.render().text;
    expect(text).toContain('synth_attachment_uploads_total{outcome="unsupported",kind="image"} 1');
    expect(text).toContain('synth_attachment_uploads_total{outcome="unsupported",kind="file"} 1');
  });

  it('без метрик загрузка работает как раньше (no-op)', async () => {
    const service = new AttachmentService({ blobs, config: testConfig() });
    const meta = await service.upload({ sessionId: 's1', bytes: pngWithText() });
    expect(meta.mime).toBe('image/png');
  });
});
