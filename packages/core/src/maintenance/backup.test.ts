// ADR-091: тесты `synth backup` на временных каталогах данных.
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTarGz, readFileFromTarGz } from './archive.js';
import { createBackup, safetyCopyPath, type BackupManifest } from './backup.js';

describe('createBackup', () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-backup-'));
    dataDir = join(tmpDir, 'data');
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    await mkdir(join(dataDir, 'projects'), { recursive: true });
    await mkdir(join(dataDir, 'secrets'), { recursive: true, mode: 0o700 });
    await mkdir(join(dataDir, 'workspaces', 'w1'), { recursive: true });
    await mkdir(join(dataDir, 'tmp'), { recursive: true });
    await mkdir(join(dataDir, 'logs'), { recursive: true });
    await mkdir(join(dataDir, 'backups'), { recursive: true });
    await mkdir(join(dataDir, 'maintenance'), { recursive: true });

    await writeFile(join(dataDir, 'sessions', 's1.json'), '{"id":"s1"}', 'utf-8');
    await writeFile(join(dataDir, 'projects', 'p1.json'), '{"id":"p1"}', 'utf-8');
    await writeFile(join(dataDir, 'secrets', 'master.key'), 'SECRET', 'utf-8');
    await writeFile(join(dataDir, 'workspaces', 'w1', 'f.txt'), 'ws', 'utf-8');
    await writeFile(join(dataDir, 'tmp', 'scratch'), 'tmp', 'utf-8');
    await writeFile(join(dataDir, 'logs', 'app.log'), 'log', 'utf-8');
    await writeFile(join(dataDir, 'backups', 'synth-pre-migrate-20260101-000000.tar.gz'), 'copy', 'utf-8');
    await writeFile(join(dataDir, 'maintenance', 'restore-request.json'), '{}', 'utf-8');
    await writeFile(join(dataDir, '.doctor-probe'), 'probe', 'utf-8');
    await writeFile(join(dataDir, 'scheduler.lock'), 'lock', 'utf-8');
    await writeFile(
      join(dataDir, 'meta.json'),
      JSON.stringify({ schemaVersion: 3, instanceVersion: '0.0.0', migrations: [], updatedAt: '' }),
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('создаёт архив 0600 с манифестом и sha256 на каждый файл; секреты/workspace исключены', async () => {
    const out = join(tmpDir, 'out', 'b.tar.gz');
    const result = await createBackup({ dataDir, out });

    expect(result.path).toBe(out);
    const info = await stat(out);
    expect(info.mode & 0o777).toBe(0o600);
    expect(result.bytes).toBeGreaterThan(0);

    const manifest = result.manifest;
    expect(manifest.tool).toBe('synth-backup');
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.instanceVersion).toBeTruthy();
    expect(manifest.excluded).toContain('secrets/');
    expect(manifest.excluded).toContain('workspaces/');
    expect(manifest.excluded).toContain('backups/');
    // ADR-091/ADR-092: транзиентное состояние обслуживания не архивируется.
    expect(manifest.excluded).toContain('maintenance/');

    const paths = manifest.entries.map((entry) => entry.path);
    expect(paths).toContain('sessions/s1.json');
    expect(paths).toContain('projects/p1.json');
    expect(paths).toContain('meta.json');
    expect(paths.some((p) => p === 'secrets' || p.startsWith('secrets/'))).toBe(false);
    expect(paths.some((p) => p === 'workspaces' || p.startsWith('workspaces/'))).toBe(false);
    expect(paths.some((p) => p === 'tmp' || p.startsWith('tmp/'))).toBe(false);
    expect(paths.some((p) => p === 'backups' || p.startsWith('backups/'))).toBe(false);
    expect(paths.some((p) => p === 'maintenance' || p.startsWith('maintenance/'))).toBe(false);
    expect(paths).not.toContain('.doctor-probe');
    expect(paths).not.toContain('scheduler.lock');
    expect(paths).not.toContain('manifest.json');

    // sha256 для каждого файла совпадает с фактическим содержимым.
    const expected = createHash('sha256').update('{"id":"s1"}').digest('hex');
    const s1 = manifest.entries.find((entry) => entry.path === 'sessions/s1.json');
    expect(s1?.sha256).toBe(expected);
    for (const entry of manifest.entries) {
      if (entry.type === 'file') expect(typeof entry.sha256).toBe('string');
    }

    // Манифест реально лежит в архиве и парсится.
    const raw = await readFileFromTarGz(out, 'manifest.json');
    const parsed = JSON.parse(raw?.toString('utf-8') ?? '{}') as BackupManifest;
    expect(parsed.contentChecksum).toBe(manifest.contentChecksum);
    expect((await listTarGz(out)).map((entry) => entry.path)).toContain('manifest.json');
    // Каталоги, присутствовавшие в дереве, попали записями.
    expect((await listTarGz(out)).some((entry) => entry.type === 'dir')).toBe(true);
  });

  it('withSecrets включает secrets/, withWorkspace — workspaces/', async () => {
    const out = join(tmpDir, 'full.tar.gz');
    const result = await createBackup({
      dataDir,
      out,
      withSecrets: true,
      withWorkspace: true,
    });

    const paths = result.manifest.entries.map((entry) => entry.path);
    expect(paths).toContain('secrets/master.key');
    expect(paths).toContain('workspaces/w1/f.txt');
    expect(result.manifest.withSecrets).toBe(true);
    expect(result.manifest.withWorkspace).toBe(true);
    expect(result.manifest.excluded).not.toContain('secrets/');
    expect(result.manifest.excluded).not.toContain('workspaces/');

    const secret = result.manifest.entries.find((entry) => entry.path === 'secrets/master.key');
    expect(secret?.sha256).toBe(createHash('sha256').update('SECRET').digest('hex'));
  });

  it('--live не меняет содержимое (те же записи и contentChecksum)', async () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const offline = await createBackup({
      dataDir,
      out: join(tmpDir, 'offline.tar.gz'),
      now,
      withSecrets: true,
    });
    const live = await createBackup({
      dataDir,
      out: join(tmpDir, 'live.tar.gz'),
      now,
      withSecrets: true,
      live: true,
    });

    expect(live.manifest.entries).toEqual(offline.manifest.entries);
    expect(live.manifest.contentChecksum).toBe(offline.manifest.contentChecksum);
  });

  it('у каждого файла манифеста ровно одна запись (нет дублей)', async () => {
    const result = await createBackup({ dataDir, out: join(tmpDir, 'dup.tar.gz'), withSecrets: true });
    const paths = result.manifest.entries.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('имя по умолчанию содержит instanceVersion и метку времени', async () => {
    const now = new Date('2026-07-08T09:10:11');
    const result = await createBackup({ dataDir, out: tmpDir, now });
    expect(dirname(result.path)).toBe(tmpDir);
    expect(result.path).toContain('synth-backup-');
    expect(result.path).toMatch(/synth-backup-.*-\d{8}-\d{6}\.tar\.gz$/);
    // meta.json включён и читаем.
    const meta = result.manifest.entries.find((entry) => entry.path === 'meta.json');
    expect(meta?.type).toBe('file');
  });

  it('safetyCopyPath: единый каталог backups/ с меткой вида (ADR-092)', () => {
    const now = new Date('2026-07-08T09:10:11');
    expect(safetyCopyPath(dataDir, 'pre-migrate', now)).toBe(
      join(dataDir, 'backups', 'synth-pre-migrate-20260708-091011.tar.gz'),
    );
    expect(safetyCopyPath(dataDir, 'pre-restore', now)).toMatch(
      /\/backups\/synth-pre-restore-\d{8}-\d{6}\.tar\.gz$/,
    );
  });
});
