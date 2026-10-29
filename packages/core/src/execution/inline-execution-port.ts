/**
 * Inline-реализация порта исполнения (ADR-077, шаг 1) — исполнение в процессе.
 *
 * История: раньше это был `execFile`, который ждёт `close` (закрытия обоих
 * потоков). Для shell-формы этого мало: оболочка форкает команду (`pnpm`,
 * `tsc`, `node`, `cat`), потомки наследуют её пайпы, и `close` не приходит,
 * пока жив хоть один внук. «Стоп» при этом убивал только `bash`, а команда
 * продолжала работать и держать stdio — тул «висел» до её естественного
 * завершения.
 *
 * Теперь семантика такая:
 *
 *   - тот же бинарь и те же аргументы (`<shell> -c <команда>` либо `<file> <args…>`);
 *   - тот же лимит буфера вывода (`maxOutputBytes`, по умолчанию 10 МБ) —
 *     превышение обрывает команду и даёт `reason: 'max_output'`;
 *   - то же окружение: **всё** `process.env` + мердж переданного `env`
 *     (переменная с тем же именем перекрывает базовую);
 *   - тот же таймаут и тот же сигнал отмены;
 *   - те же поля ошибки (`reason`/`code`/`stdout`/`stderr`/`killed`/`signal`)
 *     и те же тексты («Command failed: …»), поэтому потребители не меняются.
 *
 * Отличия от прежнего кода (осознанные):
 *
 *   - процесс — **лидер собственной группы** (`detached: true`): «Стоп» и
 *     таймаут гасят группу (`kill(-pid)` → `SIGTERM`, через 5 с `SIGKILL`),
 *     а не только прямого ребёнка. Потомков после остановки не остаётся.
 *     На Windows групп процессов в таком виде нет — там убивается только
 *     ребёнок (тесты гоняются на Linux);
 *   - завершение определяется по `exit`, а не по `close`: после `exit` —
 *     короткий дренаж потоков (250 мс), затем потоки уничтожаются. Ждать
 *     `close` нельзя: его не будет, пока пайп держит внук;
 *   - `stdin` команды — `/dev/null` (`ignore`), а не открытый пайп: порт
 *     обслуживает только неинтерактивные команды (`ExecRequest` поля `stdin`
 *     не имеет), и незакрытый пайп заставлял бы `cat` без аргументов висеть.
 *
 * Отличие от прежнего кода по типу ошибки — только одно: ошибка процесса
 * **типизирована** (`ExecutionError` с полем `reason`), а не «сырой» объект
 * `execFile`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { warning } from '../logger.js';
import { probeBinaryThroughPort } from './probe.js';
import { materializeSecretEnv } from './secret-env.js';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_SHELL_BINARY,
  EXECUTION_SECRETS_UNSUPPORTED_CODE,
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

/** Файл и аргументы запуска для обеих форм команды. */
function resolveInvocation(command: ExecCommand): { file: string; args: string[] } {
  if (command.kind === 'shell') {
    return { file: command.shell ?? DEFAULT_SHELL_BINARY, args: ['-c', command.command] };
  }
  return { file: command.file, args: command.args ?? [] };
}

/**
 * Пауза между «мягким» и «жёстким» убийством процесса/его группы:
 * `SIGTERM` → (через 5 с) `SIGKILL`.
 */
const BACKGROUND_KILL_GRACE_MS = 5_000;

/**
 * Предел дренажа потоков после `exit`.
 *
 * После выхода процесса в пайпах может остаться уже прочитанный, но ещё не
 * доставленный хвост вывода. Ждём конца потоков, но не дольше этого предела:
 * иначе внук, унаследовавший пайп, снова «подвесил» бы вызов.
 */
const EXIT_DRAIN_MS = 250;

/**
 * Потоки вывода процесса (только реально открытые).
 *
 * `ChildProcess.stdout`/`stderr` — `null` при `stdio: 'ignore'`/`'inherit'`;
 * у нас всегда `pipe`, но тип обязывает фильтровать.
 */
