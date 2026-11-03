/**
 * ADR-115: серверные миниатюры вложений.
 *
 * `ffmpeg` не запускается: медиа-раннер инъектируется. Проверяются kinds
 * (`image`/`video` → кадр, `audio` → none), content-addressed путь `.thumbs`,
 * sidecar `thumb` и то, что ошибка генерации не бросается наружу.
 */

import { describe, expect, it, vi } from 'vitest';
import { MemoryBlobStore } from '../../storage/memory/content.js';
import type { MediaRunRequest, MediaRunnerLike } from '../media/runner.js';
import { jpegSize, parseFfmpegDurationMs, ThumbnailService } from './thumbnails.js';

const SHA = 'a'.repeat(64);
const BLOB_PATH = `attachments/${SHA.slice(0, 2)}/${SHA}`;

/** Минимальный JPEG с маркером SOF0 (размеры читаются без декодера). */
function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x22, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

function fakeRunner(
  result: Awaited<ReturnType<MediaRunnerLike['run']>>,
  calls: MediaRunRequest[] = [],
): MediaRunnerLike {
  return {
    isRemote: false,
    run: vi.fn(async (request: MediaRunRequest) => {
      calls.push(request);
      return result;
    }),
  };
}

async function setup(bytes: Buffer, mime: string): Promise<MemoryBlobStore> {
  const blobs = new MemoryBlobStore();
  await blobs.write(BLOB_PATH, bytes);
  await blobs.write(`${BLOB_PATH}.json`, JSON.stringify({ mime, size: bytes.length, sha256: SHA }));
  return blobs;
}

