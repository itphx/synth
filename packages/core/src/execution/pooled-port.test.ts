/**
 * Ленивый порт на динамический пул (PROP-135, Ф4b-1).
 *
 * Проверяется поведение прокси-порта:
 *
 * - `ensure` вызывается **один раз** на ключ (адрес пула запрашивается лениво);
 * - `execute`/`spawnBackground`/`probe`/`capabilitySummary` делегируют реальному
 *   порту после разрешения пула;
 * - ошибка `ensure` **не кэшируется**: следующий вызов повторяет попытку;
 * - FS делегирует; реального порта без `fs` → `ExecutionFsUnavailableError`;
 * - порт удалённый (`isRemote`), `executorMcp` не выставляется;
 * - после активности (`execute` — успех и ошибка, успешный `spawnBackground`)
 *   провайдер получает `touch`; это fire-and-forget (результат и латентность
 *   не зависят от него), провайдер без `touch` — no-op.
 */

import { describe, it, expect, vi } from 'vitest';
import { createPooledExecutionPort } from './pooled-port.js';
import type { ExecutionPoolKey, ExecutionPoolRef } from './pool-provider.js';
import { ExecutionFsUnavailableError, type ExecutionPort } from './ports/index.js';

const KEY: ExecutionPoolKey = {
  scope: 'project',
  id: 'prj_1',
  class: 'exec',
  profile: 'default',
};

/** Порт-заглушка: считает вызовы и отдаёт заранее заданные ответы. */
function fakePort(overrides: Partial<ExecutionPort> = {}): ExecutionPort & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    execute: async () => {
      calls.push('execute');
      return { stdout: 'ok', stderr: '', exitCode: 0, truncated: false, durationMs: 1 };
    },
    ...overrides,
  } as ExecutionPort & { calls: string[] };
}