function outputStreams(child: ChildProcess): Readable[] {
  return [child.stdout, child.stderr].filter((stream): stream is Readable => stream !== null);
}

/**
 * Отправить сигнал процессу **и его потомкам**.
 *
 * POSIX: ребёнок запускается лидером собственной группы (`detached: true`),
 * поэтому `kill(-pid)` достаёт всё дерево. Иначе сигнал получает только
 * оболочка, а форкнутая ею команда остаётся жить и держит пайпы — `close`
 * не приходит, и вызов «висит» до конца команды. Если группы уже нет
 * (процесс завершился, `ESRCH`) — падаем на прямое убийство ребёнка.
 *
 * Windows: групп процессов в таком виде нет (`process.kill(-pid)` не
 * поддерживается) — там остаётся прямое убийство.
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (process.platform !== 'win32' && pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Группы нет (ESRCH) или pid не лидер — ниже пробуем прямое убийство.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Процесс уже завершён (или сигнал недопустим) — повтор/гонка не ошибка.
  }
}

/** Дождаться конца потоков вывода (не дольше `timeoutMs`). */
function drainOutputStreams(child: ChildProcess, timeoutMs: number): Promise<void> {
  const streams = outputStreams(child);
  if (streams.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let remaining = streams.length;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    for (const stream of streams) {
      if (stream.readableEnded || stream.destroyed) {
        remaining -= 1;
        continue;
      }
      // Ошибка потока трактуется как его конец: ожидание не должно зависнуть.
      stream.once('end', () => {
        remaining -= 1;
        if (remaining <= 0) finish();
      });
      stream.once('error', () => {
        remaining -= 1;
        if (remaining <= 0) finish();
      });
    }
    if (remaining <= 0) finish();
  });
}

/**
 * Уничтожить потоки вывода.
 *
 * Нужно после дренажа: если пайп унаследовал живой внук, дескриптор иначе
 * остаётся открытым у нас, а `close` не приходит никогда.
 */
function destroyOutputStreams(child: ChildProcess): void {
  for (const stream of outputStreams(child)) stream.destroy();
}

