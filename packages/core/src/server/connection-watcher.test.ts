import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionWatcher, type ConnectionWatcherDeps } from './connection-watcher.js';

const TARGET = 'https://backend.test';
/** Периоды по умолчанию (см. connection-watcher.ts). */
const INTERVAL = 15_000;
const RECONNECT_INTERVAL = 30_000;

/** Базовые моки deps: все методы — async-заглушки, вызовы записываются. */
function createDeps(overrides: Partial<ConnectionWatcherDeps> = {}): ConnectionWatcherDeps {
  const deps: ConnectionWatcherDeps = {
    getTarget: () => TARGET,
    isSessionActive: () => false,
    tryConnectFromSaved: vi.fn(async () => true),
    checkReachable: vi.fn(async () => true),
    checkAuth: vi.fn(async () => true),
    setLiveness: vi.fn(),
    ...overrides,
  };
  return deps;
}

/** Дать микрозадачам завершиться (тик watcher'а без сети резолвится за пару хопов). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ConnectionWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start(): первый тик вызывается сразу; далее по interval', async () => {
    const deps = createDeps({ isSessionActive: () => true });
    const watcher = new ConnectionWatcher(deps);

    watcher.start();
    // Немедленный тик: первая проверка доступности вызывается синхронно.
    expect(deps.checkReachable).toHaveBeenCalledTimes(1);

    await flush();
    // Сервер доступен + токен валиден → живость подтверждена.
    expect(deps.checkAuth).toHaveBeenCalledTimes(1);
    expect(deps.setLiveness).toHaveBeenLastCalledWith(true);
    expect(deps.setLiveness).toHaveBeenCalledTimes(1);

    // Далее — по interval: каждый тик снова проверяет доступность.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(deps.checkReachable).toHaveBeenCalledTimes(2);
    expect(deps.checkAuth).toHaveBeenCalledTimes(2);
    expect(deps.setLiveness).toHaveBeenLastCalledWith(true);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(deps.checkReachable).toHaveBeenCalledTimes(3);
  });

  it('нет target (getTarget=null) — ничего не делает (tryConnect/check не вызываются)', async () => {
    const deps = createDeps({ getTarget: () => null });
    const watcher = new ConnectionWatcher(deps);

    watcher.start();
    await flush();
    await vi.advanceTimersByTimeAsync(INTERVAL * 4);

    expect(deps.tryConnectFromSaved).not.toHaveBeenCalled();
    expect(deps.checkReachable).not.toHaveBeenCalled();
    expect(deps.checkAuth).not.toHaveBeenCalled();
    expect(deps.setLiveness).not.toHaveBeenCalled();
  });

  it('сессии нет: tryConnectFromSaved при успехе → setLiveness(true)', async () => {
    const deps = createDeps({ tryConnectFromSaved: vi.fn(async () => true) });
    const watcher = new ConnectionWatcher(deps);

    watcher.start();
    await flush();

    expect(deps.tryConnectFromSaved).toHaveBeenCalledTimes(1);
    expect(deps.tryConnectFromSaved).toHaveBeenCalledWith(TARGET);
    expect(deps.setLiveness).toHaveBeenLastCalledWith(true);
  });

  it('сессии нет: tryConnectFromSaved при неудаче → setLiveness(false)', async () => {
    const deps = createDeps({ tryConnectFromSaved: vi.fn(async () => false) });
    const watcher = new ConnectionWatcher(deps);

    watcher.start();
    await flush();

    expect(deps.tryConnectFromSaved).toHaveBeenCalledTimes(1);
    expect(deps.setLiveness).toHaveBeenLastCalledWith(false);
  });

  it('сессии нет: повторная попытка авто-подключения — не раньше reconnectIntervalMs', async () => {
    const deps = createDeps({ tryConnectFromSaved: vi.fn(async () => false) });
    const watcher = new ConnectionWatcher(deps);

    watcher.start();
    await flush();
    expect(deps.tryConnectFromSaved).toHaveBeenCalledTimes(1);

    // С последней попытки прошло меньше reconnectIntervalMs (тик на ~15-й секунде,
    // окно 30 c) — повторной попытки нет.
    await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL - INTERVAL);
    expect(deps.tryConnectFromSaved).toHaveBeenCalledTimes(1);

    // Ещё interval (суммарно 30 c с последней попытки) — попытка разрешена.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(deps.tryConnectFromSaved).toHaveBeenCalledTimes(2);

    // Снова раньше окна — пропуск.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(deps.tryConnectFromSaved).toHaveBeenCalledTimes(2);
  });

  it('сессия есть + checkReachable=false → setLiveness(false), checkAuth не вызывается', async () => {
    const deps = createDeps({
      isSessionActive: () => true,
      checkReachable: vi.fn(async () => false),
    });
    const watcher = new ConnectionWatcher(deps);

    watcher.start();
    await flush();

    expect(deps.checkReachable).toHaveBeenCalledTimes(1);
    expect(deps.checkAuth).not.toHaveBeenCalled();
    expect(deps.tryConnectFromSaved).not.toHaveBeenCalled();
    expect(deps.setLiveness).toHaveBeenLastCalledWith(false);

    // Сервер «лежит» — каждый тик снимает живость, переподключение не пытаемся.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(deps.setLiveness).toHaveBeenLastCalledWith(false);
    expect(deps.tryConnectFromSaved).not.toHaveBeenCalled();
  });

  it('сессия есть + reachable=true + authOk=true → setLiveness(true)', async () => {
    const deps = createDeps({
      isSessionActive: () => true,
      checkReachable: vi.fn(async () => true),
      checkAuth: vi.fn(async () => true),
    });
    const watcher = new ConnectionWatcher(deps);

    watcher.start();
    await flush();

    expect(deps.checkAuth).toHaveBeenCalledTimes(1);
    expect(deps.setLiveness).toHaveBeenLastCalledWith(true);
    expect(deps.tryConnectFromSaved).not.toHaveBeenCalled();
  });

  it('сессия есть + reachable=true + authOk=false → tryConnectFromSaved вызван; успех → setLiveness(true)', async () => {
    const deps = createDeps({
      isSessionActive: () => true,
      checkReachable: vi.fn(async () => true),
      checkAuth: vi.fn(async () => false),
      tryConnectFromSaved: vi.fn(async () => true),
    });
    const watcher = new ConnectionWatcher(deps);

    watcher.start();
    await flush();

    expect(deps.checkAuth).toHaveBeenCalledTimes(1);
    expect(deps.tryConnectFromSaved).toHaveBeenCalledTimes(1);
    expect(deps.tryConnectFromSaved).toHaveBeenCalledWith(TARGET);
    expect(deps.setLiveness).toHaveBeenLastCalledWith(true);
  });

  it('сессия есть + reachable=true + authOk=false + refresh неудачен → setLiveness(false)', async () => {
    const deps = createDeps({
      isSessionActive: () => true,
      checkReachable: vi.fn(async () => true),
      checkAuth: vi.fn(async () => false),
      tryConnectFromSaved: vi.fn(async () => false),
    });
    const watcher = new ConnectionWatcher(deps);

    watcher.start();
    await flush();

    expect(deps.tryConnectFromSaved).toHaveBeenCalledTimes(1);
    expect(deps.setLiveness).toHaveBeenLastCalledWith(false);
  });

  it('исключения из tryConnect/check не роняют тик (catch → false)', async () => {
    const deps = createDeps({
      tryConnectFromSaved: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    const watcher = new ConnectionWatcher(deps);

    watcher.start();
    await flush();
    expect(deps.setLiveness).toHaveBeenLastCalledWith(false);
  });

  it('stop() очищает таймер — тиков больше нет', async () => {
    const deps = createDeps();
    const watcher = new ConnectionWatcher(deps);

    watcher.start();
    await flush();
    expect(deps.tryConnectFromSaved).toHaveBeenCalledTimes(1);

    watcher.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 4);
    expect(deps.tryConnectFromSaved).toHaveBeenCalledTimes(1);
  });

  it('конкурентный тик не исполняется: пока тик идёт, следующий пропускается', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checkReachable = vi.fn(async () => {
      await gate;
      return true;
    });
    const deps = createDeps({
      isSessionActive: () => true,
      checkReachable,
      checkAuth: vi.fn(async () => true),
    });
    const watcher = new ConnectionWatcher(deps);

    watcher.start();
    await flush();
    // Немедленный тик стартовал и ждёт gate (checkReachable не завершился).
    expect(checkReachable).toHaveBeenCalledTimes(1);

    // Интервальный тик попадает на ещё идущий — пропускается.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(checkReachable).toHaveBeenCalledTimes(1);

    // Тик завершается: токен валиден → живость true.
    release();
    await flush();
    expect(deps.checkAuth).toHaveBeenCalledTimes(1);
    expect(deps.setLiveness).toHaveBeenLastCalledWith(true);

    // После завершения предыдущего тика интервальные снова работают.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(checkReachable).toHaveBeenCalledTimes(2);
  });
});