describe('ThumbnailService', () => {
  it('image → готовый JPEG в attachments/.thumbs и аддитивный sidecar thumb', async () => {
    const blobs = await setup(Buffer.from('png-bytes'), 'image/png');
    const thumb = jpeg(320, 200);
    const calls: MediaRunRequest[] = [];
    const service = new ThumbnailService({ blobs, runner: fakeRunner({ ok: true, outputs: [thumb] }, calls) });

    const meta = await service.ensure({ blobPath: BLOB_PATH, mime: 'image/png' });

    expect(meta).toEqual({ status: 'ready', width: 320, height: 200 });
    expect(await blobs.read(`attachments/.thumbs/${SHA}-512.jpg`)).toEqual(thumb);
    expect(calls[0]).toMatchObject({ inputBlobPath: BLOB_PATH, capture: 'file', outputName: 'thumb.jpg' });
    const sidecar = JSON.parse((await blobs.read(`${BLOB_PATH}.json`))!.toString('utf-8')) as {
      thumb?: { status?: string };
    };
    expect(sidecar.thumb?.status).toBe('ready');

    const view = await service.get(BLOB_PATH);
    expect(view?.mime).toBe('image/jpeg');
    expect(view?.size).toBe(thumb.length);
    expect(view?.stream).toBeTruthy();
  });

  it('video → кадр на 10% длительности (если известна)', async () => {
    const blobs = await setup(Buffer.from('mp4-bytes'), 'video/mp4');
    const calls: MediaRunRequest[] = [];
    const service = new ThumbnailService({
      blobs,
      runner: fakeRunner({ ok: true, outputs: [jpeg(512, 288)] }, calls),
    });

    const meta = await service.ensure({ blobPath: BLOB_PATH, mime: 'video/mp4', durationMs: 10_000 });

    expect(meta.status).toBe('ready');
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['-ss', '1.000']));
  });

  it('audio → none, ffmpeg не запускается', async () => {
    const blobs = await setup(Buffer.from('ogg-bytes'), 'audio/ogg');
    const calls: MediaRunRequest[] = [];
    const service = new ThumbnailService({ blobs, runner: fakeRunner({ ok: true, outputs: [] }, calls) });

    const meta = await service.ensure({ blobPath: BLOB_PATH, mime: 'audio/ogg' });

    expect(meta).toEqual({ status: 'none' });
    expect(calls).toHaveLength(0);
    expect(await service.get(BLOB_PATH)).toBeNull();
  });

  it('ошибка ffmpeg → none без исключения, sidecar фиксирует none', async () => {
    const blobs = await setup(Buffer.from('png-bytes'), 'image/png');
    const service = new ThumbnailService({
      blobs,
      runner: fakeRunner({ ok: false, outputs: [], reason: 'no_ffmpeg', error: 'ENOENT' }),
    });

    const meta = await service.ensure({ blobPath: BLOB_PATH, mime: 'image/png' });

    expect(meta).toEqual({ status: 'none' });
    expect(await service.get(BLOB_PATH)).toBeNull();
    const sidecar = JSON.parse((await blobs.read(`${BLOB_PATH}.json`))!.toString('utf-8')) as {
      thumb?: { status?: string };
    };
    expect(sidecar.thumb?.status).toBe('none');
  });

  it('существующая миниатюра переиспользуется (ffmpeg не вызывается)', async () => {
    const blobs = await setup(Buffer.from('png-bytes'), 'image/png');
    await blobs.write(`attachments/.thumbs/${SHA}-512.jpg`, jpeg(64, 64));
    const calls: MediaRunRequest[] = [];
    const service = new ThumbnailService({ blobs, runner: fakeRunner({ ok: true, outputs: [] }, calls) });

    const meta = await service.ensure({ blobPath: BLOB_PATH, mime: 'image/png' });

    expect(meta).toMatchObject({ status: 'ready', width: 64, height: 64 });
    expect(calls).toHaveLength(0);
  });

  it('jpegSize читает размеры из SOF0', () => {
    expect(jpegSize(jpeg(123, 45))).toEqual({ width: 123, height: 45 });
    expect(jpegSize(Buffer.from('not a jpeg'))).toBeNull();
  });

  it('одновременные ensure одного sha делят одну генерацию (дедуп)', async () => {
    const blobs = await setup(Buffer.from('png-bytes'), 'image/png');
    const run = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true, outputs: [jpeg(32, 32)] };
    });
    const service = new ThumbnailService({ blobs, runner: { isRemote: false, run } });

    const results = await Promise.all([
      service.ensure({ blobPath: BLOB_PATH, mime: 'image/png' }),
      service.ensure({ blobPath: BLOB_PATH, mime: 'image/png' }),
      service.ensure({ blobPath: BLOB_PATH, mime: 'image/png' }),
    ]);

    expect(results.every((meta) => meta.status === 'ready')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('thumbnail.enabled=false → none, ffmpeg не запускается', async () => {
    const blobs = await setup(Buffer.from('png-bytes'), 'image/png');
    const calls: MediaRunRequest[] = [];
    const service = new ThumbnailService({
      blobs,
      runner: fakeRunner({ ok: true, outputs: [jpeg(32, 32)] }, calls),
      config: () => ({ enabled: false, maxWidthPx: 256 }),
    });

    const meta = await service.ensure({ blobPath: BLOB_PATH, mime: 'image/png', durationMs: 10_000 });

    expect(meta).toEqual({ status: 'none' });
    expect(calls).toHaveLength(0);
    expect(await service.get(BLOB_PATH)).toBeNull();
  });

  it('кастомная ширина из настроек попадает в scale', async () => {
    const blobs = await setup(Buffer.from('png-bytes'), 'image/png');
    const calls: MediaRunRequest[] = [];
    const service = new ThumbnailService({
      blobs,
      runner: fakeRunner({ ok: true, outputs: [jpeg(256, 128)] }, calls),
      config: () => ({ enabled: true, maxWidthPx: 256 }),
    });

    const meta = await service.ensure({ blobPath: BLOB_PATH, mime: 'image/png' });

    expect(meta).toMatchObject({ status: 'ready', width: 256, height: 128 });
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['-vf', "scale='min(256,iw)':-2"]));
  });

  it('настройки не заданы → ширина по умолчанию 512', async () => {
    const blobs = await setup(Buffer.from('png-bytes'), 'image/png');
    const calls: MediaRunRequest[] = [];
    const service = new ThumbnailService({
      blobs,
      runner: fakeRunner({ ok: true, outputs: [jpeg(512, 288)] }, calls),
    });

    await service.ensure({ blobPath: BLOB_PATH, mime: 'image/png' });

    expect(calls[0]!.args).toEqual(expect.arrayContaining(['-vf', "scale='min(512,iw)':-2"]));
    expect(await blobs.read(`attachments/.thumbs/${SHA}-512.jpg`)).toBeTruthy();
  });

  it('legacy-миниатюра без ширины читается при 512 (без перезаписи и ffmpeg)', async () => {
    const blobs = await setup(Buffer.from('png-bytes'), 'image/png');
    const legacy = jpeg(64, 64);
    await blobs.write(`attachments/.thumbs/${SHA}.jpg`, legacy);
    const calls: MediaRunRequest[] = [];
    const service = new ThumbnailService({ blobs, runner: fakeRunner({ ok: true, outputs: [] }, calls) });

    const meta = await service.ensure({ blobPath: BLOB_PATH, mime: 'image/png' });

    expect(meta).toMatchObject({ status: 'ready', width: 64, height: 64 });
    expect(calls).toHaveLength(0);
    // Legacy только читается: файла с суффиксом ширины не появилось.
    expect(await blobs.read(`attachments/.thumbs/${SHA}-512.jpg`)).toBeNull();
    expect(await blobs.read(`attachments/.thumbs/${SHA}.jpg`)).toEqual(legacy);
    // Раздача идёт из legacy-объекта.
    const view = await service.get(BLOB_PATH);
    expect(view?.size).toBe(legacy.length);
    expect(view?.stream).toBeTruthy();
  });

  it('смена ширины → другой путь и новая генерация (старый кадр не отдаётся)', async () => {
    const blobs = await setup(Buffer.from('png-bytes'), 'image/png');
    let width = 256;
    const calls: MediaRunRequest[] = [];
    const service = new ThumbnailService({
      blobs,
      runner: {
        isRemote: false,
        run: vi.fn(async (request: MediaRunRequest) => {
          calls.push(request);
          return { ok: true, outputs: [jpeg(width, Math.round(width / 2))] };
        }),
      },
      config: () => ({ enabled: true, maxWidthPx: width }),
    });

    const first = await service.ensure({ blobPath: BLOB_PATH, mime: 'image/png' });
    expect(first).toMatchObject({ status: 'ready', width: 256, height: 128 });
    expect(await blobs.read(`attachments/.thumbs/${SHA}-256.jpg`)).toBeTruthy();

    width = 512;
    const second = await service.ensure({ blobPath: BLOB_PATH, mime: 'image/png' });

    // Новая генерация, а не переиспользование кадра 256.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual(expect.arrayContaining(['-vf', "scale='min(512,iw)':-2"]));
    expect(second).toMatchObject({ status: 'ready', width: 512, height: 256 });
    expect(await blobs.read(`attachments/.thumbs/${SHA}-512.jpg`)).toBeTruthy();
    // Старая миниатюра другой ширины не отдаётся.
    const view = await service.get(BLOB_PATH);
    expect(view?.size).toBe(jpeg(512, 256).length);
  });

  it('legacy-файл при ширине ≠ 512 не используется — генерируется новый', async () => {
    const blobs = await setup(Buffer.from('png-bytes'), 'image/png');
    await blobs.write(`attachments/.thumbs/${SHA}.jpg`, jpeg(64, 64));
    const calls: MediaRunRequest[] = [];
    const service = new ThumbnailService({
      blobs,
      runner: fakeRunner({ ok: true, outputs: [jpeg(256, 128)] }, calls),
      config: () => ({ enabled: true, maxWidthPx: 256 }),
    });

    const meta = await service.ensure({ blobPath: BLOB_PATH, mime: 'image/png' });

    expect(calls).toHaveLength(1);
    expect(meta).toMatchObject({ status: 'ready', width: 256, height: 128 });
    expect(await blobs.read(`attachments/.thumbs/${SHA}-256.jpg`)).toBeTruthy();
    // Legacy не перезаписан.
    expect(await blobs.read(`attachments/.thumbs/${SHA}.jpg`)).toEqual(jpeg(64, 64));
  });
});