/** Собранный вывод одного потока (с лимитом порта). */
interface CollectedOutput {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

/** Создать пустой буфер потока. */
function createCollectedOutput(): CollectedOutput {
  return { chunks: [], bytes: 0, truncated: false };
}

/**
 * Дописать кусок в буфер, не превышая лимит порта.
 *
 * @returns `true` — кусок упёрся в лимит (вывод обрезан, лишнее отброшено).
 */
function appendCollected(target: CollectedOutput, chunk: Buffer, maxBytes: number): boolean {
  if (target.truncated) return false;
  const room = maxBytes - target.bytes;
  if (room <= 0) {
    target.truncated = true;
    return true;
  }
  if (chunk.length > room) {
    target.chunks.push(chunk.subarray(0, room));
    target.bytes = maxBytes;
    target.truncated = true;
    return true;
  }
  target.chunks.push(chunk);
  target.bytes += chunk.length;
  return false;
}

/** Текст собранного вывода. */
function collectedText(target: CollectedOutput): string {
  return Buffer.concat(target.chunks).toString('utf-8');
}

/** Текст ошибки «превышен лимит вывода» — как у `execFile` (`maxBuffer`). */
const MAX_OUTPUT_MESSAGE = 'stdout maxBuffer length exceeded';

/** Причина обрыва команды портом (не по её собственному коду выхода). */
type StopReason = 'timeout' | 'aborted' | 'max_output';

/** Текст ошибки обрыва (сохраняем прежние тексты `execFile`/`AbortError`). */
function stopMessage(reason: StopReason, label: string, stderr: string): string {
  if (reason === 'aborted') return 'The operation was aborted';
  if (reason === 'max_output') return MAX_OUTPUT_MESSAGE;
  return `Command failed: ${label}\n${stderr}`;
}

/** Код ошибки обрыва (как у `execFile`/`AbortSignal`). */
function stopCode(reason: StopReason): string | null {
  if (reason === 'aborted') return 'ABORT_ERR';
  if (reason === 'max_output') return 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  return null;
}

/**
 * Выполнить команду через `spawn` и дождаться `exit` (+ короткий дренаж).
 *
 * Промис разрешается/отклоняется один раз: исход определяет либо `exit`,
 * либо неудача запуска (`error`). Обрыв по «Стопу», таймауту или лимиту
 * вывода фиксируется как `failure` и превращается в `ExecutionError` в
 * момент завершения.
 */
function runCommand(
  file: string,
  args: string[],
  req: ExecRequest,
  env: NodeJS.ProcessEnv,
  startedAt: number,
): Promise<ExecResult> {
  const label = [file, ...args].join(' ');
  const maxBytes = req.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    // Отмена до запуска: процесс не создаём вовсе (как `execFile` с сигналом).
    if (req.signal?.aborted === true) {
      reject(
        new ExecutionError({
          message: stopMessage('aborted', label, ''),
          code: stopCode('aborted'),
          reason: 'aborted',
          killed: true,
          durationMs: Date.now() - startedAt,
        }),
      );
      return;
    }

    const child = spawn(file, args, {
      cwd: req.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Лидер собственной группы (POSIX): «Стоп»/таймаут/лимит гасят всё
      // дерево процессов, а не только оболочку (см. `killProcessTree`).
      detached: process.platform !== 'win32',
    });

    const stdout = createCollectedOutput();
    const stderr = createCollectedOutput();
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let failure: StopReason | null = null;
    let killed = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    const removeAbortListener = (): void => {
      req.signal?.removeEventListener('abort', onAbort);
    };

    /** Обрыв команды портом: группа получает `SIGTERM`, через 5 с — `SIGKILL`. */
    const terminate = (reason: StopReason): void => {
      // Процесс уже вышел (или уже обрывается) — сигнал не нужен: pid мог быть
      // переиспользован, а группа — распущена.
      if (settled || exit !== null || failure !== null) return;
      failure = reason;
      killed = true;
      killProcessTree(child, 'SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), BACKGROUND_KILL_GRACE_MS);
        killTimer.unref?.();
      }
    };

    const onAbort = (): void => terminate('aborted');

    /** Собрать исход: результат либо типизированная ошибка. */
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      removeAbortListener();

      const stdoutText = collectedText(stdout);
      const stderrText = collectedText(stderr);
      const truncated = stdout.truncated || stderr.truncated;
      // Лимит мог быть превышен уже после выхода процесса (хвост в пайпе) —
      // это тот же исход `max_output`, что и при живом процессе.
      const reason: StopReason | null = failure ?? (truncated ? 'max_output' : null);
      const durationMs = Date.now() - startedAt;
      const signal = exit?.signal ?? null;

      if (reason !== null) {
        reject(
          new ExecutionError({
            message: stopMessage(reason, label, stderrText),
            code: stopCode(reason),
            stdout: stdoutText,
            stderr: stderrText,
            killed,
            signal,
            reason,
            truncated: reason === 'max_output',
            durationMs,
          }),
        );
        return;
      }

      if (exit === null || exit.code !== 0) {
        const failureReason: ExecFailureReason =
          exit !== null && typeof exit.code === 'number' ? 'nonzero_exit' : 'spawn_failed';
        reject(
          new ExecutionError({
            message: `Command failed: ${label}\n${stderrText}`,
            code: exit?.code ?? null,
            stdout: stdoutText,
            stderr: stderrText,
            killed,
            signal,
            reason: failureReason,
            durationMs,
          }),
        );
        return;
      }

      resolve({ stdout: stdoutText, stderr: stderrText, exitCode: 0, truncated, durationMs });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (appendCollected(stdout, chunk, maxBytes)) terminate('max_output');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (appendCollected(stderr, chunk, maxBytes)) terminate('max_output');
    });
    // Ошибка потока (EPIPE и т. п.) не должна становиться непойманной: исход
    // вызова определяет `exit`, а не сбой чтения.
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    // Неудача запуска (нет бинарника, неверный `cwd`, EACCES) — событие
    // `error`; после неё `exit` может не прийти вовсе.
    child.once('error', (err: Error) => {
      if (settled || exit !== null) return;
      settled = true;
      clearTimers();
      removeAbortListener();
      destroyOutputStreams(child);
      reject(
        new ExecutionError({
          message: err.message,
          code: (err as NodeJS.ErrnoException).code ?? null,
          stdout: collectedText(stdout),
          stderr: collectedText(stderr),
          reason: 'spawn_failed',
          durationMs: Date.now() - startedAt,
        }),
      );
    });

    // Завершение — по `exit` (не по `close`): `close` не придёт, пока пайп
    // держит внук. После `exit` — короткий дренаж, затем потоки уничтожаются.
    child.once('exit', (code, signal) => {
      exit = { code: code ?? null, signal: signal ?? null };
      // Группа уже завершилась — эскалация `SIGKILL` не нужна.
      clearTimers();
      void drainOutputStreams(child, EXIT_DRAIN_MS).then(() => {
        destroyOutputStreams(child);
        settle();
      });
    });

    const timeoutMs = req.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs);
      timeoutTimer.unref?.();
    }

    req.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Поток вывода фонового процесса — очередь кусков + сигнал о завершении.
 *
 * Куски `stdout`/`stderr` складываются в очередь и отдаются потребителю по
 * мере поступления; поток закрывается вместе с процессом: `close()` вызывает
 * порт после `exit` и дренажа (событие `close` не годится — его не будет,
 * пока пайп держит внук).
 *
 * Ограничение: пока поток не читают, куски копятся в памяти. Фоновый процесс
 * пишет лог по мере поступления, поэтому очередь короткая; контракт порта
 * лимита на объём фонового вывода не задаёт (в отличие от `maxOutputBytes`
 * у синхронного `execute`).
 */
