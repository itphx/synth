import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * AD-076 §T3: подготовка SSH-окружения для git (ключа `GIT_SSH_COMMAND`).
 *
 * Приватный ключ пишется во временный файл `0600` в каталоге `0700`
 * (`mkdtemp` в `os.tmpdir()`); `cleanup` идемпотентно удаляет файл и каталог.
 */

/** SSH-URL: scp-подобный (`git@host:path`) либо `ssh://`. */
export function isSshUrl(url: string): boolean {
  return url.startsWith('git@') || url.startsWith('ssh://');
}

export type SshEnvErrorCode = 'passphrase_unsupported';

/**
 * Типизированная ошибка подготовки SSH-окружения. `passphrase` не поддержан
 * осознанно: `ssh` не читает пароль из окружения, а `SSH_ASKPASS`-обвязка
 * небезопасна/ненадёжна — лучше явная ошибка, чем молчаливый фейл аутентификации.
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
 * файл и каталог (идемпотентно). Ключ с `passphrase` → `SshEnvError`
 * (`passphrase_unsupported`), а не тихий фейл.
 */
export async function createSshEnv(opts: CreateSshEnvOptions): Promise<SshEnv> {
  if (opts.passphrase) {
    throw new SshEnvError(
      'passphrase_unsupported',
      'SSH-ключи с passphrase не поддерживаются: ssh не читает passphrase из окружения',
    );
  }

  const dir = await mkdtemp(join(tmpdir(), 'synth-ssh-'));
  await chmod(dir, 0o700).catch(() => {});
  const keyPath = join(dir, 'key');
  await writeFile(keyPath, opts.privateKey, { encoding: 'utf-8', mode: 0o600 });
  await chmod(keyPath, 0o600).catch(() => {});

  const sshCommand = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  return { env: { GIT_SSH_COMMAND: sshCommand }, cleanup };
}
