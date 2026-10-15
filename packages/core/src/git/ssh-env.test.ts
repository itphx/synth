import { describe, it, expect } from 'vitest';
import { access, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { createSshEnv, isSshUrl } from './ssh-env.js';

const execFileAsync = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Спецсимволы, ломающие наивную конкатенацию: `$`, `"`, `'`, `\`, пробел, перевод строки. */
const TRICKY_PASSPHRASE = 'p$a"s\'\\ w\nrd';

describe('ssh-env (ADR-076 §T3)', () => {
  it('isSshUrl распознаёт git@ и ssh://', () => {
    expect(isSshUrl('git@github.com:org/repo.git')).toBe(true);
    expect(isSshUrl('ssh://git@host/org/repo.git')).toBe(true);
    expect(isSshUrl('https://github.com/org/repo.git')).toBe(false);
    expect(isSshUrl('file:///tmp/repo')).toBe(false);
  });

  it('createSshEnv без passphrase пишет ключ 0600 и BatchMode (регресс)', async () => {
    const { env, cleanup } = await createSshEnv({ privateKey: '-----BEGIN KEY-----\nsecret\n' });
    const command = env.GIT_SSH_COMMAND ?? '';
    expect(command).toContain('-o IdentitiesOnly=yes');
    expect(command).toContain('-o BatchMode=yes');
    expect(command).toContain('-i ');
    // Без passphrase askpass не подключается.
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS_REQUIRE).toBeUndefined();

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

  it('createSshEnv с passphrase готовит askpass 0700 и не ставит BatchMode', async () => {
    const { env, cleanup } = await createSshEnv({ privateKey: 'key-material', passphrase: TRICKY_PASSPHRASE });
    try {
      const command = env.GIT_SSH_COMMAND ?? '';
      expect(command).toContain('-i ');
      expect(command).toContain('-o NumberOfPasswordPrompts=1');
      // BatchMode глушит askpass — его быть не должно.
      expect(command).not.toContain('BatchMode=yes');

      const keyPath = /-i (\S+)/.exec(command)?.[1];
      expect(keyPath).toBeTruthy();
      const keyStat = await stat(keyPath!);
      expect(keyStat.mode & 0o777).toBe(0o600);

      expect(env.SSH_ASKPASS).toBeTruthy();
      expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
      const askpassPath = env.SSH_ASKPASS!;

      // Скрипт лежит в том же temp-каталоге (удаляется cleanup).
      expect(dirname(askpassPath)).toBe(dirname(keyPath!));
      expect(await exists(askpassPath)).toBe(true);
      const askpassStat = await stat(askpassPath);
      expect(askpassStat.mode & 0o777).toBe(0o700);

      // Запускаем askpass и сверяем ровно исходный passphrase (со спецсимволами).
      const { stdout } = await execFileAsync(askpassPath, []);
      expect(String(stdout)).toBe(TRICKY_PASSPHRASE);
    } finally {
      await cleanup();
    }

    // cleanup удаляет каталог вместе со скриптом.
    const match = /-i (\S+)/.exec(env.GIT_SSH_COMMAND ?? '');
    const dir = dirname(match?.[1] ?? '');
    expect(await exists(env.SSH_ASKPASS!)).toBe(false);
    expect(await exists(dir)).toBe(false);

    await expect(cleanup()).resolves.toBeUndefined();
  });
});
