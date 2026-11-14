/**
 * ADR-140: связь профиля с принципалом (ACL-id).
 *
 * `ProfileData.id` — UUID профиля, а ACL (`project.ownerId`/`members`,
 * `session.ownerId`) живёт в пространстве id пользователя из токена (OIDC
 * `sub`, debug-id). Каталог пользователей и передача владения обязаны
 * использовать ACL-id — модуль привязывает его к профилю при логине
 * (идентичность `provider: 'auth'`), без миграций схемы.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileProfileStore } from '@itphx/synth-core';
import type { ProfileData, User } from '@itphx/synth-shared';
import { AUTH_IDENTITY_PROVIDER, ensurePrincipalIdentity, principalIdOf } from './principal-identity.js';

let dataDir: string;
let profiles: FileProfileStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'synth-principal-identity-'));
  profiles = new FileProfileStore({ dataDir });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function makeProfile(over: Partial<ProfileData> & { id: string; username: string }): ProfileData {
  const now = new Date().toISOString();
  return {
    roles: ['USER'],
    teamRoles: [],
    isActive: true,
    preferences: {},
    notes: '',
    interviewCompleted: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function makeUser(id: string, username: string): User {
  return { id, username, roles: ['USER'], preferredLanguage: 'ru', createdAt: new Date().toISOString() } as User;
}

describe('principalIdOf — ACL-id профиля', () => {
  it('профиль с auth-идентичностью отдаёт externalId (OIDC sub/debug-id)', () => {
    const profile = makeProfile({
      id: 'profile-uuid',
      username: 'bob',
      identities: [
        { provider: AUTH_IDENTITY_PROVIDER, externalId: 'oidc-sub', linkedAt: new Date().toISOString() },
      ],
    });
    expect(principalIdOf(profile)).toBe('oidc-sub');
  });

  it('legacy-профиль без идентичности отдаёт profile.id', () => {
    expect(principalIdOf(makeProfile({ id: 'profile-uuid', username: 'bob' }))).toBe('profile-uuid');
  });

  it('чужие провайдеры идентичностей не считаются auth-идентичностью', () => {
    const profile = makeProfile({
      id: 'profile-uuid',
      username: 'bob',
      identities: [{ provider: 'tg', externalId: '450316139', linkedAt: new Date().toISOString() }],
    });
    expect(principalIdOf(profile)).toBe('profile-uuid');
  });
});

describe('ensurePrincipalIdentity — привязка при логине', () => {
  it('привязывает auth-идентичность к существующему профилю по username', async () => {
    await profiles.saveProfile(makeProfile({ id: 'profile-uuid', username: 'bob' }));

    await ensurePrincipalIdentity(profiles, makeUser('oidc-sub', 'bob'));

    const stored = await profiles.loadProfile('profile-uuid');
    expect(principalIdOf(stored!)).toBe('oidc-sub');
    expect(await profiles.findProfileByExternalId(AUTH_IDENTITY_PROVIDER, 'oidc-sub')).not.toBeNull();
  });

  it('идемпотентна: повторный вход не плодит идентичности', async () => {
    await profiles.saveProfile(makeProfile({ id: 'profile-uuid', username: 'bob' }));

    await ensurePrincipalIdentity(profiles, makeUser('oidc-sub', 'bob'));
    await ensurePrincipalIdentity(profiles, makeUser('oidc-sub', 'bob'));

    const stored = await profiles.loadProfile('profile-uuid');
    expect(stored!.identities?.filter((i) => i.provider === AUTH_IDENTITY_PROVIDER)).toHaveLength(1);
  });

  it('создаёт профиль и привязывает идентичность, если профиля нет', async () => {
    await ensurePrincipalIdentity(profiles, makeUser('oidc-sub', 'alice'));

    const stored = await profiles.getProfileByUsername('alice');
    expect(stored).not.toBeNull();
    expect(principalIdOf(stored!)).toBe('oidc-sub');
  });

  it('идентичность уже привязана к другому профилю — вход не ломается, чужой профиль не трогаем', async () => {
    await profiles.saveProfile(
      makeProfile({
        id: 'profile-a',
        username: 'alice',
        identities: [
          { provider: AUTH_IDENTITY_PROVIDER, externalId: 'oidc-sub', linkedAt: new Date().toISOString() },
        ],
      }),
    );
    await profiles.saveProfile(makeProfile({ id: 'profile-b', username: 'bob' }));

    await expect(ensurePrincipalIdentity(profiles, makeUser('oidc-sub', 'bob'))).resolves.toBeUndefined();

    const bob = await profiles.loadProfile('profile-b');
    expect(bob!.identities ?? []).toHaveLength(0);
    expect(principalIdOf(bob!)).toBe('profile-b');
  });
});
