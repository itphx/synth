/**
 * ADR-115: обработка вложения моделью-обработчиком (aux) — `deriveModalityText`.
 *
 * Реальные бинарники не вызываются: `chat`/`runFfmpeg` — моки, blob-хранилище —
 * in-memory (`MemoryBlobStore`). Проверяются: что уходит aux-модели, транскод
 * аудио, кадры видео, кэш результата (ключ, попадание, битая запись) и что
 * внешние сбои не бросаются наружу.
 */

import { describe, it, expect, vi } from 'vitest';
import type { MediaPartData, Part } from '@itphx/synth-shared';
import { MemoryBlobStore } from '../../storage/memory/content.js';
import {
  deriveCacheKey,
  deriveCachePath,
  deriveModalityText,
  deriveVideoAudioText,
  splitJpegFrames,
  type DeriveDeps,
  type DeriveFamily,
  type DeriveInput,
} from './derive.js';

const BLOB_PATH = 'attachments/aa/deadbeef';

/** JPEG-кадр: SOI … EOI (минимум, достаточный для разбора потока). */
function jpegFrame(index: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, index, 0x01, 0x02, 0xff, 0xd9]);
}

/** Медиа-часть вложения (как её собирает `AttachmentService.buildMediaPart`). */
function mediaPart(type: Part['type'], data: Partial<MediaPartData> = {}): Part {
  return {
    id: `p-${type}`,
    type,
    data: {
      blobPath: BLOB_PATH,
      sha256: 'a'.repeat(64),
      mime: 'image/png',
      size: 4,
      ...data,
    },
  };
}

/** Вход обработки: семейство + MIME + готовая часть. */
function makeInput(
  family: DeriveFamily,
  overrides: Partial<DeriveInput> = {},
): DeriveInput {
  const mime =
    overrides.mime ??
    (family === 'pdf' ? 'application/pdf' : `${family}/x-test`);
  const partType: Part['type'] = family === 'pdf' ? 'file' : family;
  return {
    family,
    mime,
    name: 'voice.ogg',
    blobPath: BLOB_PATH,
    part: mediaPart(partType, { mime }),
    provider: 'aux',
    model: 'vision-1',
    language: 'ru',
    ...overrides,
  };
}

/** Зависимости с моками; `bytes` — исходный объект вложения. */
function makeDeps(
  opts: {
    bytes?: Buffer;
    hasFfmpeg?: boolean;
    runFfmpeg?: DeriveDeps['runFfmpeg'];
    text?: string;
  } = {},
): DeriveDeps & {
  blobs: MemoryBlobStore;
  chat: ReturnType<typeof vi.fn>;
  runFfmpegSpy: ReturnType<typeof vi.fn>;
} {
  const blobs = new MemoryBlobStore();
  if (opts.bytes) void blobs.write(BLOB_PATH, opts.bytes);
  const chat = vi.fn(async () => ({ text: opts.text ?? 'ОПИСАНИЕ' }));
  const runFfmpegSpy = vi.fn(
    opts.runFfmpeg ?? (async (): Promise<Buffer[]> => [Buffer.from('derived')]),
  );
  const deps: DeriveDeps = {
    blobs,
    chat: chat as unknown as DeriveDeps['chat'],
    runFfmpeg: runFfmpegSpy as unknown as DeriveDeps['runFfmpeg'],
    hasFfmpeg: () => opts.hasFfmpeg ?? false,
    promptTemplate: (language) =>
      language === 'ru'
        ? 'МОДАЛЬНОСТЬ {modality}, ФАЙЛ {name}. Верни только результат.'
        : 'MODALITY {modality}, FILE {name}. Return only the result.',
  };
  return { ...deps, blobs, chat, runFfmpegSpy };
}

