import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePackStore } from './file-pack-store.js';
import type { PackInstallation } from './ports/pack-repository.js';

const installation = (
  name: string,
  overrides: Partial<PackInstallation> = {},
): PackInstallation => ({
  name,
  version: '1.0.0',
  kind: 'pack',
  status: 'active',
  requiresApproval: false,
  provides: { agents: [], skills: [], mcp: [], pipelines: [] },
  installedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('FilePackStore (ADR-086 §5, ADR-005)', () => {
  let store: FilePackStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-packs-'));
    store = new FilePackStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('отсутствие файла — пустой реестр (не ошибка)', async () => {
    expect(existsSync(join(tmpDir, 'packs.json'))).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(await store.get('missing')).toBeNull();
    expect(await store.delete('missing')).toBe(false);
  });

  it('файл создаётся при первой записи; запись атомарна (нет .tmp)', async () => {
    await store.save(installation('synth-media'));
    expect(existsSync(join(tmpDir, 'packs.json'))).toBe(true);

    const files = await readdir(tmpDir);
    expect(files.filter((f) => f.includes('.tmp'))).toHaveLength(0);
    expect(files).toContain('packs.json');

    const raw = JSON.parse(await readFile(join(tmpDir, 'packs.json'), 'utf-8'));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.packs).toHaveLength(1);
  });

  it('порча JSON — понятная ошибка, а не тихий пустой список', async () => {
    await writeFile(join(tmpDir, 'packs.json'), '{ not json', 'utf-8');
    await expect(store.list()).rejects.toThrow(/Повреждён файл/);
    await expect(store.get('synth-media')).rejects.toThrow(/Повреждён файл/);
  });

  it('upsert по имени не плодит дубликаты; данные переживают пересоздание стора', async () => {
    await store.save(installation('synth-media'));
    await store.save(installation('synth-media', { version: '2.0.0' }));

    const reloaded = new FilePackStore({ dataDir: tmpDir });
    const packs = await reloaded.list();
    expect(packs).toHaveLength(1);
    expect(packs[0]?.version).toBe('2.0.0');
    expect(packs[0]?.installedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('manifest сохраняется без изменений (вложенные объекты/массивы)', async () => {
    const manifest = {
      name: 'synth-media',
      version: '1.0.0',
      kind: 'addon',
      description: 'медиа',
      provides: { mcp: [{ name: 'telegram', transport: 'http', port: 8080 }], skills: [], agents: [], pipelines: [] },
    };
    await store.save(installation('synth-media', { kind: 'addon', manifest }));

    const raw = JSON.parse(await readFile(join(tmpDir, 'packs.json'), 'utf-8'));
    expect(raw.packs[0].manifest).toEqual(manifest);
  });
});
