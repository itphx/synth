// ADR-133: планировщик автопроверки обновлений. Сеть не трогаем — модуль
// проверки замокан; таймеры — фейковые (vi.useFakeTimers).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsRepository } from './storage/ports/settings-repository.js';
import type { UpdatesRuntimeSettings } from './storage/runtime-settings.js';
import { startUpdateScheduler } from './update-scheduler.js';

const { checkMock } = vi.hoisted(() => ({ checkMock: vi.fn() }));

vi.mock('./update-checker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./update-checker.js')>();
  return { ...actual, checkForUpdates: checkMock };
});

/** Фейковый порт runtime-настроек: только секция `updates`. */
function fakeStore(initial: boolean | undefined) {
  const state = {
    check: initial as boolean | undefined,
    async getUpdates() {
      return state.check === undefined ? {} : { check: state.check };
    },
    async setUpdates(next: UpdatesRuntimeSettings) {
      state.check = next.check;
    },
    async clearUpdates() {
      state.check = undefined;
    },
  };
  return state as unknown as typeof state & SettingsRepository;
}

/** Дать отработать промис-цепочке тика (runCheck не возвращается таймеру). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const INFO = {
  currentVersion: '0.13.7',
  latestVersion: '0.14.0',
  channel: 'stable' as const,
  prerelease: false,
  registry: 'https://registry.npmjs.org',
  hasUpdate: true,
  checkedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  checkMock.mockReset();
  checkMock.mockResolvedValue(INFO);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startUpdateScheduler (ADR-133)', () => {
  it('check:false без runtime-порта — таймеров нет, запросов нет', async () => {
    const handle = await startUpdateScheduler({
      dataDir: '/tmp/unused',
      config: { check: false },
      env: {},
    });

    expect(vi.getTimerCount()).toBe(0);
    await expect(handle.runCheck()).resolves.toBeNull();
    expect(checkMock).not.toHaveBeenCalled();
    handle.stop();
  });

  it('check:true — первый тик после задержки и повтор по интервалу; stop гасит таймеры', async () => {
    const handle = await startUpdateScheduler({
      dataDir: '/tmp/unused',
      config: { check: true },
      env: {},
      initialDelayMs: 1_000,
      intervalMs: 5_000,
      log: () => {},
    });

    expect(checkMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(checkMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(checkMock).toHaveBeenCalledTimes(2);

    handle.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    expect(checkMock).toHaveBeenCalledTimes(2);
  });

  it('runtime-тумблер перечитывается: включение после старта срабатывает на следующем тике', async () => {
    const store = fakeStore(false);
    const handle = await startUpdateScheduler({
      dataDir: '/tmp/unused',
      config: { check: false },
      settingsStore: store,
      env: {},
      initialDelayMs: 1_000,
      intervalMs: 5_000,
      log: () => {},
    });

    // Таймеры есть (иначе включить из UI было бы нечем), но выключенный тик
    // запросов не делает.
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(checkMock).not.toHaveBeenCalled();

    // Включили в UI (`PUT /api/v2/settings/updates`) — следующий тик проверяет.
    await store.setUpdates({ check: true });
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(checkMock).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('ошибка проверки не роняет планировщик и пишется в лог', async () => {
    checkMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const log = vi.fn();
    const handle = await startUpdateScheduler({
      dataDir: '/tmp/unused',
      config: { check: true },
      env: {},
      initialDelayMs: 1_000,
      intervalMs: 5_000,
      log,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('проверка не удалась'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));

    // Следующий тик продолжает работать.
    checkMock.mockResolvedValue(INFO);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(checkMock).toHaveBeenCalledTimes(2);

    handle.stop();
  });
});
