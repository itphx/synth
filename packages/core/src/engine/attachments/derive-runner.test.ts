/**
 * ADR-115 × ADR-077: derive запускает `ffmpeg` только через медиа-раннер
 * (прямого spawn в модуле нет). Инъекция раннера позволяет проверить это без
 * настоящего бинарника; причины деградации сохраняются.
 */

import { describe, expect, it, vi } from 'vitest';
import { MemoryBlobStore } from '../../storage/memory/content.js';
import type { MediaRunRequest, MediaRunnerLike } from '../media/runner.js';
import { deriveModalityText, type DeriveDeps } from './derive.js';

const BLOB_PATH = 'attachments/aa/deadbeef';

function makeDeps(runner: MediaRunnerLike): DeriveDeps & { blobs: MemoryBlobStore; chat: ReturnType<typeof vi.fn> } {
  const blobs = new MemoryBlobStore();
  void blobs.write(BLOB_PATH, Buffer.from('OggS....'));
  const chat = vi.fn(async () => ({ text: 'ТРАНСКРИПТ' }));
  return {
    blobs,
    chat,
    hasFfmpeg: () => true,
    mediaRunner: runner,
  };
}

describe('derive использует медиа-раннер', () => {
  it('audio/ogg → раннер получает argv с pipe:0 и blob-путь; результат уходит aux-модели', async () => {
    const calls: MediaRunRequest[] = [];
    const runner: MediaRunnerLike = {
      isRemote: false,
      run: vi.fn(async (request: MediaRunRequest) => {
        calls.push(request);
        return { ok: true, outputs: [Buffer.from('RIFF....WAVE')] };
      }),
    };
    const deps = makeDeps(runner);

    const result = await deriveModalityText(
      {
        family: 'audio',
        mime: 'audio/ogg',
        name: 'голос.ogg',
        blobPath: BLOB_PATH,
        part: {
          id: 'p-audio',
          type: 'audio',
          data: { blobPath: BLOB_PATH, sha256: 'a'.repeat(64), mime: 'audio/ogg', size: 8 },
        },
        provider: 'aux',
        model: 'audio-1',
        language: 'ru',
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(calls[0]!.inputBlobPath).toBe(BLOB_PATH);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['-i', 'pipe:0', 'pipe:1']));
    expect(deps.chat).toHaveBeenCalledTimes(1);
  });

  it('раннер вернул dependency_missing (нет ffmpeg в пуле) → no_ffmpeg', async () => {
    const runner: MediaRunnerLike = {
      isRemote: true,
      run: vi.fn(async () => ({
        ok: false,
        outputs: [],
        reason: 'dependency_missing' as const,
        error: 'в пуле: 0 из 1',
      })),
    };
    const deps = makeDeps(runner);

    const result = await deriveModalityText(
      {
        family: 'audio',
        mime: 'audio/ogg',
        blobPath: BLOB_PATH,
        part: {
          id: 'p-audio',
          type: 'audio',
          data: { blobPath: BLOB_PATH, sha256: 'a'.repeat(64), mime: 'audio/ogg', size: 8 },
        },
        provider: 'aux',
        model: 'audio-1',
        language: 'ru',
      },
      deps,
    );

    expect(result).toEqual({ ok: false, reason: 'no_ffmpeg' });
    expect(deps.chat).not.toHaveBeenCalled();
  });
});