describe('PROP-135 Ф4b-1: ленивый порт на пул', () => {
  it('порт удалённый, MCP-дескриптор не выставляется', () => {
    const port = createPooledExecutionPort({
      key: KEY,
      provider: { ensure: async () => ({ url: 'http://pool:8080' }) },
      createPort: async () => fakePort(),
    });
    expect(port.isRemote).toBe(true);
    expect(port.executorMcp).toBeUndefined();
  });

  it('ensure вызывается один раз на ключ; execute делегирует реальному порту', async () => {
    const ensure = vi.fn(async (_key: ExecutionPoolKey): Promise<ExecutionPoolRef> => ({
      url: 'http://pool:8080',
      token: 'pool-token',
    }));
    const inner = fakePort();
    const createPort = vi.fn(async () => inner);
    const port = createPooledExecutionPort({ key: KEY, provider: { ensure }, createPort });

    // До первого вызова пул не запрашивался (ленивость).
    expect(ensure).not.toHaveBeenCalled();

    const result = await port.execute({
      command: { kind: 'shell', command: 'echo hi' },
    });
    expect(result.stdout).toBe('ok');
    expect(inner.calls).toContain('execute');

    await port.execute({ command: { kind: 'shell', command: 'echo hi' } });
    // Один ensure на ключ — порт собран один раз.
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(createPort).toHaveBeenCalledTimes(1);
  });

  it('ошибка ensure → сброс кэша, следующий вызов повторяет ensure', async () => {
    let attempt = 0;
    const ensure = vi.fn(async (_key: ExecutionPoolKey): Promise<ExecutionPoolRef> => {
      attempt += 1;
      if (attempt === 1) throw new Error('pool unavailable');
      return { url: 'http://pool:8080' };
    });
    const port = createPooledExecutionPort({
      key: KEY,
      provider: { ensure },
      createPort: async () => fakePort(),
    });

    await expect(
      port.execute({ command: { kind: 'shell', command: 'echo hi' } }),
    ).rejects.toThrow(/pool unavailable/);
    expect(ensure).toHaveBeenCalledTimes(1);

    // Второй вызов повторяет ensure (кэш сброшен) и проходит.
    const result = await port.execute({ command: { kind: 'shell', command: 'echo hi' } });
    expect(result.stdout).toBe('ok');
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it('probe и capabilitySummary делегируют реальному порту', async () => {
    const inner = fakePort({
      probe: async () => true,
      capabilitySummary: async () => ({
        available: true,
        missing: 0,
        total: 1,
        unreachable: 0,
      }),
    });
    const port = createPooledExecutionPort({
      key: KEY,
      provider: { ensure: async () => ({ url: 'http://pool:8080' }) },
      createPort: async () => inner,
    });

    expect(await port.probe?.('git')).toBe(true);
    expect(await port.capabilitySummary?.('git')).toEqual({
      available: true,
      missing: 0,
      total: 1,
      unreachable: 0,
    });
  });

  it('spawnBackground без поддержки на реальном порте → ExecutionError с кодом EBACKGROUND', async () => {
    const port = createPooledExecutionPort({
      key: KEY,
      provider: { ensure: async () => ({ url: 'http://pool:8080' }) },
      createPort: async () => fakePort(),
    });
    const error = await port
      .spawnBackground?.({ command: { kind: 'shell', command: 'sleep 1' } })
      .catch((err: unknown) => err);
    expect((error as { code?: unknown }).code).toBe('EBACKGROUND');
  });

  it('fs делегирует реальному порту', async () => {
    const inner = fakePort({
      fs: {
        realpath: async (path: string) => `/real${path}`,
        stat: async () => ({ kind: 'file' as const, size: 3, mtimeMs: 1 }),
        readdir: async () => [],
        readText: async () => ({ lines: ['a'], totalLines: 1, truncated: false, bytes: 1 }),
        sniff: async () => ({ binary: false }),
        readBytes: async () => ({ dataBase64: 'AAA=', size: 3 }),
        writeFile: async () => {},
        mkdir: async () => {},
        remove: async () => {},
        readRawText: async () => ({ text: 'abc', size: 3 }),
        rename: async () => {},
        download: async () => Buffer.from('abc'),
        upload: async () => {},
        hash: async () => 'a'.repeat(64),
      },
    });
    const port = createPooledExecutionPort({
      key: KEY,
      provider: { ensure: async () => ({ url: 'http://pool:8080' }) },
      createPort: async () => inner,
    });

    expect(await port.fs?.realpath('/a')).toBe('/real/a');
    expect(await port.fs?.hash('/a')).toBe('a'.repeat(64));
  });

  it('реальный порт без fs → ExecutionFsUnavailableError (fail-closed)', async () => {
    const port = createPooledExecutionPort({
      key: KEY,
      provider: { ensure: async () => ({ url: 'http://pool:8080' }) },
      createPort: async () => fakePort(),
    });
    await expect(port.fs?.realpath('/a')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
    await expect(port.fs?.readText('/a')).rejects.toBeInstanceOf(ExecutionFsUnavailableError);
  });
});

describe('PROP-135: touch — сообщение provisioner\'у об активности пула', () => {
  /** Провайдер с учётом `touch`. */
  function touchProvider(): {
    provider: {
      ensure: (key: ExecutionPoolKey) => Promise<ExecutionPoolRef>;
      touch: (key: ExecutionPoolKey) => Promise<void>;
    };
    ensure: ReturnType<typeof vi.fn>;
    touch: ReturnType<typeof vi.fn>;
  } {
    const ensure = vi.fn(async (_key: ExecutionPoolKey): Promise<ExecutionPoolRef> => ({
      url: 'http://pool:8080',
    }));
    const touch = vi.fn(async (_key: ExecutionPoolKey): Promise<void> => {});
    return { provider: { ensure, touch }, ensure, touch };
  }

  it('execute (успех) → touch один раз с ключом пула', async () => {
    const { provider, touch } = touchProvider();
    const port = createPooledExecutionPort({
      key: KEY,
      provider,
      createPort: async () => fakePort(),
    });

    expect(touch).not.toHaveBeenCalled();
    await port.execute({ command: { kind: 'shell', command: 'echo hi' } });
    // Fire-and-forget: даём микрозадаче промиса `touch` выполниться.
    await Promise.resolve();

    expect(touch).toHaveBeenCalledTimes(1);
    expect(touch).toHaveBeenCalledWith(KEY);
  });

  it('execute (ошибка команды) → touch один раз (активность была)', async () => {
    const { provider, touch } = touchProvider();
    const inner = fakePort({
      execute: async () => {
        throw new Error('command failed');
      },
    });
    const port = createPooledExecutionPort({ key: KEY, provider, createPort: async () => inner });

    await expect(
      port.execute({ command: { kind: 'shell', command: 'false' } }),
    ).rejects.toThrow(/command failed/);
    await Promise.resolve();

    expect(touch).toHaveBeenCalledTimes(1);
  });

  it('spawnBackground (успех) → touch один раз', async () => {
    const { provider, touch } = touchProvider();
    const inner = fakePort({
      spawnBackground: async () => ({
        processId: 'proc_1',
        output: (async function* () {})(),
        exited: Promise.resolve({ exitCode: 0, signal: null, durationMs: 1 }),
        stop: () => {},
      }),
    });
    const port = createPooledExecutionPort({ key: KEY, provider, createPort: async () => inner });

    const process = await port.spawnBackground?.({
      command: { kind: 'shell', command: 'sleep 1' },
    });
    await Promise.resolve();

    expect(process?.processId).toBe('proc_1');
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it('spawnBackground без поддержки → touch не вызывается (активности не было)', async () => {
    const { provider, touch } = touchProvider();
    const port = createPooledExecutionPort({
      key: KEY,
      provider,
      createPort: async () => fakePort(),
    });

    await expect(
      port.spawnBackground?.({ command: { kind: 'shell', command: 'sleep 1' } }),
    ).rejects.toThrow(/background/);
    await Promise.resolve();

    expect(touch).not.toHaveBeenCalled();
  });

  it('touch не влияет на результат и латентность (промис не ждём)', async () => {
    const { provider } = touchProvider();
    // `touch` «завис» — если бы порт его ждал, вызов execute не завершился бы.
    provider.touch = () => new Promise<void>(() => {});

    const port = createPooledExecutionPort({
      key: KEY,
      provider,
      createPort: async () => fakePort(),
    });

    const result = await port.execute({ command: { kind: 'shell', command: 'echo hi' } });
    expect(result.stdout).toBe('ok');
  });

  it('ошибка touch не влияет на execute (best-effort)', async () => {
    const { provider } = touchProvider();
    provider.touch = async () => {
      throw new Error('provisioner down');
    };

    const port = createPooledExecutionPort({
      key: KEY,
      provider,
      createPort: async () => fakePort(),
    });

    const result = await port.execute({ command: { kind: 'shell', command: 'echo hi' } });
    // Даём отклонённому промису `touch` отработать: необработанных отказов нет.
    await new Promise((resolve) => setImmediate(resolve));
    expect(result.stdout).toBe('ok');
  });

  it('провайдер без touch — no-op (execute работает как раньше)', async () => {
    const port = createPooledExecutionPort({
      key: KEY,
      provider: { ensure: async () => ({ url: 'http://pool:8080' }) },
      createPort: async () => fakePort(),
    });

    const result = await port.execute({ command: { kind: 'shell', command: 'echo hi' } });
    expect(result.stdout).toBe('ok');
  });
});

describe('PROP-135: прогрев пула (connect-ошибки повторяются)', () => {
  const connectError = (): Error => Object.assign(new Error('исполнители не ответили на /capabilities'), { code: 'EUNREACHABLE' });
  const okResult = { stdout: 'ok', stderr: '', exitCode: 0, truncated: false, durationMs: 1 };

  it('повторяет connect-ошибку и затем выполняет команду', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const inner = fakePort({
        execute: async () => {
          attempts += 1;
          if (attempts < 3) throw connectError();
          return okResult;
        },
      });
      const port = createPooledExecutionPort({
        key: KEY,
        provider: { ensure: async () => ({ url: 'http://pool:8080' }) },
        createPort: async () => inner,
      });

      const promise = port.execute({ command: { kind: 'shell', command: 'echo hi' } });
      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).resolves.toMatchObject({ stdout: 'ok' });
      expect(attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('не смог — понятная ошибка с профилем и ключом пула', async () => {
    vi.useFakeTimers();
    try {
      const inner = fakePort({ execute: async () => { throw connectError(); } });
      const port = createPooledExecutionPort({
        key: KEY,
        provider: { ensure: async () => ({ url: 'http://pool:8080' }) },
        createPort: async () => inner,
      });

      const promise = port.execute({ command: { kind: 'shell', command: 'echo hi' } });
      const assertion = expect(promise).rejects.toThrow(/не ответил за .*с \(пул project:prj_1:exec:default\)/);
      await vi.advanceTimersByTimeAsync(20000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('не-connect ошибка не повторяется', async () => {
    const inner = fakePort({ execute: async () => { throw new Error('boom'); } });
    const port = createPooledExecutionPort({
      key: KEY,
      provider: { ensure: async () => ({ url: 'http://pool:8080' }) },
      createPort: async () => inner,
    });
    await expect(port.execute({ command: { kind: 'shell', command: 'echo hi' } })).rejects.toThrow('boom');
  });
});
