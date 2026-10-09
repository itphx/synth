import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouteRuleStore } from './route-rule-store.js';
import type { UpsertRouteRuleInput } from './route-rule-store.js';

const rule = (overrides: Partial<UpsertRouteRuleInput> = {}): UpsertRouteRuleInput => ({
  priority: 10,
  enabled: true,
  match: { source: 'telegram' },
  target: { mode: 'ephemeral' },
  ...overrides,
});

describe('RouteRuleStore (AD-089)', () => {
  let store: RouteRuleStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-route-rules-'));
    store = new RouteRuleStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('upsert без id генерирует rule_<uuid>', async () => {
    const created = await store.upsert(rule());
    expect(created.id).toMatch(/^rule_/);
    expect(created.priority).toBe(10);
    expect(created.match.source).toBe('telegram');
    expect(created.target.mode).toBe('ephemeral');
  });

  it('get/list/remove — базовый CRUD', async () => {
    const created = await store.upsert(rule());
    expect((await store.get(created.id))?.id).toBe(created.id);
    expect(await store.list()).toHaveLength(1);
    expect(await store.get('missing')).toBeNull();

    expect(await store.remove(created.id)).toBe(true);
    expect(await store.get(created.id)).toBeNull();
    expect(await store.remove(created.id)).toBe(false);
  });

  it('upsert с существующим id заменяет запись', async () => {
    const created = await store.upsert(rule({ name: 'first' }));
    const updated = await store.upsert({ ...rule({ name: 'second' }), id: created.id });
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('second');
    expect(await store.list()).toHaveLength(1);
  });

  it('listEnabled фильтрует выключенные правила', async () => {
    await store.upsert(rule({ enabled: true }));
    await store.upsert(rule({ enabled: false }));
    expect(await store.list()).toHaveLength(2);
    expect(await store.listEnabled()).toHaveLength(1);
  });

  it('персистит данные между инстансами', async () => {
    const created = await store.upsert(rule({ name: 'keep' }));
    const reloaded = new RouteRuleStore({ dataDir: tmpDir });
    expect((await reloaded.get(created.id))?.name).toBe('keep');
  });

  it('отклоняет id с path traversal', async () => {
    await expect(store.upsert({ ...rule(), id: '../evil' })).rejects.toThrow('Недопустимый id');
  });

  it('пишет файл атомарно: нет .tmp-файлов, JSON валиден', async () => {
    await store.upsert(rule());
    const dir = join(tmpDir, 'events');
    const files = await readdir(dir);
    expect(files.filter((f) => f.includes('.tmp'))).toHaveLength(0);
    expect(files).toContain('routes.json');
    const raw = JSON.parse(await readFile(join(dir, 'routes.json'), 'utf-8'));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.rules).toHaveLength(1);
  });

  it('пустой файл (нет каталога) → пустой список', async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.listEnabled()).toEqual([]);
  });

  it('невалидный JSON → пустой список, запись восстанавливает файл', async () => {
    const dir = join(tmpDir, 'events');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'routes.json'), '{ not json', 'utf-8');
    expect(await store.list()).toEqual([]);

    const created = await store.upsert(rule());
    expect(await store.list()).toHaveLength(1);
    expect((await store.get(created.id))?.id).toBe(created.id);
  });

  it('параллельные upsert не теряют записи (per-file lock)', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.upsert(rule({ name: `r${i}` }))),
    );
    const entries = await store.list();
    expect(entries).toHaveLength(10);
    expect(new Set(entries.map((e) => e.id)).size).toBe(10);
  });
});
