/**
 * ADR-090 п. 9: подтверждение установки — хранилище и срок (24 ч).
 *
 * Отдельный файл — потому что у подтверждения **собственный** жизненный цикл
 * (выдача → проверка срока → проверка привязки к content-hash), а установщик
 * использует его как внешнюю зависимость.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPluginApproval,
  FilePluginApprovalStore,
  isPluginApprovalExpired,
  MemoryPluginApprovalStore,
  PLUGIN_APPROVAL_TTL_HOURS,
  PLUGIN_APPROVAL_TTL_MS,
} from './approval.js';
import type { PluginApprovalRecord, PluginApprovalStore } from './approval.js';

/** Временные каталоги теста (убираются в `afterEach`). */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Временный каталог для файлового хранилища. */
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-plugin-approval-'));
  tempDirs.push(dir);
  return dir;
}

/** Запись подтверждения для тестов. */
function record(over: Partial<PluginApprovalRecord> = {}): PluginApprovalRecord {
  return {
    name: 'demo-plugin',
    version: '1.0.0',
    contentHash: 'a'.repeat(64),
    approvedBy: 'admin',
    approvedAt: '2026-10-24T10:00:00.000Z',
    expiresAt: '2026-10-25T10:00:00.000Z',
    ...over,
  };
}

describe('ADR-090 п. 9: подтверждение установки', () => {
  it('срок подтверждения — 24 ч (константа слоя плагинов)', () => {
    expect(PLUGIN_APPROVAL_TTL_HOURS).toBe(24);
    expect(PLUGIN_APPROVAL_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('buildPluginApproval: срок считается от момента выдачи (+24 ч)', () => {
    const built = buildPluginApproval({
      name: 'demo-plugin',
      version: '1.0.0',
      contentHash: 'a'.repeat(64),
      approvedBy: 'admin',
      approvedAt: '2026-10-24T10:00:00.000Z',
    });
    expect(built.expiresAt).toBe('2026-10-25T10:00:00.000Z');
    expect(built.approvedBy).toBe('admin');
  });

  it('isPluginApprovalExpired: истёкшее — на границе срока и позже; битый срок — истёкшее', () => {
    const approval = record();
    expect(isPluginApprovalExpired(approval, '2026-10-25T09:59:59.999Z')).toBe(false);
    expect(isPluginApprovalExpired(approval, '2026-10-25T10:00:00.000Z')).toBe(true);
    expect(isPluginApprovalExpired(approval, '2026-10-26T00:00:00.000Z')).toBe(true);
    // Битое/пустое `expiresAt` — fail-closed (подтверждение без срока не продлевается).
    expect(isPluginApprovalExpired(record({ expiresAt: '' }), '2026-10-24T11:00:00.000Z')).toBe(true);
    expect(isPluginApprovalExpired(record({ expiresAt: 'не-дата' }), '2026-10-24T11:00:00.000Z')).toBe(true);
  });

  it('файловое хранилище: запись/чтение/удаление, порядок по имени и версии', async () => {
    const dir = await makeTempDir();
    const store = new FilePluginApprovalStore({ path: join(dir, 'plugin-approvals.json') });

    expect(await store.get('demo-plugin', '1.0.0')).toBeNull();

    await store.save(record());
    await store.save(record({ name: 'alpha-plugin', version: '2.0.0' }));
    await store.save(record({ name: 'demo-plugin', version: '0.9.0' }));

    const stored = await store.get('demo-plugin', '1.0.0');
    expect(stored?.contentHash).toBe('a'.repeat(64));
    expect(stored?.approvedBy).toBe('admin');
    expect(stored?.expiresAt).toBe('2026-10-25T10:00:00.000Z');

    // Детерминированный порядок — по имени, затем по версии.
    expect((await store.list()).map((item) => `${item.name}@${item.version}`)).toEqual([
      'alpha-plugin@2.0.0',
      'demo-plugin@0.9.0',
      'demo-plugin@1.0.0',
    ]);

    // Перезапись записи того же бандла — не плодит дубли.
    await store.save(record({ approvedBy: 'admin-2' }));
    expect((await store.list()).filter((i) => i.version === '1.0.0')).toHaveLength(1);
    expect((await store.get('demo-plugin', '1.0.0'))?.approvedBy).toBe('admin-2');

    expect(await store.delete('demo-plugin', '1.0.0')).toBe(true);
    expect(await store.delete('demo-plugin', '1.0.0')).toBe(false);
    expect(await store.get('demo-plugin', '1.0.0')).toBeNull();
  });

  it('файловое хранилище: состояние переживает пересоздание экземпляра (персистентность)', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'plugin-approvals.json');
    const first = new FilePluginApprovalStore({ path });
    await first.save(record());

    const second = new FilePluginApprovalStore({ path });
    expect((await second.get('demo-plugin', '1.0.0'))?.contentHash).toBe('a'.repeat(64));

    // На диске — JSON с записью (атомарная запись: tmp→rename, ADR-005).
    const raw = JSON.parse(await readFile(path, 'utf-8')) as {
      schemaVersion: number;
      approvals: PluginApprovalRecord[];
    };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.approvals).toHaveLength(1);
    expect(raw.approvals[0]?.name).toBe('demo-plugin');
  });

  it('in-memory хранилище — тот же контракт (тесты без ФС)', async () => {
    const store: PluginApprovalStore = new MemoryPluginApprovalStore();
    expect(await store.get('demo-plugin', '1.0.0')).toBeNull();
    await store.save(record());
    expect((await store.get('demo-plugin', '1.0.0'))?.approvedBy).toBe('admin');
    expect(await store.delete('demo-plugin', '1.0.0')).toBe(true);
    expect(await store.get('demo-plugin', '1.0.0')).toBeNull();
  });
});
