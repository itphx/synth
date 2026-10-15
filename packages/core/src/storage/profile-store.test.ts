import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileProfileStore } from './profile-store.js';
import type { ProfileData, ExternalIdentity } from '@itphx/synth-shared';

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

describe('FileProfileStore identities (ADR-089)', () => {
  let store: FileProfileStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-profile-identities-'));
    store = new FileProfileStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const identity = (overrides: Partial<ExternalIdentity> = {}): ExternalIdentity => ({
    provider: 'tg',
    externalId: '450316139',
    username: 'john',
    displayName: 'John Doe',
    linkedAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  });

  it('linkIdentity сохраняет и делает доступной через findProfileByExternalId', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));

    const updated = await store.linkIdentity('u1', identity());
    expect(updated).not.toBeNull();
    expect(updated!.identities).toHaveLength(1);
    expect(updated!.identities![0]).toMatchObject({
      provider: 'tg',
      externalId: '450316139',
      username: 'john',
      displayName: 'John Doe',
    });

    const found = await store.findProfileByExternalId('tg', '450316139');
    expect(found?.id).toBe('u1');
  });

  it('findProfileByExternalId возвращает null, если пары нет', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    expect(await store.findProfileByExternalId('tg', 'nope')).toBeNull();
  });

  it('linkIdentity идемпотентен: повтор не дублирует привязку', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    await store.linkIdentity('u1', identity());
    await store.linkIdentity('u1', identity());

    const loaded = await store.loadProfile('u1');
    expect(loaded!.identities).toHaveLength(1);
  });

  it('linkIdentity: конфликт с чужим профилем → null и НЕ перезапись', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    await store.saveProfile(makeProfile({ id: 'u2', username: 'other' }));
    await store.linkIdentity('u1', identity());

    const conflict = await store.linkIdentity('u2', identity());
    expect(conflict).toBeNull();

    // Владелец не изменился, у u2 привязки нет.
    const owner = await store.findProfileByExternalId('tg', '450316139');
    expect(owner?.id).toBe('u1');
    const u2 = await store.loadProfile('u2');
    expect(u2!.identities).toEqual([]);
  });

  it('linkIdentity: нет профиля → null', async () => {
    expect(await store.linkIdentity('missing', identity())).toBeNull();
  });

  it('unlinkIdentity удаляет привязку и возвращает обновлённый профиль', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    await store.linkIdentity('u1', identity());

    const updated = await store.unlinkIdentity('u1', 'tg', '450316139');
    expect(updated).not.toBeNull();
    expect(updated!.identities).toEqual([]);
    expect(await store.findProfileByExternalId('tg', '450316139')).toBeNull();
  });

  it('unlinkIdentity: нет такой идентичности → null (без записи)', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    expect(await store.unlinkIdentity('u1', 'tg', 'absent')).toBeNull();
    expect(await store.unlinkIdentity('missing', 'tg', 'x')).toBeNull();
  });

  it('legacy-профиль без identities читается как []', async () => {
    const profilesDir = join(tmpDir, 'auth', 'profiles');
    await mkdir(profilesDir, { recursive: true });
    const now = new Date().toISOString();
    const legacy = {
      id: 'legacy-id',
      username: 'legacy',
      roles: ['USER'],
      team_roles: [],
      is_active: true,
      preferences: {},
      notes: '',
      created_at: now,
      updated_at: now,
    };
    await writeFile(join(profilesDir, 'legacy-id.json'), JSON.stringify(legacy), 'utf-8');

    const loaded = await store.loadProfile('legacy-id');
    expect(loaded).not.toBeNull();
    expect(loaded!.identities).toEqual([]);
    expect(await store.findProfileByExternalId('tg', '450316139')).toBeNull();
  });

  it('персистентность: привязка переживает повторное чтение (snake_case JSON)', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    // linkedBy не задаём в этом кейсе; проверим полный round-trip отдельной привязкой.
    await store.linkIdentity('u1', identity({ linkedBy: 'admin' }));

    // Перечитываем тем же стором (с диска) и новым экземпляром (формат JSON).
    const reread = await store.loadProfile('u1');
    expect(reread!.identities![0]).toMatchObject({
      provider: 'tg',
      externalId: '450316139',
      displayName: 'John Doe',
      linkedAt: '2026-03-01T10:00:00.000Z',
      linkedBy: 'admin',
    });

    const raw = JSON.parse(
      await readFile(join(tmpDir, 'auth', 'profiles', 'u1.json'), 'utf-8'),
    ) as { identities: Array<Record<string, unknown>> };
    expect(raw.identities[0]).toMatchObject({
      provider: 'tg',
      external_id: '450316139',
      display_name: 'John Doe',
      linked_at: '2026-03-01T10:00:00.000Z',
      linked_by: 'admin',
    });

    const fresh = new FileProfileStore({ dataDir: tmpDir });
    expect((await fresh.loadProfile('u1'))!.identities).toHaveLength(1);
  });
});
