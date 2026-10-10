/**
 * AD-089/AD-052: in-memory лемитер запросов по API-ключу привязки.
 *
 * Fixed-window 60 c: окно ключа начинается с первого запроса; пока окно не
 * истекло, `check` пропускает не более `limitPerMinute` запросов, затем —
 * `false`. Лимитер — per-процесс (single-instance приём событий); для
 * мульти-инстанса потребуется внешний store (K8s/PG), как и для dedup.
 */
export class KeyRateLimiter {
  private _windows = new Map<string, { windowStart: number; count: number }>();

  constructor(private _windowMs = 60_000) {}

  /**
   * Регистрирует попытку запроса по `keyId` и проверяет лимит.
   * `limitPerMinute <= 0` либо нечисловой — без лимита (`true`).
   */
  check(keyId: string, limitPerMinute: number, now: number = Date.now()): boolean {
    if (!Number.isFinite(limitPerMinute) || limitPerMinute <= 0) return true;

    const entry = this._windows.get(keyId);
    if (!entry || now - entry.windowStart >= this._windowMs) {
      this._windows.set(keyId, { windowStart: now, count: 1 });
      return true;
    }
    if (entry.count >= limitPerMinute) return false;
    entry.count += 1;
    return true;
  }
}
