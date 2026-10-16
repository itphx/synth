// ADR-092: тесты авто-миграций при старте (`applyStartupMigrations`):
// обязательная страховочная копия, fail-closed, идемпотентность, too-new.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { RuntimeSettingsStore } from '../storage/runtime-settings.js';
import { MemoryMaintenanceAuditRepository } from '../storage/memory/index.js';
import {
  InstanceDataTooNewError,
  SCHEMA_VERSION,
  readInstanceMeta,
} from '../storage/instance-meta.js';
import { readFileFromTarGz } from './archive.js';
import { createBackup } from './backup.js';
import { getPendingRestore, scheduleRestore } from './service.js';
import { applyPendingRestore, applyStartupMigrations } from './startup.js';

describe('applyStartupMigrations (ADR-092)', () => {
  let tmpDir: string;
  let dataDir: string;
  let settingsStore: RuntimeSettingsStore;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-startup-'));
    dataDir = join(tmpDir, 'data');
    await mkdir(dataDir, { recursive: true });
    settingsStore = new RuntimeSettingsStore({ dataDir });
    sessionManager = new SessionManager(new FileStore({ dataDir }));
    projectStore = new ProjectStore({ dataDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const deps = () => ({ dataDir, settingsStore, sessionManager, projectStore });
  const metaPath = () => join(dataDir, 'meta.json');
  const exists = async (p: string): Promise<boolean> => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  };
  const writeMeta = (schemaVersion: number): Promise<void> =>
    writeFile(
      metaPath(),
      JSON.stringify({ schemaVersion, instanceVersion: '0.0.0', migrations: [], updatedAt: '' }),
      'utf-8',
    );

  it('свежий (актуальный) каталог → applied: [], страховочная копия не создана', async () => {
    await writeMeta(SCHEMA_VERSION);

    const logs: string[] = [];
    const result = await applyStartupMigrations({ ...deps(), log: (m) => logs.push(m) });

    expect(result.applied).toEqual([]);
    expect(result.safetyCopyPath).toBeUndefined();
    expect(logs).toEqual([]);
    expect(await exists(join(dataDir, 'backups'))).toBe(false);
  });

  it('pending: копия создана до применения, meta обновлён, повторный вызов — no-op', async () => {
    await writeMeta(0);

    const logs: string[] = [];
    const result = await applyStartupMigrations({ ...deps(), log: (m) => logs.push(m) });

    expect(result.applied).toContain('session-scope-snapshots-v1');
    const copyPath = result.safetyCopyPath as string;
    expect(copyPath).toMatch(/\/backups\/synth-pre-migrate-\d{8}-\d{6}\.tar\.gz$/);
    await expect(stat(copyPath)).resolves.toBeTruthy();

    // Копия снята ДО применения: её manifest/содержимое фиксирует прежнюю схему.
    const archivedMeta = await readFileFromTarGz(copyPath, 'meta.json');
    expect(JSON.parse(archivedMeta!.toString('utf-8')).schemaVersion).toBe(0);

    // После применения meta.json отражает актуальную схему.
    expect((await readInstanceMeta(dataDir))?.schemaVersion).toBe(SCHEMA_VERSION);

    // Единственное предупреждение на старт, без секретов.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('миграции применены');
    expect(logs[0]).toContain(copyPath);

    // Повторный запуск: pending пуст → ничего не пишем/не копируем.
    const second = await applyStartupMigrations({ ...deps() });
    expect(second.applied).toEqual([]);
    expect(second.safetyCopyPath).toBeUndefined();
  });

  it('too-new → InstanceDataTooNewError, миграции не применены', async () => {
    await writeMeta(SCHEMA_VERSION + 5);

    await expect(applyStartupMigrations({ ...deps() })).rejects.toBeInstanceOf(InstanceDataTooNewError);
    expect((await readInstanceMeta(dataDir))?.schemaVersion).toBe(SCHEMA_VERSION + 5);
  });

  it('createBackup бросает → ошибка пробрасывается, миграции не применены', async () => {
    await writeMeta(0);
    // Каталог `backups/` занят файлом → создание каталога копии падает (недоступность пути).
    await writeFile(join(dataDir, 'backups'), 'blocker', 'utf-8');

    await expect(applyStartupMigrations({ ...deps() })).rejects.toThrow(/страховочную копию/);
    // Схема НЕ обновлена (fail-closed).
    expect((await readInstanceMeta(dataDir))?.schemaVersion).toBe(0);
  });

  it('аудит: реальное применение пишет migrate.applied (trigger startup); no-op — нет', async () => {
    await writeMeta(0);
    const audit = new MemoryMaintenanceAuditRepository();

    const result = await applyStartupMigrations({ ...deps(), audit });
    expect(result.applied).toContain('session-scope-snapshots-v1');

    const list = await audit.list();
    expect(list.map((e) => e.op)).toEqual(['migrate.applied']);
    expect(list[0]!.actor).toBe('startup');
    expect(list[0]!.details).toMatchObject({
      trigger: 'startup',
      from: 0,
      to: SCHEMA_VERSION,
    });
    expect(list[0]!.details?.applied).toContain('session-scope-snapshots-v1');

    // Повторный запуск (pending пуст) — событие не пишется.
    await audit.clear();
    await applyStartupMigrations({ ...deps(), audit });
    expect(await audit.list()).toEqual([]);
  });
});

describe('applyPendingRestore (ADR-091)', () => {
  let tmpDir: string;
  let dataDir: string;
  let archive: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-pending-restore-'));
    dataDir = join(tmpDir, 'data');
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    await writeFile(join(dataDir, 'sessions', 's1.json'), '{"v":1}', 'utf-8');
    archive = join(dataDir, 'backups', 'snapshot.tar.gz');
    await createBackup({ dataDir, out: archive, withSecrets: true });
    // Данные меняются после снятия снимка — восстановление должно их откатить.
    await writeFile(join(dataDir, 'sessions', 's1.json'), '{"v":2}', 'utf-8');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const requestPath = (): string => join(dataDir, 'maintenance', 'restore-request.json');

  it('без запроса — no-op', async () => {
    const result = await applyPendingRestore({ dataDir });

    expect(result).toEqual({ restored: false });
    expect(await readFile(join(dataDir, 'sessions', 's1.json'), 'utf-8')).toBe('{"v":2}');
  });

  it('с запросом — данные восстановлены, запрос удалён', async () => {
    await scheduleRestore({ dataDir, archive });
    expect(await getPendingRestore(dataDir)).not.toBeNull();

    const logs: string[] = [];
    const result = await applyPendingRestore({ dataDir, log: (m) => logs.push(m) });

    expect(result.restored).toBe(true);
    expect(result.archive).toBe(archive);
    // Данные возвращены к снимку.
    expect(await readFile(join(dataDir, 'sessions', 's1.json'), 'utf-8')).toBe('{"v":1}');
    // Запрос удалён.
    expect(await getPendingRestore(dataDir)).toBeNull();
    await expect(stat(requestPath())).rejects.toThrow();
    expect(logs.join('\n')).toContain('запрос на восстановление');
  });

  it('safetyCopy:false — восстановление без страховочной копии', async () => {
    await scheduleRestore({ dataDir, archive, safetyCopy: false });

    const logs: string[] = [];
    const result = await applyPendingRestore({ dataDir, log: (m) => logs.push(m) });

    expect(result.restored).toBe(true);
    expect(logs.join('\n')).toContain('не создавалась');
    expect(await readFile(join(dataDir, 'sessions', 's1.json'), 'utf-8')).toBe('{"v":1}');
  });

  it('невалидный архив → ошибка, запрос НЕ удалён', async () => {
    await scheduleRestore({ dataDir, archive });
    // Портим архив после планирования — восстановление обязано отказать.
    const buffer = await readFile(archive);
    buffer[Math.floor(buffer.length / 2)] = (buffer[Math.floor(buffer.length / 2)] as number) ^ 0xff;
    await writeFile(archive, buffer);

    await expect(applyPendingRestore({ dataDir })).rejects.toThrow();
    // Запрос на месте (fail-closed: оператор исправляет или отменяет).
    expect(await getPendingRestore(dataDir)).not.toBeNull();
    await expect(stat(requestPath())).resolves.toBeTruthy();
  });

  it('аудит: применение запроса пишет restore.applied (trigger startup, actor startup)', async () => {
    const audit = new MemoryMaintenanceAuditRepository();
    await scheduleRestore({ dataDir, archive });

    const result = await applyPendingRestore({ dataDir, audit });

    expect(result.restored).toBe(true);
    const list = await audit.list();
    expect(list.map((e) => e.op)).toEqual(['restore.applied']);
    expect(list[0]!.actor).toBe('startup');
    expect(list[0]!.details).toMatchObject({ trigger: 'startup', archive });
  });

  it('аудит: ошибка восстановления при старте пишет restore.failed (actor startup)', async () => {
    const audit = new MemoryMaintenanceAuditRepository();
    await scheduleRestore({ dataDir, archive });
    // Портим архив после планирования — восстановление обязано отказать.
    const buffer = await readFile(archive);
    buffer[Math.floor(buffer.length / 2)] = (buffer[Math.floor(buffer.length / 2)] as number) ^ 0xff;
    await writeFile(archive, buffer);

    await expect(applyPendingRestore({ dataDir, audit })).rejects.toThrow();

    const list = await audit.list();
    expect(list.map((e) => e.op)).toEqual(['restore.failed']);
    expect(list[0]!.actor).toBe('startup');
    expect(list[0]!.error).toBeTruthy();
  });
});
