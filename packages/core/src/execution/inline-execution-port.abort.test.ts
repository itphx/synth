/**
 * Остановка inline-исполнения (регрессия «Стоп не прерывает тул»).
 *
 * Воспроизведение бага: `sleep 30 | cat` и `pnpm build` — «Стоп» убивал только
 * оболочку (`bash`), а её потомки (`pnpm`, `tsc`, `node`, `cat`) оставались
 * жить и держали stdio. Завершение ждалось по `close`, поэтому тул «висел» до
 * конца команды.
 *
 * Теперь процесс запускается лидером собственной группы, «Стоп»/таймаут гасят
 * **группу** (`SIGTERM` → `SIGKILL` через 5 с), а завершение определяется по
 * `exit` (+ короткий дренаж потоков), а не по `close`.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InlineExecutionPort } from './inline-execution-port.js';
import { isExecutionError } from './ports/index.js';

/** Пауза (без `unref`: ожидание теста должно держать event loop). */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Дождаться появления файла с pid (команда пишет его до `wait`). */
async function waitFileWithPid(path: string, deadlineMs = 5_000): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const text = (await readFile(path, 'utf-8')).trim();
      if (text.length > 0) {
        const pid = Number(text);
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
    } catch {
      // Файла ещё нет — ждём.
    }
    if (Date.now() > deadline) throw new Error(`не дождались pid в ${path}`);
    await delay(20);
  }
}

/**
 * Дождаться исчезновения процесса: `process.kill(pid, 0)` бросает `ESRCH`.
 *
 * `EPERM` означает «процесс есть, но не наш» — считаем живым и ждём дальше.
 */
async function waitProcessGone(pid: number, deadlineMs = 2_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
    if (Date.now() > deadline) throw new Error(`процесс ${pid} остался жив после остановки`);
    await delay(20);
  }
}

/** Дождаться завершения промиса с пределом (внятное сообщение вместо таймаута vitest). */
async function within<T>(promise: Promise<T>, limitMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: дольше ${limitMs} мс`)), limitMs);
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('inline-порт: остановка группы процессов', () => {
  it('«Стоп» прерывает команду и гасит её потомков (sleep 30 & … wait)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-exec-abort-'));
    const pidFile = join(dir, 'pid');
    try {
      const port = new InlineExecutionPort();
      const controller = new AbortController();
      const promise = port.execute({
        // `sleep` — потомок оболочки, а не сама команда: без убийства группы
        // он остаётся жив и держит stdio.
        command: {
          kind: 'shell',
          command: `sleep 30 & echo $! > '${pidFile}'; wait`,
          shell: 'bash',
        },
        signal: controller.signal,
        timeoutMs: 30_000,
      });

      const pid = await waitFileWithPid(pidFile);

      const startedAt = Date.now();
      controller.abort();
      const err = await within(promise.catch((e: unknown) => e), 2_000, 'отмена');
      const elapsed = Date.now() - startedAt;

      expect(isExecutionError(err)).toBe(true);
      if (!isExecutionError(err)) return;
      expect(err.reason).toBe('aborted');
      expect(elapsed).toBeLessThan(2_000);

      // Потомок оболочки убит вместе с группой — процессов после «Стопа» нет.
      await waitProcessGone(pid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('таймаут обрывает команду быстро (reason: timeout)', async () => {
    const port = new InlineExecutionPort();
    const startedAt = Date.now();
    const err = await within(
      port
        .execute({
          command: { kind: 'shell', command: 'sleep 5', shell: 'bash' },
          timeoutMs: 200,
        })
        .catch((e: unknown) => e),
      1_500,
      'таймаут',
    );
    const elapsed = Date.now() - startedAt;

    expect(isExecutionError(err)).toBe(true);
    if (!isExecutionError(err)) return;
    expect(err.reason).toBe('timeout');
    expect(elapsed).toBeLessThan(1_500);
  });

  it('spawnBackground: stop() гасит конвейер и завершает поток вывода', async () => {
    const port = new InlineExecutionPort();
    const bg = await port.spawnBackground({
      // `cat` держит пайп: без убийства группы завершения не дождаться.
      command: { kind: 'shell', command: 'sleep 30 | cat', shell: 'bash' },
    });

    // Потребитель вывода (как в `ProcessService`/detach-пути): поток обязан
    // завершиться, иначе вызов «висит».
    const consumed = (async (): Promise<number> => {
      let bytes = 0;
      for await (const chunk of bg.output) bytes += chunk.data.length;
      return bytes;
    })();

    const startedAt = Date.now();
    bg.stop();
    const exit = await within(bg.exited, 2_000, 'exited');
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2_000);
    expect(exit.signal).not.toBeNull();
    await within(consumed, 2_000, 'поток вывода');
  });

  it('оболочка вышла, потомок держит пайп — вызов завершается, не дожидаясь close', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-exec-close-'));
    const pidFile = join(dir, 'pid');
    try {
      const port = new InlineExecutionPort();
      const startedAt = Date.now();
      // `sleep 30` наследует stdout и живёт после выхода оболочки: `close` не
      // придёт, пока он не закончит (именно это «подвешивало» `pnpm build`).
      const res = await within(
        port.execute({
          command: {
            kind: 'shell',
            command: `sleep 30 & echo $! > '${pidFile}'; printf started`,
            shell: 'bash',
          },
        }),
        3_000,
        'execute',
      );
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(res.stdout).toContain('started');
      expect(res.exitCode).toBe(0);

      // Потомок пережил оболочку (это и есть сценарий) — убираем за собой.
      const pid = Number((await readFile(pidFile, 'utf-8')).trim());
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Уже завершился — не ошибка.
      }
      await waitProcessGone(pid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('оболочка по умолчанию — bash (без явного shell)', async () => {
    const port = new InlineExecutionPort();
    // `[[ ]]` — bash-синтаксис: под dash/busybox ash команда завершилась бы
    // ошибкой 127, и тест поймал бы регрессию дефолта оболочки.
    const res = await port.execute({
      command: { kind: 'shell', command: '[[ 1 == 1 ]] && printf bash' },
    });
    expect(res.stdout).toBe('bash');
    expect(res.exitCode).toBe(0);
  });
});
