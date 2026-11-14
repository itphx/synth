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
import {
  lstat,
  readdir as fsReaddir,
  readFile as fsReadFile,
  realpath as fsRealpath,
  stat as fsStat,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { SshEnvError } from '../git/ssh-env.js';
import { warning } from '../logger.js';
import { probeBinaryThroughPort } from './probe.js';
import { materializeSecretEnv } from './secret-env.js';
import { createPtyHandle } from './pty/handle.js';
import {
  getPtyProvider,
  PTY_COLORTERM,
  PTY_TERM,
  PtyUnavailableError,
  type PtyProvider,
  type PtySession,
} from './pty/provider.js';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_SHELL_BINARY,
  EXECUTION_PTY_UNSUPPORTED_CODE,
  ExecutionError,
  FsPathError,
  fsErrorCodeFromErrno,
  type ExecBackgroundChunk,
  type ExecBackgroundExit,
  type ExecBackgroundProcess,
  type ExecCommand,
  type ExecFailureReason,
  type ExecRequest,
  type ExecResult,
  type ExecutionFs,
  type ExecutionPort,
  type FsBytesResult,
  type FsDirEntry,
  type FsErrorCode,
  type FsRawTextResult,
  type FsSniffResult,
  type FsStat,
  type FsTextOptions,
  type FsTextPage,
  type FsUploadOptions,
  type PtyHandle,
  type PtyOpenRequest,
} from './ports/index.js';
import {
  BINARY_SNIFF_BYTES,
  hashFileSha256,
  readBytesFromFile,
  readRawTextFromFile,
  readTextPageFromFile,
  sniffFileHeadFromFile,
} from './fs-text.js';
import {
  mkdirRecursive,
  removePath,
  renamePath,
  uploadBytes,
  writeTextFileAtomic,
} from './fs-atomic.js';

/** Файл и аргументы запуска для обеих форм команды. */
function resolveInvocation(command: ExecCommand): { file: string; args: string[] } {
  if (command.kind === 'shell') {
    return { file: command.shell ?? DEFAULT_SHELL_BINARY, args: ['-c', command.command] };
  }
  return { file: command.file, args: command.args ?? [] };
}

/**
 * Уточнение к тексту ошибки подготовки секретов — **только код причины**.
 *
 * Код (`env_failed`/`agent_failed`) — из закрытого набора и материала не
 * содержит; текст исходной ошибки в сообщение не попадает (в нём может быть
 * stderr внешней программы).
 */
function sshEnvErrorSuffix(err: unknown): string {
  if (err instanceof SshEnvError) return ` (${err.code})`;
  return '';
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
 * Проверка пути FS-операции: пустой путь или NUL — невалидный запрос.
 *
 * Относительные пути допускаются (контракт требует абсолютных, но запрет не
 * нужен — резолвит вызывающий тул).
 */
function requireValidFsPath(path: string): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new FsPathError('invalid', path, 'путь не задан');
  }
  if (path.includes('\0')) {
    throw new FsPathError('invalid', path, 'путь содержит недопустимые символы');
  }
  return path;
}

/**
 * errno ФС → машинный код ошибки FS-операции.
 *
 * `ENOENT` → `not_found`, `ENOTDIR` → `not_directory`, `EACCES`/`EPERM` →
 * `permission`; остальное (в т.ч. `ELOOP`) → `unresolvable` (fail-closed:
 * неизвестная причина не должна выглядеть как «путь просто не найден»).
 */
function fsErrorCode(code: string | undefined): FsErrorCode {
  return fsErrorCodeFromErrno(code);
}

/** Ошибка ФС → `FsPathError` (с сохранением текста системы). */
function toFsPathError(err: unknown, path: string): FsPathError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return new FsPathError(fsErrorCode(code), path, message);
}

/**
 * Битый симлинк (существует как ссылка, цель — нет).
 *
 * Различение нужно для `realpath`: «пути нет» (`not_found`) и «путь есть,
 * но разрешить его нельзя» (`unresolvable`) — разные причины, и вторая
 * означает потенциальный обход периметра (fail-closed).
 */
async function isDanglingSymlink(target: string): Promise<boolean> {
  try {
    const info = await lstat(target);
    return info.isSymbolicLink();
  } catch {
    // Компонент не существует вовсе — это «пути нет», а не «битый симлинк».
    return false;
  }
}

