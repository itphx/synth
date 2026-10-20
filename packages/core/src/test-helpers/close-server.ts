/**
 * Надёжное закрытие локального HTTP(S)/TCP-сервера в тестах.
 *
 * `server.close()` ждёт, пока завершатся все живые соединения. Keep-alive-сокет
 * (его держит, например, undici-агент) сам по себе не заканчивается — `close()`
 * не вызывает callback, и хук `afterEach`/`afterAll` виснет до таймаута vitest
 * («Hook timed out in 10000ms»). Локально такой зависший сокет обычно успевает
 * исчезнуть и баг не воспроизводится, на CI — воспроизводится.
 *
 * Поэтому закрытие идёт в три шага:
 * 1. рвём отслеживаемые сокеты — детерминированно, без ожидания;
 * 2. `closeAllConnections()` — все оставшиеся соединения сервера;
 * 3. `server.close()` — с ограничением по времени: зависший сокет не должен
 *    блокировать suite (таймер всегда снимается).
 */

/** Минимальный контракт сервера, который умеет закрыться. */
export interface CloseableServer {
  close(callback: () => void): unknown;
}

/** Сокет, который можно оборвать. */
export interface DestroyableSocket {
  destroy(): void;
}

export interface CloseServerOptions {
  /** Сокеты, которые нужно оборвать до `close()`. */
  sockets?: Iterable<DestroyableSocket>;
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
  for (const socket of options.sockets ?? []) {
    try {
      socket.destroy();
    } catch {
      // сокет уже мёртв — закрытию не мешает
    }
  }
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
