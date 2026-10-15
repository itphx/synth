import { describe, expect, it, vi } from 'vitest';
import { createLocalOwnerResolver, LOCAL_USER_ID } from './local-owner.js';

describe('LocalOwnerResolver (ADR-089, standalone)', () => {
  it('без резолвера профиля: нормализуется только литерал `local`', async () => {
    const r = createLocalOwnerResolver({});
    expect([...(await r.resolveLocalOwnerIds())]).toEqual([LOCAL_USER_ID]);
    expect(await r.isLocalOwner(LOCAL_USER_ID)).toBe(true);
    expect(await r.isLocalOwner('uuid')).toBe(false);
    expect(await r.normalizeOwner(LOCAL_USER_ID)).toBe(LOCAL_USER_ID);
    expect(await r.normalizeOwner('uuid')).toBe('uuid');
    expect(await r.normalizeOwner(undefined)).toBeUndefined();
  });

  it('legacy-UUID профиля `local` нормализуется к `local`', async () => {
    const profileId = 'profile-uuid';
    const r = createLocalOwnerResolver({
      resolveLocalProfileId: async () => profileId,
    });
    expect(await r.isLocalOwner(profileId)).toBe(true);
    expect(await r.normalizeOwner(profileId)).toBe(LOCAL_USER_ID);
    // id профиля кэшируется — повторного резолва нет.
    const spy = vi.fn(async () => profileId);
    const r2 = createLocalOwnerResolver({ resolveLocalProfileId: spy });
    await r2.resolveLocalOwnerIds();
    await r2.resolveLocalOwnerIds();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('sync-кэш (`isLocalOwnerCached`) знает профиль только после разрешения', async () => {
    const r = createLocalOwnerResolver({ resolveLocalProfileId: async () => 'p1' });
    // До первого разрешения кэш пуст — fail-safe (видимость не расширяется).
    expect(r.isLocalOwnerCached('p1')).toBe(false);
    expect(r.isLocalOwnerCached(LOCAL_USER_ID)).toBe(true);
    await r.resolveLocalOwnerIds();
    expect(r.isLocalOwnerCached('p1')).toBe(true);
    expect(r.isLocalOwnerCached('other')).toBe(false);
  });

  it('нет профиля (`null`) — только `local`; позднее созданный профиль учитывается (null не кэшируется)', async () => {
    let profileId: string | null = null;
    const r = createLocalOwnerResolver({ resolveLocalProfileId: async () => profileId });
    expect([...(await r.resolveLocalOwnerIds())].sort()).toEqual([LOCAL_USER_ID]);
    profileId = 'p-late';
    expect([...(await r.resolveLocalOwnerIds())].sort()).toEqual([LOCAL_USER_ID, 'p-late'].sort());
  });

  it('ошибка резолвера профиля → fail-safe: только `local`', async () => {
    const r = createLocalOwnerResolver({
      resolveLocalProfileId: async () => {
        throw new Error('boom');
      },
    });
    expect([...(await r.resolveLocalOwnerIds())]).toEqual([LOCAL_USER_ID]);
    expect(await r.isLocalOwner('uuid')).toBe(false);
  });
});
