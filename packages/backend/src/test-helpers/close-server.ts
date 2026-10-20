/**
 * Надёжное закрытие локального HTTP(S)-сервера в тестах.
 *
 * `server.close()` ждёт, пока завершатся все живые соединения. Keep-alive-сокет
 * (его держит, например, undici-агент) сам по себе не заканчивается — `close()`
 * не вызывает callback, и хук `afterAll` виснет до таймаута vitest
 * («Hook timed out in 10000ms»). Поэтому закрытие идёт в три шага:
 *
 * 1. `closeAllConnections()` — все живые соединения сервера;
 * 2. `server.close()` — с ограничением по времени: зависший сокет не должен
 *    блокировать suite (таймер всегда снимается).
 *
 * Дубль хелпера из `@itphx/synth-core` (`src/test-helpers/close-server.ts`):
 * пакеты не зависят друг от друга на уровне внутренних модулей, а
 * `@itphx/synth-core` не экспортирует тестовые хелперы в публичный API.
 */

/** Минимальный контракт сервера, который умеет закрыться. */
export interface CloseableServer {
  close(callback: () => void): unknown;
}

export interface CloseServerOptions {
  /** Максимальное ожидание закрытия, мс (по умолчанию 1000). */
  timeoutMs?: number;
}

/** Таймаут ожидания закрытия по умолчанию, мс. */
export const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;

/**
 * Закрывает сервер так, чтобы `close()` не мог зависнуть.
 *
 * Ошибка закрытия игнорируется: сервер уже не слушает — это не повод ронять
 * тест. Единственный важный инвариант — функция **всегда** завершается.
 */
export async function closeTestServer(
  server: CloseableServer,
  options: CloseServerOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  // Тот же приём, что в остальных тестах репозитория: метод есть не во всех
  // версиях Node и не во всех типах — вызываем опционально через каст.
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
