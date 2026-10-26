/**
 * Материализация секретов вызова на стороне исполнителя (ADR-077,
 * протокол 4).
 *
 * Control plane передаёт приватный SSH-ключ **значением** (полем `secrets[]`
 * в `POST /exec`): путь к файлу в control plane в контейнере исполнителя не
 * существует, поэтому прописать его в `GIT_SSH_COMMAND` нельзя (ADR-077,
 * «Обновлено 2026-10-26», (б)).
 *
 * Исполнитель готовит материал **у себя**:
 *
 * - каталог `0700` во временной папке (`mkdtemp`), ключ `0600`, askpass
 *   `0700` — общая реализация core (`createSshEnv`), дублировать её нельзя;
 * - удаление — **всегда** (успех, ошибка команды, таймаут, отмена);
 * - при старте процесса — sweep осиротевших каталогов `synth-ssh-*`
 *   (прерванный процесс мог не дойти до `finally`).
 *
 * Секреты **не логируются** и не попадают ни в ошибку, ни в ответ: в лог
 * уходит только факт materialization.
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecSecret } from '@itphx/synth-core';

/** Префикс временных каталогов SSH-ключа (общий с core `createSshEnv`). */
export const SSH_TEMP_DIR_PREFIX = 'synth-ssh-';

/** TTL «осиротевших» каталогов: старше — удаляются при старте процесса. */
export const STALE_SSH_DIR_TTL_MS = 60 * 60 * 1000;

/** Готовое окружение вызова + идемпотентная очистка. */
export interface MaterializedSecrets {
  /** Переменные окружения (например `GIT_SSH_COMMAND`). */
  env: Record<string, string>;
  /** Идемпотентная очистка временных каталогов. */
  cleanup: () => Promise<void>;
}

/** Ленивая загрузка `createSshEnv` из core (точечный runtime-импорт). */
let createSshEnvImpl:
  | ((opts: { privateKey: string; passphrase?: string }) => Promise<{
      env: Record<string, string>;
      cleanup: () => Promise<void>;
    }>)
  | undefined;

async function resolveCreateSshEnv(): Promise<NonNullable<typeof createSshEnvImpl>> {
  if (!createSshEnvImpl) {
    const core = await import('@itphx/synth-core');
    createSshEnvImpl = core.createSshEnv;
  }
  return createSshEnvImpl;
}

/**
 * Материализовать секреты вызова в окружение команды исполнителя.
 *
 * Окружение секретов **перекрывает** `env` вызова: материал доставлен явно
 * для этой команды, а значит он важнее ambient-значений.
 *
 * Ошибка подготовки пробрасывается вызывающему: исполнитель сообщает о ней
 * как о внутренней ошибке **без** материала (в тексте ошибки нет ни ключа,
 * ни passphrase).
 */
export async function materializeSecrets(secrets: ExecSecret[]): Promise<MaterializedSecrets> {
  const createSshEnv = await resolveCreateSshEnv();
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

/**
 * Sweep осиротевших каталогов SSH-ключа в `os.tmpdir()`.
 *
 * Каталог удаляется, если он старше TTL (по умолчанию — час) **или** если его
 * не удалось разобрать (не каталог / stat не сработал): такой каталог всё
 * равно бесполезен, а ключ в нём — нет.
 *
 * @param maxAgeMs возраст «осиротевшего» каталога (по умолчанию — час)
 * @returns число удалённых каталогов
 */
export async function sweepStaleSshDirs(maxAgeMs: number = STALE_SSH_DIR_TTL_MS): Promise<number> {
  const root = tmpdir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith(SSH_TEMP_DIR_PREFIX)) continue;
    const path = join(root, name);
    let age: number | null = null;
    try {
      const info = await stat(path);
      if (!info.isDirectory()) {
        // Не каталог — мусор с тем же префиксом: удаляем.
        await rm(path, { recursive: true, force: true });
        removed += 1;
        continue;
      }
      age = now - info.mtimeMs;
    } catch {
      // Не удалось разобрать (уже удалён, нет прав): считаем мусором.
      age = null;
    }
    if (age === null || age > maxAgeMs) {
      await rm(path, { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}
