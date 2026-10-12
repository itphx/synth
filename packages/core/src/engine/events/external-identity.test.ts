import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProfileData } from '@itphx/synth-shared';
import { FileProfileStore } from '../../storage/profile-store.js';
import { createExternalIdentityResolver } from './external-identity.js';

function makeProfile(overrides: Partial<ProfileData> = {}): ProfileData {
  const now = new Date().toISOString();
  return {
    id: 'u1',
    username: 'john',
    roles: ['USER'],
    teamRoles: [],
    isActive: true,
    preferences: {},
    notes: '',
    interviewCompleted: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('createExternalIdentityResolver (AD-089)', () => {
  let tmpDir: string;
  let profiles: FileProfileStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-ext-identity-'));
    profiles = new FileProfileStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const resolver = (map: Record<string, string> = {}) =>
    createExternalIdentityResolver({ profiles, getIdentityMap: () => map });

  it('override identityMap по principalId приоритетнее профиля', async () => {
    await profiles.saveProfile(makeProfile({ id: 'u-profile' }));
    await profiles.linkIdentity('u-profile', {
      provider: 'tg',
      externalId: '111',
      linkedAt: '2026-03-01T10:00:00.000Z',
    });

    const res = await resolver({ 'tg:111': 'u-override' })({ principalId: 'tg:111' });
    expect(res).toEqual({ userId: 'u-override' });
  });

  it('override identityMap по chatKey, когда principalId неизвестен', async () => {
    const res = await resolver({ 'chat:telegram:42': 'u-chat' })({
      principalId: 'tg:999',
      chatKey: 'chat:telegram:42',
    });
    expect(res).toEqual({ userId: 'u-chat' });
  });

  it('профиль по principalId с displayName', async () => {
    await profiles.saveProfile(makeProfile({ id: 'u1', username: 'john', displayName: 'John Doe' }));
    await profiles.linkIdentity('u1', {
      provider: 'tg',
      externalId: '450316139',
      linkedAt: '2026-03-01T10:00:00.000Z',
    });

    const res = await resolver()({ principalId: 'tg:450316139' });
    expect(res).toEqual({ userId: 'u1', displayName: 'John Doe' });
  });

  it('displayName падает на username, если displayName не задан', async () => {
    await profiles.saveProfile(makeProfile({ id: 'u1', username: 'john', displayName: undefined }));
    await profiles.linkIdentity('u1', {
      provider: 'tg',
      externalId: '7',
      linkedAt: '2026-03-01T10:00:00.000Z',
    });

    const res = await resolver()({ principalId: 'tg:7' });
    expect(res).toEqual({ userId: 'u1', displayName: 'john' });
  });

  it('неизвестный principalId → null', async () => {
    await profiles.saveProfile(makeProfile({ id: 'u1' }));
    expect(await resolver()({ principalId: 'tg:000' })).toBeNull();
  });

  it('невалидный principalId (без ":") → null', async () => {
    expect(await resolver()({ principalId: 'nocolon' })).toBeNull();
  });

  it('пустая карта и пустой профиль → null', async () => {
    expect(await resolver()({})).toBeNull();
    expect(await resolver()({ chatKey: 'chat:telegram:1' })).toBeNull();
  });

  it('getIdentityMap читается на каждом вызове (live-обновление)', async () => {
    let map: Record<string, string> = {};
    const res = createExternalIdentityResolver({ profiles, getIdentityMap: () => map });

    expect(await res({ principalId: 'tg:1' })).toBeNull();
    map = { 'tg:1': 'u-live' };
    expect(await res({ principalId: 'tg:1' })).toEqual({ userId: 'u-live' });
  });
});
