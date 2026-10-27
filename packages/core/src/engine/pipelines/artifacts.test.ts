/**
 * ADR-101 §9 / ADR-116: хранилище артефактов прогонов пайплайнов.
 *
 * Отдельного хранилища артефактов нет: байты лежат в общем blob-порте
 * (`artifacts/<runId>/<name>`), учёт — в `blob_refs` (`ownerKind: 'pipeline-run'`).
 * Проверяются: запись/чтение/список, санитайз имени, разведение коллизий,
 * лимит размера (`too_large`), ссылки владельца и уборка прогона.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileBlobStore } from '../../storage/file-blob-store.js';
import { MemoryBlobRefRepository } from '../../storage/memory/blob-refs.js';
import {
  DEFAULT_PIPELINE_ARTIFACT_MAX_BYTES,
  PipelineArtifactError,
  PipelineArtifactStore,
  isPipelineArtifactPath,
  sanitizeArtifactName,
  sanitizeRunId,
} from './artifacts.js';

describe('PipelineArtifactStore (ADR-101 §9, ADR-116)', () => {
  let dir: string;
  let blobs: FileBlobStore;
  let refs: MemoryBlobRefRepository;
  let store: PipelineArtifactStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-pipeline-artifacts-'));
    blobs = new FileBlobStore({ root: join(dir, 'blobs') });
    refs = new MemoryBlobRefRepository();
    store = new PipelineArtifactStore({ blobs, blobRefs: refs });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('put кладёт байты по пути artifacts/<runId>/<name> и пишет ссылку владельца', async () => {
    const artifact = await store.put('prun_1', {
      name: 'report.md',
      bytes: Buffer.from('# отчёт', 'utf8'),
      mime: 'text/markdown',
    });

    expect(artifact.kind).toBe('blob');
    expect(artifact.path).toBe('artifacts/prun_1/report.md');
    expect(artifact.name).toBe('report.md');
    expect(artifact.mime).toBe('text/markdown');
    expect(artifact.size).toBe(Buffer.byteLength('# отчёт'));

    const stored = await blobs.read('artifacts/prun_1/report.md');
    expect(stored?.toString('utf8')).toBe('# отчёт');
    expect(await refs.listByOwner('pipeline-run', 'prun_1')).toEqual([
      'artifacts/prun_1/report.md',
    ]);
  });

  it('read отдаёт байты и не читает чужие blob-пути', async () => {
    const artifact = await store.put('prun_1', { name: 'a.txt', bytes: Buffer.from('a') });

    expect((await store.read({ path: artifact.path! }))?.toString('utf8')).toBe('a');
    expect(await store.read({ path: 'attachments/ab/deadbeef' })).toBeNull();
    expect(await store.read({ path: 'artifacts/../secrets/master.key' })).toBeNull();
  });

  it('listRun отдаёт артефакты только своего прогона', async () => {
    await store.put('prun_1', { name: 'a.txt', bytes: Buffer.from('a') });
    await store.put('prun_1', { name: 'b.txt', bytes: Buffer.from('bb') });
    await store.put('prun_2', { name: 'c.txt', bytes: Buffer.from('ccc') });

    const list = await store.listRun('prun_1');
    expect(list.map((item) => item.path).sort()).toEqual([
      'artifacts/prun_1/a.txt',
      'artifacts/prun_1/b.txt',
    ]);
    expect(list.find((item) => item.path.endsWith('b.txt'))?.size).toBe(2);
  });

  it('санитайз имени: пути схлопываются до basename, `..` и управляющие символы вычищаются', async () => {
    const traversal = await store.put('prun_1', {
      name: '../../etc/passwd',
      bytes: Buffer.from('x'),
    });
    expect(traversal.path).toBe('artifacts/prun_1/passwd');

    const backslash = await store.put('prun_1', {
      name: 'C:\\tmp\\win.txt',
      bytes: Buffer.from('x'),
    });
    expect(backslash.path).toBe('artifacts/prun_1/win.txt');

    // Управляющие символы (NUL/перевод строки) не попадают в путь.
    const control = await store.put('prun_1', {
      name: 'bad\u0000name\n.txt',
      bytes: Buffer.from('x'),
    });
    expect(control.path).toBe('artifacts/prun_1/badname.txt');
    expect(isPipelineArtifactPath(control.path)).toBe(true);

    // Имя, состоящее из `..`, не выходит за каталог прогона.
    expect(sanitizeArtifactName('..')).toBe('artifact');
    expect(sanitizeArtifactName('')).toBe('artifact');
  });

  it('коллизия имени в одном прогоне разводится суффиксом -2', async () => {
    const first = await store.put('prun_1', { name: 'report.md', bytes: Buffer.from('1') });
    const second = await store.put('prun_1', { name: 'report.md', bytes: Buffer.from('2') });

    expect(first.path).toBe('artifacts/prun_1/report.md');
    expect(second.path).toBe('artifacts/prun_1/report-2.md');
    expect((await store.read({ path: second.path! }))?.toString('utf8')).toBe('2');
    // Оба артефакта — в списке прогона.
    expect(await store.listRun('prun_1')).toHaveLength(2);
  });

  it('превышение лимита — too_large, объект не записывается', async () => {
    const small = new PipelineArtifactStore({ blobs, blobRefs: refs, maxBytes: 4 });

    await expect(
      small.put('prun_1', { name: 'big.bin', bytes: Buffer.from('01234') }),
    ).rejects.toMatchObject({ code: 'too_large' });
    await expect(small.put('prun_1', { name: 'big.bin', bytes: Buffer.from('01234') })).rejects.toBeInstanceOf(
      PipelineArtifactError,
    );

    expect(await small.listRun('prun_1')).toEqual([]);
    expect(await refs.listByOwner('pipeline-run', 'prun_1')).toEqual([]);
    // Дефолтный предел — 50 МиБ.
    expect(small.maxBytes).toBe(4);
    expect(new PipelineArtifactStore({ blobs, blobRefs: refs }).maxBytes).toBe(
      DEFAULT_PIPELINE_ARTIFACT_MAX_BYTES,
    );
  });

  it('find находит артефакт по имени (для HTTP-раздачи), чужое имя — null', async () => {
    await store.put('prun_1', { name: 'report.md', bytes: Buffer.from('hello') });

    const found = await store.find('prun_1', 'report.md');
    expect(found).toMatchObject({ path: 'artifacts/prun_1/report.md', size: 5, name: 'report.md' });
    expect(await store.find('prun_1', 'missing.md')).toBeNull();
    expect(await store.find('../prun_1', 'report.md')).toBeNull();
  });

  it('removeRun удаляет объекты и ссылки только этого прогона', async () => {
    await store.put('prun_1', { name: 'a.txt', bytes: Buffer.from('a') });
    await store.put('prun_1', { name: 'b.txt', bytes: Buffer.from('b') });
    const other = await store.put('prun_2', { name: 'c.txt', bytes: Buffer.from('c') });

    await store.removeRun('prun_1');

    expect(await store.listRun('prun_1')).toEqual([]);
    expect(await refs.listByOwner('pipeline-run', 'prun_1')).toEqual([]);
    // Соседний прогон не затронут.
    expect((await store.read({ path: other.path! }))?.toString('utf8')).toBe('c');
    expect(await refs.listByOwner('pipeline-run', 'prun_2')).toHaveLength(1);
  });

  it('некорректный id прогона — invalid_input (в путь не попадает мусор)', async () => {
    expect(() => sanitizeRunId('../..')).toThrow(PipelineArtifactError);
    await expect(
      store.put('../..', { name: 'a.txt', bytes: Buffer.from('a') }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
