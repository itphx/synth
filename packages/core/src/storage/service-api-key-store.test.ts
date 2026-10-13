import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobalRole } from '@itphx/synth-shared';
import {
  ServiceApiKeyStore,
  ServiceApiKeyConflictError,
  SERVICE_KEY_SECRET_PREFIX,
  isServiceKeySecret,
} from './service-api-key-store.js';

describe('ServiceApiKeyStore (AD-052, этап I)', () => {
  let store: ServiceApiKeyStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-service-keys-'));
    store = new ServiceApiKeyStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('create: svk_<uuid>, секрет synth_svc_, prefix, дефолтная роль и label', async () => {
    const created = await store.create({ label: 'gateway', scopes: ['events:ingest'] }, 'u-1');
    expect(created.id).toMatch(/^svk_/);
    expect(created.label).toBe('gateway');
    expect(created.scopes).toEqual(['events:ingest']);
    expect(created.roles).toEqual([GlobalRole.USER]);
    expect(created.createdBy).toBe('u-1');
    expect(created.key.startsWith(SERVICE_KEY_SECRET_PREFIX)).toBe(true);
    expect(isServiceKeySecret(created.key)).toBe(true);
    expect(created.prefix.endsWith('…')).toBe(true);
    expect(created.key.startsWith(created.prefix.slice(0, -1))).toBe(true);
    expect(typeof created.createdAt).toBe('string');
    // Хеш/секрет наружу не идут.
    expect((created as unknown as Record<string, unknown>).hash).toBeUndefined();
  });

  it('create: roles/scopes/allowedProjects/rateLimit/expiresAt сохраняются; пустой label → исключение', async () => {
    const created = await store.create(
      {
        label: 'ops',
        description: 'ops key',
        roles: [GlobalRole.ADMIN, GlobalRole.LEAD],
        scopes: ['events:*', 'sessions:read'],
        allowedProjects: ['p1', 'p2'],
        rateLimitPerMinute: 42,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      'u-1',
    );
    expect(created.roles).toEqual([GlobalRole.ADMIN, GlobalRole.LEAD]);
    expect(created.allowedProjects).toEqual(['p1', 'p2']);
    expect(created.rateLimitPerMinute).toBe(42);
    expect(typeof created.expiresAt).toBe('string');

    await expect(store.create({ label: '   ', scopes: ['events:ingest'] }, 'u-1')).rejects.toThrow();
  });

  it('create: глобальная уникальность label (регистронезависимо)', async () => {
    await store.create({ label: 'Gateway', scopes: ['events:ingest'] }, 'u-1');
    await expect(
      store.create({ label: '  gateway ', scopes: ['events:ingest'] }, 'u-2'),
    ).rejects.toBeInstanceOf(ServiceApiKeyConflictError);
    const other = await store.create({ label: 'other', scopes: ['events:ingest'] }, 'u-1');
    expect(other.label).toBe('other');
  });

  it('list/get: метаданные без hash/key; отсутствующий — null', async () => {
    const created = await store.create({ label: 'n', description: 'd', scopes: ['llm:chat'] }, 'u-1');
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(created.id);
    expect((list[0] as unknown as Record<string, unknown>).hash).toBeUndefined();
    expect((list[0] as unknown as Record<string, unknown>).key).toBeUndefined();

    const got = await store.get(created.id);
    expect(got?.label).toBe('n');
    expect(await store.get('svk_missing')).toBeNull();
  });

  it('update: смена полей и сброс null; отсутствующий — null; конфликт label', async () => {
    const a = await store.create({ label: 'alpha', scopes: ['events:ingest'], allowedProjects: ['p1'], rateLimitPerMinute: 5 }, 'u-1');
    await store.create({ label: 'beta', scopes: ['events:ingest'] }, 'u-1');

    const updated = await store.update(a.id, {
      label: 'Alpha 2',
      description: 'd2',
      scopes: ['sessions:*'],
      allowedProjects: ['p9'],
      rateLimitPerMinute: 99,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(updated?.label).toBe('Alpha 2');
    expect(updated?.description).toBe('d2');
    expect(updated?.scopes).toEqual(['sessions:*']);
    expect(updated?.allowedProjects).toEqual(['p9']);
    expect(updated?.rateLimitPerMinute).toBe(99);

    const reset = await store.update(a.id, {
      description: null,
      allowedProjects: null,
      rateLimitPerMinute: null,
      expiresAt: null,
    });
    expect(reset?.description).toBeUndefined();
    expect(reset?.allowedProjects).toBeUndefined();
    expect(reset?.rateLimitPerMinute).toBeUndefined();
    expect(reset?.expiresAt).toBeUndefined();

    await expect(store.update(a.id, { label: 'BETA' })).rejects.toBeInstanceOf(ServiceApiKeyConflictError);
    expect(await store.update('svk_missing', { label: 'x' })).toBeNull();
  });

  it('resolveBySecret: успех, неверный секрет, роли/scopes/allowedProjects в credential', async () => {
    const created = await store.create(
      { label: 'bot', scopes: ['events:ingest'], allowedProjects: ['p1'], rateLimitPerMinute: 7, roles: [GlobalRole.LEAD] },
      'u-1',
    );
    const resolved = await store.resolveBySecret(created.key);
    expect(resolved?.key.id).toBe(created.id);
    expect(resolved?.credential.keyId).toBe(created.id);
    expect(resolved?.credential.label).toBe('bot');
    expect(resolved?.credential.scopes).toEqual(['events:ingest']);
    expect(resolved?.credential.allowedProjects).toEqual(['p1']);
    expect(resolved?.credential.rateLimitPerMinute).toBe(7);
    expect(resolved?.credential.roles).toEqual([GlobalRole.LEAD]);
    expect((resolved?.key as unknown as Record<string, unknown>).hash).toBeUndefined();

    expect(await store.resolveBySecret('synth_svc_wrong')).toBeNull();
    expect(await store.resolveBySecret('')).toBeNull();
  });

  it('revoke: мягкий отзыв → resolveBySecret null; идемпотентен', async () => {
    const created = await store.create({ label: 'bot', scopes: ['events:ingest'] }, 'u-1');
    expect(await store.resolveBySecret(created.key)).not.toBeNull();
    expect(await store.revoke('svk_missing')).toBe(false);
    expect(await store.revoke(created.id)).toBe(true);
    expect(await store.resolveBySecret(created.key)).toBeNull();

    const [first] = await store.list();
    expect(typeof first?.revokedAt).toBe('string');
    expect(await store.revoke(created.id)).toBe(true);
    const [second] = await store.list();
    expect(second?.revokedAt).toBe(first?.revokedAt);
  });

  it('expiresAt: прошлое → null, будущее → валиден, нет — бессрочно', async () => {
    const past = await store.create({ label: 'past', scopes: ['events:ingest'] }, 'u-1');
    const future = await store.create({ label: 'future', scopes: ['events:ingest'] }, 'u-1');
    const forever = await store.create({ label: 'forever', scopes: ['events:ingest'] }, 'u-1');

    const filePath = join(tmpDir, 'service-keys.json');
    const file = JSON.parse(await readFile(filePath, 'utf8')) as { keys: Array<Record<string, unknown>> };
    file.keys.find((k) => k.id === past.id)!.expiresAt = new Date(Date.now() - 60_000).toISOString();
    file.keys.find((k) => k.id === future.id)!.expiresAt = new Date(Date.now() + 60_000).toISOString();
    await writeFile(filePath, JSON.stringify(file, null, 2), 'utf8');

    expect(await store.resolveBySecret(past.key)).toBeNull();
    expect((await store.resolveBySecret(future.key))?.key.id).toBe(future.id);
    expect((await store.resolveBySecret(forever.key))?.key.id).toBe(forever.id);
  });

  it('remove/touch: удаление и best-effort lastUsedAt', async () => {
    const created = await store.create({ label: 'bot', scopes: ['events:ingest'] }, 'u-1');
    expect(await store.remove('svk_missing')).toBe(false);
    await store.touch(created.id);
    const [touched] = await store.list();
    expect(typeof touched?.lastUsedAt).toBe('string');
    expect(await store.remove(created.id)).toBe(true);
    expect(await store.list()).toHaveLength(0);
    await expect(store.touch('svk_missing')).resolves.toBeUndefined();
  });

  it('персистентность: секрет не хранится открыто (только hash)', async () => {
    const created = await store.create({ label: 'bot', scopes: ['events:ingest'] }, 'u-1');
    const raw = await readFile(join(tmpDir, 'service-keys.json'), 'utf8');
    expect(raw).not.toContain(created.key);
    const parsed = JSON.parse(raw) as { keys: Array<Record<string, unknown>> };
    expect(typeof parsed.keys[0]?.hash).toBe('string');

    const reloaded = new ServiceApiKeyStore({ dataDir: tmpDir });
    expect((await reloaded.resolveBySecret(created.key))?.key.id).toBe(created.id);
  });

  it('path-traversal в id (remove/revoke) → исключение', async () => {
    await expect(store.remove('../evil')).rejects.toThrow();
    await expect(store.revoke('../evil')).rejects.toThrow();
  });
});
