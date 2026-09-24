import { describe, it, expect } from 'vitest';
import { access, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createSshEnv, isSshUrl, SshEnvError } from './ssh-env.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('ssh-env (AD-076 §T3)', () => {
  it('isSshUrl распознаёт git@ и ssh://', () => {
    expect(isSshUrl('git@github.com:org/repo.git')).toBe(true);
    expect(isSshUrl('ssh://git@host/org/repo.git')).toBe(true);
    expect(isSshUrl('https://github.com/org/repo.git')).toBe(false);
    expect(isSshUrl('file:///tmp/repo')).toBe(false);
  });

  it('createSshEnv пишет ключ 0600 и формирует GIT_SSH_COMMAND', async () => {
    const { env, cleanup } = await createSshEnv({ privateKey: '-----BEGIN KEY-----\nsecret\n' });
    const command = env.GIT_SSH_COMMAND ?? '';
    expect(command).toContain('-o IdentitiesOnly=yes');
    expect(command).toContain('-o BatchMode=yes');
    expect(command).toContain('-i ');

    const match = /-i (\S+)/.exec(command);
    expect(match).not.toBeNull();
    const keyPath = match![1]!;
    expect(await exists(keyPath)).toBe(true);
    const st = await stat(keyPath);
    expect(st.mode & 0o777).toBe(0o600);

    const dir = dirname(keyPath);
    await cleanup();
    expect(await exists(keyPath)).toBe(false);
    expect(await exists(dir)).toBe(false);

    // Идемпотентность.
    await cleanup();
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it('createSshEnv отклоняет ключ с passphrase явной ошибкой', async () => {
    await expect(createSshEnv({ privateKey: 'key', passphrase: 'p@ss' })).rejects.toBeInstanceOf(SshEnvError);
    try {
      await createSshEnv({ privateKey: 'key', passphrase: 'p@ss' });
    } catch (err) {
      expect((err as SshEnvError).code).toBe('passphrase_unsupported');
    }
  });
});