/**
 * Канонический путь (PROP-135, Ф1).
 *
 * Неразрешимый путь (битый симлинк, цикл симлинков, ошибка ФС) →
 * `unresolvable`: путь нельзя достоверно привести к реальному, а «угадывать»
 * лексический путь опасно (это и есть потенциальный обход периметра).
 */
async function inlineRealpath(path: string): Promise<string> {
  const target = requireValidFsPath(path);
  try {
    return await fsRealpath(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // Отсутствие доступа — отдельная причина.
    if (code === 'EACCES' || code === 'EPERM') {
      throw new FsPathError('permission', path, err instanceof Error ? err.message : String(err));
    }
    if (code === 'ENOENT') {
      // Ссылка есть, цели нет — путь не разрешается (fail-closed); пути нет
      // вовсе — обычный `not_found`.
      const dangling = await isDanglingSymlink(target);
      throw new FsPathError(
        dangling ? 'unresolvable' : 'not_found',
        path,
        err instanceof Error ? err.message : String(err),
      );
    }
    throw new FsPathError(
      'unresolvable',
      path,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Сведения о файле/каталоге (размер каталога — `0`). */
async function inlineStat(path: string): Promise<FsStat> {
  const target = requireValidFsPath(path);
  try {
    const info = await fsStat(target);
    const kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
    return {
      kind,
      size: kind === 'directory' ? 0 : info.size,
      mtimeMs: info.mtimeMs,
    };
  } catch (err) {
    throw toFsPathError(err, path);
  }
}

/**
 * Записи каталога — в файловом порядке (сортировка — на стороне вызывающего).
 *
 * Размер записи — из `stat` (как в прежнем листинге); если `stat` не удался —
 * `0` (вызывающий не отличит «пустой файл» от «неизвестного размера» — это
 * осознанное упрощение контракта, размер у каталога в разборе не важен).
 */
async function inlineReaddir(path: string): Promise<FsDirEntry[]> {
  const target = requireValidFsPath(path);
  let dirents;
  try {
    dirents = await fsReaddir(target, { withFileTypes: true });
  } catch (err) {
    throw toFsPathError(err, path);
  }
  const entries: FsDirEntry[] = [];
  for (const dirent of dirents) {
    const kind = dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : 'other';
    let size = 0;
    try {
      size = (await fsStat(join(target, dirent.name))).size;
    } catch {
      size = 0;
    }
    entries.push({ name: dirent.name, kind, size });
  }
  return entries;
}

/**
 * Страница текста файла (inline) — локальная ФС процесса.
 *
 * Потоковое чтение — общий модуль `execution/fs-text.ts` (тем же кодом
 * читает исполнитель, поэтому формат вывода не зависит от топологии).
 * Ошибка чтения — типизированная (`FsPathError`): вызывающий различает
 * «пути нет» и «нет доступа» без разбора текста.
 */
async function inlineReadText(path: string, opts: FsTextOptions = {}): Promise<FsTextPage> {
  const target = requireValidFsPath(path);
  try {
    return await readTextPageFromFile(target, opts);
  } catch (err) {
    throw toFsPathError(err, path);
  }
}

/**
 * Признак «бинарь» + MIME по сигнатуре (inline).
 *
 * Читается только начало файла (`maxBytes`, по умолчанию — 8 КиБ).
 */
async function inlineSniff(path: string, maxBytes?: number): Promise<FsSniffResult> {
  const target = requireValidFsPath(path);
  try {
    return await sniffFileHeadFromFile(target, maxBytes ?? BINARY_SNIFF_BYTES);
  } catch (err) {
    throw toFsPathError(err, path);
  }
}

/**
 * Байты файла (inline) — base64, с жёстким лимитом размера.
 *
 * Файл больше `maxBytes` → `FsPathError` с кодом `too_large` (файл не
 * читается вовсе: размер известен из `stat` до чтения).
 */
async function inlineReadBytes(path: string, maxBytes: number): Promise<FsBytesResult> {
  const target = requireValidFsPath(path);
  try {
    return await readBytesFromFile(target, maxBytes);
  } catch (err) {
    // `too_large` — уже типизированная ошибка порта: переводить её в
    // «unresolvable» нельзя (вызывающий различает лимит от сбоя чтения).
    if (err instanceof FsPathError) throw err;
    throw toFsPathError(err, path);
  }
}

/**
 * Запись текста в файл (inline, PROP-135 Ф2).
 *
 * Правила — **общий** модуль `execution/fs-atomic.ts`: тем же кодом пишет
 * исполнитель, поэтому записанный файл не зависит от топологии (права,
 * атомарность, симлинки). Ошибки — типизированные (`FsPathError`).
 */
async function inlineWriteFile(path: string, content: string): Promise<void> {
  const target = requireValidFsPath(path);
  await writeTextFileAtomic(target, content);
}

/** Создание каталога (inline, PROP-135 Ф2) — общий модуль `execution/fs-atomic.ts`. */
async function inlineMkdir(path: string): Promise<void> {
  const target = requireValidFsPath(path);
  await mkdirRecursive(target);
}

/** Удаление файла или пустого каталога (inline, PROP-135 Ф2). */
async function inlineRemove(path: string): Promise<void> {
  const target = requireValidFsPath(path);
  await removePath(target);
}

/**
 * Текст файла **как есть** (inline, PROP-135 Ф2) — UTF-8, без нумерации.
 *
 * Общий модуль core (`execution/fs-text.ts`): тем же кодом читает исполнитель,
 * поэтому содержимое не зависит от топологии.
 */
async function inlineReadRawText(path: string, maxBytes: number): Promise<FsRawTextResult> {
  const target = requireValidFsPath(path);
  try {
    return await readRawTextFromFile(target, maxBytes);
  } catch (err) {
    // `too_large` — уже типизированная ошибка порта: переводить её в
    // «unresolvable» нельзя (вызывающий различает лимит от сбоя чтения).
    if (err instanceof FsPathError) throw err;
    throw toFsPathError(err, path);
  }
}

/**
 * Переименование/перемещение файла (inline, PROP-135 Ф2).
 *
 * Общий модуль core (`execution/fs-atomic.ts`) — те же правила, что у
 * исполнителя (цель существует → отказ, источника нет → `not_found`).
 */
async function inlineRename(from: string, to: string): Promise<void> {
  const source = requireValidFsPath(from);
  const target = requireValidFsPath(to);
  await renamePath(source, target);
}

/**
 * Бинарная передача файла (inline, PROP-135 Ф3).
 *
 * Размер известен **до** чтения (`stat`): файл больше `maxBytes` не читается
 * вовсе — отказ `too_large` с тем же кодом, что у `readBytes`.
 */
async function inlineDownload(path: string, maxBytes: number): Promise<Buffer> {
  const target = requireValidFsPath(path);
  try {
    const info = await fsStat(target);
    if (info.size > maxBytes) {
      throw new FsPathError(
        'too_large',
        path,
        `файл больше лимита: ${info.size} байт (лимит ${maxBytes} байт)`,
      );
    }
    return await fsReadFile(target);
  } catch (err) {
    // `too_large` — уже типизированная ошибка порта: переводить её в
    // «unresolvable» нельзя (вызывающий различает лимит от сбоя чтения).
    if (err instanceof FsPathError) throw err;
    throw toFsPathError(err, path);
  }
}

/**
 * Опубликовать байты в файл (inline, PROP-135 Ф3) — общий модуль
 * `execution/fs-atomic.ts`.
 *
 * Тем же кодом пишет исполнитель, поэтому опубликованный файл не зависит от
 * топологии (атомарность, права, симлинки). Ошибки — типизированные
 * (`FsPathError`), в т.ч. `exists` (цель занята при `ifExists: 'fail'`).
 */
async function inlineUpload(
  path: string,
  bytes: Buffer,
  opts?: FsUploadOptions,
): Promise<void> {
  const target = requireValidFsPath(path);
  await uploadBytes(target, bytes, opts);
}

/**
 * SHA-256 файла (inline, PROP-135 Ф3) — общий модуль `execution/fs-text.ts`.
 *
 * Хэш считается **потоком** (файл целиком в память не поднимается); ошибки
 * чтения — типизированные (`FsPathError`).
 */
async function inlineHash(path: string): Promise<string> {
  const target = requireValidFsPath(path);
  try {
    return await hashFileSha256(target);
  } catch (err) {
    throw toFsPathError(err, path);
  }
}

/**
 * Оболочка PTY-сессии по умолчанию.
 *
 * Порядок: явный `shell` запроса → `$SHELL` окружения → `/bin/bash`. В отличие
 * от шелл-вызовов ядра (`bash` обязателен, ADR-078) здесь выбор свободен:
 * терминал запускает **интерактивную** оболочку пользователя, и `bash` — лишь
 * последний фоллбэк.
 */
const DEFAULT_PTY_SHELL = '/bin/bash';

/**
 * Переменные окружения, которые **не наследуются** PTY-сессией.
 *
 * - `NODE_CHANNEL_FD` — дескриптор канала Node IPC: в дочернем процессе он
 *   бессмысленен (и ломает `child_process`-наследование);
 * - `ARGV0` — переопределение `argv[0]`: оболочке не нужно;
 * - `BASH_ENV`/`ENV`/`BASH_XTRACEFD` — файлы, которые оболочка читает при
 *   старте (в т.ч. непечатаемый вывод `xtrace`): наследование сделало бы
 *   поведение терминала зависимым от окружения control plane;
 * - `ELECTRON_RUN_AS_NODE` — превращает Electron-приложение в Node-процесс.
 */
const PTY_ENV_BLOCKLIST: readonly string[] = [
  'NODE_CHANNEL_FD',
  'ARGV0',
  'BASH_ENV',
  'ENV',
  'BASH_XTRACEFD',
  'ELECTRON_RUN_AS_NODE',
];

/**
 * Окружение PTY-сессии: очищенное ambient + признаки терминала + `env`
 * запроса.
 *
 * `TERM`/`COLORTERM` объявляются всегда: без `TERM=xterm-256color` оболочка
 * не включает цвета, а `COLORTERM=truecolor` включает 24-битный цвет.
 */
function buildPtyEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (PTY_ENV_BLOCKLIST.includes(key)) continue;
    env[key] = value;
  }
  env.TERM = PTY_TERM;
  env.COLORTERM = PTY_COLORTERM;
  return { ...env, ...(extra ?? {}) };
}

/**
 * Рабочий каталог PTY-сессии — абсолютный путь к существующему каталогу.
 *
 * Fail-closed: каталога нет или это не каталог → отказ порта (`spawn_failed`),
 * а не запуск оболочки «где получится» (как у `execute` — тот же класс ошибки
 * `ENOENT`, что видит shell-тул).
 *
 * Периметр сессии (рабочий каталог/`allowedRoots`) проверяет **вызывающий** —
 * так же, как shell-тул (`isSymlinkEscapeInRoots`); порт о периметре не знает.
 */
async function resolvePtyCwd(cwd: string): Promise<string> {
  const target = resolve(cwd ?? '');
  let info;
  try {
    info = await fsStat(target);
  } catch {
    throw new ExecutionError({
      message: `PTY: рабочий каталог недоступен: ${target}`,
      code: 'ENOENT',
      reason: 'spawn_failed',
    });
  }
  if (!info.isDirectory()) {
    throw new ExecutionError({
      message: `PTY: рабочий каталог не является каталогом: ${target}`,
      code: 'ENOTDIR',
      reason: 'spawn_failed',
    });
  }
  return target;
}

/**
 * Опции inline-порта.
 *
 * `ptyProvider` — фабрика провайдера PTY: тесты подставляют подделку, а
 * рабочий код берёт ленивую загрузку нативного модуля (`getPtyProvider`).
 */
export interface InlineExecutionPortOptions {
  /** Фабрика провайдера PTY; не задана — ленивая загрузка нативного модуля. */
  ptyProvider?: () => Promise<PtyProvider>;
}

/**
 * Исполнение в процессе backend'а — нынешнее поведение Synth.
 *
 * Экземпляр **без состояния**: его можно создавать на каждый вызов (тулы
 * создают fallback-экземпляр, когда порт не внедрён) — процесс-глобальных
 * синглтонов не появляется (инвариант 24). Единственное состояние — кэш
 * провайдера PTY (ленивая загрузка нативного модуля), он не влияет на
 * `execute`/`spawnBackground`.
 */
export class InlineExecutionPort implements ExecutionPort {
  /** Исполнение — в процессе control plane (ADR-077). */
  readonly isRemote = false;

  /**
   * Порт умеет открывать PTY-сессии (план терминалов, Ф1).
   *
   * Признак означает «реализация PTY есть»; фактическая доступность нативного
   * модуля проверяется при вызове (`openPty` → `EPTY`).
   */
  readonly pty = true;

  /** Фабрика провайдера PTY (тесты подставляют подделку). */
  private readonly _ptyProviderFactory: () => Promise<PtyProvider>;

  /** Кэш провайдера PTY — модуль грузится лениво, один раз. */
  private _ptyProvider: PtyProvider | undefined;

  constructor(opts?: InlineExecutionPortOptions) {
    this._ptyProviderFactory = opts?.ptyProvider ?? getPtyProvider;
  }

  /**
   * FS-операции — локальная файловая система процесса (PROP-135, Ф1).
   *
   * Inline-реализация **всегда** умеет FS: файлы лежат рядом с control plane,
   * отдельного контура нет. То же самое касается удалённого режима: там FS
   * уезжает на исполнителя (`features.fs`).
   */
  readonly fs: ExecutionFs = {
    realpath: (path: string) => inlineRealpath(path),
    stat: (path: string) => inlineStat(path),
    readdir: (path: string) => inlineReaddir(path),
    readText: (path: string, opts?: FsTextOptions) => inlineReadText(path, opts),
    sniff: (path: string, maxBytes?: number) => inlineSniff(path, maxBytes),
    readBytes: (path: string, maxBytes: number) => inlineReadBytes(path, maxBytes),
    writeFile: (path: string, content: string) => inlineWriteFile(path, content),
    mkdir: (path: string) => inlineMkdir(path),
    remove: (path: string) => inlineRemove(path),
    readRawText: (path: string, maxBytes: number) => inlineReadRawText(path, maxBytes),
    rename: (from: string, to: string) => inlineRename(from, to),
    download: (path: string, maxBytes: number) => inlineDownload(path, maxBytes),
    upload: (path: string, bytes: Buffer, opts?: FsUploadOptions) =>
      inlineUpload(path, bytes, opts),
    hash: (path: string) => inlineHash(path),
  };

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
   * Открытие PTY-сессии в процессе control plane (план терминалов, Ф1).
   *
   * Отличия от `execute`:
   *
   * - оболочка запускается **интерактивно** (`shell` → `$SHELL` → `/bin/bash`),
   *   ввод идёт через `PtyHandle.write`, вывод — через `onData`;
   * - окружение — очищенное ambient (см. `PTY_ENV_BLOCKLIST`) + `TERM`/
   *   `COLORTERM` + `env` запроса;
   * - `cwd` — абсолютный путь к существующему каталогу (fail-closed);
   * - недоступность нативного модуля — **понятная ошибка порта**
   *   (`code: 'EPTY'`, `reason: 'dependency_missing'`), а не падение процесса.
   *
   * `execute`/`spawnBackground` этим методом **не затронуты**.
   */
  async openPty(req: PtyOpenRequest): Promise<PtyHandle> {
    const startedAt = Date.now();
    const provider = await this._resolvePtyProvider(startedAt);
    const shell = req.shell?.trim() || process.env.SHELL?.trim() || DEFAULT_PTY_SHELL;
    const cwd = await resolvePtyCwd(req.cwd);
    const env = buildPtyEnv(req.env);

    let session: PtySession;
    try {
      session = provider.spawn({
        shell,
        args: req.args ?? [],
        cwd,
        cols: req.cols,
        rows: req.rows,
        env,
      });
    } catch (err) {
      // Неудача запуска (нет бинаря оболочки, неверный `cwd`) — тот же класс
      // ошибки, что у `execute` (`spawn_failed`), чтобы вызывающий различал
      // «не запустилось» и «упало с кодом».
      throw new ExecutionError({
        message: err instanceof Error ? err.message : String(err),
        code: (err as NodeJS.ErrnoException | undefined)?.code ?? null,
        reason: 'spawn_failed',
        durationMs: Date.now() - startedAt,
      });
    }

    return createPtyHandle(session, `pty_${randomUUID()}`);
  }

  /**
   * Провайдер PTY (ленивая загрузка нативного модуля, кэш на экземпляр).
   *
   * Отсутствие модуля — `ExecutionError` с `code: 'EPTY'` и
   * `reason: 'dependency_missing'` (слой доступности превращает его в
   * `unavailable(dependency)`).
   */
  private async _resolvePtyProvider(startedAt: number): Promise<PtyProvider> {
    try {
      this._ptyProvider ??= await this._ptyProviderFactory();
      return this._ptyProvider;
    } catch (err) {
      const message =
        err instanceof PtyUnavailableError
          ? err.message
          : `PTY недоступен: ${err instanceof Error ? err.message : String(err)}`;
      throw new ExecutionError({
        message,
        code: EXECUTION_PTY_UNSUPPORTED_CODE,
        reason: 'dependency_missing',
        durationMs: Date.now() - startedAt,
      });
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
    const startedAt = Date.now();
    const { file, args } = resolveInvocation(req.command);
    // PROP-124 §7 (протокол 6): секреты вызова в фоне **поддерживаются** —
    // материал готовится здесь (как в `execute`) и гасится **вместе с
    // процессом**: выход, `stop()`, таймаут. Ключ в режиме `agent` живёт в
    // памяти ssh-агента, а агент **не** входит в группу процессов команды —
    // поэтому очистка явная и гарантированная (идемпотентная), а не «по
    // факту выхода».
    const secrets = req.secrets && req.secrets.length > 0 ? req.secrets : undefined;
    let materialized: Awaited<ReturnType<typeof materializeSecretEnv>> | undefined;
    if (secrets) {
      try {
        materialized = await materializeSecretEnv(secrets);
      } catch (err) {
        // Подготовка материала не удалась (нет `ssh-agent`, битый ключ, сбой FS) —
        // процесс не запускаем: «тихо» выполнить команду без ключа нельзя.
        // Ошибка — **типовая** порта (`ExecutionError`, `reason: 'spawn_failed'`),
        // как и остальные сбои запуска; текст — без материала.
        throw new ExecutionError({
          message: `Не удалось подготовить секреты вызова для фонового запуска${sshEnvErrorSuffix(err)}`,
          code: null,
          reason: 'spawn_failed',
          durationMs: Date.now() - startedAt,
        });
      }
    }
    // Очистка материала — **одна** на весь фоновый процесс: все точки
    // (выход, `stop()`, таймаут) ждут один и тот же промис, поэтому к моменту
    // резолва `exited` материал уже убран. Идемпотентна.
    let cleanupPromise: Promise<void> | undefined;
    const cleanupMaterial = async (): Promise<void> => {
      cleanupPromise ??= (async () => {
        await materialized?.cleanup().catch(() => {});
      })();
      await cleanupPromise;
    };
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: req.cwd,
        // Базовое окружение — всё `process.env`; `env` запроса мержится поверх;
        // окружение секретов — поверх `env` (материал доставлен явно для этой
        // команды, он важнее ambient-значений).
        env: { ...process.env, ...(req.env ?? {}), ...(materialized?.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Своя группа процессов (POSIX): `stop`/таймаут должны гасить всё
        // дерево, а не только прямого ребёнка — иначе форкнутая оболочкой
        // команда остаётся жить и держит пайпы. На Windows групп процессов в
        // таком виде нет — там остаётся прямое убийство ребёнка.
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      // Неудача запуска (неверный `cwd` и т. п.) — материал убираем сразу:
      // процесса, который им пользовался, не будет.
      await cleanupMaterial();
      throw err;
    }

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
        void drainOutputStreams(child, EXIT_DRAIN_MS).then(async () => {
          output.close();
          // Материал гасится **до** резолва `exited`: когда хэндл сообщил о
          // выходе процесса, ключа (и агента) в среде уже нет.
          await cleanupMaterial();
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
      // Процесса не будет — материал убираем сразу.
      void cleanupMaterial().then(() => {
        resolveExited({
          exitCode: typeof errno === 'number' ? errno : -1,
          signal: null,
          durationMs: Date.now() - startedAt,
        });
      });
    });

    const timeoutMs = req.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        // Материал гасится вместе с процессом: ключ не переживает остановку
        // по таймауту.
        void cleanupMaterial();
        killProcessTree(child, 'SIGTERM');
        killTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), BACKGROUND_KILL_GRACE_MS);
        killTimer.unref?.();
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    const stop = (signal: NodeJS.Signals = 'SIGTERM'): void => {
      // Материал гасится **всегда**: остановленный процесс не должен
      // продолжать пользоваться ключом (иначе ключ пережил бы «стоп»).
      // Очистка идемпотентна — повторный вызов безопасен.
      void cleanupMaterial();
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
