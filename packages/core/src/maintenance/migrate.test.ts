// ADR-092: тесты аудит-событий `synth migrate` — `migrate.applied` при реальном
// применении, отсутствие записи на no-op/dry-run, `migrate.failed` при ошибке.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
