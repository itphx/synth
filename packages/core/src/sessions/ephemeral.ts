import type { SessionManager } from './manager.js';

/**
 * AD-089: поддержка ephemeral-сессий — «сессия на событие с TTL и авто-архивом».
 * Модуль не хранит состояние: TTL вычисляется в момент создания, архивация —
 * sweeper'ом по `expiresAt`.
 */

const TTL_UNITS_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const TTL_PATTERN = /^(\d+)([smhd])$/;

/** Дефолтный интервал sweeper'а — раз в минуту. */
export const DEFAULT_EPHEMERAL_SWEEP_INTERVAL_MS = 60_000;

/**
 * AD-089: парсит длительность вида `30s` / `15m` / `24h` / `7d` в ISO-8601
 * момент `now + duration`. Формат строгий (целое число + единица s/m/h/d,
 * регистр значим); невалидный вход — `Error` (осознанно: ошибка конфигурации
 * должна быть видна, а не превращаться в бессрочную сессию).
 */
export function parseTtl(ttl: string, now: Date = new Date()): string {
  const match = TTL_PATTERN.exec(ttl.trim());
  if (!match) {
    throw new Error(`parseTtl: невалидный TTL "${ttl}" (ожидается <число><s|m|h|d>, например "15m")`);
  }
  const amount = Number(match[1]);
  const unit = match[2]!;
  return new Date(now.getTime() + amount * TTL_UNITS_MS[unit]!).toISOString();
}

/**
 * AD-089: периодический воркер авто-архивации ephemeral-сессий. Ошибки sweep
 * логируются и не роняют процесс. Таймер `unref()`-ится, чтобы не удерживать
 * event loop (тесты/короткоживущие процессы). Возвращает функцию остановки.
 */
export function startEphemeralSweeper(
  sessionManager: SessionManager,
  intervalMs: number = DEFAULT_EPHEMERAL_SWEEP_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    void sessionManager.archiveExpired().catch((err) => {
      console.warn(`[ephemeral] ошибка авто-архивации сессий: ${String(err)}`);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
