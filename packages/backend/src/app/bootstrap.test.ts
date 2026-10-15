/**
 * `seedDebugTestUsers` (`src/app/bootstrap.ts`): сид профилей тестовых
 * пользователей в debug-режиме. Fire-and-forget — ошибки не должны ронять
 * старт приложения; в не-debug режиме сид не выполняется.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AuthConfig, TestUser } from '@itphx/synth-shared';
import type { FileProfileStore } from '@itphx/synth-core';
import { seedDebugTestUsers } from './bootstrap.js';

interface ProfileInput {
  username: string;
  roles?: string[];
  email?: string;
}

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

function fakeStore() {
  const calls: ProfileInput[] = [];
  const getOrCreateProfile = vi.fn(async (input: ProfileInput) => {
    calls.push(input);
    return { id: `id-${input.username}`, username: input.username };
  });
  return { store: { getOrCreateProfile } as unknown as FileProfileStore, calls };
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
    const { store, calls } = fakeStore();
    seedDebugTestUsers(store, auth({
      debugMode: true,
      testUsers: [tu('admin', ['ADMIN']), tu('developer', ['USER'])],
    }));

    await flush();
    expect(calls.map((c) => c.username)).toEqual(['admin', 'developer']);
    expect(calls.map((c) => c.roles)).toEqual([['ADMIN'], ['USER']]);
  });

  it('не-debug режим → сид не выполняется', async () => {
    const { store, calls } = fakeStore();
    seedDebugTestUsers(store, auth({
      debugMode: false,
      testUsers: [tu('admin', ['ADMIN'])],
    }));

    await flush();
    expect(calls).toHaveLength(0);
  });

  it('debug без testUsers → сид не выполняется', async () => {
    const { store, calls } = fakeStore();
    seedDebugTestUsers(store, auth({ debugMode: true }));

    await flush();
    expect(calls).toHaveLength(0);
  });

  it('ошибка создания профиля не роняет вызов (fire-and-forget)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = {
      getOrCreateProfile: vi.fn(async () => {
        throw new Error('disk full');
      }),
    } as unknown as FileProfileStore;

    expect(() => seedDebugTestUsers(store, auth({
      debugMode: true,
      testUsers: [tu('admin', ['ADMIN'])],
    }))).not.toThrow();

    await flush();
    expect(warn).toHaveBeenCalled();
  });
});
