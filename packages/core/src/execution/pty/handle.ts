/**
 * Хэндл PTY-сессии (план терминалов, Ф1) — адаптер поверх `PtySession`.
 *
 * ## Что добавляет адаптер
 *
 * - **идентификатор** сессии (`pty_<uuid>`) — для реестра и диагностики;
 * - **гарантию «`onExit` — один раз»**: событие выхода одно, а подписчиков
 *   может быть несколько (сервис терминалов, подписчики UI);
 * - **идемпотентное закрытие**: повторный `close()` возвращает тот же промис
 *   и не шлёт второй сигнал;
 * - **закрытие группой процессов**: node-pty запускает лидера сессии
 *   (`setsid`), поэтому `pid` — лидер группы: сигнал уходит **всему дереву**
 *   процессов терминала, а не только оболочке (как у `execute`/`spawnBackground`);
 * - **проба переднего плана** (`inspect`, протокол исполнителя 9): факт из
 *   ядра ОС (`inspectForeground`), кэш 250 мс и склейка одновременных вызовов.
 *
 * ## Ограничение по фоновым задачам оболочки
 *
 * Интерактивная оболочка с job control выносит **фоновые** задачи в
 * отдельные группы процессов (`sleep 300 &` — своя pgid). Сигнал группе
 * лидера их не достаёт: закрытие терминала гасит оболочку и её передний план,
 * а фоновые задачи остаются жить (их чистит оболочка при нормальном выходе).
 * Гасить сессию целиком — отдельная задача сервиса терминалов.
 */

import type { PtyForeground, PtyHandle } from '../ports/index.js';
import { inspectForeground } from './foreground.js';
import type { PtySession } from './provider.js';

/**
 * Пауза между «мягким» и «жёстким» закрытием PTY-сессии, мс.
 *
 * Как у фоновых процессов (`BACKGROUND_KILL_GRACE_MS`), но короче: терминал
 * закрывают явно, ждать пользователю 5 с незачем.
 */
export const PTY_CLOSE_GRACE_MS = 1_000;

/**
 * Время жизни кэша пробы переднего плана, мс.
 *
 * Сервис терминалов спрашивает «что в фокусе» часто (при старте запуска —
 * несколько раз за ход), а проба читает `/proc` (скан по процессам). 250 мс —
 * компромисс: пользователь не успевает переключиться между вопросами, а
 * цикл «проверил → отправил команду → проверил ещё раз» уже видит свежий
 * факт.
 */
export const PTY_FOREGROUND_CACHE_MS = 250;

/** Настройки хэндла (тесты подставляют пробу). */
export interface PtyHandleOptions {
  /** Проба переднего плана (по умолчанию — `inspectForeground`). */
  probe?: (shellPid: number | undefined) => Promise<PtyForeground | null>;
  /** Время жизни кэша пробы, мс (по умолчанию `PTY_FOREGROUND_CACHE_MS`). */
  inspectCacheMs?: number;
}

/** Исход выхода PTY-сессии. */
interface PtyExitInfo {
  exitCode?: number;
  signal?: string;
}

/**
 * Обернуть PTY-сессию в хэндл контракта порта.
 *
 * @param session живая сессия провайдера
 * @param id идентификатор сессии (`pty_<uuid>`)
 * @param opts подмена пробы переднего плана (тесты)
 */
