/**
 * Слой исполнения команд исполнителя (PROP-077, шаг 7a).
 *
 * Отвечает за три вещи, которые делают удалённый исполнитель **эквивалентом**
 * inline-режима:
 *
 * 1. **Семантика исполнения** — команды выполняет `InlineExecutionPort` из
 *    `@itphx/synth-core` (тот же бинарь, тот же `sh -c`, тот же лимит буфера,
 *    тот же таймаут, те же поля ошибки). Свою реализацию `execFile` здесь не
 *    пишем — иначе remote и inline разойдутся по текстам, которые видит модель.
 * 2. **Containment** — `cwd` обязан лежать внутри корня workspace
 *    исполнителя (`workspace.ts`), иначе команда не запускается вовсе.
 * 3. **Лимиты** — потолок таймаута и буфера вывода, лимит одновременных команд.
 *
 * Ограничения исполнителя **жёстче** запроса: клиент может попросить больше,
 * но потолок исполнителя — final (fail-closed): исполнитель не доверяет
 * заявленным лимитам клиента.
 */

import type { ExecutionPort, ExecRequest, ExecResult } from '@itphx/synth-core';
import {
  type ExecErrorBody,
  type ExecErrorStatus,
  type ExecRequestBody,
  type ExecSuccessBody,
  type ExecutorErrorReason,
  isPortFailureReason,
} from './protocol.js';
import { resolveContainedCwd } from './workspace.js';

/** Итог выполнения команды: успех либо ошибка (без исключения). */
export type ExecOutcome =
  | { ok: true; result: ExecSuccessBody }
  | { ok: false; error: ExecErrorBody; status: ExecErrorStatus };

/** Параметры сервиса исполнения. */
export interface ExecServiceOptions {
  /** Корень workspace — граница containment'а. */
  workspaceRoot: string;
  /** Лимит одновременных команд. */
  maxConcurrency: number;
  /** Потолок таймаута команды, мс. */
  maxTimeoutMs: number;
  /** Потолок буфера вывода, байт. */
  maxOutputBytes: number;
  /** Порт исполнения (по умолчанию — inline-реализация core). */
  executionPort?: ExecutionPort;
}

/** Ленивая загрузка inline-порта core (runtime-импорт — точечный). */
let inlinePort: ExecutionPort | undefined;

async function resolveInlinePort(): Promise<ExecutionPort> {
  if (inlinePort === undefined) {
    const core = await import('@itphx/synth-core');
    inlinePort = new core.InlineExecutionPort();
  }
  return inlinePort;
}

/** Ошибка сервиса → тело ошибочного ответа. */
function toErrorBody(
  reason: ExecutorErrorReason,
  message: string,
  extra: Partial<Omit<ExecErrorBody, 'reason' | 'message'>> = {},
): ExecErrorBody {
  return {
    reason,
    code: extra.code ?? null,
    message,
    stdout: extra.stdout ?? '',
    stderr: extra.stderr ?? '',
    killed: extra.killed ?? false,
    signal: extra.signal ?? null,
    truncated: extra.truncated ?? false,
    durationMs: extra.durationMs ?? 0,
  };
}

/**
 * Сервис исполнения команд исполнителя.
 *
 * Экземпляр **без состояния между вызовами**, кроме счётчика активных
 * команд (лимит параллельности) — процесс-глобальных синглтонов нет.
 */
export class ExecService {
  private readonly _workspaceRoot: string;
  private readonly _maxConcurrency: number;
  private readonly _maxTimeoutMs: number;
  private readonly _maxOutputBytes: number;
  private readonly _executionPort: ExecutionPort | undefined;
  private _active = 0;

  constructor(opts: ExecServiceOptions) {
    this._workspaceRoot = opts.workspaceRoot;
    this._maxConcurrency = Math.max(1, opts.maxConcurrency);
    this._maxTimeoutMs = Math.max(1, opts.maxTimeoutMs);
    this._maxOutputBytes = Math.max(1, opts.maxOutputBytes);
    this._executionPort = opts.executionPort;
  }

  /** Число выполняющихся сейчас команд. */
  get activeCount(): number {
    return this._active;
  }

  /** Лимит одновременных команд. */
  get concurrencyLimit(): number {
    return this._maxConcurrency;
  }

  /**
   * Выполнить команду.
   *
   * @param req запрос (валидный — разбор тела делает HTTP-слой)
   * @param signal отмена (разрыв соединения клиентом → «Стоп»)
   */
  async execute(req: ExecRequestBody, signal?: AbortSignal): Promise<ExecOutcome> {
    // Containment — до всего остального: команда вне workspace не запускается.
    const cwd = resolveContainedCwd(this._workspaceRoot, req.cwd);
    if (!cwd.ok) {
      return {
        ok: false,
        status: 400,
        error: toErrorBody(cwd.reason, cwd.message, { code: 'EWORKSPACE' }),
      };
    }

    if (this._active >= this._maxConcurrency) {
      return {
        ok: false,
        status: 429,
        error: toErrorBody(
          'too_many_requests',
          `превышен лимит одновременных команд исполнителя (${this._maxConcurrency})`,
          { code: 'ELIMIT' },
        ),
      };
    }

    this._active += 1;
    try {
      const port = this._executionPort ?? (await resolveInlinePort());
      const execRequest: ExecRequest = {
        command: req.command,
        cwd: cwd.path,
        env: req.env,
        // Потолок исполнителя — final: запрошенное значение ограничивается.
        timeoutMs: Math.min(req.timeoutMs ?? this._maxTimeoutMs, this._maxTimeoutMs),
        maxOutputBytes: Math.min(req.maxOutputBytes ?? this._maxOutputBytes, this._maxOutputBytes),
      };
      if (signal !== undefined) execRequest.signal = signal;

      const result: ExecResult = await port.execute(execRequest);
      return {
        ok: true,
        result: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          truncated: result.truncated,
          durationMs: result.durationMs,
        },
      };
    } catch (err) {
      const e = err as {
        reason?: string;
        code?: string | number | null;
        message?: string;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        signal?: string | null;
        truncated?: boolean;
        durationMs?: number;
      };
      const reason: ExecutorErrorReason =
        typeof e.reason === 'string' && isPortFailureReason(e.reason) ? e.reason : 'spawn_failed';
      return {
        ok: false,
        status: 500,
        error: toErrorBody(reason, e.message ?? 'команда завершилась с ошибкой', {
          code: e.code ?? null,
          stdout: e.stdout,
          stderr: e.stderr,
          killed: e.killed,
          signal: e.signal,
          truncated: e.truncated,
          durationMs: e.durationMs,
        }),
      };
    } finally {
      this._active -= 1;
    }
  }
}
