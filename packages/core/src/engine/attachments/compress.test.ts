/**
 * ADR-115: сжатие вложений на границе отправки провайдеру.
 *
 * `ffmpeg` не запускается: медиа-раннер инъектируется. Проверяются пороги
 * (minBytes/размеры), выбор формата и аргументов, кэш по профилю, отказ от
 * копии, которая не меньше оригинала, и безопасная деградация при ошибке.
 */

import { describe, expect, it, vi } from 'vitest';
import { attachmentsConfigSchema, type AttachmentsConfig } from '@itphx/synth-shared';
import { MemoryBlobStore } from '../../storage/memory/content.js';
import type { MediaRunRequest, MediaRunResult, MediaRunnerLike } from '../media/runner.js';
import {
  AttachmentCompressor,
  COMPRESS_CACHE_DIR,
  jpegQualityValue,
  resolveCompressTarget,
  resolveNativeAudioFormat,
  type AttachmentCompressTarget,
} from './compress.js';

const SHA = 'b'.repeat(64);
const BLOB_PATH = `attachments/${SHA.slice(0, 2)}/${SHA}`;

function configPatch(
  patch: Partial<AttachmentsConfig['compression']> = {},
): AttachmentsConfig['compression'] {
  return { ...attachmentsConfigSchema.parse({}).compression, ...patch };
}

function fakeRunner(
  output: Buffer | null,
  calls: MediaRunRequest[] = [],
): MediaRunnerLike {
  return {
    isRemote: false,
    run: vi.fn(async (request: MediaRunRequest): Promise<MediaRunResult> => {
      calls.push(request);
      return output
        ? { ok: true, outputs: [output] }
        : { ok: false, outputs: [], reason: 'no_ffmpeg', error: 'ENOENT' };
    }),
  };
}

async function setup(bytes: Buffer): Promise<MemoryBlobStore> {
  const blobs = new MemoryBlobStore();
  await blobs.write(BLOB_PATH, bytes);
  return blobs;
}

function compressor(
  blobs: MemoryBlobStore,
  runner: MediaRunnerLike,
  config: AttachmentsConfig['compression'] = configPatch(),
): AttachmentCompressor {
  return new AttachmentCompressor({ blobs, runner, config: () => config });
}

