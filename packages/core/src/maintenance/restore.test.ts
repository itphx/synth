// ADR-091: тесты `synth restore` на временных каталогах данных.
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listFilesForArchive, readFileFromTarGz, writeTarGz, type ArchiveEntryMeta } from './archive.js';
import { computeContentChecksum, createBackup } from './backup.js';
import { SCHEMA_VERSION } from '../storage/instance-meta.js';
import { BackupChecksumError, restoreBackup, runRestoreCommand } from './restore.js';

describe('restore', () => {
  let tmpDir: string;
  let dataDir: string;
  let archive: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-restore-'));
    dataDir = join(tmpDir, 'data');
    archive = join(tmpDir, 'backup.tar.gz');
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    await mkdir(join(dataDir, 'projects'), { recursive: true });
    await mkdir(join(dataDir, 'secrets'), { recursive: true, mode: 0o700 });
    await writeFile(join(dataDir, 'sessions', 's1.json'), '{"id":"s1"}', 'utf-8');
    await writeFile(join(dataDir, 'projects', 'p1.json'), '{"id":"p1"}', 'utf-8');
    await writeFile(join(dataDir, 'secrets', 'master.key'), 'KEY', { encoding: 'utf-8', mode: 0o600 });
    await createBackup({ dataDir, out: archive, withSecrets: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('backup → restore в новый каталог: содержимое идентично, manifest.json не пишется', async () => {
    const target = join(tmpDir, 'restored');
    const result = await restoreBackup({ archive, dataDir: target });

    expect(result.restored).toBeGreaterThanOrEqual(3);
    expect(result.safetyCopyPath).toBeUndefined();

    expect(await readFile(join(target, 'sessions', 's1.json'), 'utf-8')).toBe('{"id":"s1"}');
    expect(await readFile(join(target, 'projects', 'p1.json'), 'utf-8')).toBe('{"id":"p1"}');
    expect(await readFile(join(target, 'secrets', 'master.key'), 'utf-8')).toBe('KEY');

    const secretMode = (await stat(join(target, 'secrets', 'master.key'))).mode & 0o777;
    expect(secretMode).toBeGreaterThanOrEqual(0o600);

    expect(await readdir(target)).not.toContain('manifest.json');
  });

  it('--dry-run: печатает план и ничего не пишет', async () => {
    const target = join(tmpDir, 'dry');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'existing.txt'), 'old', 'utf-8');

    const logs: string[] = [];
    const result = await restoreBackup({ archive, dataDir: target, dryRun: true, log: (m) => logs.push(m) });

    expect(result.restored).toBeGreaterThan(0);
    expect(result.safetyCopyPath).toBeUndefined();
    expect(await readdir(target)).toEqual(['existing.txt']);
    expect(await readFile(join(target, 'existing.txt'), 'utf-8')).toBe('old');
    expect(logs.join('\n')).toContain('dry-run');
  });

  it('без --yes: runRestoreCommand отказывает и данные не трогаются', async () => {
    const target = join(tmpDir, 'noyes');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'existing.txt'), 'old', 'utf-8');

    const errors: string[] = [];
    const code = await runRestoreCommand({
      archive,
      dataDir: target,
      log: () => {},
      error: (m) => errors.push(m),
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('--dry-run');
    expect(await readdir(target)).toEqual(['existing.txt']);
  });

  it('страховочная копия создаётся и содержит прежние данные', async () => {
    const target = join(tmpDir, 'with-safety');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'existing.txt'), 'old', 'utf-8');

    const logs: string[] = [];
    const result = await restoreBackup({ archive, dataDir: target, log: (m) => logs.push(m) });

    expect(result.safetyCopyPath).toBeTruthy();
    const copyPath = result.safetyCopyPath as string;
    expect(basename(copyPath)).toMatch(/^synth-pre-restore-\d{8}-\d{6}\.tar\.gz$/);
    // ADR-092: страховочная копия — в едином каталоге {dataDir}/backups/.
    expect(dirname(copyPath)).toBe(join(target, 'backups'));
    await expect(stat(copyPath)).resolves.toBeTruthy();

    const previous = await readFileFromTarGz(copyPath, 'existing.txt');
    expect(previous?.toString('utf-8')).toBe('old');

    // Прежние данные перезаписаны восстановленными.
    expect(await readFile(join(target, 'sessions', 's1.json'), 'utf-8')).toBe('{"id":"s1"}');
    // Новая копия — тоже 0600.
    expect((await stat(copyPath)).mode & 0o777).toBe(0o600);
  });

  it('повреждённый архив → ошибка, данные не тронуты', async () => {
    const target = join(tmpDir, 'corrupt-target');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'existing.txt'), 'old', 'utf-8');

    const buffer = await readFile(archive);
    const middle = Math.floor(buffer.length / 2);
    buffer[middle] = (buffer[middle] as number) ^ 0xff;
    const corrupted = join(tmpDir, 'corrupted.tar.gz');
    await writeFile(corrupted, buffer);

    await expect(restoreBackup({ archive: corrupted, dataDir: target })).rejects.toThrow();
    expect(await readdir(target)).toEqual(['existing.txt']);
    expect(await readFile(join(target, 'existing.txt'), 'utf-8')).toBe('old');
  });

  it('несовпадение контрольной суммы файла → BackupChecksumError', async () => {
    const bad = join(tmpDir, 'bad-checksum.tar.gz');
    await _stageAndArchive(tmpDir, bad, [{ path: 'sessions/s1.json', content: '{"id":"s1"}' }], (entries) => {
      const wrong = entries.map((entry) =>
        entry.type === 'file' ? { ...entry, sha256: 'deadbeef'.repeat(8) } : entry,
      );
      return _manifest(wrong);
    });

    await expect(restoreBackup({ archive: bad, dataDir: join(tmpDir, 't') })).rejects.toBeInstanceOf(
      BackupChecksumError,
    );
  });

  it('архив из более новой схемы → отказ', async () => {
    const newer = join(tmpDir, 'newer.tar.gz');
    await _stageAndArchive(tmpDir, newer, [{ path: 'sessions/s1.json', content: 'x' }], (entries) =>
      _manifest(entries, { schemaVersion: SCHEMA_VERSION + 5 }),
    );

    await expect(restoreBackup({ archive: newer, dataDir: join(tmpDir, 't') })).rejects.toThrow(
      /более новой версии Synth/,
    );
  });

  it('архив без manifest.json → отказ', async () => {
    const noManifest = join(tmpDir, 'no-manifest.tar.gz');
    await _stageAndArchive(tmpDir, noManifest, [{ path: 'sessions/s1.json', content: 'x' }], () => null);

    await expect(restoreBackup({ archive: noManifest, dataDir: join(tmpDir, 't') })).rejects.toThrow(
      /manifest\.json/,
    );
  });

  it('архив старой схемы: восстановление + предупреждение про synth migrate', async () => {
    const older = join(tmpDir, 'older.tar.gz');
    await _stageAndArchive(tmpDir, older, [{ path: 'sessions/s1.json', content: 'x' }], (entries) =>
      _manifest(entries, { schemaVersion: 0 }),
    );

    const logs: string[] = [];
    const target = join(tmpDir, 'older-target');
    const result = await restoreBackup({ archive: older, dataDir: target, log: (m) => logs.push(m) });
    expect(result.restored).toBe(1);
    expect(logs.join('\n')).toContain('synth migrate');
  });

  it('лишний файл удаляется (возврат к снимку)', async () => {
    const target = join(tmpDir, 'stale');
    await mkdir(join(target, 'sessions'), { recursive: true });
    await writeFile(join(target, 'sessions', 'extra.json'), '{"id":"extra"}', 'utf-8');
    await writeFile(join(target, 'stale.txt'), 'stale', 'utf-8');

    const result = await restoreBackup({ archive, dataDir: target });

    expect(result.removed).toBeGreaterThanOrEqual(2);
    await expect(stat(join(target, 'sessions', 'extra.json'))).rejects.toThrow();
    await expect(stat(join(target, 'stale.txt'))).rejects.toThrow();
    expect(await readFile(join(target, 'sessions', 's1.json'), 'utf-8')).toBe('{"id":"s1"}');
  });

  it('повреждённый файл заменяется архивным (sha256 совпадает)', async () => {
    const target = join(tmpDir, 'corrupt-file');
    await mkdir(join(target, 'sessions'), { recursive: true });
    await writeFile(join(target, 'sessions', 's1.json'), 'BROKEN {', 'utf-8');

    await restoreBackup({ archive, dataDir: target });

    const content = await readFile(join(target, 'sessions', 's1.json'));
    const expected = createHash('sha256').update('{"id":"s1"}').digest('hex');
    expect(createHash('sha256').update(content).digest('hex')).toBe(expected);
  });

  it('backups/ сохраняется при восстановлении', async () => {
    const target = join(tmpDir, 'keep-backups');
    await mkdir(join(target, 'backups'), { recursive: true });
    await writeFile(join(target, 'backups', 'marker.txt'), 'keep', 'utf-8');

    await restoreBackup({ archive, dataDir: target });

    expect(await readFile(join(target, 'backups', 'marker.txt'), 'utf-8')).toBe('keep');
    expect(await readFile(join(target, 'sessions', 's1.json'), 'utf-8')).toBe('{"id":"s1"}');
  });

  it('--dry-run: печатает план очистки, но ничего не удаляет и не пишет', async () => {
    const target = join(tmpDir, 'dry-cleanup');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'stale.txt'), 'stale', 'utf-8');

    const logs: string[] = [];
    const result = await restoreBackup({
      archive,
      dataDir: target,
      dryRun: true,
      log: (m) => logs.push(m),
    });

    expect(result.removed).toBe(0);
    expect(await readFile(join(target, 'stale.txt'), 'utf-8')).toBe('stale');
    expect(logs.join('\n')).toContain('stale.txt');
    await expect(stat(join(target, 'sessions'))).rejects.toThrow();
  });

  it('целевой каталог не существует → создаётся, распаковка проходит', async () => {
    const target = join(tmpDir, 'fresh-target');

    const result = await restoreBackup({ archive, dataDir: target });

    expect(result.removed).toBe(0);
    expect(await readFile(join(target, 'sessions', 's1.json'), 'utf-8')).toBe('{"id":"s1"}');
    expect(await readFile(join(target, 'secrets', 'master.key'), 'utf-8')).toBe('KEY');
  });

  it('--no-safety-copy: копия не создаётся, вычистка и распаковка выполняются', async () => {
    const target = join(tmpDir, 'no-safety');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'stale.txt'), 'stale', 'utf-8');

    const warns: string[] = [];
    const result = await restoreBackup({
      archive,
      dataDir: target,
      safetyCopy: false,
      warn: (m) => warns.push(m),
    });

    expect(result.safetyCopyPath).toBeUndefined();
    expect(warns.join('\n')).toContain('откат');
    await expect(stat(join(target, 'stale.txt'))).rejects.toThrow();
    await expect(stat(join(target, 'backups'))).rejects.toThrow();
    expect(await readFile(join(target, 'sessions', 's1.json'), 'utf-8')).toBe('{"id":"s1"}');
  });
});

