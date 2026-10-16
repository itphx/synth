// ADR-091/ADR-092: тесты сервисного слоя обслуживания инстанса —
// список/удаление бэкапов, проверка архива, отложенное восстановление,
// сводный статус.
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../storage/instance-meta.js';
import { createBackup } from './backup.js';
import {
  cancelPendingRestore,
  deleteBackup,
  getMaintenanceStatus,
  getPendingRestore,
  isSafeBackupName,
  listBackups,
  sanitizeBackupName,
  scheduleRestore,
  stageUploadedArchive,
  validateRestoreArchive,
} from './service.js';

describe('maintenance service (ADR-091/ADR-092)', () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-service-'));
    dataDir = join(tmpDir, 'data');
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    await mkdir(join(dataDir, 'projects'), { recursive: true });
    await writeFile(join(dataDir, 'sessions', 's1.json'), '{"id":"s1"}', 'utf-8');
    await writeFile(join(dataDir, 'projects', 'p1.json'), '{"id":"p1"}', 'utf-8');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const backupsDir = (): string => join(dataDir, 'backups');
  const archivePath = (name: string): string => join(backupsDir(), name);
  const makeArchive = async (name = 'backup.tar.gz'): Promise<string> => {
    const out = archivePath(name);
    const result = await createBackup({ dataDir, out, withSecrets: true });
    return result.path;
  };

  describe('listBackups', () => {
    it('пустой каталог → []', async () => {
      expect(await listBackups(dataDir)).toEqual([]);
    });

    it('после createBackup — одна запись с корректными метаданными', async () => {
      const path = await makeArchive('a.tar.gz');

      const list = await listBackups(dataDir);
      expect(list).toHaveLength(1);
      const info = list[0]!;
      expect(info.name).toBe('a.tar.gz');
      expect(info.path).toBe(path);
      expect(info.bytes).toBeGreaterThan(0);
      expect(info.createdAt).toBeTruthy();
      expect(info.schemaVersion).toBe(0);
      expect(info.instanceVersion).toBeTruthy();
      expect(info.withSecrets).toBe(true);
      expect(info.withWorkspace).toBe(false);
      expect(info.entries).toBeGreaterThan(0);
    });

    it('мусорный файл в backups/ не ломает список', async () => {
      await makeArchive('good.tar.gz');
      await writeFile(join(backupsDir(), 'junk.txt'), 'not an archive', 'utf-8');
      await writeFile(join(backupsDir(), 'broken.tar.gz'), 'not a gzip', 'utf-8');
      await mkdir(join(backupsDir(), 'subdir'), { recursive: true });

      const list = await listBackups(dataDir);
      expect(list.map((b) => b.name)).toEqual(['good.tar.gz']);
    });
  });

  describe('stageUploadedArchive / sanitize', () => {
    it('санитизирует имя и кладёт в uploads/, уникализирует коллизию', async () => {
      expect(sanitizeBackupName('../..//weird name.tar.gz')).toBe('weird_name.tar.gz');
      expect(sanitizeBackupName('..')).toBe('upload.tar.gz');

      const bytes = Buffer.from('payload');
      const first = await stageUploadedArchive(dataDir, '../..//weird name.tar.gz', bytes);
      const second = await stageUploadedArchive(dataDir, 'weird name.tar.gz', bytes);

      expect(first).toBe(join(backupsDir(), 'uploads', 'weird_name.tar.gz'));
      expect(second).toBe(join(backupsDir(), 'uploads', 'weird_name-1.tar.gz'));
      expect((await stat(first)).mode & 0o777).toBe(0o600);
    });
  });

  describe('deleteBackup', () => {
    it('имя с / или .. → false, файл не удалён', async () => {
      const path = await makeArchive('del.tar.gz');

      expect(await deleteBackup(dataDir, '../del.tar.gz')).toBe(false);
      expect(await deleteBackup(dataDir, 'sub/del.tar.gz')).toBe(false);
      expect(await deleteBackup(dataDir, '..')).toBe(false);
      await expect(stat(path)).resolves.toBeTruthy();
    });

    it('существующий архив удаляется, повторно → false', async () => {
      const path = await makeArchive('del.tar.gz');

      expect(await deleteBackup(dataDir, 'del.tar.gz')).toBe(true);
      await expect(stat(path)).rejects.toThrow();
      expect(await deleteBackup(dataDir, 'del.tar.gz')).toBe(false);
    });

    it('isSafeBackupName отсекает небезопасные имена', () => {
      expect(isSafeBackupName('ok.tar.gz')).toBe(true);
      expect(isSafeBackupName('a/b.tar.gz')).toBe(false);
      expect(isSafeBackupName('../b.tar.gz')).toBe(false);
      expect(isSafeBackupName('noext')).toBe(false);
      expect(isSafeBackupName('..')).toBe(false);
    });
  });

  describe('validateRestoreArchive', () => {
    it('валидный архив → ok:true + манифест', async () => {
      const path = await makeArchive('valid.tar.gz');

      const result = await validateRestoreArchive({ dataDir, archive: path });
      expect(result.ok).toBe(true);
      expect(result.problem).toBeUndefined();
      expect(result.manifest?.instanceVersion).toBeTruthy();
      expect(result.manifest?.withSecrets).toBe(true);
      expect(result.manifest?.schemaVersion).toBe(0);
      expect(result.manifest?.entries).toBeGreaterThan(0);
    });

    it('повреждённый архив → ok:false + problem', async () => {
      const path = await makeArchive('corrupt.tar.gz');
      const buffer = await readFile(path);
      const middle = Math.floor(buffer.length / 2);
      buffer[middle] = (buffer[middle] as number) ^ 0xff;
      await writeFile(path, buffer);

      const result = await validateRestoreArchive({ dataDir, archive: path });
      expect(result.ok).toBe(false);
      expect(result.problem).toBeTruthy();
    });

    it('архив из более новой схемы → ok:false', async () => {
      await writeFile(
        join(dataDir, 'meta.json'),
        JSON.stringify({
          schemaVersion: SCHEMA_VERSION + 5,
          instanceVersion: '0.0.0',
          migrations: [],
          updatedAt: '',
        }),
        'utf-8',
      );
      const path = await makeArchive('newer.tar.gz');

      const result = await validateRestoreArchive({ dataDir, archive: path });
      expect(result.ok).toBe(false);
      expect(result.problem).toContain('более новой');
    });

    it('архив вне каталога бэкапов → ok:false', async () => {
      const outside = join(tmpDir, 'outside.tar.gz');
      await createBackup({ dataDir, out: outside });

      const result = await validateRestoreArchive({ dataDir, archive: outside });
      expect(result.ok).toBe(false);
      expect(result.problem).toContain('каталоге бэкапов');
    });

    it('отсутствующий архив → ok:false', async () => {
      const result = await validateRestoreArchive({
        dataDir,
        archive: archivePath('nope.tar.gz'),
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('scheduleRestore / getPendingRestore / cancelPendingRestore', () => {
    it('валидный архив → запрос создаётся, читается, отменяется', async () => {
      const path = await makeArchive('sched.tar.gz');

      const request = await scheduleRestore({ dataDir, archive: path, requestedBy: 'admin' });
      expect(request.archive).toBe(path);
      expect(request.requestedBy).toBe('admin');
      expect(request.safetyCopy).toBe(true);
      expect(request.requestedAt).toBeTruthy();

      expect(await getPendingRestore(dataDir)).toEqual(request);

      const raw = JSON.parse(
        await readFile(join(dataDir, 'maintenance', 'restore-request.json'), 'utf-8'),
      );
      expect(raw.archive).toBe(path);

      expect(await cancelPendingRestore(dataDir)).toBe(true);
      expect(await getPendingRestore(dataDir)).toBeNull();
      expect(await cancelPendingRestore(dataDir)).toBe(false);
    });

    it('safetyCopy:false сохраняется в запросе', async () => {
      const path = await makeArchive('sched2.tar.gz');
      const request = await scheduleRestore({ dataDir, archive: path, safetyCopy: false });
      expect(request.safetyCopy).toBe(false);
    });

    it('отсутствующий архив → ошибка, запрос не создаётся', async () => {
      await expect(
        scheduleRestore({ dataDir, archive: archivePath('nope.tar.gz') }),
      ).rejects.toThrow();
      expect(await getPendingRestore(dataDir)).toBeNull();
    });

    it('невалидный архив → ошибка, запрос не создаётся', async () => {
      const path = await makeArchive('bad.tar.gz');
      const buffer = await readFile(path);
      buffer[Math.floor(buffer.length / 2)] = (buffer[Math.floor(buffer.length / 2)] as number) ^ 0xff;
      await writeFile(path, buffer);

      await expect(scheduleRestore({ dataDir, archive: path })).rejects.toThrow(/проверку/);
      expect(await getPendingRestore(dataDir)).toBeNull();
    });

    it('архив вне каталога бэкапов → ошибка', async () => {
      const outside = join(tmpDir, 'outside.tar.gz');
      await createBackup({ dataDir, out: outside });

      await expect(scheduleRestore({ dataDir, archive: outside })).rejects.toThrow(/бэкапов/);
    });
  });

  describe('getMaintenanceStatus', () => {
    it('пустой каталог → структура со схемой 0, pending непустым, doctor.ok (warn ≠ fail)', async () => {
      const status = await getMaintenanceStatus({ dataDir });

      expect(status.version).toBeTruthy();
      expect(status.dataDir).toBe(dataDir);
      expect(status.schema.current).toBe(0);
      expect(status.schema.expected).toBe(SCHEMA_VERSION);
      expect(status.schema.pending.length).toBeGreaterThan(0);
      expect(status.schema.pending[0]).toHaveProperty('id');
      expect(status.schema.pending[0]).toHaveProperty('toVersion');
      expect(status.backups).toEqual([]);
      expect(status.pendingRestore).toBeNull();

      // warn не делает ok=false — fail-проверок нет.
      expect(status.doctor.fail).toBe(0);
      expect(status.doctor.ok).toBe(true);
      expect(status.doctor.warn).toBeGreaterThan(0);
    });

    it('с бэкапом и запросом восстановления → отражает оба', async () => {
      const path = await makeArchive('status.tar.gz');
      await scheduleRestore({ dataDir, archive: path });

      const status = await getMaintenanceStatus({ dataDir });
      expect(status.backups).toHaveLength(1);
      expect(status.pendingRestore?.archive).toBe(path);
    });
  });
});
