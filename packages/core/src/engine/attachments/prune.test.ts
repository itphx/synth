/**
 * ADR-115: GC вложений.
 *
 * Живой объект (есть ссылка `blob_refs`) не удаляется никогда; сирота старше
 * `gcDays` удаляется вместе с sidecar; свежая сирота остаётся (могла быть
 * загружена до отправки сообщения). Кэши (`.thumbs`/`.derived`) — регенерируемые
 * производные: чистятся по `gcDays` без проверки ссылок; временные объекты
 * загрузок (`.uploads`) — по своему TTL (1 ч), независимо от `gcDays`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBlobStore } from '../../storage/file-blob-store.js';
import { FileBlobRefRepository } from '../../storage/file-blob-ref-repository.js';
import { MetricsRegistry } from '../../metrics/registry.js';
import { createAttachmentMetrics } from '../../metrics/collectors/attachments.js';
import { startAttachmentPruner } from './prune.js';

const DAY = 24 * 3600_000;
const HOUR = 3600_000;
/** Фиксированный «сейчас» для инъекции времени. */
const NOW = 1_800_000_000_000;

describe('startAttachmentPruner (ADR-115)', () => {
  let tmpDir: string;
  let blobsRoot: string;
  let blobs: FileBlobStore;
  let blobRefs: FileBlobRefRepository;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-attachments-gc-'));
    blobsRoot = join(tmpDir, 'blobs');
    blobs = new FileBlobStore({ root: blobsRoot });
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

  /** Проставить mtime объекта blob-хранилища (проверки «старый/свежий»). */
  async function setMtime(blobPath: string, mtimeMs: number): Promise<void> {
    const date = new Date(mtimeMs);
    await utimes(join(blobsRoot, blobPath), date, date);
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

  it('считает удалённые объекты в synth_attachment_gc_removed_total (ADR-094)', async () => {
    await seedObject('f'.repeat(64));
    await seedObject('9'.repeat(64));
    const registry = new MetricsRegistry();

    const stop = startAttachmentPruner({
      blobs,
      blobRefs,
      gcDays: 30,
      now: () => Date.now() + 40 * DAY,
      intervalMs: 60 * 60_000,
      metrics: createAttachmentMetrics(registry),
    });

    await vi.waitFor(() => {
      expect(registry.render().text).toContain('synth_attachment_gc_removed_total 2');
    });
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

  it('чистит кэш миниатюр (.thumbs): старый файл удаляется, свежий остаётся', async () => {
    const oldThumb = `attachments/.thumbs/${'a'.repeat(64)}-512.jpg`;
    const newThumb = `attachments/.thumbs/${'b'.repeat(64)}-512.jpg`;
    await blobs.write(oldThumb, 'jpeg');
    await blobs.write(newThumb, 'jpeg');
    await setMtime(oldThumb, NOW - 31 * DAY);
    await setMtime(newThumb, NOW - 1 * DAY);

    const stop = startAttachmentPruner({
      blobs,
      blobRefs,
      gcDays: 30,
      now: () => NOW,
      intervalMs: 60 * 60_000,
    });

    await vi.waitFor(async () => {
      expect(await blobs.exists(oldThumb)).toBe(false);
    });
    expect(await blobs.exists(newThumb)).toBe(true);
    stop();
  });

  it('чистит кэш производных объектов (.derived): старый — удаляется, свежий — остаётся', async () => {
    const oldDerived = `attachments/.derived/${'c'.repeat(64)}.json`;
    const oldDerivedFile = `attachments/.derived/compress/${'d'.repeat(64)}_profile.png`;
    const newDerived = `attachments/.derived/${'e'.repeat(64)}.json`;
    await blobs.write(oldDerived, '{"version":1,"text":"x"}');
    await blobs.write(oldDerivedFile, 'png');
    await blobs.write(newDerived, '{"version":1,"text":"y"}');
    await setMtime(oldDerived, NOW - 31 * DAY);
    await setMtime(oldDerivedFile, NOW - 31 * DAY);
    await setMtime(newDerived, NOW - 1 * DAY);

    const stop = startAttachmentPruner({
      blobs,
      blobRefs,
      gcDays: 30,
      now: () => NOW,
      intervalMs: 60 * 60_000,
    });

    await vi.waitFor(async () => {
      expect(await blobs.exists(oldDerived)).toBe(false);
    });
    expect(await blobs.exists(oldDerivedFile)).toBe(false);
    expect(await blobs.exists(newDerived)).toBe(true);
    stop();
  });

  it('чистит временные объекты загрузок (.uploads) по TTL 1 ч, независимо от gcDays', async () => {
    const oldUpload = 'attachments/.uploads/upload-old';
    const newUpload = 'attachments/.uploads/upload-new';
    await blobs.write(oldUpload, 'часть');
    await blobs.write(newUpload, 'часть');
    await setMtime(oldUpload, NOW - 2 * HOUR);
    await setMtime(newUpload, NOW - 10 * 60_000);

    const stop = startAttachmentPruner({
      blobs,
      blobRefs,
      gcDays: 30,
      now: () => NOW,
      intervalMs: 60 * 60_000,
    });

    await vi.waitFor(async () => {
      expect(await blobs.exists(oldUpload)).toBe(false);
    });
    expect(await blobs.exists(newUpload)).toBe(true);
    stop();
  });

  it('gcDays = 0 — кэши не чистятся, но временные объекты загрузок чистятся', async () => {
    const thumb = `attachments/.thumbs/${'f'.repeat(64)}-512.jpg`;
    const derived = `attachments/.derived/${'1'.repeat(64)}.json`;
    const upload = 'attachments/.uploads/upload-old';
    await blobs.write(thumb, 'jpeg');
    await blobs.write(derived, '{"version":1,"text":"x"}');
    await blobs.write(upload, 'часть');
    await setMtime(thumb, NOW - 4000 * DAY);
    await setMtime(derived, NOW - 4000 * DAY);
    await setMtime(upload, NOW - 2 * HOUR);

    const stop = startAttachmentPruner({
      blobs,
      blobRefs,
      gcDays: 0,
      now: () => NOW,
      intervalMs: 60 * 60_000,
    });

    await vi.waitFor(async () => {
      expect(await blobs.exists(upload)).toBe(false);
    });
    // Кэши при `gcDays = 0` не трогаем (срок не задан).
    expect(await blobs.exists(thumb)).toBe(true);
    expect(await blobs.exists(derived)).toBe(true);
    stop();
  });

  it('счётчик GC учитывает удалённые кэши и сироты суммарно', async () => {
    const orphan = await seedObject('2'.repeat(64));
    const oldThumb = `attachments/.thumbs/${'3'.repeat(64)}-512.jpg`;
    await blobs.write(oldThumb, 'jpeg');
    await setMtime(orphan, NOW - 31 * DAY);
    await setMtime(oldThumb, NOW - 31 * DAY);

    const registry = new MetricsRegistry();
    const stop = startAttachmentPruner({
      blobs,
      blobRefs,
      gcDays: 30,
      now: () => NOW,
      intervalMs: 60 * 60_000,
      metrics: createAttachmentMetrics(registry),
    });

    await vi.waitFor(() => {
      expect(registry.render().text).toContain('synth_attachment_gc_removed_total 2');
    });
    stop();
  });
});