/** Базовый манифест с корректными полями. */
function _manifest(
  entries: ArchiveEntryMeta[],
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    tool: 'synth-backup',
    formatVersion: 1,
    schemaVersion: SCHEMA_VERSION,
    instanceVersion: '0.0.0',
    createdAt: new Date().toISOString(),
    withSecrets: false,
    withWorkspace: false,
    excluded: [],
    entries,
    contentChecksum: computeContentChecksum(entries),
    dataDir: '',
    ...overrides,
  };
}

/**
 * Готовит staging-каталог, собирает записи и пишет архив с манифестом.
 * `buildManifest` возвращает объект манифеста или `null` (архив без манифеста).
 */
async function _stageAndArchive(
  base: string,
  archivePath: string,
  files: Array<{ path: string; content: string }>,
  buildManifest: (entries: ArchiveEntryMeta[]) => Record<string, unknown> | null,
): Promise<void> {
  const staging = join(base, `staging-${Math.random().toString(36).slice(2)}`);
  await mkdir(staging, { recursive: true });
  for (const file of files) {
    const target = join(staging, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf-8');
  }
  const sources = await listFilesForArchive(staging, { exclude: () => false });
  const entries: ArchiveEntryMeta[] = [];
  for (const source of sources) {
    if (source.type === 'dir') {
      entries.push({ path: source.path, type: 'dir', size: 0, mode: source.mode });
    } else {
      const content = await readFile(source.absPath);
      entries.push({
        path: source.path,
        type: 'file',
        size: content.length,
        mode: source.mode,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
  }
  const manifest = buildManifest(entries);
  await writeTarGz(archivePath, sources, {
    ...(manifest
      ? { extraFile: { path: 'manifest.json', content: Buffer.from(JSON.stringify(manifest), 'utf-8') } }
      : {}),
  });
}
