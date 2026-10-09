import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileUpdateTool } from './profile-update.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { FileProfileStore } from '../../storage/profile-store.js';
import type { ToolContext } from '@itphx/synth-shared';
import { generateId } from '@itphx/synth-shared';

describe('profile_update tool', () => {
  let sessionManager: SessionManager;
  let profilesStore: FileProfileStore;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-profile-update-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    profilesStore = new FileProfileStore({ dataDir: tmpDir });
    const session = await sessionManager.createSession({ title: 'Profile test', userId: 'user-1' });
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(extra?: Record<string, unknown>): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: { sessionManager, profilesStore, sessionId, ...(extra ?? {}) },
    };
  }

  it('обновляет поля профиля и возвращает строку результата', async () => {
    const result = await profileUpdateTool.execute(
      { display_name: 'Иван', email: 'ivan@example.com', phone: '+7 900 000-00-00', notes: 'Любит краткость' },
      makeCtx(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Profile updated');
    expect(result.content).toContain('display_name');
    expect(result.metadata?.fields).toEqual(['display_name', 'email', 'phone', 'notes']);

    const profile = (await profilesStore.getProfileByUsername('user-1'))!;
    expect(profile.displayName).toBe('Иван');
    expect(profile.email).toBe('ivan@example.com');
    expect(profile.phone).toBe('+7 900 000-00-00');
    expect(profile.notes).toBe('Любит краткость');
    expect(profile.updatedAt).toBeTruthy();
  });

  it('обновляет только переданные поля', async () => {
    await profilesStore.getOrCreateProfile({ username: 'user-1', email: 'old@example.com' });
    await profileUpdateTool.execute({ display_name: 'Новое имя' }, makeCtx());
    const profile = (await profilesStore.getProfileByUsername('user-1'))!;
    expect(profile.displayName).toBe('Новое имя');
    expect(profile.email).toBe('old@example.com');
  });

  it('interview_completed=true выставляет флаг и interviewCompletedAt', async () => {
    const result = await profileUpdateTool.execute({ interview_completed: true }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.interview_completed).toBe(true);

    const profile = (await profilesStore.getProfileByUsername('user-1'))!;
    expect(profile.interviewCompleted).toBe(true);
    expect(profile.interviewCompletedAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(profile.interviewCompletedAt!))).toBe(false);
  });

  it('interview_completed=false сбрасывает флаг и время', async () => {
    await profileUpdateTool.execute({ interview_completed: true }, makeCtx());
    await profileUpdateTool.execute({ interview_completed: false }, makeCtx());
    const profile = (await profilesStore.getProfileByUsername('user-1'))!;
    expect(profile.interviewCompleted).toBe(false);
    expect(profile.interviewCompletedAt).toBeUndefined();
  });

  it('резолвит профиль по id (session.userId = id профиля)', async () => {
    const created = await profilesStore.getOrCreateProfile({ username: 'uuid-user' });
    await sessionManager.withLock(sessionId, async (s) => {
      s.userId = created.id;
      await sessionManager.saveSession(s);
    });

    await profileUpdateTool.execute({ email: 'by-id@example.com' }, makeCtx());
    const loaded = (await profilesStore.loadProfile(created.id))!;
    expect(loaded.email).toBe('by-id@example.com');
  });

  it('резолвит профиль по username (session.userId = username)', async () => {
    await profilesStore.getOrCreateProfile({ username: 'user-1', email: 'by-username@example.com' });
    await profileUpdateTool.execute({ phone: '+1 000' }, makeCtx());
    const profile = (await profilesStore.getProfileByUsername('user-1'))!;
    expect(profile.phone).toBe('+1 000');
    expect(profile.email).toBe('by-username@example.com');
  });

  it('создаёт профиль, если его нет (getOrCreateProfile)', async () => {
    await profileUpdateTool.execute({ display_name: 'Новый' }, makeCtx());
    const profile = await profilesStore.getProfileByUsername('user-1');
    expect(profile).not.toBeNull();
    expect(profile!.displayName).toBe('Новый');
  });

  it('без profilesStore — ошибка deps_unavailable', async () => {
    const ctx = makeCtx({ profilesStore: undefined });
    const result = await profileUpdateTool.execute({ email: 'x@example.com' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('profiles store');
  });

  it('без sessionManager — ошибка deps_unavailable', async () => {
    const ctx = makeCtx({ sessionManager: undefined });
    const result = await profileUpdateTool.execute({ email: 'x@example.com' }, ctx);
    expect(result.isError).toBe(true);
  });

  it('сессия без владельца — ошибка', async () => {
    const noOwner = await sessionManager.createSession({ title: 'No owner' });
    const result = await profileUpdateTool.execute(
      { email: 'x@example.com' },
      { ...makeCtx(), sessionId: noOwner.id },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('owner');
  });

  it('несуществующая сессия — ошибка session_not_found', async () => {
    const result = await profileUpdateTool.execute(
      { email: 'x@example.com' },
      { ...makeCtx(), sessionId: 'does-not-exist' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('session not found');
  });

  it('пустые параметры — ошибка валидации (хотя бы одно поле)', async () => {
    const result = await profileUpdateTool.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('at least one field');
  });

  it('тул зарегистрирован с capability runtime', () => {
    expect(profileUpdateTool.name).toBe('profile_update');
    expect(profileUpdateTool.capabilities).toEqual(['runtime']);
  });
});
