/**
 * `seedDebugTestUsers` (`src/app/bootstrap.ts`): сид профилей тестовых
 * пользователей в debug-режиме. Fire-and-forget — ошибки не должны ронять
 * старт приложения; в не-debug режиме сид не выполняется.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AuthConfig, TestUser } from '@itphx/synth-shared';
import { MemoryProfileRepository } from '@itphx/synth-core';
import { seedDebugTestUsers } from './bootstrap.js';

const tu = (username: string, roles: string[]): TestUser => ({
  username,
  roles,
  apiKey: `key-${username}`,
  displayName: username,
});

const auth = (over: Partial<AuthConfig>): AuthConfig => ({
  debugMode: false,
  sessionMaxAgeMinutes: 60,
  ...over,
});

/**
 * Заглушка `ProfileRepository`: in-memory реализация с шипом на
 * `getOrCreateProfile` — тест перехватывает вызовы (`mock.calls`), поведение
 * стораджа не подменяется.
 */
function fakeStore() {
  const store = new MemoryProfileRepository();
  const getOrCreateProfile = vi.spyOn(store, 'getOrCreateProfile');
  return { store, getOrCreateProfile };
}

/** Дождаться микротасок, чтобы отработал fire-and-forget `.catch(...)`. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('seedDebugTestUsers', () => {
  it('debug + testUsers → создаёт профиль для каждого тестового пользователя', async () => {
    const { store, getOrCreateProfile } = fakeStore();
    seedDebugTestUsers(store, auth({
      debugMode: true,
      testUsers: [tu('admin', ['ADMIN']), tu('developer', ['USER'])],
    }));

    await flush();
    const calls = getOrCreateProfile.mock.calls.map(([input]) => input);
    expect(calls.map((c) => c.username)).toEqual(['admin', 'developer']);
    expect(calls.map((c) => c.roles)).toEqual([['ADMIN'], ['USER']]);
  });

  it('не-debug режим → сид не выполняется', async () => {
    const { store, getOrCreateProfile } = fakeStore();
    seedDebugTestUsers(store, auth({
      debugMode: false,
      testUsers: [tu('admin', ['ADMIN'])],
    }));

    await flush();
    expect(getOrCreateProfile).not.toHaveBeenCalled();
  });

  it('debug без testUsers → сид не выполняется', async () => {
    const { store, getOrCreateProfile } = fakeStore();
    seedDebugTestUsers(store, auth({ debugMode: true }));

    await flush();
    expect(getOrCreateProfile).not.toHaveBeenCalled();
  });

  it('ошибка создания профиля не роняет вызов (fire-and-forget)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, getOrCreateProfile } = fakeStore();
    getOrCreateProfile.mockRejectedValue(new Error('disk full'));

    expect(() => seedDebugTestUsers(store, auth({
      debugMode: true,
      testUsers: [tu('admin', ['ADMIN'])],
    }))).not.toThrow();

    await flush();
    expect(warn).toHaveBeenCalled();
  });
});
