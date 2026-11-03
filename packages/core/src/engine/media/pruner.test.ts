/**
 * ADR-115 × ADR-077: уборка временных каталогов медиа-раннера.
 *
 * После жёсткого kill раннер не успевает убрать каталог
 * `{workspacesRoot}/.synth-media/<uuid>` (`finally` не выполняется) — такие
 * каталоги копятся на общем томе. Сборщик мусора удаляет записи старше TTL
 * (1 ч); свежие/активные не трогает, каталог не создаёт.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_TMP_DIR_NAME } from './runner.js';
import { MEDIA_TEMP_TTL_MS, startMediaTempPruner } from './pruner.js';

/** Фиксированный «сейчас» для инъекции времени. */
const NOW = 1_800_000_000_000;
const HOUR = 3600_000;

describe('startMediaTempPruner (ADR-115 × ADR-077)', () => {
  let tmpDir: string;
  let mediaDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-media-temp-'));
    mediaDir = join(tmpDir, MEDIA_TMP_DIR_NAME);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Создать временный каталог раннера с заданным mtime. */
  async function seedDir(name: string, mtimeMs: number): Promise<string> {
    const dir = join(mediaDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'input.bin'), 'байты');
    const date = new Date(mtimeMs);
    await utimes(dir, date, date);
    return dir;
  }

  it('удаляет временный каталог старше TTL, свежий не трогает', async () => {
    const oldDir = await seedDir('old-run', NOW - 2 * HOUR);
    const newDir = await seedDir('new-run', NOW - 5 * 60_000);

    const stop = startMediaTempPruner({
      workspacesRoot: tmpDir,
      now: () => NOW,
      intervalMs: 3600_000,
    });

    await vi.waitFor(() => {
      expect(existsSync(oldDir)).toBe(false);
    });
    expect(existsSync(newDir)).toBe(true);
    stop();
  });

  it('удаляет и файлы (не только каталоги)', async () => {
    await mkdir(mediaDir, { recursive: true });
    const strayFile = join(mediaDir, 'leftover.bin');
    await writeFile(strayFile, 'мусор');
    const date = new Date(NOW - 2 * HOUR);
    await utimes(strayFile, date, date);

    const stop = startMediaTempPruner({
      workspacesRoot: tmpDir,
      now: () => NOW,
      intervalMs: 3600_000,
    });

    await vi.waitFor(() => {
      expect(existsSync(strayFile)).toBe(false);
    });
    stop();
  });

  it('не создаёт каталог, если его нет', async () => {
    const stop = startMediaTempPruner({
      workspacesRoot: tmpDir,
      now: () => NOW,
      intervalMs: 3600_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(mediaDir)).toBe(false);
    stop();
  });

  it('ошибка уборки одной записи не мешает остальным (best-effort)', async () => {
    const oldDir = await seedDir('old-run', NOW - 2 * HOUR);
    const otherDir = await seedDir('other-run', NOW - 3 * HOUR);
    const stop = startMediaTempPruner({
      workspacesRoot: tmpDir,
      now: () => NOW,
      intervalMs: 3600_000,
      fs: {
        rm: async (path) => {
          if (path === oldDir) throw new Error('не удалилось');
          await rm(path, { recursive: true, force: true });
        },
      },
      log: () => undefined,
    });

    await vi.waitFor(() => {
      expect(existsSync(otherDir)).toBe(false);
    });
    expect(existsSync(oldDir)).toBe(true);
    stop();
  });

  it('TTL по умолчанию — 1 час', () => {
    expect(MEDIA_TEMP_TTL_MS).toBe(HOUR);
  });
});
