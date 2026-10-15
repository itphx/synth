// PROP-092: тесты авто-миграций при старте (`applyStartupMigrations`):
// обязательная страховочная копия, fail-closed, идемпотентность, too-new.
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { RuntimeSettingsStore } from '../storage/runtime-settings.js';
import {
  InstanceDataTooNewError,
  SCHEMA_VERSION,
  readInstanceMeta,
} from '../storage/instance-meta.js';
import { readFileFromTarGz } from './archive.js';
import { applyStartupMigrations } from './startup.js';

describe('applyStartupMigrations (PROP-092)', () => {
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
});
