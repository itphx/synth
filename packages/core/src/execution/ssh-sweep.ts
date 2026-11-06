/**
 * Reaper каталогов SSH-материала (PROP-124 §2).
 *
 * Материал SSH-ключа живёт во временном каталоге `synth-ssh-*` (`os.tmpdir()`).
 * Нормально каталог убирает `cleanup` (гарантированно — успех, ошибка, таймаут,
 * отмена). Но процесс могут убить «жёстко» (SIGKILL инстанса, падение контейнера):
 * тогда `finally` не выполняется, и каталог с ключом (или с эфемерным
 * `ssh-agent`, в памяти которого ключ остался) остаётся в `tmp` навсегда.
 *
 * ## Критерий уборки — «жив ли владелец», а не «жив ли агент»
 *
 * В agent-режиме в каталог пишется `owner.pid` (pid процесса, создавшего
 * агента, и время старта из `/proc/<pid>/stat` — best-effort):
 *
 * - **владелец мёртв** (или его pid переиспользован — не совпало время старта)
 *   → агент осиротел: гасим его (`SIGTERM` → `SIGKILL`) и убираем каталог,
 *   **даже если агент жив** — он ведь не нужен никому;
 * - **владелец жив** → каталог **не трогаем никогда**: длинный фоновый прогон
 *   не должен терять ключ из-за «старости» каталога.
 *
 * Каталоги без `owner.pid` (git-режим, каталоги прошлых версий) — прежнее
 * поведение: живой агент не трогаем, остальное убираем по возрасту (TTL час).
 *
 * ## Где живёт реализация
 *
 * Здесь — **единственная** копия: и control plane (inline-режим), и исполнитель
 * (remote-режим) зовут её (исполнитель — делегирует в core, ADR-077).
 */

import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isProcessAlive,
  readProcessStartTime,
  readSshOwner,
  SSH_AGENT_PID_FILE,
  SSH_TEMP_DIR_PREFIX,
  terminateProcess,
  type ProcessKillTimeouts,
  type SshOwnerInfo,
} from '../git/ssh-env.js';

/** TTL «осиротевших» каталогов без владельца, мс (час). */
export const STALE_SSH_DIR_TTL_MS = 60 * 60 * 1000;

/** Интервал периодической уборки, мс (10 минут). */
export const SSH_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** Параметры уборки каталогов SSH-материала. */
export interface SshSweepOptions {
  /** Корень каталогов материала (по умолчанию — `os.tmpdir()`). */
  rootDir?: string;
  /** Таймауты эскалации гашения агента (см. `ProcessKillTimeouts`). */
  kill?: ProcessKillTimeouts;
}

/** Параметры периодической уборки. */
export interface SshSweepTimerOptions extends SshSweepOptions {
  /** Интервал уборки, мс (по умолчанию — 10 минут). */
  intervalMs?: number;
  /** TTL «осиротевших» каталогов без владельца, мс (по умолчанию — час). */
  maxAgeMs?: number;
  /**
   * Первая уборка — сразу (по умолчанию — `true`): каталоги, оставшиеся от
   * прошлого запуска (процесс был убит жёстко), убираются без ожидания
   * первого тика. Выключается, если уборка уже выполнена вручную.
   */
  immediate?: boolean;
}

/**
 * Убрать осиротевшие каталоги SSH-материала.
 *
 * @param maxAgeMs возраст «осиротевшего» каталога без владельца (по умолчанию — час)
 * @returns число удалённых каталогов
 */
export async function sweepStaleSshDirs(
  maxAgeMs: number = STALE_SSH_DIR_TTL_MS,
  opts: SshSweepOptions = {},
): Promise<number> {
  const root = opts.rootDir ?? tmpdir();
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

    // Владелец каталога (процесс, создавший агента): мёртв или pid переиспользован
    // → агент осиротел, гасим его и убираем каталог (даже если агент жив).
    const owner = await readSshOwner(path);
    if (owner) {
      if (isOwnerAlive(owner)) continue;
      await killAgent(path, opts.kill);
      await rm(path, { recursive: true, force: true }).catch(() => {});
      removed += 1;
      continue;
    }

    // Каталог без владельца (git-режим, прошлые версии) — прежнее поведение:
    // живой агент не трогаем (ключ нужен процессу вызова), остальное — по возрасту.
    const agentPid = await readAgentPid(path);
    if (agentPid !== null && isProcessAlive(agentPid)) continue;
    if (age === null || age > maxAgeMs) {
      await rm(path, { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}

/**
 * Запустить периодическую уборку (таймер `unref` — процесс не держится на нём).
 *
 * @returns функция остановки таймера
 */
export function startSshSweep(opts: SshSweepTimerOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? SSH_SWEEP_INTERVAL_MS;
  const maxAgeMs = opts.maxAgeMs ?? STALE_SSH_DIR_TTL_MS;
  const run = (): void => {
    void sweepStaleSshDirs(maxAgeMs, opts).catch(() => 0);
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  if (opts.immediate !== false) run();
  return (): void => {
    clearInterval(timer);
  };
}

/**
 * Ленивый запуск уборки — один раз на процесс.
 *
 * Вызывается точкой, которая **создаёт** материал (материализация секретов
 * в control plane): процесс, создавший каталоги, и обязан за ними следить.
 */
let sweepStop: (() => void) | null = null;

export function ensureSshSweepStarted(): void {
  if (sweepStop) return;
  sweepStop = startSshSweep();
}

/**
 * Жив ли владелец каталога.
 *
 * Владелец мёртв, если процесс не существует либо его pid переиспользован
 * (время старта не совпало). Время старта прочитать не удалось — верим pid
 * (fail-safe: каталог живого владельца лучше не трогать).
 */
function isOwnerAlive(owner: SshOwnerInfo): boolean {
  if (!isProcessAlive(owner.pid)) return false;
  if (owner.startTime === null) return true;
  const current = readProcessStartTime(owner.pid);
  if (current === null) return true;
  return current === owner.startTime;
}

/** pid агента из каталога материала; `null` — файла нет/нечитаем/некорректен. */
async function readAgentPid(dir: string): Promise<number | null> {
  try {
    const raw = await readFile(join(dir, SSH_AGENT_PID_FILE), 'utf-8');
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Гасить осиротевшего агента каталога (`SIGTERM` → `SIGKILL`). */
async function killAgent(dir: string, killOpts?: ProcessKillTimeouts): Promise<void> {
  const pid = await readAgentPid(dir);
  if (pid === null) return;
  if (!isProcessAlive(pid)) return;
  await terminateProcess(pid, killOpts ?? {});
}
