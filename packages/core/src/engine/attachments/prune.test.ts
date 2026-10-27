/**
 * ADR-115: GC осиротевших вложений.
 *
 * Живой объект (есть ссылка `blob_refs`) не удаляется никогда; сирота старше
 * `gcDays` удаляется вместе с sidecar; свежая сирота остаётся (могла быть
 * загружена до отправки сообщения).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBlobStore } from '../../storage/file-blob-store.js';
import { FileBlobRefRepository } from '../../storage/file-blob-ref-repository.js';
import { startAttachmentPruner } from './prune.js';

const DAY = 24 * 3600_000;

describe('startAttachmentPruner (ADR-115)', () => {
  let tmpDir: string;
  let blobs: FileBlobStore;
  let blobRefs: FileBlobRefRepository;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-attachments-gc-'));
    blobs = new FileBlobStore({ root: join(tmpDir, 'blobs') });
    blobRefs = new FileBlobRefRepository({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Создать объект вложения + sidecar, вернуть путь. */
  async function seedObject(sha: string): Promise<string> {
    const blobPath = `attachments/${sha.slice(0, 2)}/${sha}`;
    await blobs.write(blobPath, 'байты');
    await blobs.write(`${blobPath}.json`, JSON.stringify({ mime: 'image/png', size: 5, sha256: sha }));
    return blobPath;
  }

  it('удаляет сироту старше TTL вместе с sidecar', async () => {
    const blobPath = await seedObject('a'.repeat(64));
    const stop = startAttachmentPruner({
      blobs,
      blobRefs,
      gcDays: 30,
      // Отсечка в будущем: объект заведомо «старше» срока.
      now: () => Date.now() + 40 * DAY,
      intervalMs: 60 * 60_000,
    });

    await vi.waitFor(async () => {
      expect(await blobs.exists(blobPath)).toBe(false);
    });
    expect(await blobs.exists(`${blobPath}.json`)).toBe(false);
    stop();
  });

  it('живой объект (есть ссылка) не удаляется, даже если старый', async () => {
    const blobPath = await seedObject('b'.repeat(64));
    await blobRefs.add({ blobPath, ownerKind: 'message', ownerId: 'msg-1' });

    const stop = startAttachmentPruner({
      blobs,
      blobRefs,
      gcDays: 30,
      now: () => Date.now() + 400 * DAY,
      intervalMs: 60 * 60_000,
    });

    // Дать прогону завершиться (prune стартует сразу).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await blobs.exists(blobPath)).toBe(true);
    expect(await blobs.exists(`${blobPath}.json`)).toBe(true);
    stop();
  });

  it('свежая сирота остаётся (вложение могло быть загружено до отправки)', async () => {
    const blobPath = await seedObject('c'.repeat(64));
    const stop = startAttachmentPruner({
      blobs,
      blobRefs,
      gcDays: 30,
      intervalMs: 60 * 60_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await blobs.exists(blobPath)).toBe(true);
    stop();
  });

  it('gcDays <= 0 — очистки нет (без ограничения срока)', async () => {
    const blobPath = await seedObject('d'.repeat(64));
    const stop = startAttachmentPruner({
      blobs,
      blobRefs,
      gcDays: 0,
      now: () => Date.now() + 4000 * DAY,
      intervalMs: 60 * 60_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await blobs.exists(blobPath)).toBe(true);
    stop();
  });

  it('после снятия ссылки объект становится сиротой и удаляется', async () => {
    const blobPath = await seedObject('e'.repeat(64));
    await blobRefs.add({ blobPath, ownerKind: 'message', ownerId: 'msg-1' });
    await blobRefs.removeByOwner('message', 'msg-1');

    const stop = startAttachmentPruner({
      blobs,
      blobRefs,
      gcDays: 30,
      now: () => Date.now() + 40 * DAY,
      intervalMs: 60 * 60_000,
    });

    await vi.waitFor(async () => {
      expect(await blobs.exists(blobPath)).toBe(false);
    });
    stop();
  });
});
