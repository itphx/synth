/**
 * In-memory sliding window rate limiter (AD-036).
 * Хранит timestamp-ы вызовов в Map<key, number[]>, чистит устаревшие (> 60s).
 */

const WINDOW_MS = 60_000;

export class RateLimiter {
  private _userCalls = new Map<string, number[]>();
  private _providerCalls = new Map<string, number[]>();

  constructor(
    private _userPerMinute: number,
    private _providerPerMinute: number,
  ) {}

  /** Проверяет лимит на пользователя. Возвращает false, если лимит превышен. */
  checkUser(userId: string): boolean {
    if (!userId) return true;
    return this._check(this._userCalls, userId, this._userPerMinute);
  }

  /** Проверяет лимит на провайдера. Возвращает false, если лимит превышен. */
  checkProvider(provider: string): boolean {
    if (!provider) return true;
    return this._check(this._providerCalls, provider, this._providerPerMinute);
  }

  reset(): void {
    this._userCalls.clear();
    this._providerCalls.clear();
  }

  private _check(map: Map<string, number[]>, key: string, limit: number): boolean {
    const now = Date.now();
    const history = map.get(key) ?? [];
    const fresh = history.filter((t) => now - t < WINDOW_MS);

    if (fresh.length >= limit) {
      map.set(key, fresh);
      return false;
    }

    fresh.push(now);
    map.set(key, fresh);
    return true;
  }
}
