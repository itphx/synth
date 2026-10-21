/**
 * Inline-реализация порта исполнения (PROP-077, шаг 1) — исполнение в
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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_SHELL_BINARY,
  ExecutionError,
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
    name: e.name,
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
 * Исполнение в процессе backend'а — нынешнее поведение Synth.
 *
 * Экземпляр **без состояния**: его можно создавать на каждый вызов (тулы
 * создают fallback-экземпляр, когда порт не внедрён) — процесс-глобальных
 * синглтонов не появляется (инвариант 24).
 */
export class InlineExecutionPort implements ExecutionPort {
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
}
