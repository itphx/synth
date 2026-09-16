import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileProfileStore } from './profile-store.js';
import type { ProfileData } from '@itphx/synth-shared';

function makeProfile(overrides: Partial<ProfileData> = {}): ProfileData {
  const now = new Date().toISOString();
  return {
    id: 'profile-1',
    username: 'tester',
    roles: ['USER'],
    teamRoles: [],
    isActive: true,
    preferences: {},
    notes: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('FileProfileStore phone', () => {
  let store: FileProfileStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-profile-test-'));
    store = new FileProfileStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('сохраняет и читает phone (round-trip)', async () => {
    const profile = makeProfile({ email: 'a@example.com', phone: '+7 999 123-45-67' });
    await store.saveProfile(profile);

    const loaded = await store.loadProfile(profile.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.email).toBe('a@example.com');
    expect(loaded!.phone).toBe('+7 999 123-45-67');
  });

  it('профиль без phone читается без ошибок (phone === undefined)', async () => {
    const profile = makeProfile();
    await store.saveProfile(profile);

    const loaded = await store.loadProfile(profile.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.phone).toBeUndefined();
  });

  it('читает legacy-профиль без поля phone', async () => {
    const profilesDir = join(tmpDir, 'auth', 'profiles');
    await mkdir(profilesDir, { recursive: true });
    const now = new Date().toISOString();
    const legacy = {
      id: 'legacy-1',
      username: 'legacy',
      email: 'legacy@example.com',
      roles: ['USER'],
      team_roles: [],
      is_active: true,
      preferences: {},
      notes: '',
      created_at: now,
      updated_at: now,
    };
    await writeFile(join(profilesDir, 'legacy-1.json'), JSON.stringify(legacy), 'utf-8');

    const loaded = await store.loadProfile('legacy-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.phone).toBeUndefined();
    expect(loaded!.email).toBe('legacy@example.com');
  });
});
