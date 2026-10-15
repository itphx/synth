import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * ADR-076 §T3: подготовка SSH-окружения для git (ключа `GIT_SSH_COMMAND`).
 *
 * Приватный ключ пишется во временный файл `0600` в каталоге `0700`
 * (`mkdtemp` в `os.tmpdir()`); при наличии `passphrase` там же создаётся
 * исполняемый askpass-скрипт `0700`, который отдаёт ровно passphrase
 * (`base64`, чтобы не зависеть от кавычек/спецсимволов). `cleanup` идемпотентно
 * удаляет каталог вместе с ключом и скриптом.
 */

/** SSH-URL: scp-подобный (`git@host:path`) либо `ssh://`. */
export function isSshUrl(url: string): boolean {
  return url.startsWith('git@') || url.startsWith('ssh://');
}

export type SshEnvErrorCode = 'env_failed';

/**
 * Типизированная ошибка подготовки SSH-окружения (FS/permissions при создании
 * временного ключа/askpass-скрипта). `passphrase` теперь поддержан через
 * `SSH_ASKPASS_REQUIRE=force`.
 */
export class SshEnvError extends Error {
  constructor(
    readonly code: SshEnvErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SshEnvError';
  }
}

export interface CreateSshEnvOptions {
  privateKey: string;
  passphrase?: string;
}

export interface SshEnv {
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

/**
 * Создаёт временный ключ и env для git-вызова. Возвращённый `cleanup` удаляет
 * каталог (идемпотентно). Ключ с `passphrase` получает `SSH_ASKPASS`-скрипт и
 * `SSH_ASKPASS_REQUIRE=force` (без `BatchMode`, с `NumberOfPasswordPrompts=1`);
 * ключ без passphrase — `BatchMode=yes` без askpass, как раньше. Сбой подготовки
 * (FS/permissions) → `SshEnvError('env_failed')`.
 */
export async function createSshEnv(opts: CreateSshEnvOptions): Promise<SshEnv> {
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), 'synth-ssh-'));
  } catch (err) {
    throw new SshEnvError('env_failed', `Не удалось создать временный каталог SSH: ${(err as Error).message}`);
  }

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    await chmod(dir, 0o700).catch(() => {});
    const keyPath = join(dir, 'key');
    await writeFile(keyPath, opts.privateKey, { encoding: 'utf-8', mode: 0o600 });
    await chmod(keyPath, 0o600).catch(() => {});

    const baseCommand = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    const env: Record<string, string> = {};

    if (opts.passphrase) {
      const askpassPath = join(dir, 'askpass.sh');
      const encoded = Buffer.from(opts.passphrase, 'utf-8').toString('base64');
      await writeFile(askpassPath, `#!/bin/sh\nbase64 -d <<'EOF'\n${encoded}\nEOF\n`, {
        encoding: 'utf-8',
        mode: 0o700,
      });
      await chmod(askpassPath, 0o700).catch(() => {});

      env.SSH_ASKPASS = askpassPath;
      env.SSH_ASKPASS_REQUIRE = 'force';
      // BatchMode глушит askpass; NumberOfPasswordPrompts=1 — защита от зависания.
      env.GIT_SSH_COMMAND = `${baseCommand} -o NumberOfPasswordPrompts=1`;
    } else {
      env.GIT_SSH_COMMAND = `${baseCommand} -o BatchMode=yes`;
    }

    return { env, cleanup };
  } catch (err) {
    await cleanup();
    if (err instanceof SshEnvError) throw err;
    throw new SshEnvError('env_failed', `Не удалось подготовить SSH-окружение: ${(err as Error).message}`);
  }
}
