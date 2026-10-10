import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventApiKeyConflictError, EventApiKeyStore } from './event-api-key-store.js';

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

  it('create: генерирует eak_<uuid>, секрет synth_evt_, префикс и label', async () => {
    const created = await store.create({ bindingId: 'bnd_1', label: 'bot', createdBy: 'u-1' });
    expect(created.id).toMatch(/^eak_/);
    expect(created.bindingId).toBe('bnd_1');
    expect(created.label).toBe('bot');
    expect(created.description).toBeUndefined();
    expect(created.createdBy).toBe('u-1');
    expect(created.key.startsWith('synth_evt_')).toBe(true);
    expect(created.prefix.endsWith('…')).toBe(true);
    expect(created.key.startsWith(created.prefix.slice(0, -1))).toBe(true);
    expect(typeof created.createdAt).toBe('string');
  });

  it('create: description/expiresAt/rateLimitPerMinute сохраняются; пустой label → исключение', async () => {
    const created = await store.create({
      bindingId: 'bnd_1',
      label: 'bot',
      description: 'telegram bot',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      rateLimitPerMinute: 42,
      createdBy: 'u-1',
    });
    expect(created.description).toBe('telegram bot');
    expect(typeof created.expiresAt).toBe('string');
    expect(created.rateLimitPerMinute).toBe(42);

    await expect(store.create({ bindingId: 'bnd_1', label: '   ', createdBy: 'u-1' })).rejects.toThrow();
  });

  it('create: глобальная уникальность label (регистронезависимо, по всем привязкам)', async () => {
    await store.create({ bindingId: 'bnd_1', label: 'Bot', createdBy: 'u-1' });
    await expect(
      store.create({ bindingId: 'bnd_2', label: '  bot ', createdBy: 'u-1' }),
    ).rejects.toBeInstanceOf(EventApiKeyConflictError);
    // Другая метка — ок.
    const other = await store.create({ bindingId: 'bnd_2', label: 'other', createdBy: 'u-1' });
    expect(other.label).toBe('other');
  });

  it('listByBinding: отдаёт метаданные без hash и key', async () => {
    const created = await store.create({ bindingId: 'bnd_1', label: 'n', description: 'd', createdBy: 'u-1' });
    const keys = await store.listByBinding('bnd_1');
    expect(keys).toHaveLength(1);
    expect(keys[0]?.id).toBe(created.id);
    expect(keys[0]?.label).toBe('n');
    expect((keys[0] as unknown as Record<string, unknown>).hash).toBeUndefined();
    expect((keys[0] as unknown as Record<string, unknown>).key).toBeUndefined();
    // Другая привязка — пусто.
    expect(await store.listByBinding('bnd_other')).toEqual([]);
  });

  it('get: публичные метаданные ключа, отсутствующий — null', async () => {
    const created = await store.create({ bindingId: 'bnd_1', label: 'bot', createdBy: 'u-1' });
    const got = await store.get('bnd_1', created.id);
    expect(got?.id).toBe(created.id);
    expect(got?.label).toBe('bot');
    expect((got as unknown as Record<string, unknown>).hash).toBeUndefined();

    expect(await store.get('bnd_1', 'eak_missing')).toBeNull();
    expect(await store.get('bnd_other', created.id)).toBeNull();
  });

  it('update: метка/описание/срок/лимит и сброс null; отсутствующий — null', async () => {
    const created = await store.create({
      bindingId: 'bnd_1',
      label: 'bot',
      description: 'd',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      rateLimitPerMinute: 10,
      createdBy: 'u-1',
    });

    const updated = await store.update('bnd_1', created.id, {
      label: 'Bot 2',
      description: 'd2',
      expiresAt: null,
      rateLimitPerMinute: 99,
    });
    expect(updated?.label).toBe('Bot 2');
    expect(updated?.description).toBe('d2');
    expect(updated?.expiresAt).toBeUndefined();
    expect(updated?.rateLimitPerMinute).toBe(99);

    // Сброс description/rateLimit null.
    const reset = await store.update('bnd_1', created.id, { description: null, rateLimitPerMinute: null });
    expect(reset?.description).toBeUndefined();
    expect(reset?.rateLimitPerMinute).toBeUndefined();

    // Неизвестный ключ — null.
    expect(await store.update('bnd_1', 'eak_missing', { label: 'x' })).toBeNull();
    expect(await store.update('bnd_other', created.id, { label: 'x' })).toBeNull();
  });

  it('update: смена label на занятую → EventApiKeyConflictError; своя метка — ок', async () => {
    const a = await store.create({ bindingId: 'bnd_1', label: 'alpha', createdBy: 'u-1' });
    await store.create({ bindingId: 'bnd_1', label: 'beta', createdBy: 'u-1' });

    await expect(store.update('bnd_1', a.id, { label: 'BETA' })).rejects.toBeInstanceOf(EventApiKeyConflictError);
    // Своя метка (тот же ключ) конфликтом не считается.
    const same = await store.update('bnd_1', a.id, { label: 'alpha' });
    expect(same?.label).toBe('alpha');
  });

  it('legacy backfill: запись с name (без label) читается как label', async () => {
    const filePath = join(tmpDir, 'events', 'api-keys.json');
    const legacy = {
      schemaVersion: 1,
      keys: [
        {
          id: 'eak_legacy',
          bindingId: 'bnd_1',
          name: 'legacy-bot',
          description: 'old',
          createdBy: 'u-1',
          createdAt: new Date().toISOString(),
          prefix: 'synth_evt_x…',
          hash: 'deadbeef',
        },
      ],
    };
    await mkdir(join(tmpDir, 'events'), { recursive: true });
    await writeFile(filePath, JSON.stringify(legacy, null, 2), 'utf8');

    const keys = await store.listByBinding('bnd_1');
    expect(keys).toHaveLength(1);
    expect(keys[0]?.label).toBe('legacy-bot');
    expect((keys[0] as unknown as Record<string, unknown>).name).toBeUndefined();
  });

  it('resolveBySecret: успех и неверный секрет', async () => {
    const created = await store.create({ bindingId: 'bnd_1', label: 'bot', createdBy: 'u-1' });
    const resolved = await store.resolveBySecret(created.key);
    expect(resolved?.credential.bindingId).toBe('bnd_1');
    expect(resolved?.key.id).toBe(created.id);
    expect((resolved?.key as unknown as Record<string, unknown>).hash).toBeUndefined();

    expect(await store.resolveBySecret('synth_evt_wrong')).toBeNull();
    expect(await store.resolveBySecret('')).toBeNull();
  });

  it('resolveBySecret: rateLimitPerMinute пробрасывается в credential', async () => {
    const created = await store.create({ bindingId: 'bnd_1', label: 'bot', rateLimitPerMinute: 7, createdBy: 'u-1' });
    const resolved = await store.resolveBySecret(created.key);
    expect(resolved?.credential.rateLimitPerMinute).toBe(7);
  });

  it('revoke: мягкий отзыв (revokedAt) → resolveBySecret null; идемпотентен; отсутствующий — false', async () => {
    const created = await store.create({ bindingId: 'bnd_1', label: 'bot', createdBy: 'u-1' });
    expect(await store.resolveBySecret(created.key)).not.toBeNull();

    expect(await store.revoke('bnd_other', created.id)).toBe(false);
    expect(await store.revoke('bnd_1', created.id)).toBe(true);
    expect(await store.resolveBySecret(created.key)).toBeNull();

    const [first] = await store.listByBinding('bnd_1');
    expect(typeof first?.revokedAt).toBe('string');
    // Повторный отзыв — true, дата не меняется.
    expect(await store.revoke('bnd_1', created.id)).toBe(true);
    const [second] = await store.listByBinding('bnd_1');
    expect(second?.revokedAt).toBe(first?.revokedAt);

    // Ключ остался в списке (мягкий отзыв, не удаление).
    const keys = await store.listByBinding('bnd_1');
    expect(keys).toHaveLength(1);

    // Отзыв несуществующего ключа — false.
    expect(await store.revoke('bnd_1', 'eak_missing')).toBe(false);
  });

  it('expiresAt: прошлое → resolveBySecret null, будущее → валиден, нет — бессрочно', async () => {
    const past = await store.create({ bindingId: 'bnd_1', label: 'past', createdBy: 'u-1' });
    const future = await store.create({ bindingId: 'bnd_1', label: 'future', createdBy: 'u-1' });
    const forever = await store.create({ bindingId: 'bnd_1', label: 'forever', createdBy: 'u-1' });

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
    const a = await store.create({ bindingId: 'bnd_1', label: 'a', createdBy: 'u-1' });
    const b = await store.create({ bindingId: 'bnd_2', label: 'b', createdBy: 'u-1' });

    expect(await store.remove('bnd_other', a.id)).toBe(false);
    expect(await store.remove('bnd_1', b.id)).toBe(false);
    expect(await store.remove('bnd_1', a.id)).toBe(true);
    expect(await store.listByBinding('bnd_1')).toHaveLength(0);
    expect(await store.listByBinding('bnd_2')).toHaveLength(1);
    expect(await store.remove('bnd_1', a.id)).toBe(false);
  });

  it('removeByBinding: каскад, возвращает число удалённых', async () => {
    await store.create({ bindingId: 'bnd_1', label: 'a', createdBy: 'u-1' });
    await store.create({ bindingId: 'bnd_1', label: 'b', createdBy: 'u-1' });
    await store.create({ bindingId: 'bnd_2', label: 'c', createdBy: 'u-1' });

    expect(await store.removeByBinding('bnd_1')).toBe(2);
    expect(await store.listByBinding('bnd_1')).toHaveLength(0);
    expect(await store.removeByBinding('bnd_1')).toBe(0);
    expect(await store.listByBinding('bnd_2')).toHaveLength(1);
  });

  it('touch: проставляет lastUsedAt только существующему ключу', async () => {
    const created = await store.create({ bindingId: 'bnd_1', label: 'bot', createdBy: 'u-1' });
    expect(created.lastUsedAt).toBeUndefined();

    await store.touch(created.id);
    const [key] = await store.listByBinding('bnd_1');
    expect(typeof key?.lastUsedAt).toBe('string');

    // Несуществующий — no-op, не бросает.
    await expect(store.touch('eak_missing')).resolves.toBeUndefined();
  });

  it('персистентность: секрет не хранится в открытом виде (только hash)', async () => {
    const created = await store.create({ bindingId: 'bnd_1', label: 'bot', createdBy: 'u-1' });
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
      store.create({ bindingId: '../evil', label: 'x', createdBy: 'u-1' }),
    ).rejects.toThrow();
  });
});
