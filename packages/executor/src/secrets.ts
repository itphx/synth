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
 * - при старте процесса — уборка осиротевших каталогов `synth-ssh-*`
 *   (прерванный процесс мог не дойти до `finally`), далее — раз в 10 минут.
 *
 * ## Режим агента (PROP-124 §2)
 *
 * Секрет с `mode: 'agent'` материализуется **эфемерным `ssh-agent`**:
 * `SSH_AUTH_SOCK` (+ `SSH_AGENT_PID`) в окружении вызова, приватный ключ
 * удаляется с диска сразу после `ssh-add` (материал остаётся только в памяти
 * агента). Режим `git` (по умолчанию) не меняется: ключ файлом +
 * `GIT_SSH_COMMAND`.
 *
 * Уборка (reaper) — **общая реализация в core** (`execution/ssh-sweep.ts`):
 * критерий — «жив ли **владелец** каталога» (`owner.pid`), а не «жив ли агент»:
 * осиротевший агент (владелец мёртв) гасится и каталог убирается, а каталог
 * живого владельца не трогается никогда (длинный фоновый прогон не теряет
 * ключ). Каталоги без владельца (git-режим, прошлые версии) убираются по
 * возрасту, как раньше.
 *
 * Секреты **не логируются** и не попадают ни в ошибку, ни в ответ: в лог
 * уходит только факт materialization.
 *
 * ## Фоновые процессы (протокол 6, PROP-124 §7)
 *
 * Тот же помощник обслуживает и фоновый запуск (`POST /exec/spawn`): материал
 * нужен процессу на время его жизни, поэтому гасится **вместе с процессом** —
 * выход, `stop()`, таймаут, остановка исполнителя (`background.ts`).
 */

import type { ExecSecret } from '@itphx/synth-core';

/**
 * Префикс временных каталогов SSH-ключа (общий с core `createSshEnv`).
 *
 * Значение — **контракт с core** (`git/ssh-env.ts`): одинаковое в обоих
 * пакетах, иначе reaper исполнителя не увидел бы каталоги control plane.
 * Сверка значений — тест `secrets.test.ts`.
 */
export const SSH_TEMP_DIR_PREFIX = 'synth-ssh-';

/**
 * Имя файла с pid агента в каталоге материала (общий с core `createSshEnv`).
 *
 * Признак «агент жив» для reaper'а: каталог с живым агентом не удаляется по
 * возрасту (PROP-124 §2).
 */
export const SSH_AGENT_PID_FILE = 'agent.pid';

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
  | ((opts: { privateKey: string; passphrase?: string; agent?: boolean }) => Promise<{
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
        // PROP-124 §2: режим доставки ключа — git (файл + `GIT_SSH_COMMAND`)
        // либо agent (эфемерный `ssh-agent`, ключ удаляется после `ssh-add`).
        ...(secret.mode === 'agent' ? { agent: true } : {}),
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
 * Уборка осиротевших каталогов SSH-материала — **общая реализация в core**
 * (`execution/ssh-sweep.ts`).
 *
 * Одна точка уборки на оба режима: control plane (inline) и исполнитель
 * (remote) создают одинаковые каталоги `synth-ssh-*`, поэтому и reaper должен
 * быть один — иначе core создаёт каталоги, которые никто не убирает.
 * Исполнитель лишь делегирует (точечный runtime-импорт core — как и
 * `createSshEnv`).
 *
 * Критерий уборки — «жив ли **владелец**» каталога (`owner.pid`), а не «жив ли
 * агент»: осиротевший агент (владелец мёртв) гасится, а каталог живого
 * владельца не трогается никогда.
 *
 * @param maxAgeMs возраст «осиротевшего» каталога без владельца (по умолчанию — час)
 * @returns число удалённых каталогов
 */
export async function sweepStaleSshDirs(maxAgeMs: number = STALE_SSH_DIR_TTL_MS): Promise<number> {
  const core = await import('@itphx/synth-core');
  return core.sweepStaleSshDirs(maxAgeMs);
}

/**
 * Периодическая уборка (таймер `unref`, раз в 10 минут) — общая реализация
 * в core.
 *
 * @param opts параметры таймера (`immediate: false` — если уборка уже была
 *   выполнена вручную при старте процесса)
 * @returns функция остановки таймера
 */
export async function startSshSweep(
  opts: { immediate?: boolean } = {},
): Promise<() => void> {
  const core = await import('@itphx/synth-core');
  return core.startSshSweep(opts);
}
