/**
 * Уборка временных каталогов медиа-раннера (ADR-115 × ADR-077).
 *
 * Медиа-раннер (`engine/media/runner.ts`) в split-режиме (remote) работает в
 * `{workspacesRoot}/.synth-media/<uuid>` — общий том control plane и
 * исполнителя. Каталог удаляется раннером в `finally`, но после **жёсткого
 * kill** (SIGKILL, паника узла, рестарт пода) `finally` не выполняется: каталог
 * остаётся на томе навсегда. Раз за прогоном (транскод/кадры/миниатюра) таких
 * каталогов может накопиться много, нужен периодический сборщик мусора.
 *
 * ## Правила
 *
 *  - удаляются **подкаталоги и файлы** `.synth-media`, которые старше TTL
 *    (`MEDIA_TEMP_TTL_MS`, 1 ч) — по времени изменения (mtime каталога: он
 *    меняется при записи входа/выхода `ffmpeg`);
 *  - каталог **не создаётся**: если `.synth-media` нет — нечего убирать;
 *  - уборка **best-effort**: ошибка по одной записи не мешает остальным,
 *    ошибка прогона — в лог, процесс продолжает жить;
 *  - таймер `unref` — процесс не держим; интервал — 6 ч (как у соседних
 *    pruner'ов).
 *
 * Запуск — при старте процесса (core `server/app/deps.ts` и backend
 * `app/deps.ts`) с корнем workspace.
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MEDIA_TMP_DIR_NAME } from './runner.js';

/** Срок жизни временного каталога медиа-раннера, мс (1 ч). */
export const MEDIA_TEMP_TTL_MS = 60 * 60 * 1000;

/** Период прогона уборки временных каталогов, мс (6 ч). */
export const MEDIA_TEMP_PRUNE_INTERVAL_MS = 6 * 3600_000;

/** Запись каталога `.synth-media` для уборки. */
export interface MediaTempEntry {
  /** Имя записи внутри `.synth-media`. */
  name: string;
  /** Время последнего изменения, мс (эпоха). */
  mtimeMs: number;
  /** Каталог ли это (файлы тоже убираются). */
  isDirectory: boolean;
}

/** ФС-операции уборки (инъекция тестов). */
export interface MediaTempPrunerFs {
  /** Содержимое каталога; ошибка (каталога нет) — пробрасывается вызывающему. */
  readdir(path: string): Promise<MediaTempEntry[]>;
  /** Удалить путь (рекурсивно для каталога); отсутствие — не ошибка. */
  rm(path: string): Promise<void>;
}

/** ФС по умолчанию (`node:fs/promises`). */
const DEFAULT_FS: MediaTempPrunerFs = {
  readdir: async (path) => {
    const entries = await readdir(path, { withFileTypes: true });
    const out: MediaTempEntry[] = [];
    for (const entry of entries) {
      const info = await stat(join(path, entry.name)).catch(() => null);
      // Гонка удаления (файл исчез между readdir и stat) — пропускаем.
      if (!info) continue;
      out.push({ name: entry.name, mtimeMs: info.mtimeMs, isDirectory: entry.isDirectory() });
    }
    return out;
  },
  rm: async (path) => {
    await rm(path, { recursive: true, force: true });
  },
};

export interface MediaTempPrunerOptions {
  /** Корень workspace (общий том control plane и исполнителя). */
  workspacesRoot: string;
  /** Срок жизни временного каталога, мс (по умолчанию `MEDIA_TEMP_TTL_MS`). */
  ttlMs?: number;
  /** Период проверки, мс (по умолчанию 6 часов). */
  intervalMs?: number;
  /** Лог предупреждений (по умолчанию `console.warn`). */
  log?: (message: string) => void;
  /** Источник времени (тесты); по умолчанию `Date.now`. */
  now?: () => number;
  /** ФС-операции (инъекция тестов). */
  fs?: Partial<MediaTempPrunerFs>;
}

/**
 * Запустить уборку временных каталогов медиа-раннера: сразу при старте и
 * далее каждые `intervalMs`. Возвращает stop-функцию.
 */
export function startMediaTempPruner(opts: MediaTempPrunerOptions): () => void {
  const intervalMs = opts.intervalMs ?? MEDIA_TEMP_PRUNE_INTERVAL_MS;
  const ttlMs = opts.ttlMs ?? MEDIA_TEMP_TTL_MS;
  const log = opts.log ?? ((message) => console.warn(message));
  const now = opts.now ?? Date.now;
  const fs: MediaTempPrunerFs = { ...DEFAULT_FS, ...(opts.fs ?? {}) };
  const base = join(resolve(opts.workspacesRoot), MEDIA_TMP_DIR_NAME);

  const run = async (): Promise<void> => {
    let entries: MediaTempEntry[];
    try {
      entries = await fs.readdir(base);
    } catch (err) {
      // Каталога нет (нормально: медиа не обрабатывали) — создавать его не
      // нужно; прочая ошибка — в лог.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code && code !== 'ENOENT') {
        log(
          `[MediaTempPruner] каталог временных файлов не прочитан: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }

    const cutoff = now() - ttlMs;
    for (const entry of entries) {
      if (entry.mtimeMs >= cutoff) continue;
      try {
        await fs.rm(join(base, entry.name));
      } catch (err) {
        log(
          `[MediaTempPruner] временный каталог не удалён (${entry.name}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  };

  void run();
  const timer = setInterval(() => {
    void run();
  }, intervalMs);
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}
