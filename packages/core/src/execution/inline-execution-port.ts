/**
 * Inline-реализация порта исполнения (ADR-077, шаг 1) — исполнение в
 * процессе, поверх нынешних `execFile`.
 *
 * Поведение совпадает с прежним «ручным» вызовом `execFile`:
 *   - тот же бинарь и те же аргументы (`sh -c <команда>` либо `<file> <args…>`);
 *   - тот же лимит буфера вывода (10 МБ — `maxBuffer`);
 *   - то же окружение: **всё** `process.env` + мердж переданного `env`
 *     (переменная с тем же именем перекрывает базовую);
 *   - тот же таймаут и тот же сигнал отмены;
 *   - те же поля ошибки (`code`/`stdout`/`stderr`/`killed`/`message`) — они
 *     приходят в `ExecutionError` без изменения текстов.
 *
 * Отличие от прежнего кода — только одно: ошибка процесса теперь **типизирована**
 * (`ExecutionError` с полем `reason`), а не «сырой» объект `execFile`.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { warning } from '../logger.js';
import { probeBinaryThroughPort } from './probe.js';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_SHELL_BINARY,
  ExecutionError,
  type ExecBackgroundChunk,
  type ExecBackgroundExit,
  type ExecBackgroundProcess,
  type ExecCommand,
  type ExecFailureReason,
  type ExecRequest,
  type ExecResult,
  type ExecutionPort,
} from './ports/index.js';

const execFileAsync = promisify(execFile);

/** Файл и аргументы запуска для обеих форм команды. */
function resolveInvocation(command: ExecCommand): { file: string; args: string[] } {
  if (command.kind === 'shell') {
    return { file: command.shell ?? DEFAULT_SHELL_BINARY, args: ['-c', command.command] };
  }
  return { file: command.file, args: command.args ?? [] };
}

/** Классификация неудачи — по полям ошибки `execFile`. */
function classifyFailure(err: {
  name?: string;
  code?: string | number | null;
  killed?: boolean;
}): ExecFailureReason {
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return 'aborted';
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'max_output';
  if (err.code === 'ENOENT') return 'spawn_failed';
  if (err.killed === true) return 'timeout';
  if (typeof err.code === 'number') return 'nonzero_exit';
  return 'spawn_failed';
}

/** Ошибка `execFile` → типизированная `ExecutionError` (тексты сохраняются). */
function toExecutionError(err: unknown, durationMs: number): ExecutionError {
  const e = (err ?? {}) as {
    name?: string;
    message?: string;
    code?: string | number | null;
    stdout?: string;
    stderr?: string;
    killed?: boolean;
    signal?: string | null;
  };
  const reason = classifyFailure(e);
  return new ExecutionError({
    message: e.message ?? '',
    code: e.code,
    stdout: e.stdout,
    stderr: e.stderr,
    killed: e.killed,
    signal: e.signal,
    reason,
    truncated: reason === 'max_output',
    durationMs,
  });
}

/**
 * Пауза между «мягким» и «жёстким» убийством фонового процесса:
 * `SIGTERM` → (через 5 с) `SIGKILL`.
 */
const BACKGROUND_KILL_GRACE_MS = 5_000;

/**
 * Поток вывода фонового процесса — очередь кусков + сигнал о завершении.
 *
 * Куски `stdout`/`stderr` складываются в очередь и отдаются потребителю по
 * мере поступления; поток закрывается вместе с процессом (событие `close` —
 * оно приходит после закрытия обоих потоков, поэтому последний кусок не
 * теряется).
 *
 * Ограничение: пока поток не читают, куски копятся в памяти. Фоновый процесс
 * пишет лог по мере поступления, поэтому очередь короткая; контракт порта
 * лимита на объём фонового вывода не задаёт (в отличие от `maxOutputBytes`
 * у синхронного `execute`).
 */
function createBackgroundOutput(child: ChildProcess): AsyncIterable<ExecBackgroundChunk> {
  const queue: ExecBackgroundChunk[] = [];
  let notify: (() => void) | null = null;
  let closed = false;

  /** Разбудить потребителя (данные пришли или процесс завершился). */
  const wake = (): void => {
    const resolve = notify;
    notify = null;
    resolve?.();
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    queue.push({ stream: 'stdout', data: chunk.toString('utf-8') });
    wake();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    queue.push({ stream: 'stderr', data: chunk.toString('utf-8') });
    wake();
  });
  child.once('close', () => {
    closed = true;
    wake();
  });

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<ExecBackgroundChunk> {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift() as ExecBackgroundChunk;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
  };
}

