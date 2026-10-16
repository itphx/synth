import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYNTH_VERSION } from '@itphx/synth-shared';
import { RuntimeSettingsStore } from './runtime-settings.js';
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  InstanceDataTooNewError,
  assertInstanceDataNotTooNew,
  checkInstanceCompatibility,
  readInstanceMeta,
  runMigrations,
  writeInstanceMeta,
} from './instance-meta.js';

describe('instance-meta (ADR-092)', () => {
  let tmpDir: string;
  let settingsStore: RuntimeSettingsStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-instance-meta-'));
    settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const metaPath = () => join(tmpDir, 'meta.json');
  const exists = async (p: string): Promise<boolean> => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  };

  it('SCHEMA_VERSION = max(toVersion) реестра', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(SCHEMA_VERSION).toBe(Math.max(...MIGRATIONS.map((m) => m.toVersion)));
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('свежий каталог: pending (current 0), meta отсутствует, ничего не создано', async () => {
    const compat = await checkInstanceCompatibility(tmpDir);
    expect(compat.status).toBe('pending');
    expect(compat.meta).toBeNull();
    expect(compat.currentVersion).toBe(0);
    expect(compat.expectedVersion).toBe(SCHEMA_VERSION);
    expect(compat.pending.map((m) => m.id)).toContain('session-scope-snapshots-v1');

    expect(await readInstanceMeta(tmpDir)).toBeNull();
    expect(await exists(metaPath())).toBe(false);
    expect(await readdir(tmpDir)).toEqual([]);

    // На свежем каталоге guard не бросает и ничего не пишет.
    await expect(assertInstanceDataNotTooNew(tmpDir)).resolves.toBeUndefined();
    expect(await exists(metaPath())).toBe(false);
  });

  it('dry-run: planned непустой, meta.json не создан', async () => {
    const result = await runMigrations({ dataDir: tmpDir, deps: { settingsStore }, dryRun: true });
    expect(result.planned).toContain('session-scope-snapshots-v1');
    expect(result.applied).toEqual([]);
    expect(result.updated).toBe(0);
    expect(await exists(metaPath())).toBe(false);
    expect(await readdir(tmpDir)).toEqual([]);
  });

  it('применение: meta.json создан, идемпотентно, без дублей', async () => {
    const first = await runMigrations({ dataDir: tmpDir, deps: { settingsStore } });
    expect(first.applied).toContain('session-scope-snapshots-v1');
    expect(await exists(metaPath())).toBe(true);

    const meta = await readInstanceMeta(tmpDir);
    expect(meta?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(meta?.instanceVersion).toBe(SYNTH_VERSION);
    expect(meta?.migrations).toContain('session-scope-snapshots-v1');
    expect(meta?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Set(meta!.migrations).size).toBe(meta!.migrations.length);

    // Повторный запуск — идемпотентно.
    const second = await runMigrations({ dataDir: tmpDir, deps: { settingsStore } });
    expect(second.applied).toEqual([]);
    expect(second.planned).toEqual([]);
    const meta2 = await readInstanceMeta(tmpDir);
    expect(meta2?.migrations).toEqual(meta?.migrations);
    expect(new Set(meta2!.migrations).size).toBe(meta2!.migrations.length);
  });

  it('too-new: status + assert бросает InstanceDataTooNewError', async () => {
    await writeInstanceMeta(tmpDir, {
      schemaVersion: SCHEMA_VERSION + 1,
      instanceVersion: '99.0.0',
      migrations: ['future'],
      updatedAt: new Date().toISOString(),
    });

    const compat = await checkInstanceCompatibility(tmpDir);
    expect(compat.status).toBe('too-new');
    expect(compat.currentVersion).toBe(SCHEMA_VERSION + 1);

    await expect(assertInstanceDataNotTooNew(tmpDir)).rejects.toBeInstanceOf(InstanceDataTooNewError);
    await expect(runMigrations({ dataDir: tmpDir, deps: { settingsStore } }))
      .rejects.toBeInstanceOf(InstanceDataTooNewError);
  });

  it('битый meta.json (не-JSON) → readInstanceMeta null', async () => {
    await writeFile(metaPath(), '{ not json', 'utf-8');
    expect(await readInstanceMeta(tmpDir)).toBeNull();
    // Неверная форма (JSON без schemaVersion) — тоже null.
    await writeFile(metaPath(), JSON.stringify({ foo: 'bar' }), 'utf-8');
    expect(await readInstanceMeta(tmpDir)).toBeNull();
  });
});
