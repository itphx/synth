// ConnectionWatcher — фоновая проверка живости гибридного подключения к удалённому
// backend и повторное авто-подключение при недоступности/перезапуске сервера.
//
// Проблема: RemoteConnection.connected отражает лишь наличие runtime-сессии (токена),
// а не реальную доступность backend — если сервер лёг или перезапустился, сессия в
// памяти остаётся «живой», повторного подключения не происходит, и UI не видит
// offline/online. Watcher периодически (intervalMs, 15 с) проверяет:
//   - сессии нет → авто-подключение по сохранённым credentials (не чаще
//     reconnectIntervalMs, 30 с);
//   - сессия есть → GET /health (доступность), затем GET /auth/status (валидность токена);
//   - сервер доступен, но токен невалиден/протух → пересоздание сессии (refresh).
// Результат пишется в фактическую живость через deps.setLiveness → /api/v2/hybrid/status
// (connected = connection.connected && liveness).
//
// Зависимости инжектируются (ConnectionWatcherDeps) — класс покрывается юнит-тестами
// без сети.

export interface ConnectionWatcherDeps {
  /** Активный целевой сервер (connection.backendUrl ?? defaultBackendUrl) или null. */
  getTarget: () => string | null;
  /** Есть ли runtime-сессия (connection.connected). */
  isSessionActive: () => boolean;
  /** Попытка авто-подключения по сохранённым credentials (обёртка connectRemoteFromSaved). true — подключились. */
  tryConnectFromSaved: (url: string) => Promise<boolean>;
  /** Проверка доступности сервера (client.isReachable()). */
  checkReachable: () => Promise<boolean>;
  /** Проверка валидности токена (client.getAuthStatus()). Бросает при 401/ошибке. */
  checkAuth: () => Promise<boolean>;
  /** Обновить фактический статус живости для hybrid/status. */
  setLiveness: (connected: boolean) => void;
}

export interface ConnectionWatcherOptions {
  /** Период тиков (по умолчанию 15 000 мс). */
  intervalMs?: number;
  /** Минимальный интервал между попытками авто-подключения (по умолчанию 30 000 мс). */
  reconnectIntervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_RECONNECT_INTERVAL_MS = 30_000;

export class ConnectionWatcher {
  private readonly _deps: ConnectionWatcherDeps;
  private readonly _intervalMs: number;
  private readonly _reconnectIntervalMs: number;
  private _timer: ReturnType<typeof setInterval> | null = null;
  /** Предыдущий тик ещё выполняется — новый пропускаем (никакой конкурентности). */
  private _ticking = false;
  /** Когда последний раз реально пытались пересоздать сессию (epoch ms). */
  private _lastConnectAttempt = 0;

  constructor(deps: ConnectionWatcherDeps, opts?: ConnectionWatcherOptions) {
    this._deps = deps;
    this._intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this._reconnectIntervalMs = opts?.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
  }

  /** Немедленный тик + периодические по intervalMs. Идемпотентен (повторный start — no-op). */
  start(): void {
    if (this._timer) return;
    void this._tick();
    this._timer = setInterval(() => {
      void this._tick();
    }, this._intervalMs);
  }

  /** Остановить периодические тики. */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  private async _tick(): Promise<void> {
    // Тик не должен исполняться конкурентно: предыдущий ещё идёт — пропускаем.
    if (this._ticking) return;
    this._ticking = true;
    try {
      const target = this._deps.getTarget();
      if (!target) return;

      if (!this._deps.isSessionActive()) {
        // Повторные попытки авто-подключения — не чаще reconnectIntervalMs.
        // Вне окна статус не трогаем: liveness остаётся как есть.
        if (!this._canAttemptConnect()) return;
        await this._tryConnect(target);
        return;
      }

      // Сессия есть: сначала доступность сервера, затем валидность токена.
      let reachable = false;
      try {
        reachable = await this._deps.checkReachable();
      } catch {
        reachable = false;
      }
      if (!reachable) {
        this._deps.setLiveness(false);
        return;
      }

      let authOk = false;
      try {
        authOk = await this._deps.checkAuth();
      } catch {
        authOk = false;
      }
      if (authOk) {
        this._deps.setLiveness(true);
        return;
      }

      // Сервер доступен, но токен невалиден/протух — пересоздаём сессию (refresh).
      await this._tryConnect(target);
    } finally {
      this._ticking = false;
    }
  }

  /** Частотное ограничение авто-подключений: разрешено, если окно reconnectIntervalMs прошло. */
  private _canAttemptConnect(): boolean {
    const now = Date.now();
    if (now - this._lastConnectAttempt < this._reconnectIntervalMs) return false;
    this._lastConnectAttempt = now;
    return true;
  }

  private async _tryConnect(target: string): Promise<void> {
    let ok = false;
    try {
      ok = await this._deps.tryConnectFromSaved(target);
    } catch {
      ok = false;
    }
    this._deps.setLiveness(ok);
  }
}