/**
 * Исполнение в процессе backend'а — нынешнее поведение Synth.
 *
 * Экземпляр **без состояния**: его можно создавать на каждый вызов (тулы
 * создают fallback-экземпляр, когда порт не внедрён) — процесс-глобальных
 * синглтонов не появляется (инвариант 24).
 */
export class InlineExecutionPort implements ExecutionPort {
  /**
   * ADR-077/ADR-078: наличие программы в окружении исполнения.
   *
   * У inline-порта окружение — процесс control plane, поэтому проба та же,
   * что и до появления порта: `bin --version`; `ENOENT` → программы нет,
   * прочие ошибки → fail-open (программа, скорее всего, есть).
   */
  async probe(bin: string, args?: string[]): Promise<boolean> {
    return probeBinaryThroughPort(this, bin, args);
  }

  async execute(req: ExecRequest): Promise<ExecResult> {
    const startedAt = Date.now();
    const { file, args } = resolveInvocation(req.command);
    try {
      const { stdout, stderr } = await execFileAsync(file, args, {
        cwd: req.cwd,
        timeout: req.timeoutMs,
        signal: req.signal,
        maxBuffer: req.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        // Базовое окружение — всё `process.env`; `env` запроса мержится поверх.
        env: { ...process.env, ...(req.env ?? {}) },
      });
      return {
        stdout,
        stderr,
        exitCode: 0,
        truncated: false,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      throw toExecutionError(err, Date.now() - startedAt);
    }
  }

  /**
   * Фоновый запуск команды (PROP-097) — исполнение в процессе control plane.
   *
   * Отличия от `execute` (портовый контракт — `ExecutionPort.spawnBackground`):
   *
   * - процесс **не ждёт** завершения: хэндл отдаётся сразу, результат — в
   *   `exited`, вывод — в потоке `output`;
   * - `requires` не проверяется (проверка бинарных требований — на слое тула,
   *   как и в `execute`), `signal` запроса не поддерживается (отмена — через
   *   `stop()`), `maxOutputBytes` не применяется (вывод стримится);
   * - `timeoutMs > 0` — таймер, убивающий процесс (`SIGTERM`, затем `SIGKILL`
   *   через 5 с); в `exited` это видно по `signal`.
   *
   * Таймеры фонового процесса — `unref`: они не держат event loop, поэтому
   * процесс control plane не «зависает» из-за фоновой команды.
   */
  async spawnBackground(req: ExecRequest): Promise<ExecBackgroundProcess> {
    const startedAt = Date.now();
    const { file, args } = resolveInvocation(req.command);
    const child = spawn(file, args, {
      cwd: req.cwd,
      // Базовое окружение — всё `process.env`; `env` запроса мержится поверх.
      env: { ...process.env, ...(req.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Фоновый процесс — ребёнок control plane, а не отдельная группа:
      // он не должен переживать завершение родителя «сам по себе».
      detached: false,
    });

    // Неудача запуска (нет бинарника, неверный `cwd`) приходит событием
    // 'error'; без подписки Node бросает её как непойманную. Отдельного поля
    // для ошибки в контракте нет — неудача видна в `exited`: `pid` не задан,
    // а `exitCode` — отрицательный код libuv (например `-2` для ENOENT).
    child.on('error', (err: Error) => {
      warning('EXECUTION', `Фоновый процесс не запущен (${err.message})`);
    });

    let timeoutTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const exited = new Promise<ExecBackgroundExit>((resolve) => {
      child.once('close', (code, signal) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve({
          exitCode: code ?? null,
          signal: signal ?? null,
          durationMs: Date.now() - startedAt,
        });
      });
    });

    const timeoutMs = req.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), BACKGROUND_KILL_GRACE_MS);
        killTimer.unref?.();
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    const stop = (signal: NodeJS.Signals = 'SIGTERM'): void => {
      try {
        child.kill(signal);
      } catch {
        // Процесс уже завершён (или сигнал недопустим) — `stop()` не бросает:
        // повторный вызов и гонка с завершением — норма.
      }
    };

    return {
      processId: `proc_${randomUUID()}`,
      pid: child.pid ?? undefined,
      output: createBackgroundOutput(child),
      exited,
      stop,
    };
  }
}