describe('deriveModalityText: image / pdf', () => {
  it('image: aux-модель получает часть как есть и русский промпт с модальностью/именем', async () => {
    const deps = makeDeps();
    const input = makeInput('image', { mime: 'image/png', name: 'схема.png' });

    const result = await deriveModalityText(input, deps);

    expect(result).toEqual({ ok: true, text: 'ОПИСАНИЕ', cached: false });
    expect(deps.chat).toHaveBeenCalledTimes(1);
    const [parts, prompt] = deps.chat.mock.calls[0]! as unknown as [Part[], string];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(input.part);
    expect(prompt).toContain('image');
    expect(prompt).toContain('схема.png');
    expect(prompt).not.toContain('{modality}');
    expect(prompt).not.toContain('{name}');
  });

  it('image: английский язык → английский шаблон', async () => {
    const deps = makeDeps();
    await deriveModalityText(
      makeInput('image', { mime: 'image/jpeg', language: 'en' }),
      deps,
    );
    const prompt = deps.chat.mock.calls[0]![1] as string;
    expect(prompt.startsWith('MODALITY image')).toBe(true);
  });

  it('pdf: часть уходит как есть, промпт про pdf', async () => {
    const deps = makeDeps();
    const input = makeInput('pdf', { mime: 'application/pdf', name: 'доклад.pdf' });

    const result = await deriveModalityText(input, deps);

    expect(result.ok).toBe(true);
    const [parts, prompt] = deps.chat.mock.calls[0]! as unknown as [Part[], string];
    expect(parts).toEqual([input.part]);
    expect(prompt).toContain('pdf');
    expect(prompt).toContain('доклад.pdf');
    expect(deps.runFfmpegSpy).not.toHaveBeenCalled();
  });

  it('имени нет — в промпте прочерк (плейсхолдер всё равно подставлен)', async () => {
    const deps = makeDeps();
    await deriveModalityText(makeInput('image', { mime: 'image/png', name: undefined }), deps);
    const prompt = deps.chat.mock.calls[0]![1] as string;
    expect(prompt).toContain('ФАЙЛ —');
  });
});

describe('deriveModalityText: audio', () => {
  it('wav уходит провайдеру как есть — ffmpeg не нужен и не вызывается', async () => {
    const deps = makeDeps({ hasFfmpeg: false });
    const input = makeInput('audio', { mime: 'audio/wav', name: 'запись.wav' });

    const result = await deriveModalityText(input, deps);

    expect(result.ok).toBe(true);
    expect(deps.runFfmpegSpy).not.toHaveBeenCalled();
    const [parts] = deps.chat.mock.calls[0]! as unknown as [Part[], string];
    expect(parts).toEqual([input.part]);
  });

  it('mp3 уходит провайдеру как есть', async () => {
    const deps = makeDeps({ hasFfmpeg: false });
    const input = makeInput('audio', { mime: 'audio/mpeg', name: 'запись.mp3' });

    await deriveModalityText(input, deps);

    expect(deps.runFfmpegSpy).not.toHaveBeenCalled();
    expect(deps.chat.mock.calls[0]![0]).toEqual([input.part]);
  });

  it('ogg транскодируется в wav 16k mono, часть ссылается на производный объект', async () => {
    const wav = Buffer.from('RIFF....WAVE');
    const deps = makeDeps({
      bytes: Buffer.from('OggS....'),
      hasFfmpeg: true,
      runFfmpeg: async () => [wav],
    });
    const input = makeInput('audio', { mime: 'audio/ogg', name: 'голос.ogg' });

    const result = await deriveModalityText(input, deps);

    expect(result).toEqual({ ok: true, text: 'ОПИСАНИЕ', cached: false });
    const [args, stdin] = deps.runFfmpegSpy.mock.calls[0]! as unknown as [string[], Buffer];
    expect(args).toEqual(
      expect.arrayContaining(['-i', 'pipe:0', '-f', 'wav', '-ar', '16000', '-ac', '1', 'pipe:1']),
    );
    expect(stdin.toString()).toBe('OggS....');

    const [parts] = deps.chat.mock.calls[0]! as unknown as [Part[], string];
    expect(parts).toHaveLength(1);
    const part = parts[0]!;
    expect(part.type).toBe('audio');
    const data = part.data as MediaPartData;
    expect(data.mime).toBe('audio/wav');
    expect(data.blobPath).toBe(`attachments/.derived/${deriveCacheKey(input)}.wav`);
    // Производный объект действительно записан и содержит результат транскода.
    expect(await deps.blobs.read(data.blobPath)).toEqual(wav);
    expect(data.size).toBe(wav.length);
  });

  it('нет ffmpeg → no_ffmpeg, aux-модель не вызывается', async () => {
    const deps = makeDeps({ bytes: Buffer.from('OggS....'), hasFfmpeg: false });
    const result = await deriveModalityText(makeInput('audio', { mime: 'audio/ogg' }), deps);
    expect(result).toEqual({ ok: false, reason: 'no_ffmpeg' });
    expect(deps.chat).not.toHaveBeenCalled();
    expect(deps.runFfmpegSpy).not.toHaveBeenCalled();
  });

  it('ffmpeg упал → failed, без исключения', async () => {
    const log = vi.fn();
    const deps = makeDeps({
      bytes: Buffer.from('OggS....'),
      hasFfmpeg: true,
      runFfmpeg: async () => {
        throw new Error('ffmpeg exited with 1');
      },
    });
    const result = await deriveModalityText(makeInput('audio', { mime: 'audio/ogg' }), {
      ...deps,
      log,
    });
    expect(result).toEqual({ ok: false, reason: 'failed' });
    expect(deps.chat).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ffmpeg'));
  });
});

