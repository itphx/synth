// ADR-092: тесты аудит-журнала обслуживания инстанса —
// файловая реализация (`MaintenanceAuditStore`) и in-memory
// (`MemoryMaintenanceAuditRepository`).
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MaintenanceAuditEntry } from '@itphx/synth-shared';
import { MaintenanceAuditStore } from './maintenance-audit-store.js';
import { MemoryMaintenanceAuditRepository } from './memory/index.js';

function entry(id: string, over: Partial<MaintenanceAuditEntry> = {}): MaintenanceAuditEntry {
  return {
    id,
    ts: new Date().toISOString(),
    op: 'backup.created',
    status: 'ok',
    ...over,
  };
}

describe('MaintenanceAuditStore (ADR-092)', () => {
  let tmpDir: string;
  let dataDir: string;
  let filePath: string;
  let store: MaintenanceAuditStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-audit-'));
    dataDir = join(tmpDir, 'data');
    filePath = join(dataDir, 'audit', 'maintenance.jsonl');
    store = new MaintenanceAuditStore({ dataDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('append создаёт каталог `audit/` и пишет JSONL-строку', async () => {
    await expect(stat(join(dataDir, 'audit'))).rejects.toThrow();

    await store.append(
      entry('ma_1', { op: 'migrate.applied', actor: 'cli', version: '1.2.3', details: { from: 0, to: 1 } }),
    );

    expect((await stat(join(dataDir, 'audit'))).isDirectory()).toBe(true);
    const raw = await readFile(filePath, 'utf-8');
    expect(raw.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(raw.trim()) as MaintenanceAuditEntry;
    expect(parsed.id).toBe('ma_1');
    expect(parsed.op).toBe('migrate.applied');
    expect(parsed.status).toBe('ok');
    expect(parsed.actor).toBe('cli');
    expect(parsed.version).toBe('1.2.3');
    expect(parsed.details).toEqual({ from: 0, to: 1 });
  });

  it('list: свежие первыми; фильтр op и limit', async () => {
    await store.append(entry('ma_1'));
    await store.append(entry('ma_2', { op: 'restore.applied' }));
    await store.append(entry('ma_3'));

    expect((await store.list()).map((e) => e.id)).toEqual(['ma_3', 'ma_2', 'ma_1']);
    expect((await store.list({ op: 'backup.created' })).map((e) => e.id)).toEqual(['ma_3', 'ma_1']);
    expect((await store.list({ op: 'restore.applied' })).map((e) => e.id)).toEqual(['ma_2']);
    expect((await store.list({ limit: 2 })).map((e) => e.id)).toEqual(['ma_3', 'ma_2']);
    expect((await store.list({ op: 'backup.created', limit: 1 })).map((e) => e.id)).toEqual(['ma_3']);
  });

  it('clear: число удалённых + опустошение; пустой журнал — 0', async () => {
    expect(await store.clear()).toBe(0);

    await store.append(entry('ma_1'));
    await store.append(entry('ma_2'));
    expect(await store.clear()).toBe(2);
    expect(await store.list()).toEqual([]);
    expect(await readFile(filePath, 'utf-8')).toBe('');
    expect(await store.clear()).toBe(0);
  });

  it('повреждённая строка не ломает list и не мешает дозаписи', async () => {
    await store.append(entry('ma_ok'));
    await appendFile(filePath, 'не-json-мусор\n', 'utf-8');

    expect((await store.list()).map((e) => e.id)).toEqual(['ma_ok']);

    await store.append(entry('ma_next'));
    expect((await store.list()).map((e) => e.id)).toEqual(['ma_next', 'ma_ok']);
  });

  it('нет файла → list пуст, clear — 0', async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.clear()).toBe(0);
  });
});

describe('MemoryMaintenanceAuditRepository (ADR-092)', () => {
  it('семантика идентична файловой (append/list/limit/op/clear)', async () => {
    const repo = new MemoryMaintenanceAuditRepository();
    expect(await repo.list()).toEqual([]);

    await repo.append(entry('ma_1'));
    await repo.append(entry('ma_2', { op: 'restore.applied', status: 'failed', error: 'boom' }));
    await repo.append(entry('ma_3'));

    expect((await repo.list()).map((e) => e.id)).toEqual(['ma_3', 'ma_2', 'ma_1']);
    expect((await repo.list({ op: 'restore.applied' })).map((e) => e.id)).toEqual(['ma_2']);
    expect((await repo.list({ limit: 1 })).map((e) => e.id)).toEqual(['ma_3']);
    expect((await repo.list())[1]!.error).toBe('boom');

    expect(await repo.clear()).toBe(3);
    expect(await repo.list()).toEqual([]);
    expect(await repo.clear()).toBe(0);
  });
});
