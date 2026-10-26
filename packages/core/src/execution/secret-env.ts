/**
 * Материализация секретов вызова (ADR-077, протокол 4).
 *
 * Секрет вызова (`ExecSecret`) — это **значение**, а не путь к файлу: путь
 * control plane в контейнере исполнителя не существует (ADR-077, «Обновлено
 * 2026-10-26», (б)). Поэтому точка исполнения готовит окружение **у себя**:
 * временный каталог `0700`, ключ `0600`, askpass `0700` — и удаляет всё
 * после вызова.
 *
 * Подготовка ключа/askpass — **общая** с control plane (`createSshEnv` из
 * `git/ssh-env.ts`): реализация не дублируется, различается только точка
 * материализации (процесс control plane или процесс исполнителя).
 */

import { createSshEnv } from '../git/ssh-env.js';
import type { ExecSecret } from './ports/index.js';

/** Готовое окружение вызова + идемпотентная очистка. */
export interface MaterializedSecretEnv {
  /** Переменные окружения (например `GIT_SSH_COMMAND`). */
  env: Record<string, string>;
  /** Идемпотентная очистка временных каталогов. */
  cleanup: () => Promise<void>;
}

/**
 * Материализовать секреты вызова в окружение команды.
 *
 * Окружение секретов **перекрывает** окружение вызова (`ExecRequest.env`):
 * материал доставлен явно для этой команды, а значит он важнее ambient-значений.
 *
 * Ошибка подготовки (`SshEnvError`) пробрасывается вызывающему: «тихо» выполнить
 * команду без ключа нельзя — операция упала бы с невнятной ошибкой
 * аутентификации.
 */
export async function materializeSecretEnv(secrets: ExecSecret[]): Promise<MaterializedSecretEnv> {
  const cleanups: Array<() => Promise<void>> = [];
  const env: Record<string, string> = {};
  try {
    for (const secret of secrets) {
      if (secret.kind !== 'ssh-key') continue;
      const ssh = await createSshEnv({
        privateKey: secret.privateKey,
        ...(secret.passphrase !== undefined ? { passphrase: secret.passphrase } : {}),
      });
      cleanups.push(ssh.cleanup);
      Object.assign(env, ssh.env);
    }
  } catch (err) {
    // Частично подготовленные каталоги убираем — иначе ключ остался бы в tmp.
    for (const cleanup of cleanups.reverse()) {
      await cleanup().catch(() => {});
    }
    throw err;
  }

  let cleaned = false;
  return {
    env,
    cleanup: async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      for (const cleanup of cleanups.reverse()) {
        await cleanup().catch(() => {});
      }
    },
  };
}