describe('deriveVideoAudioText (аудиодорожка видео)', () => {
  const input = {
    mime: 'video/mp4',
    name: 'ролик.mp4',
    blobPath: BLOB_PATH,
    provider: 'aux',
    model: 'audio-1',
    language: 'ru' as const,
  };

  it('извлекает дорожку (-vn) и отдаёт aux-модели аудио; результат кэшируется', async () => {
    const wav = Buffer.from('RIFF....WAVE');
    const deps = makeDeps({
      bytes: Buffer.from('....ftyp'),
      hasFfmpeg: true,
      runFfmpeg: async () => [wav],
      text: 'транскрипт речи',
    });

    const result = await deriveVideoAudioText(input, deps);

    expect(result).toEqual({ ok: true, text: 'транскрипт речи', cached: false });
    const [args, stdin] = deps.runFfmpegSpy.mock.calls[0]! as unknown as [string[], Buffer];
    // `-vn` — без него ffmpeg пишет видеопоток в wav и падает.
    expect(args).toEqual(
      expect.arrayContaining(['-vn', '-i', 'pipe:0', '-f', 'wav', '-ar', '16000', '-ac', '1', 'pipe:1']),
    );
    expect(stdin.toString()).toBe('....ftyp');

    const [parts, prompt] = deps.chat.mock.calls[0]! as unknown as [Part[], string];
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe('audio');
    const data = parts[0]!.data as MediaPartData;
    expect(data.mime).toBe('audio/wav');
    expect(data.blobPath).toBe(
      `attachments/.derived/${deriveCacheKey({ ...input, family: 'video-audio' })}.wav`,
    );
    expect(await deps.blobs.read(data.blobPath)).toEqual(wav);
    // Промпт — как для аудио (транскрипт), а не «описание по кадрам».
    expect(prompt).toContain('audio');
    expect(prompt).toContain('ролик.mp4');

    const cachePath = deriveCachePath({ ...input, family: 'video-audio' });
    expect((await deps.blobs.read(cachePath))?.toString('utf-8')).toContain('транскрипт речи');
  });

  it('повторный вызов — из кэша: ffmpeg и aux-модель не вызываются', async () => {
    const deps = makeDeps({
      bytes: Buffer.from('....ftyp'),
      hasFfmpeg: true,
      runFfmpeg: async () => [Buffer.from('RIFF....WAVE')],
      text: 'транскрипт речи',
    });
    await deriveVideoAudioText(input, deps);
    deps.chat.mockClear();
    deps.runFfmpegSpy.mockClear();

    const second = await deriveVideoAudioText(input, deps);

    expect(second).toEqual({ ok: true, text: 'транскрипт речи', cached: true });
    expect(deps.chat).not.toHaveBeenCalled();
    expect(deps.runFfmpegSpy).not.toHaveBeenCalled();
  });

  it('нет ffmpeg → no_ffmpeg, aux-модель не вызывается', async () => {
    const deps = makeDeps({ bytes: Buffer.from('....ftyp'), hasFfmpeg: false });

    const result = await deriveVideoAudioText(input, deps);

    expect(result).toEqual({ ok: false, reason: 'no_ffmpeg' });
    expect(deps.chat).not.toHaveBeenCalled();
    expect(deps.runFfmpegSpy).not.toHaveBeenCalled();
  });

  it('MIME не видео → unsupported (транскод не запускается)', async () => {
    const deps = makeDeps({ bytes: Buffer.from('OggS'), hasFfmpeg: true });

    const result = await deriveVideoAudioText({ ...input, mime: 'audio/ogg' }, deps);

    expect(result).toEqual({ ok: false, reason: 'unsupported' });
    expect(deps.runFfmpegSpy).not.toHaveBeenCalled();
  });

  it('aux-модель упала → failed, без исключения', async () => {
    const log = vi.fn();
    const deps = makeDeps({
      bytes: Buffer.from('....ftyp'),
      hasFfmpeg: true,
      runFfmpeg: async () => [Buffer.from('RIFF....WAVE')],
    });
    deps.chat.mockRejectedValueOnce(new Error('aux down'));

    const result = await deriveVideoAudioText(input, { ...deps, log });

    expect(result).toEqual({ ok: false, reason: 'failed' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('aux-модель'));
  });
});

describe('deriveModalityText: video', () => {
  it('5 кадров → 5 image-частей, промпт про видео', async () => {
    const frames = [0, 1, 2, 3, 4].map(jpegFrame);
    const deps = makeDeps({
      bytes: Buffer.from('....ftyp'),
      hasFfmpeg: true,
      runFfmpeg: async () => frames,
    });
    const input = makeInput('video', { mime: 'video/mp4', name: 'демо.mp4' });

    const result = await deriveModalityText(input, deps);

    expect(result.ok).toBe(true);
    const [parts, prompt] = deps.chat.mock.calls[0]! as unknown as [Part[], string];
    expect(parts).toHaveLength(5);
    for (const [index, part] of parts.entries()) {
      expect(part.type).toBe('image');
      const data = part.data as MediaPartData;
      expect(data.mime).toBe('image/jpeg');
      expect(await deps.blobs.read(data.blobPath)).toEqual(frames[index]);
    }
    expect(prompt).toContain('video');
    expect(prompt).toContain('демо.mp4');
    const [args] = deps.runFfmpegSpy.mock.calls[0]! as unknown as [string[], Buffer];
    expect(args).toEqual(
      expect.arrayContaining(['-frames:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']),
    );
  });

  it('длительность известна → fps считается по ней (равномерно по ролику)', async () => {
    const frames = [0, 1, 2, 3, 4].map(jpegFrame);
    const deps = makeDeps({
      bytes: Buffer.from('....ftyp'),
      hasFfmpeg: true,
      runFfmpeg: async () => frames,
    });
    const input = makeInput('video', {
      mime: 'video/mp4',
      part: mediaPart('video', { mime: 'video/mp4', durationMs: 10_000 }),
    });

    await deriveModalityText(input, deps);

    const [args] = deps.runFfmpegSpy.mock.calls[0]! as unknown as [string[], Buffer];
    const filter = args[args.indexOf('-vf') + 1]!;
    expect(filter).toContain('fps=0.5000');
  });

  it('склеенный mjpeg-поток разбивается на кадры', async () => {
    const frames = [0, 1, 2, 3, 4].map(jpegFrame);
    const deps = makeDeps({
      bytes: Buffer.from('....ftyp'),
      hasFfmpeg: true,
      // Реальный ffmpeg отдаёт один поток `image2pipe` без контейнера.
      runFfmpeg: async () => [Buffer.concat(frames)],
    });

    await deriveModalityText(makeInput('video', { mime: 'video/mp4' }), deps);

    const [parts] = deps.chat.mock.calls[0]! as unknown as [Part[], string];
    expect(parts).toHaveLength(5);
  });

  it('нет ffmpeg → no_ffmpeg (видео без кадров не обрабатывается)', async () => {
    const deps = makeDeps({ bytes: Buffer.from('....ftyp'), hasFfmpeg: false });
    const result = await deriveModalityText(makeInput('video', { mime: 'video/mp4' }), deps);
    expect(result).toEqual({ ok: false, reason: 'no_ffmpeg' });
    expect(deps.chat).not.toHaveBeenCalled();
  });

  it('ffmpeg не извлёк кадров → failed', async () => {
    const deps = makeDeps({
      bytes: Buffer.from('....ftyp'),
      hasFfmpeg: true,
      runFfmpeg: async () => [],
    });
    const result = await deriveModalityText(makeInput('video', { mime: 'video/mp4' }), deps);
    expect(result).toEqual({ ok: false, reason: 'failed' });
    expect(deps.chat).not.toHaveBeenCalled();
  });
});

describe('deriveModalityText: кэш результата', () => {
  it('второй вызов берёт текст из кэша и не зовёт aux-модель', async () => {
    const deps = makeDeps();
    const input = makeInput('image', { mime: 'image/png' });

    const first = await deriveModalityText(input, deps);
    const second = await deriveModalityText(input, deps);

    expect(first).toEqual({ ok: true, text: 'ОПИСАНИЕ', cached: false });
    expect(second).toEqual({ ok: true, text: 'ОПИСАНИЕ', cached: true });
    expect(deps.chat).toHaveBeenCalledTimes(1);
    // Кэш лежит по документированному пути и в документированном формате.
    const raw = await deps.blobs.read(deriveCachePath(input));
    const parsed = JSON.parse(raw!.toString('utf-8')) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
    expect(parsed.text).toBe('ОПИСАНИЕ');
    expect(typeof parsed.at).toBe('string');
  });

  it('битый кэш → пересчёт', async () => {
    const deps = makeDeps();
    const input = makeInput('image', { mime: 'image/png' });
    await deps.blobs.write(deriveCachePath(input), '{не json');

    const result = await deriveModalityText(input, deps);

    expect(result.ok).toBe(true);
    expect(deps.chat).toHaveBeenCalledTimes(1);
  });

  it('кэш чужой версии/пустой текст → пересчёт', async () => {
    const deps = makeDeps();
    const input = makeInput('image', { mime: 'image/png' });
    await deps.blobs.write(
      deriveCachePath(input),
      JSON.stringify({ version: 2, text: 'СТАРОЕ', at: '2020-01-01T00:00:00.000Z' }),
    );

    const result = await deriveModalityText(input, deps);

    expect(result).toMatchObject({ ok: true, cached: false });
    expect(deps.chat).toHaveBeenCalledTimes(1);
  });

  it('ошибка записи кэша не ломает обработку', async () => {
    const deps = makeDeps();
    const write = deps.blobs.write.bind(deps.blobs);
    deps.blobs.write = async (): Promise<void> => {
      throw new Error('нет места');
    };

    const result = await deriveModalityText(makeInput('image', { mime: 'image/png' }), deps);

    expect(result.ok).toBe(true);
    deps.blobs.write = write;
  });

  it('ключ кэша различается по provider/model/family', () => {
    const base = { blobPath: BLOB_PATH, provider: 'aux', model: 'm1', family: 'image' as const };
    expect(deriveCacheKey(base)).toBe(deriveCacheKey({ ...base }));
    expect(deriveCacheKey(base)).not.toBe(deriveCacheKey({ ...base, provider: 'other' }));
    expect(deriveCacheKey(base)).not.toBe(deriveCacheKey({ ...base, model: 'm2' }));
    expect(deriveCacheKey(base)).not.toBe(deriveCacheKey({ ...base, family: 'pdf' }));
    expect(deriveCacheKey(base)).not.toBe(
      deriveCacheKey({ ...base, blobPath: 'attachments/bb/other' }),
    );
    expect(deriveCacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('deriveModalityText: сбои и неподходящие вложения', () => {
  it('aux-модель бросила → failed, исключение не выходит наружу', async () => {
    const log = vi.fn();
    const deps = makeDeps();
    const chat = vi.fn(async () => {
      throw new Error('provider 500');
    });
    const result = await deriveModalityText(makeInput('image', { mime: 'image/png' }), {
      ...deps,
      chat: chat as unknown as DeriveDeps['chat'],
      log,
    });

    expect(result).toEqual({ ok: false, reason: 'failed' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('provider 500'));
  });

  it('пустой ответ aux-модели → failed (и не кэшируется)', async () => {
    const deps = makeDeps({ text: '   ' });
    const input = makeInput('image', { mime: 'image/png' });
    const first = await deriveModalityText(input, deps);
    const second = await deriveModalityText(input, deps);

    expect(first).toEqual({ ok: false, reason: 'failed' });
    expect(second).toEqual({ ok: false, reason: 'failed' });
    expect(deps.chat).toHaveBeenCalledTimes(2);
  });

  it('MIME не относится к семейству → unsupported', async () => {
    const deps = makeDeps();
    const result = await deriveModalityText(
      makeInput('image', { mime: 'audio/ogg' }),
      deps,
    );
    expect(result).toEqual({ ok: false, reason: 'unsupported' });
    expect(deps.chat).not.toHaveBeenCalled();
  });

  it('часть без blobPath → unsupported', async () => {
    const deps = makeDeps();
    const input = makeInput('pdf', {
      mime: 'application/pdf',
      part: { id: 'p', type: 'file', data: { mime: 'application/pdf' } },
    });
    expect(await deriveModalityText(input, deps)).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('объект не прочитан → failed', async () => {
    const deps = makeDeps({ hasFfmpeg: true });
    const result = await deriveModalityText(makeInput('audio', { mime: 'audio/ogg' }), deps);
    expect(result).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('splitJpegFrames', () => {
  it('склеенный поток → отдельные кадры', () => {
    const frames = [0, 1, 2].map(jpegFrame);
    expect(splitJpegFrames(Buffer.concat(frames))).toEqual(frames);
  });

  it('нет кадров → пустой список', () => {
    expect(splitJpegFrames(Buffer.from('not a jpeg'))).toEqual([]);
  });
});