describe('AttachmentCompressor: image', () => {
  it('большая картинка → JPEG по качеству и scale длинной стороны', async () => {
    const blobs = await setup(Buffer.alloc(2 * 1024 * 1024));
    const compressed = Buffer.alloc(400 * 1024);
    const calls: MediaRunRequest[] = [];

    const result = await compressor(blobs, fakeRunner(compressed, calls)).compress(
      { blobPath: BLOB_PATH, mime: 'image/jpeg', family: 'image', size: 2 * 1024 * 1024, width: 3000, height: 2000 },
      { audioFormat: null, nativeVideo: false },
    );

    expect(result).not.toBeNull();
    expect(result!.blobPath.startsWith(`${COMPRESS_CACHE_DIR}/`)).toBe(true);
    expect(result!.mime).toBe('image/jpeg');
    expect(result!.size).toBe(compressed.length);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      inputBlobPath: BLOB_PATH,
      capture: 'file',
      maxOutputBytes: 32 * 1024 * 1024,
    });
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining(["scale='min(2048,iw)':-2", '-q:v', String(jpegQualityValue(85))]),
    );
    expect(await blobs.read(result!.blobPath)).toEqual(compressed);
  });

  it('PNG остаётся PNG: lossless scale и -compression_level вместо -q:v', async () => {
    const blobs = await setup(Buffer.alloc(2 * 1024 * 1024));
    const calls: MediaRunRequest[] = [];

    const result = await compressor(blobs, fakeRunner(Buffer.alloc(1024), calls)).compress(
      { blobPath: BLOB_PATH, mime: 'image/png', family: 'image', size: 2 * 1024 * 1024, width: 4000, height: 3000 },
      { audioFormat: null, nativeVideo: false },
    );

    expect(result?.mime).toBe('image/png');
    expect(result?.blobPath.endsWith('.png')).toBe(true);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['-c:v', 'png', '-compression_level', '9']));
    expect(calls[0]!.args).not.toContain('-q:v');
  });

  it('маленькая картинка в пределах размеров → не сжимаем (раннер не вызывается)', async () => {
    const blobs = await setup(Buffer.alloc(1000));
    const calls: MediaRunRequest[] = [];

    const result = await compressor(blobs, fakeRunner(Buffer.alloc(100), calls)).compress(
      { blobPath: BLOB_PATH, mime: 'image/jpeg', family: 'image', size: 1000, width: 800, height: 600 },
      { audioFormat: null, nativeVideo: false },
    );

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('размеры превышают предел → сжимаем даже при size < minBytes', async () => {
    const blobs = await setup(Buffer.alloc(500));
    const calls: MediaRunRequest[] = [];

    const result = await compressor(blobs, fakeRunner(Buffer.alloc(100), calls)).compress(
      { blobPath: BLOB_PATH, mime: 'image/jpeg', family: 'image', size: 500, width: 4000, height: 1000 },
      { audioFormat: null, nativeVideo: false },
    );

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe('AttachmentCompressor: video', () => {
  it('нативное видео → H.264/MP4 с битрейтом, аудио и scale по высоте', async () => {
    const blobs = await setup(Buffer.alloc(10 * 1024 * 1024));
    const calls: MediaRunRequest[] = [];

    const result = await compressor(blobs, fakeRunner(Buffer.alloc(1024 * 1024), calls)).compress(
      { blobPath: BLOB_PATH, mime: 'video/mp4', family: 'video', size: 10 * 1024 * 1024, height: 1080 },
      { audioFormat: null, nativeVideo: true },
    );

    expect(result?.mime).toBe('video/mp4');
    expect(result?.blobPath.endsWith('.mp4')).toBe(true);
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining([
        "scale=-2:'min(720,ih)'",
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-b:v', '2000k',
        '-maxrate', '3000k',
        '-bufsize', '4000k',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-movflags', '+faststart',
        '-f', 'mp4',
      ]),
    );
  });

  it('транспорт не принимает видео нативно → сжатие не участвует', async () => {
    const blobs = await setup(Buffer.alloc(10 * 1024 * 1024));
    const calls: MediaRunRequest[] = [];

    const result = await compressor(blobs, fakeRunner(Buffer.alloc(1024), calls)).compress(
      { blobPath: BLOB_PATH, mime: 'video/mp4', family: 'video', size: 10 * 1024 * 1024, height: 1080 },
      { audioFormat: null, nativeVideo: false },
    );

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('короткое видео в пределах высоты → не сжимаем', async () => {
    const blobs = await setup(Buffer.alloc(1024 * 1024));
    const calls: MediaRunRequest[] = [];

    const result = await compressor(blobs, fakeRunner(Buffer.alloc(1024), calls)).compress(
      { blobPath: BLOB_PATH, mime: 'video/mp4', family: 'video', size: 1024 * 1024, height: 480 },
      { audioFormat: null, nativeVideo: true },
    );

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('небольшой файл без известной высоты → не сжимаем', async () => {
    const blobs = await setup(Buffer.alloc(1024 * 1024));
    const calls: MediaRunRequest[] = [];

    const result = await compressor(blobs, fakeRunner(Buffer.alloc(1024), calls)).compress(
      { blobPath: BLOB_PATH, mime: 'video/mp4', family: 'video', size: 1024 * 1024 },
      { audioFormat: null, nativeVideo: true },
    );

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('AttachmentCompressor: audio', () => {
  it('mp3: libmp3lame с битрейтом, каналами и частотой', async () => {
    const blobs = await setup(Buffer.alloc(5 * 1024 * 1024));
    const calls: MediaRunRequest[] = [];

    const result = await compressor(blobs, fakeRunner(Buffer.alloc(512 * 1024), calls)).compress(
      { blobPath: BLOB_PATH, mime: 'audio/ogg', family: 'audio', size: 5 * 1024 * 1024 },
      { audioFormat: 'mp3', nativeVideo: false },
    );

    expect(result?.mime).toBe('audio/mpeg');
    expect(result?.blobPath.endsWith('.mp3')).toBe(true);
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining([
        '-c:a', 'libmp3lame',
        '-b:a', '64k',
        '-ac', '1',
        '-ar', '16000',
        '-f', 'mp3',
      ]),
    );
  });

  it('wav: pcm_s16le без битрейта', async () => {
    const blobs = await setup(Buffer.alloc(5 * 1024 * 1024));
    const calls: MediaRunRequest[] = [];

    const result = await compressor(blobs, fakeRunner(Buffer.alloc(512 * 1024), calls)).compress(
      { blobPath: BLOB_PATH, mime: 'audio/ogg', family: 'audio', size: 5 * 1024 * 1024 },
      { audioFormat: 'wav', nativeVideo: false },
    );

    expect(result?.mime).toBe('audio/wav');
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['-c:a', 'pcm_s16le', '-f', 'wav']));
    expect(calls[0]!.args).not.toContain('-b:a');
  });

  it('транспорт не принимает контейнер (audioFormat=null) → не сжимаем', async () => {
    const blobs = await setup(Buffer.alloc(5 * 1024 * 1024));
    const calls: MediaRunRequest[] = [];

    const result = await compressor(blobs, fakeRunner(Buffer.alloc(1024), calls)).compress(
      { blobPath: BLOB_PATH, mime: 'audio/ogg', family: 'audio', size: 5 * 1024 * 1024 },
      { audioFormat: null, nativeVideo: false },
    );

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('файл меньше minBytes → не сжимаем', async () => {
    const blobs = await setup(Buffer.alloc(1024));
    const calls: MediaRunRequest[] = [];

    const result = await compressor(blobs, fakeRunner(Buffer.alloc(512), calls)).compress(
      { blobPath: BLOB_PATH, mime: 'audio/ogg', family: 'audio', size: 1024 },
      { audioFormat: 'mp3', nativeVideo: false },
    );

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('AttachmentCompressor: кэш и деградация', () => {
  it('второй вызов берёт кэш и не запускает раннер', async () => {
    const blobs = await setup(Buffer.alloc(2 * 1024 * 1024));
    const calls: MediaRunRequest[] = [];
    const runner = fakeRunner(Buffer.alloc(1024), calls);
    const service = compressor(blobs, runner);
    const input = {
      blobPath: BLOB_PATH,
      mime: 'image/jpeg',
      family: 'image' as const,
      size: 2 * 1024 * 1024,
      width: 3000,
      height: 2000,
    };
    const target: AttachmentCompressTarget = { audioFormat: null, nativeVideo: false };

    const first = await service.compress(input, target);
    const second = await service.compress(input, target);

    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('сжатая копия не меньше оригинала → null и кэш не пишется', async () => {
    const blobs = await setup(Buffer.alloc(100));
    const calls: MediaRunRequest[] = [];

    const result = await compressor(blobs, fakeRunner(Buffer.alloc(200), calls)).compress(
      { blobPath: BLOB_PATH, mime: 'image/jpeg', family: 'image', size: 100 },
      { audioFormat: null, nativeVideo: false },
    );

    expect(result).toBeNull();
    expect(await blobs.list(COMPRESS_CACHE_DIR)).toEqual([]);
  });

  it('ошибка раннера → null, ход не падает', async () => {
    const blobs = await setup(Buffer.alloc(2 * 1024 * 1024));
    const logs: string[] = [];
    const service = new AttachmentCompressor({
      blobs,
      runner: fakeRunner(null),
      config: () => configPatch(),
      log: (message) => logs.push(message),
    });

    const result = await service.compress(
      { blobPath: BLOB_PATH, mime: 'image/jpeg', family: 'image', size: 2 * 1024 * 1024, width: 3000, height: 2000 },
      { audioFormat: null, nativeVideo: false },
    );

    expect(result).toBeNull();
    expect(logs.some((line) => line.includes('сжатие не выполнено'))).toBe(true);
  });

  it('мастер-выключатель и выключатель семейства → не сжимаем', async () => {
    const blobs = await setup(Buffer.alloc(2 * 1024 * 1024));
    const calls: MediaRunRequest[] = [];

    const masterOff = await compressor(
      blobs,
      fakeRunner(Buffer.alloc(1024), calls),
      configPatch({ enabled: false }),
    ).compress(
      { blobPath: BLOB_PATH, mime: 'image/jpeg', family: 'image', size: 2 * 1024 * 1024, width: 3000, height: 2000 },
      { audioFormat: null, nativeVideo: false },
    );
    const familyOff = await compressor(
      blobs,
      fakeRunner(Buffer.alloc(1024), calls),
      configPatch({ image: { ...configPatch().image, enabled: false } }),
    ).compress(
      { blobPath: BLOB_PATH, mime: 'image/jpeg', family: 'image', size: 2 * 1024 * 1024, width: 3000, height: 2000 },
      { audioFormat: null, nativeVideo: false },
    );

    expect(masterOff).toBeNull();
    expect(familyOff).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('имя файла получает расширение целевого формата', async () => {
    const blobs = await setup(Buffer.alloc(2 * 1024 * 1024));

    const result = await compressor(blobs, fakeRunner(Buffer.alloc(1024))).compress(
      { blobPath: BLOB_PATH, mime: 'image/webp', family: 'image', name: 'photo.webp', size: 2 * 1024 * 1024, width: 3000, height: 2000 },
      { audioFormat: null, nativeVideo: false },
    );

    expect(result?.name).toBe('photo.jpg');
  });
});

describe('resolveCompressTarget', () => {
  it('официальный OpenAI: mp3, без нативного видео', () => {
    expect(resolveCompressTarget('openai', 'https://api.openai.com/v1')).toEqual({
      audioFormat: 'mp3',
      nativeVideo: false,
    });
  });

  it('RouterAI: mp3 и нативное видео', () => {
    expect(resolveCompressTarget('openai', 'https://routerai.ru/v1')).toEqual({
      audioFormat: 'mp3',
      nativeVideo: true,
    });
  });

  it('официальный Anthropic: ни аудио, ни видео', () => {
    expect(resolveCompressTarget('anthropic', 'https://api.anthropic.com')).toEqual({
      audioFormat: null,
      nativeVideo: false,
    });
  });

  it('Anthropic-совместимый RouterAI: только wav', () => {
    expect(resolveNativeAudioFormat('anthropic', 'https://routerai.ru/v1')).toBe('wav');
  });
});
