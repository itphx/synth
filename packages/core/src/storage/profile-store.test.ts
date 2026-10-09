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
    interviewCompleted: false,
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

describe('FileProfileStore interviewCompleted', () => {
  let store: FileProfileStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-profile-interview-'));
    store = new FileProfileStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('сохраняет и читает interviewCompleted/interviewCompletedAt (round-trip)', async () => {
    const at = '2026-02-03T10:20:30.000Z';
    const profile = makeProfile({ interviewCompleted: true, interviewCompletedAt: at });
    await store.saveProfile(profile);

    const loaded = await store.loadProfile(profile.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.interviewCompleted).toBe(true);
    expect(loaded!.interviewCompletedAt).toBe(at);
  });

  it('legacy-профиль с меткой [ИНТЕРВЬЮ] → interviewCompleted=true, время из updated_at', async () => {
    const profilesDir = join(tmpDir, 'auth', 'profiles');
    await mkdir(profilesDir, { recursive: true });
    const updatedAt = '2025-05-06T07:08:09.000Z';
    const legacy = {
      id: 'legacy-iv',
      username: 'legacy-iv',
      roles: ['USER'],
      team_roles: [],
      is_active: true,
      preferences: {},
      notes: 'Немного о себе\n\n[ИНТЕРВЬЮ]\n[ВОПРОС q1]\n...',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: updatedAt,
    };
    await writeFile(join(profilesDir, 'legacy-iv.json'), JSON.stringify(legacy), 'utf-8');

    const loaded = await store.loadProfile('legacy-iv');
    expect(loaded).not.toBeNull();
    expect(loaded!.interviewCompleted).toBe(true);
    expect(loaded!.interviewCompletedAt).toBe(updatedAt);
  });

  it('legacy-профиль без метки → interviewCompleted=false, без времени', async () => {
    const profilesDir = join(tmpDir, 'auth', 'profiles');
    await mkdir(profilesDir, { recursive: true });
    const now = new Date().toISOString();
    const legacy = {
      id: 'legacy-none',
      username: 'legacy-none',
      roles: ['USER'],
      team_roles: [],
      is_active: true,
      preferences: {},
      notes: 'обычные заметки',
      created_at: now,
      updated_at: now,
    };
    await writeFile(join(profilesDir, 'legacy-none.json'), JSON.stringify(legacy), 'utf-8');

    const loaded = await store.loadProfile('legacy-none');
    expect(loaded).not.toBeNull();
    expect(loaded!.interviewCompleted).toBe(false);
    expect(loaded!.interviewCompletedAt).toBeUndefined();
  });

  it('getOrCreateProfile инициализирует interviewCompleted=false', async () => {
    const profile = await store.getOrCreateProfile({ username: 'fresh' });
    expect(profile.interviewCompleted).toBe(false);

    const loaded = await store.loadProfile(profile.id);
    expect(loaded!.interviewCompleted).toBe(false);
  });
});