describe('ThumbnailService: длительность видео (ADR-115)', () => {
  /** stderr ffmpeg с длительностью (как печатает при разборе входа). */
  const DURATION_STDERR =
    '  Duration: 00:00:31.00, start: 0.000000, bitrate: 1050 kb/s\n' +
    '  Stream #0:0: Video: h264, yuv420p, 1280x720\n';

  /** Раннер: проба длительности (без `-frames:v`) → stderr, кадр → JPEG. */
  function probeRunner(
    probe: Awaited<ReturnType<MediaRunnerLike['run']>>,
    calls: MediaRunRequest[] = [],
  ): MediaRunnerLike {
    return {
      isRemote: false,
      run: vi.fn(async (request: MediaRunRequest) => {
        calls.push(request);
        const isProbe = !request.args.includes('-frames:v');
        return isProbe ? probe : { ok: true, outputs: [jpeg(512, 288)] };
      }),
    };
  }

  async function sidecar(blobs: MemoryBlobStore): Promise<Record<string, unknown>> {
    return JSON.parse((await blobs.read(`${BLOB_PATH}.json`))!.toString('utf-8')) as Record<
      string,
      unknown
    >;
  }

  it('длительность из stderr ffmpeg → sidecar durationMs, кадр на 10% длительности', async () => {
    const blobs = await setup(Buffer.from('mp4-bytes'), 'video/mp4');
    const calls: MediaRunRequest[] = [];
    const service = new ThumbnailService({
      blobs,
      runner: probeRunner({ ok: false, outputs: [], reason: 'failed', stderr: DURATION_STDERR }, calls),
    });

    const meta = await service.ensure({ blobPath: BLOB_PATH, mime: 'video/mp4' });

    expect(meta.status).toBe('ready');
    const written = await sidecar(blobs);
    expect(written.durationMs).toBe(31_000);
    // Кадр берётся на 10% длительности (3.1 с), а не на первой секунде.
    expect(calls[1]!.args).toEqual(expect.arrayContaining(['-ss', '3.100']));
  });

  it('ошибка ffmpeg без Duration → durationMs не пишется', async () => {
    const blobs = await setup(Buffer.from('mp4-bytes'), 'video/mp4');
    const calls: MediaRunRequest[] = [];
    const service = new ThumbnailService({
      blobs,
      runner: probeRunner({ ok: false, outputs: [], reason: 'no_ffmpeg', error: 'ENOENT' }, calls),
    });

    await service.ensure({ blobPath: BLOB_PATH, mime: 'video/mp4' });

    const written = await sidecar(blobs);
    expect(written.durationMs).toBeUndefined();
    // Кадр всё равно попытались сделать (по умолчанию — первая секунда).
    expect(calls.some((call) => call.args.includes('-frames:v'))).toBe(true);
  });

  it('существующий durationMs в sidecar не перезаписывается и не probe-ится', async () => {
    const blobs = await setup(Buffer.from('mp4-bytes'), 'video/mp4');
    const written = await blobs.read(`${BLOB_PATH}.json`);
    const parsed = JSON.parse(written!.toString('utf-8')) as Record<string, unknown>;
    await blobs.write(`${BLOB_PATH}.json`, JSON.stringify({ ...parsed, durationMs: 5_000 }));
    const calls: MediaRunRequest[] = [];
    const service = new ThumbnailService({
      blobs,
      runner: probeRunner({ ok: false, outputs: [], reason: 'failed', stderr: DURATION_STDERR }, calls),
    });

    await service.ensure({ blobPath: BLOB_PATH, mime: 'video/mp4' });

    const after = await sidecar(blobs);
    expect(after.durationMs).toBe(5_000);
    // Проба длительности не запускалась — только кадр.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['-ss', '0.500']));
  });

  it('длительность из входа сохраняется в sidecar без запуска ffmpeg', async () => {
    const blobs = await setup(Buffer.from('mp4-bytes'), 'video/mp4');
    const calls: MediaRunRequest[] = [];
    const service = new ThumbnailService({
      blobs,
      runner: probeRunner({ ok: false, outputs: [], reason: 'failed', stderr: DURATION_STDERR }, calls),
    });

    await service.ensure({ blobPath: BLOB_PATH, mime: 'video/mp4', durationMs: 10_000 });

    const written = await sidecar(blobs);
    expect(written.durationMs).toBe(10_000);
    // Только кадр: длительность уже известна вызывающему.
    expect(calls).toHaveLength(1);
  });

  it('parseFfmpegDurationMs: HH:MM:SS.xx → мс; N/A и пусто → null', () => {
    expect(parseFfmpegDurationMs(DURATION_STDERR)).toBe(31_000);
    expect(parseFfmpegDurationMs('  Duration: 01:02:03.50, start: 0.0')).toBe(3_723_500);
    expect(parseFfmpegDurationMs('  Duration: N/A, start: 0.0')).toBeNull();
    expect(parseFfmpegDurationMs('')).toBeNull();
    expect(parseFfmpegDurationMs(undefined)).toBeNull();
  });
});
