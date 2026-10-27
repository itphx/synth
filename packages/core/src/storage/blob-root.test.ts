/**
 * ADR-115/ADR-116: корень blob-хранилища `{dataDir}/blobs`.
 *
 * Проверяется: создание каталога, переезд логов фоновых процессов старой
 * раскладки (`{dataDir}/processes/<id>.log`), сохранение реестра прогонов на
 * месте (`processes/registry.json` — не blob), идемпотентность и отсутствие
 * падений на пустом каталоге.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blobRootPath, prepareBlobRoot } from './blob-root.js';
import { createFileStorage } from './storage-context.js';

describe('prepareBlobRoot (ADR-115)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-blob-root-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('создаёт {dataDir}/blobs и не падает, когда каталогов нет', () => {
    expect(existsSync(blobRootPath(tmpDir))).toBe(false);
    expect(() => prepareBlobRoot(tmpDir)).not.toThrow();
    expect(existsSync(blobRootPath(tmpDir))).toBe(true);
  });

  it('переносит логи фоновых процессов из старой раскладки', async () => {
    const legacyDir = join(tmpDir, 'processes');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, 'run-1.log'), 'лог процесса');
    await writeFile(join(legacyDir, 'registry.json'), '{"runs":[]}');

    prepareBlobRoot(tmpDir);

    expect(await readFile(join(blobRootPath(tmpDir), 'processes', 'run-1.log'), 'utf-8')).toBe('лог процесса');
    // Реестр прогонов — данные домена, а не blob: остаётся на месте.
    expect(existsSync(join(legacyDir, 'registry.json'))).toBe(true);
    expect(await readFile(join(legacyDir, 'registry.json'), 'utf-8')).toBe('{"runs":[]}');
    expect(existsSync(join(blobRootPath(tmpDir), 'processes', 'registry.json'))).toBe(false);
    // Логи переехали — в старом каталоге их нет.
    expect(existsSync(join(legacyDir, 'run-1.log'))).toBe(false);
  });

  it('идемпотентна: повторный вызов ничего не ломает и не дублирует', async () => {
    const legacyDir = join(tmpDir, 'processes');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, 'run-1.log'), 'v1');

    prepareBlobRoot(tmpDir);
    // Новая запись в blob-корне не перетирается вторым вызовом.
    await writeFile(join(blobRootPath(tmpDir), 'processes', 'run-1.log'), 'v2');
    prepareBlobRoot(tmpDir);

    expect(await readFile(join(blobRootPath(tmpDir), 'processes', 'run-1.log'), 'utf-8')).toBe('v2');
  });

  it('ошибка подготовки не роняет старт (best-effort, предупреждение в лог)', async () => {
    const logs: string[] = [];
    // Препятствие: на месте `{dataDir}/blobs` — файл, каталог не создать.
    await writeFile(blobRootPath(tmpDir), 'not-a-directory');

    expect(() => prepareBlobRoot(tmpDir, (message) => logs.push(message))).not.toThrow();
    expect(logs.length).toBeGreaterThan(0);
  });

  it('FileBlobStore файлового backend смотрит в {dataDir}/blobs', async () => {
    const storage = createFileStorage({ dataDir: tmpDir });
    await storage.blobs.write('processes/run-2.log', 'строка лога');

    expect(await readFile(join(blobRootPath(tmpDir), 'processes', 'run-2.log'), 'utf-8')).toBe('строка лога');
    expect(existsSync(join(tmpDir, 'processes', 'run-2.log'))).toBe(false);
  });
});
