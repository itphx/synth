import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventApiKeyStore } from './event-api-key-store.js';

describe('EventApiKeyStore (AD-089/AD-052)', () => {
  let store: EventApiKeyStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-event-api-keys-'));
    store = new EventApiKeyStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('create: генерирует eak_<uuid>, секрет synth_evt_ и префикс', async () => {
    const created = await store.create({ bindingId: 'bnd_1', description: 'bot', createdBy: 'u-1' });
    expect(created.id).toMatch(/^eak_/);
    expect(created.bindingId).toBe('bnd_1');
    expect(created.description).toBe('bot');
    expect(created.createdBy).toBe('u-1');
    expect(created.key.startsWith('synth_evt_')).toBe(true);
    expect(created.prefix.endsWith('…')).toBe(true);
    expect(created.key.startsWith(created.prefix.slice(0, -1))).toBe(true);
    expect(typeof created.createdAt).toBe('string');
  });

  it('listByBinding: отдаёт метаданные без hash и key', async () => {
    const created = await store.create({ bindingId: 'bnd_1', name: 'n', description: 'd', createdBy: 'u-1' });
    const keys = await store.listByBinding('bnd_1');
    expect(keys).toHaveLength(1);
    expect(keys[0]?.id).toBe(created.id);
    expect(keys[0]?.name).toBe('n');
    expect((keys[0] as unknown as Record<string, unknown>).hash).toBeUndefined();
    expect((keys[0] as unknown as Record<string, unknown>).key).toBeUndefined();
    // Другая привязка — пусто.
    expect(await store.listByBinding('bnd_other')).toEqual([]);
  });

  it('resolveBySecret: успех и неверный секрет', async () => {
    const created = await store.create({ bindingId: 'bnd_1', description: 'd', createdBy: 'u-1' });
    const resolved = await store.resolveBySecret(created.key);
    expect(resolved?.credential.bindingId).toBe('bnd_1');
    expect(resolved?.key.id).toBe(created.id);
    expect((resolved?.key as unknown as Record<string, unknown>).hash).toBeUndefined();

    expect(await store.resolveBySecret('synth_evt_wrong')).toBeNull();
    expect(await store.resolveBySecret('')).toBeNull();
  });

  it('revoke: мягкий отзыв (revokedAt) → resolveBySecret null; отсутствующий — false', async () => {
    const created = await store.create({ bindingId: 'bnd_1', description: 'd', createdBy: 'u-1' });
    expect(await store.resolveBySecret(created.key)).not.toBeNull();

    expect(await store.revoke('bnd_other', created.id)).toBe(false);
    expect(await store.revoke('bnd_1', created.id)).toBe(true);
    expect(await store.resolveBySecret(created.key)).toBeNull();

    // Ключ остался в списке (мягкий отзыв, не удаление).
    const keys = await store.listByBinding('bnd_1');
    expect(keys).toHaveLength(1);
    expect(typeof keys[0]?.revokedAt).toBe('string');

    // Отзыв несуществующего ключа — false.
    expect(await store.revoke('bnd_1', 'eak_missing')).toBe(false);
  });

  it('expiresAt: прошлое → resolveBySecret null, будущее → валиден, нет — бессрочно', async () => {
    const past = await store.create({ bindingId: 'bnd_1', description: 'd', createdBy: 'u-1' });
    const future = await store.create({ bindingId: 'bnd_1', description: 'd', createdBy: 'u-1' });
    const forever = await store.create({ bindingId: 'bnd_1', description: 'd', createdBy: 'u-1' });

    const filePath = join(tmpDir, 'events', 'api-keys.json');
    const file = JSON.parse(await readFile(filePath, 'utf8')) as { keys: Array<Record<string, unknown>> };
    file.keys.find((k) => k.id === past.id)!.expiresAt = new Date(Date.now() - 60_000).toISOString();
    file.keys.find((k) => k.id === future.id)!.expiresAt = new Date(Date.now() + 60_000).toISOString();
    await writeFile(filePath, JSON.stringify(file, null, 2), 'utf8');

    expect(await store.resolveBySecret(past.key)).toBeNull();
    expect((await store.resolveBySecret(future.key))?.key.id).toBe(future.id);
    // Нет expiresAt — обратная совместимость (бессрочный).
    expect((await store.resolveBySecret(forever.key))?.key.id).toBe(forever.id);
  });

  it('remove: только свой ключ своей привязки', async () => {
    const a = await store.create({ bindingId: 'bnd_1', description: 'd', createdBy: 'u-1' });
    const b = await store.create({ bindingId: 'bnd_2', description: 'd', createdBy: 'u-1' });

    expect(await store.remove('bnd_other', a.id)).toBe(false);
    expect(await store.remove('bnd_1', b.id)).toBe(false);
    expect(await store.remove('bnd_1', a.id)).toBe(true);
    expect(await store.listByBinding('bnd_1')).toHaveLength(0);
    expect(await store.listByBinding('bnd_2')).toHaveLength(1);
    expect(await store.remove('bnd_1', a.id)).toBe(false);
  });

  it('removeByBinding: каскад, возвращает число удалённых', async () => {
    await store.create({ bindingId: 'bnd_1', description: 'd', createdBy: 'u-1' });
    await store.create({ bindingId: 'bnd_1', description: 'd', createdBy: 'u-1' });
    await store.create({ bindingId: 'bnd_2', description: 'd', createdBy: 'u-1' });

    expect(await store.removeByBinding('bnd_1')).toBe(2);
    expect(await store.listByBinding('bnd_1')).toHaveLength(0);
    expect(await store.removeByBinding('bnd_1')).toBe(0);
    expect(await store.listByBinding('bnd_2')).toHaveLength(1);
  });

  it('touch: проставляет lastUsedAt только существующему ключу', async () => {
    const created = await store.create({ bindingId: 'bnd_1', description: 'd', createdBy: 'u-1' });
    expect(created.lastUsedAt).toBeUndefined();

    await store.touch(created.id);
    const [key] = await store.listByBinding('bnd_1');
    expect(typeof key?.lastUsedAt).toBe('string');

    // Несуществующий — no-op, не бросает.
    await expect(store.touch('eak_missing')).resolves.toBeUndefined();
  });

  it('персистентность: секрет не хранится в открытом виде (только hash)', async () => {
    const created = await store.create({ bindingId: 'bnd_1', description: 'd', createdBy: 'u-1' });
    const raw = await readFile(join(tmpDir, 'events', 'api-keys.json'), 'utf8');
    expect(raw).not.toContain(created.key);
    const parsed = JSON.parse(raw) as { keys: Array<Record<string, unknown>> };
    expect(typeof parsed.keys[0]?.hash).toBe('string');
    // Новый экземпляр читает тот же ключ (данные на диске).
    const reloaded = new EventApiKeyStore({ dataDir: tmpDir });
    const resolved = await reloaded.resolveBySecret(created.key);
    expect(resolved?.key.id).toBe(created.id);
  });

  it('path-traversal в bindingId при create → исключение', async () => {
    await expect(
      store.create({ bindingId: '../evil', description: 'd', createdBy: 'u-1' }),
    ).rejects.toThrow();
  });
});