function createBackgroundOutput(child: ChildProcess): {
  [Symbol.asyncIterator](): AsyncIterator<ExecBackgroundChunk>;
  close(): void;
} {
  const queue: ExecBackgroundChunk[] = [];
  let notify: (() => void) | null = null;
  let closed = false;

  /** Разбудить потребителя (данные пришли или процесс завершился). */
  const wake = (): void => {
    const resolveNotify = notify;
    notify = null;
    resolveNotify?.();
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    queue.push({ stream: 'stdout', data: chunk.toString('utf-8') });
    wake();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    queue.push({ stream: 'stderr', data: chunk.toString('utf-8') });
    wake();
  });
  // Ошибка потока трактуется как конец чтения — потребитель не должен висеть.
  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});

  /** Закрыть поток: очередь дочитывается, затем итератор завершается. */
  const close = (): void => {
    if (closed) return;
    closed = true;
    destroyOutputStreams(child);
    wake();
  };

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
    close,
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
  /** Исполнение — в процессе control plane (ADR-077). */
  readonly isRemote = false;

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
    // ADR-077 (протокол 4): секреты вызова материализуются **здесь** — временный
    // ключ `0600` в каталоге `0700`; очистка — гарантированно (успех, ошибка
    // команды, таймаут, отмена, неудача запуска).
    const secrets = req.secrets && req.secrets.length > 0 ? req.secrets : undefined;
    const materialized = secrets ? await materializeSecretEnv(secrets) : undefined;
    // Базовое окружение — всё `process.env`; `env` запроса мержится поверх,
    // окружение секретов — поверх `env` (материал доставлен явно для этой
    // команды, он важнее ambient-значений).
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(req.env ?? {}),
      ...(materialized?.env ?? {}),
    };
    try {
      return await runCommand(file, args, req, env, startedAt);
    } finally {
      await materialized?.cleanup().catch(() => {});
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
   * - `timeoutMs > 0` — таймер, убивающий **группу** процессов (`SIGTERM`,
   *   затем `SIGKILL` через 5 с); в `exited` это видно по `signal`;
   * - `stop(signal)` гасит группу (`kill(-pid)`), а не только оболочку:
   *   потомки shell-формы не должны переживать остановку;
   * - `exited` разрешается по `exit` (+ дренаж), а не по `close`.
   *
   * Таймеры фонового процесса — `unref`: они не держат event loop, поэтому
   * процесс control plane не «зависает» из-за фоновой команды.
   */
  async spawnBackground(req: ExecRequest): Promise<ExecBackgroundProcess> {
    // ADR-077 (протокол 4): секреты вызова **не поддерживаются** в фоне —
    // процесс переживает вызов, а материал доставляется «на время вызова».
    // Fail-closed: «тихо» запустить процесс без ключа нельзя.
    if (req.secrets && req.secrets.length > 0) {
      throw new ExecutionError({
        message: 'секреты вызова не поддерживаются для фоновых процессов',
        code: EXECUTION_SECRETS_UNSUPPORTED_CODE,
        reason: 'spawn_failed',
      });
    }
    const startedAt = Date.now();
    const { file, args } = resolveInvocation(req.command);
    const child = spawn(file, args, {
      cwd: req.cwd,
      // Базовое окружение — всё `process.env`; `env` запроса мержится поверх.
      env: { ...process.env, ...(req.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Своя группа процессов (POSIX): `stop`/таймаут должны гасить всё
      // дерево, а не только прямого ребёнка — иначе форкнутая оболочкой
      // команда остаётся жить и держит пайпы. На Windows групп процессов в
      // таком виде нет — там остаётся прямое убийство ребёнка.
      detached: process.platform !== 'win32',
    });

    let timeoutTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    // Процесс вышел (или не запустился): группа распущена, сигналы больше не
    // шлём (pid мог быть переиспользован).
    let finished = false;

    const clearTimers = (): void => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const output = createBackgroundOutput(child);

    let resolveExited!: (exit: ExecBackgroundExit) => void;
    const exited = new Promise<ExecBackgroundExit>((resolve) => {
      resolveExited = resolve;
      // Резолв — по `exit`, не по `close`: `close` не придёт, пока пайп
      // держит внук (именно так «Стоп» раньше не завершал вызов).
      child.once('exit', (code, signal) => {
        finished = true;
        clearTimers();
        void drainOutputStreams(child, EXIT_DRAIN_MS).then(() => {
          output.close();
          resolve({
            exitCode: code ?? null,
            signal: signal ?? null,
            durationMs: Date.now() - startedAt,
          });
        });
      });
    });

    // Неудача запуска (нет бинарника, неверный `cwd`) приходит событием
    // 'error'; без подписки Node бросает её как непойманную. `exit` после
    // такой ошибки может не прийти вовсе, поэтому `exited` разрешается здесь
    // же: `pid` не задан, а `exitCode` — отрицательный код libuv (например
    // `-2` для ENOENT), как и раньше.
    child.on('error', (err: Error) => {
      warning('EXECUTION', `Фоновый процесс не запущен (${err.message})`);
      if (finished) return;
      finished = true;
      clearTimers();
      output.close();
      const errno = (err as NodeJS.ErrnoException).errno;
      resolveExited({
        exitCode: typeof errno === 'number' ? errno : -1,
        signal: null,
        durationMs: Date.now() - startedAt,
      });
    });

    const timeoutMs = req.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        killProcessTree(child, 'SIGTERM');
        killTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), BACKGROUND_KILL_GRACE_MS);
        killTimer.unref?.();
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    const stop = (signal: NodeJS.Signals = 'SIGTERM'): void => {
      if (finished) return;
      // Группа целиком; `ESRCH`/завершённый процесс — не ошибка (`stop()`
      // не бросает: повторный вызов и гонка с завершением — норма).
      killProcessTree(child, signal);
    };

    return {
      processId: `proc_${randomUUID()}`,
      pid: child.pid ?? undefined,
      output,
      exited,
      stop,
    };
  }
}
