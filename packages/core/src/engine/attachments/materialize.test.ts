/**
 * ADR-115: материализация отброшенного вложения в рабочий каталог проекта.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { materializeAttachment, sanitizeAttachmentName } from './materialize.js';

const PDF_BYTES = Buffer.from('%PDF-1.7\nконтент');

function sha8(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

describe('materializeAttachment (ADR-115)', () => {
  let workingDir: string;
  let blobs: Record<string, Buffer>;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), 'synth-materialize-'));
    blobs = { 'attachments/aa/doc': PDF_BYTES };
  });

  afterEach(async () => {
    await rm(workingDir, { recursive: true, force: true });
  });

  /** Материализация с портом чтения поверх `blobs`. */
  function materialize(overrides: {
    name?: string;
    blobPath?: string;
    mime?: string;
    workingDir?: string;
  } = {}) {
    return materializeAttachment({
      read: async (blobPath) => blobs[blobPath] ?? null,
      blobPath: overrides.blobPath ?? 'attachments/aa/doc',
      name: overrides.name,
      mime: overrides.mime ?? 'application/pdf',
      workingDir: overrides.workingDir ?? workingDir,
    });
  }

  it('сохраняет файл в <workspace>/attachments и возвращает путь относительно workspace', async () => {
    const path = await materialize({ name: 'док.pdf' });

    expect(path).toBe('attachments/док.pdf');
    const saved = await readFile(join(workingDir, 'attachments', 'док.pdf'));
    expect(saved.equals(PDF_BYTES)).toBe(true);
    // Прямые слэши в пути (модель передаёт его в `read_file`).
    expect(path).not.toContain('\\');
    // Временных файлов не осталось.
    expect((await readdir(join(workingDir, 'attachments'))).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('имя без пути/имени → attachment-<sha8> от содержимого', async () => {
    const path = await materialize();
    expect(path).toBe(`attachments/attachment-${sha8(PDF_BYTES)}`);
  });

  it('санитайзит имя: `..`, подкаталоги, кавычки, управляющие символы', async () => {
    // `../x` — остаётся только последний сегмент.
    expect(await materialize({ name: '../x.pdf' })).toBe('attachments/x.pdf');
    // Путь внутри вложения — берём имя файла.
    expect(await materialize({ name: 'a/b.pdf' })).toBe('attachments/b.pdf');
    // Windows-разделитель тоже.
    expect(await materialize({ name: 'a\\b.pdf' })).toBe('attachments/b.pdf');
    // Кавычки и управляющие символы вырезаются.
    expect(await materialize({ name: 'my "file".pdf' })).toBe('attachments/my file.pdf');
    expect(await materialize({ name: 'bad\u0000name.pdf' })).toBe('attachments/badname.pdf');
    // Только точки/слэши — не имя, берётся fallback.
    expect(await materialize({ name: '..' })).toBe(`attachments/attachment-${sha8(PDF_BYTES)}`);
    expect(await materialize({ name: '/' })).toBe(`attachments/attachment-${sha8(PDF_BYTES)}`);
  });

  it('коллизия имён с разным содержимым → суффикс -2, -3', async () => {
    const other = Buffer.from('другие байты');
    blobs['attachments/aa/other'] = other;

    expect(await materialize({ name: 'doc.pdf' })).toBe('attachments/doc.pdf');
    expect(
      await materialize({ name: 'doc.pdf', blobPath: 'attachments/aa/other' }),
    ).toBe('attachments/doc-2.pdf');

    blobs['attachments/aa/third'] = Buffer.from('третьи байты');
    expect(
      await materialize({ name: 'doc.pdf', blobPath: 'attachments/aa/third' }),
    ).toBe('attachments/doc-3.pdf');

    expect(await readdir(join(workingDir, 'attachments'))).toEqual(
      expect.arrayContaining(['doc.pdf', 'doc-2.pdf', 'doc-3.pdf']),
    );
  });

  it('дедуп по содержимому: второй вызов возвращает тот же путь, файлов не прибавляется', async () => {
    const first = await materialize({ name: 'doc.pdf' });
    const second = await materialize({ name: 'doc.pdf' });
    expect(second).toBe(first);

    // Тот же байт-в-байт файл под другим blob-путём (пересланная копия).
    blobs['attachments/bb/copy'] = Buffer.from(PDF_BYTES);
    const third = await materialize({ name: 'doc.pdf', blobPath: 'attachments/bb/copy' });
    expect(third).toBe(first);

    const files = await readdir(join(workingDir, 'attachments'));
    expect(files).toEqual(['doc.pdf']);
  });

  it('существующий файл с другим содержимым не перезаписывается', async () => {
    const dir = join(workingDir, 'attachments');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'doc.pdf'), 'чужой контент');

    const path = await materialize({ name: 'doc.pdf' });
    expect(path).toBe('attachments/doc-2.pdf');
    expect(await readFile(join(dir, 'doc.pdf'), 'utf-8')).toBe('чужой контент');
  });

  it('нет workspace (пустой или несуществующий каталог) → null', async () => {
    expect(await materialize({ workingDir: '' })).toBeNull();
    expect(await materialize({ workingDir: '   ' })).toBeNull();
    expect(await materialize({ workingDir: join(workingDir, 'нет-такого') })).toBeNull();
  });

  it('объект не прочитан (порт вернул null/бросил) → null', async () => {
    expect(await materialize({ blobPath: 'attachments/aa/missing' })).toBeNull();

    const path = await materializeAttachment({
      read: async () => {
        throw new Error('EIO');
      },
      blobPath: 'attachments/aa/doc',
      mime: 'application/pdf',
      workingDir,
    });
    expect(path).toBeNull();
  });

  it('sanitizeAttachmentName: пустой/опасный ввод → fallback', () => {
    expect(sanitizeAttachmentName(undefined, 'attachment-deadbeef')).toBe('attachment-deadbeef');
    expect(sanitizeAttachmentName('   ', 'attachment-deadbeef')).toBe('attachment-deadbeef');
    expect(sanitizeAttachmentName('../..', 'attachment-deadbeef')).toBe('attachment-deadbeef');
    expect(sanitizeAttachmentName('отчёт.pdf', 'attachment-deadbeef')).toBe('отчёт.pdf');
  });
});