export function createPtyHandle(
  session: PtySession,
  id: string,
  opts?: PtyHandleOptions,
): PtyHandle {
  const dataListeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(e: PtyExitInfo) => void>();
  const exitWaiters: Array<() => void> = [];
  let exited = false;
  let exitInfo: PtyExitInfo = {};
  let closePromise: Promise<void> | undefined;
  const probe = opts?.probe ?? inspectForeground;
  const inspectCacheMs = Math.max(0, opts?.inspectCacheMs ?? PTY_FOREGROUND_CACHE_MS);
  /** Кэш результата пробы: `at` — момент, `value` — факт (в т.ч. `null`). */
  let inspectCache: { at: number; value: PtyForeground | null } | undefined;
  /** Идущая проба (одновременные вызовы делят один прогон). */
  let inspectInFlight: Promise<PtyForeground | null> | undefined;

  /** Разбудить ожидателей выхода. */
  const wakeExitWaiters = (): void => {
    const waiters = exitWaiters.splice(0, exitWaiters.length);
    for (const waiter of waiters) waiter();
  };

  const disposeData = session.onData((chunk) => {
    for (const listener of [...dataListeners]) {
      try {
        listener(chunk);
      } catch {
        // Подписчик не должен ломать поток вывода терминала.
      }
    }
  });

  session.onExit((info) => {
    if (exited) return;
    exited = true;
    exitInfo = info;
    for (const listener of [...exitListeners]) {
      try {
        listener(info);
      } catch {
        // Подписчик не должен ломать обработку выхода.
      }
    }
    exitListeners.clear();
    dataListeners.clear();
    disposeData();
    wakeExitWaiters();
  });

  /** Отправить сигнал группе процессов терминала (fallback — процессу). */
  const sendSignal = (signal: string): void => {
    const pid = session.pid;
    if (pid !== undefined && process.platform !== 'win32') {
      try {
        // node-pty запускает лидера сессии (`setsid`) ⇒ его pid — лидер
        // группы процессов: сигнал уходит всему дереву (как у `execute`).
        process.kill(-pid, signal as NodeJS.Signals);
        return;
      } catch {
        // Группы нет (процесс завершён) — ниже прямое убийство.
      }
    }
    try {
      session.kill(signal);
    } catch {
      // Процесс уже завершён (или сигнал недопустим) — гонка не ошибка.
    }
  };

  /** Дождаться выхода (не дольше `timeoutMs`). */
  const waitExit = (timeoutMs: number): Promise<boolean> => {
    if (exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      exitWaiters.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  };

  const close = (opts?: { signal?: string }): Promise<void> => {
    closePromise ??= (async () => {
      if (exited) return;
      sendSignal(opts?.signal ?? 'SIGTERM');
      if (await waitExit(PTY_CLOSE_GRACE_MS)) return;
      // Процесс не ушёл — эскалация (как у фоновых процессов: TERM → KILL).
      sendSignal('SIGKILL');
      await waitExit(PTY_CLOSE_GRACE_MS);
    })();
    return closePromise;
  };

  /**
   * Проба переднего плана с кэшем (250 мс) и склейкой одновременных вызовов.
   *
   * После закрытия/выхода — `null`: спрашивать «что в фокусе» у мёртвого
   * терминала бессмысленно, а пробе нечего читать.
   */
  const inspect = (): Promise<PtyForeground | null> => {
    if (exited || closePromise !== undefined) return Promise.resolve(null);
    const now = Date.now();
    if (inspectCache && now - inspectCache.at < inspectCacheMs) {
      return Promise.resolve(inspectCache.value);
    }
    if (inspectInFlight) return inspectInFlight;
    const run: Promise<PtyForeground | null> = (async () => {
      let value: PtyForeground | null = null;
      try {
        value = await probe(session.pid);
      } catch {
        // Проба не должна ломать вызывающего: неизвестно — значит `null`.
        value = null;
      }
      inspectCache = { at: Date.now(), value };
      return value;
    })().finally(() => {
      inspectInFlight = undefined;
    });
    inspectInFlight = run;
    return run;
  };

  return {
    id,
    pid: session.pid,
    write(data: string): void {
      if (exited) return;
      try {
        session.write(data);
      } catch (err) {
        // После выхода терминала запись невозможна — но это не ошибка вызова.
        if (!exited) throw err;
      }
    },
    resize(cols: number, rows: number): void {
      if (exited) return;
      try {
        session.resize(cols, rows);
      } catch (err) {
        if (!exited) throw err;
      }
    },
    onData(cb: (chunk: string) => void): () => void {
      if (exited) return () => {};
      dataListeners.add(cb);
      return () => {
        dataListeners.delete(cb);
      };
    },
    onExit(cb: (e: PtyExitInfo) => void): () => void {
      if (exited) {
        // Выход уже был — отдаём результат немедленно (событие одно).
        cb(exitInfo);
        return () => {};
      }
      exitListeners.add(cb);
      return () => {
        exitListeners.delete(cb);
      };
    },
    close,
    inspect,
  };
}
