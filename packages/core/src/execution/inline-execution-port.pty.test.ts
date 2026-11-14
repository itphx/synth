/**
 * План терминалов (Ф1): интеграционный прогон PTY на настоящем модуле.
 *
 * Проверяется то, что unit-тест на подделке проверить не может:
 *
 * - терминал действительно поднимает оболочку и отдаёт её вывод;
 * - `close()` освобождает процесс (группа процессов гасится);
 * - **гигиена окружения**: переменные, которые не должны попасть в дочерний
 *   процесс (`NODE_CHANNEL_FD` и прочие из blocklist), в PTY-сессии
 *   отсутствуют, а обычное окружение наследуется.
 *
 * Тест **пропускается**, если нативный модуль не загрузился (тонкий образ
 * control plane) или платформа — Windows (там нет групп процессов и Unix-PTY).
 */

import { describe, expect, it } from 'vitest';
import { InlineExecutionPort } from './inline-execution-port.js';
import { isExecutionError } from './ports/index.js';
import { isPtyAvailable } from './pty/provider.js';

/** Модуль PTY доступен в этом окружении (top-level await — как в других тестах пакета). */
const PTY_AVAILABLE = process.platform !== 'win32' && (await isPtyAvailable());

/** Дождаться появления подстроки в потоке вывода терминала. */
async function waitForOutput(
  handle: { onData(cb: (chunk: string) => void): () => void },
  marker: string,
  timeoutMs = 15_000,
): Promise<string> {
  let buffer = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`маркер '${marker}' не появился в выводе терминала`));
    }, timeoutMs);
    timer.unref?.();
    const unsubscribe = handle.onData((chunk) => {
      buffer += chunk;
      if (buffer.includes(marker)) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
  return buffer;
}

/** Жив ли процесс по pid. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Дождаться, пока процесс перестанет существовать (не дольше `timeoutMs`). */
async function waitNotAlive(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref?.();
    });
  }
  return !isAlive(pid);
}

describe.skipIf(!PTY_AVAILABLE)('PTY порта — живой модуль', () => {
  it('открывает терминал, принимает ввод и отдаёт вывод', async () => {
    const port = new InlineExecutionPort();

    const handle = await port.openPty({
      cwd: process.cwd(),
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
    });

    const output = waitForOutput(handle, 'synth-pty-ok');
    // Маркер собирается из двух частей: терминал **эхо** ввода, поэтому
    // литерал маркера не должен встречаться в набираемой команде.
    handle.write("printf 'synth-%s\\n' pty-ok\n");
    const buffer = await output;

    expect(buffer).toContain('synth-pty-ok');
    await handle.close();
  });

  it('close() освобождает процесс', async () => {
    const port = new InlineExecutionPort();

    const handle = await port.openPty({
      cwd: process.cwd(),
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
    });
    const pid = handle.pid;
    expect(pid).toBeGreaterThan(0);

    // Процесс жив до закрытия.
    expect(isAlive(pid!)).toBe(true);

    const exited = new Promise<void>((resolve) => {
      handle.onExit(() => resolve());
    });
    await handle.close();
    await exited;

    // Процесс завершён и подобран (не «зомби»).
    expect(await waitNotAlive(pid!)).toBe(true);
  });

  it('гигиена окружения: NODE_CHANNEL_FD не попадает в дочерний процесс', async () => {
    const port = new InlineExecutionPort();

    // Контрольное значение в ambient-окружении теста: переменная должна быть
    // видна в окружении теста, но **не** в дочернем процессе.
    process.env.NODE_CHANNEL_FD = '42';
    try {
      const handle = await port.openPty({
        cwd: process.cwd(),
        shell: '/bin/sh',
        cols: 80,
        rows: 24,
      });

      const output = waitForOutput(handle, 'SYNTH_ENV_DONE');
      // Маркер собирается printf'ом: терминал эхоит ввод, поэтому литерал
      // маркера не должен встречаться в набираемой команде.
      handle.write("env; printf 'SYNTH_ENV_%s\\n' DONE\n");
      const buffer = await output;

      expect(buffer).not.toContain('NODE_CHANNEL_FD');
      // Обычное окружение наследуется, терминальные признаки объявлены.
      expect(buffer).toContain('PATH=');
      expect(buffer).toContain('TERM=xterm-256color');
      expect(buffer).toContain('COLORTERM=truecolor');

      await handle.close();
    } finally {
      delete process.env.NODE_CHANNEL_FD;
    }
  });

  it('несуществующий рабочий каталог → отказ порта', async () => {
    const port = new InlineExecutionPort();

    await expect(
      port.openPty({ cwd: '/nonexistent-synth-pty-cwd', cols: 80, rows: 24 }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(isExecutionError(err)).toBe(true);
      const execError = err as { code?: string | number | null; reason?: string };
      expect(execError.code).toBe('ENOENT');
      expect(execError.reason).toBe('spawn_failed');
      return true;
    });
  });
});
