// ADR-092: тесты аудит-событий `synth migrate` — `migrate.applied` при реальном
// применении, отсутствие записи на no-op/dry-run, `migrate.failed` при ошибке.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStorage, type StorageContext } from '../storage/storage-context.js';
import { MemoryMaintenanceAuditRepository } from '../storage/memory/index.js';
import { runMigrateCommand } from './migrate.js';

describe('runMigrateCommand — аудит-журнал (ADR-092)', () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-migrate-audit-'));
    dataDir = join(tmpDir, 'data');
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('--yes при реальном применении пишет migrate.applied (trigger cli)', async () => {
    const audit = new MemoryMaintenanceAuditRepository();

    const code = await runMigrateCommand({ dataDir, yes: true, audit, log: () => {} });

    expect(code).toBe(0);
    const list = await audit.list();
    expect(list.map((e) => e.op)).toEqual(['migrate.applied']);
    expect(list[0]!.actor).toBe('cli');
    expect(list[0]!.details).toMatchObject({ trigger: 'cli', from: 0 });
    expect(list[0]!.details?.applied).toContain('session-scope-snapshots-v1');
  });

  it('повторный --yes (no-op) не пишет событие', async () => {
    const audit = new MemoryMaintenanceAuditRepository();
    await runMigrateCommand({ dataDir, yes: true, audit, log: () => {} });
    await audit.clear();

    const code = await runMigrateCommand({ dataDir, yes: true, audit, log: () => {} });

    expect(code).toBe(0);
    expect(await audit.list()).toEqual([]);
  });

  it('--dry-run не пишет событие', async () => {
    const audit = new MemoryMaintenanceAuditRepository();

    const code = await runMigrateCommand({ dataDir, dryRun: true, audit, log: () => {} });

    expect(code).toBe(0);
    expect(await audit.list()).toEqual([]);
  });

  it('ошибка миграции пишет migrate.failed и возвращает 1', async () => {
    const audit = new MemoryMaintenanceAuditRepository();
    // `dataDir` — файл: создание `meta.json` (mkdir внутри) падает.
    const blocker = join(tmpDir, 'blocker');
    await writeFile(blocker, 'x', 'utf-8');

    const code = await runMigrateCommand({
      dataDir: blocker,
      yes: true,
      audit,
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(1);
    const list = await audit.list();
    expect(list.map((e) => e.op)).toEqual(['migrate.failed']);
    expect(list[0]!.status).toBe('failed');
    expect(list[0]!.actor).toBe('cli');
    expect(list[0]!.error).toBeTruthy();
  });
});

/**
 * ADR-097: `synth migrate` при `storage.backend=postgres` мигрирует SQL-схему
 * драйвера (контур `synth_schema_migrations`), а не `meta.json`. Контекст хранения
 * подменяется memory-сборкой с швом `schemaMigrations` — БД не нужна.
 */
describe('runMigrateCommand — backend=postgres (ADR-097)', () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-migrate-pg-'));
    dataDir = join(tmpDir, 'data');
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Контекст хранения с признаком postgres и моком миграций схемы. */
  function pgStorage(
    schemaMigrations: StorageContext['schemaMigrations'],
  ): StorageContext {
    return { ...createMemoryStorage(), kind: 'postgres', schemaMigrations };
  }

  it('--dry-run показывает план и ничего не применяет', async () => {
    const calls: Array<{ dryRun?: boolean } | undefined> = [];
    const storage = pgStorage(async (opts) => {
      calls.push(opts);
      return { current: 1, expected: 3, pending: [2, 3], applied: [] };
    });
    const audit = new MemoryMaintenanceAuditRepository();
    const logs: string[] = [];

    const code = await runMigrateCommand({
      dataDir,
      dryRun: true,
      storage,
      audit,
      log: (m) => logs.push(m),
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ dryRun: true }]);
    const out = logs.join('\n');
    expect(out).toContain('[dry-run] Миграция схемы БД');
    expect(out).toContain('текущая версия схемы БД: 1');
    expect(out).toContain('ожидаемая версия: 3');
    expect(out).toContain('план (2): v2, v3');
    expect(out).toContain('изменения не записаны');
    expect(await audit.list()).toEqual([]);
  });

  it('--yes применяет миграции и пишет migrate.applied с backend=postgres', async () => {
    const calls: Array<{ dryRun?: boolean } | undefined> = [];
    const storage = pgStorage(async (opts) => {
      calls.push(opts);
      return opts?.dryRun
        ? { current: 1, expected: 3, pending: [2, 3], applied: [] }
        : { current: 3, expected: 3, pending: [], applied: [2, 3] };
    });
    const audit = new MemoryMaintenanceAuditRepository();
    const logs: string[] = [];

    const code = await runMigrateCommand({
      dataDir,
      yes: true,
      storage,
      audit,
      log: (m) => logs.push(m),
    });

    expect(code).toBe(0);
    // Сначала план (dry-run), затем применение.
    expect(calls).toEqual([{ dryRun: true }, { dryRun: false }]);
    const out = logs.join('\n');
    expect(out).toContain('применено миграций: 2');
    expect(out).toContain('версии: v2, v3');
    expect(out).toContain('версия схемы БД: 3');

    const list = await audit.list();
    expect(list.map((e) => e.op)).toEqual(['migrate.applied']);
    expect(list[0]!.actor).toBe('cli');
    expect(list[0]!.details).toMatchObject({
      backend: 'postgres',
      from: 1,
      to: 3,
      applied: [2, 3],
      trigger: 'cli',
    });
  });

  it('нечего применять: сообщение и код 0, применение не вызывается', async () => {
    const calls: Array<{ dryRun?: boolean } | undefined> = [];
    const storage = pgStorage(async (opts) => {
      calls.push(opts);
      return { current: 3, expected: 3, pending: [], applied: [] };
    });
    const logs: string[] = [];

    const code = await runMigrateCommand({ dataDir, yes: true, storage, log: (m) => logs.push(m) });

    expect(code).toBe(0);
    expect(calls).toEqual([{ dryRun: true }]);
    expect(logs.join('\n')).toContain('нечего применять');
  });

  it('схема БД новее драйвера → fail-closed: код 1, миграции не применяются', async () => {
    const applied: boolean[] = [];
    const storage = pgStorage(async (opts) => {
      applied.push(opts?.dryRun === false);
      return { current: 9, expected: 3, pending: [], applied: [] };
    });
    const errors: string[] = [];

    const code = await runMigrateCommand({
      dataDir,
      yes: true,
      storage,
      log: () => {},
      error: (m) => errors.push(m),
    });

    expect(code).toBe(1);
    expect(applied).toEqual([false]); // только план (dryRun=true), применения нет
    expect(errors.join('\n')).toContain('схема БД новее драйвера');
    expect(errors.join('\n')).toContain('9 > 3');
  });

  it('без --dry-run и без --yes отказ до обращения к схеме БД', async () => {
    const storage = pgStorage(async () => {
      throw new Error('не должен вызываться');
    });
    const errors: string[] = [];

    const code = await runMigrateCommand({ dataDir, storage, log: () => {}, error: (m) => errors.push(m) });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('--dry-run');
  });

  it('ошибка применения пишет migrate.failed (backend=postgres) и возвращает 1', async () => {
    const storage = pgStorage(async (opts) => {
      if (opts?.dryRun) return { current: 1, expected: 3, pending: [2, 3], applied: [] };
      throw new Error('relation already exists');
    });
    const audit = new MemoryMaintenanceAuditRepository();
    const errors: string[] = [];
    const log = vi.fn();

    const code = await runMigrateCommand({
      dataDir,
      yes: true,
      storage,
      audit,
      log,
      error: (m) => errors.push(m),
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('relation already exists');
    const list = await audit.list();
    expect(list.map((e) => e.op)).toEqual(['migrate.failed']);
    expect(list[0]!.details).toMatchObject({ backend: 'postgres', trigger: 'cli' });
    expect(list[0]!.error).toContain('relation already exists');
  });

  it('контекст postgres без шва schemaMigrations → понятная ошибка, код 1', async () => {
    const storage = { ...createMemoryStorage(), kind: 'postgres' } as StorageContext;
    const errors: string[] = [];

    const code = await runMigrateCommand({
      dataDir,
      yes: true,
      storage,
      log: () => {},
      error: (m) => errors.push(m),
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('schemaMigrations');
  });
});
