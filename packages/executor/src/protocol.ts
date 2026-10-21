/**
 * Wire-протокол исполнителя (PROP-077, шаг 7a).
 *
 * Транспорт — HTTP/1.1 + JSON. Протокол версионируется полем `protocol`
 * (`GET /capabilities`): расхождение версий — признак несовместимого
 * исполнителя, а не «случайная» ошибка.
 *
 * ## Форма запроса
 *
 * `POST /exec`:
 *
 * ```json
 * {
 *   "command": { "kind": "shell", "command": "printf hi" },
 *   "cwd": "/workspace/project",
 *   "env": { "HOME": "/root" },
 *   "timeoutMs": 30000,
 *   "maxOutputBytes": 10485760
 * }
 * ```
 *
 * `command` — тот же union `ExecCommand`, что у порта core (`shell` | `argv`):
 * форма команды на проводе не переопределяется, чтобы удалённый исполнитель
 * вёл себя как inline (паритет семантики — главная ценность порта).
 *
 * ## Форма ответа
 *
 * - **Успех** — `200` + `{ stdout, stderr, exitCode, truncated, durationMs }`.
 *   Успешный вызов — всегда `exitCode: 0` (неуспешный код приходит ошибкой,
 *   как и в inline-режиме: текст «Command failed: …» должен остаться прежним).
 * - **Ошибка** — тело `{ error: { reason, code, message, stdout, stderr, killed,
 *   signal, truncated, durationMs } }` — зеркало `ExecutionError` из core.
 *   Код ответа — по классу ошибки (см. `EXEC_ERROR_STATUS`).
 *
 * `reason` — либо одна из причин порта (`timeout` | `aborted` | `spawn_failed` |
 * `nonzero_exit` | `max_output`), либо протокольная причина
 * (`invalid_request` | `cwd_outside_workspace` | `unauthorized` |
 * `too_many_requests` | `internal_error`).
 */

import type { ExecCommand } from '@itphx/synth-core';

/** Версия wire-протокола исполнителя. */
export const EXECUTOR_PROTOCOL_VERSION = 1;

/** Причина неудачи на проводе. */
export type ExecutorErrorReason =
  /** Превышен таймаут — процесс прерван. */
  | 'timeout'
  /** Отмена («Стоп»): клиент разорвал запрос — процесс убит на сервере. */
  | 'aborted'
  /** Не удалось запустить процесс (нет бинарника, EACCES, …). */
  | 'spawn_failed'
  /** Процесс завершился с ненулевым кодом. */
  | 'nonzero_exit'
  /** Превышен лимит буфера вывода — вывод обрезан. */
  | 'max_output'
  /** Тело запроса невалидно (нет команды, неверные типы полей). */
  | 'invalid_request'
  /** `cwd` вне корня workspace исполнителя (включая симлинк-побег). */
  | 'cwd_outside_workspace'
  /** Нет или неверный bearer-токен. */
  | 'unauthorized'
  /** Превышен лимит одновременных команд. */
  | 'too_many_requests'
  /** Прочие ошибки сервера. */
  | 'internal_error';

/** Тело запроса `POST /exec`. */
export interface ExecRequestBody {
  /** Команда: shell-строка или argv (без shell). */
  command: ExecCommand;
  /** Рабочий каталог команды (внутри workspace исполнителя). */
  cwd?: string;
  /** Дополнительное окружение — мержится поверх окружения исполнителя. */
  env?: Record<string, string>;
  /** Таймаут команды, мс (исполнитель ограничивает своим максимумом). */
  timeoutMs?: number;
  /** Лимит буфера вывода, байт (исполнитель ограничивает своим максимумом). */
  maxOutputBytes?: number;
}

/** Тело успешного ответа `POST /exec`. */
export interface ExecSuccessBody {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  durationMs: number;
}

/** Тело ошибочного ответа — зеркало `ExecutionError` из core. */
export interface ExecErrorBody {
  reason: ExecutorErrorReason;
  /** Код: `'ENOENT'`, код выхода, `null` или протокольный код (`EWORKSPACE`, …). */
  code: string | number | null;
  /** Текст ошибки (дословно, как его видит модель). */
  message: string;
  stdout: string;
  stderr: string;
  killed: boolean;
  signal: string | null;
  truncated: boolean;
  durationMs: number;
}

/** Ошибочный ответ исполнителя. */
export interface ExecErrorResponse {
  error: ExecErrorBody;
}

/** Ответ `GET /capabilities`. */
export interface ExecutorCapabilities {
  /** Версия wire-протокола. */
  protocol: number;
  /** Состав toolchain'а: бинарник → версия (нет бинарника — ключа нет). */
  toolchain: Record<string, string>;
  /** ОС исполнителя (`process.platform`). */
  os: string;
  /** Архитектура (`process.arch`). */
  arch: string;
  /** Версия Node.js исполнителя. */
  node: string;
}

/** Ответ `GET /health`. */
export interface ExecutorHealth {
  status: 'ok';
  protocol: number;
  uptimeSec: number;
  concurrency: { limit: number; active: number };
}

/**
 * HTTP-код ответа по классу ошибки.
 *
 * - `400` — некорректный запрос или `cwd` вне workspace;
 * - `401` — нет/неверный токен;
 * - `429` — превышен лимит одновременных команд;
 * - `500` — прочие ошибки исполнения (включая ненулевой код выхода).
 */
export type ExecErrorStatus = 400 | 401 | 429 | 500;

export const EXEC_ERROR_STATUS: Record<ExecutorErrorReason, ExecErrorStatus> = {
  invalid_request: 400,
  cwd_outside_workspace: 400,
  unauthorized: 401,
  too_many_requests: 429,
  timeout: 500,
  aborted: 500,
  spawn_failed: 500,
  nonzero_exit: 500,
  max_output: 500,
  internal_error: 500,
};

/** Причины порта core (`ExecutionError.reason`) — подмножество причин провода. */
export const PORT_FAILURE_REASONS = [
  'timeout',
  'aborted',
  'spawn_failed',
  'nonzero_exit',
  'max_output',
] as const;

export type PortFailureReason = (typeof PORT_FAILURE_REASONS)[number];

/** Причина на проводе — причина порта? */
export function isPortFailureReason(reason: string): reason is PortFailureReason {
  return (PORT_FAILURE_REASONS as readonly string[]).includes(reason);
}

/** Структурная проверка команды из тела запроса. */
export function isValidExecCommand(value: unknown): value is ExecCommand {
  if (typeof value !== 'object' || value === null) return false;
  const cmd = value as { kind?: unknown; command?: unknown; shell?: unknown; file?: unknown; args?: unknown };
  if (cmd.kind === 'shell') {
    if (typeof cmd.command !== 'string' || cmd.command.length === 0) return false;
    if (cmd.shell !== undefined && typeof cmd.shell !== 'string') return false;
    return true;
  }
  if (cmd.kind === 'argv') {
    if (typeof cmd.file !== 'string' || cmd.file.length === 0) return false;
    if (cmd.args !== undefined) {
      if (!Array.isArray(cmd.args)) return false;
      if (!cmd.args.every((a) => typeof a === 'string')) return false;
    }
    return true;
  }
  return false;
}

/** Разбор тела запроса `POST /exec` → валидный запрос или причина отказа. */
export function parseExecRequestBody(
  body: unknown,
): { ok: true; value: ExecRequestBody } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'тело запроса должно быть JSON-объектом' };
  }
  const raw = body as Record<string, unknown>;
  if (!isValidExecCommand(raw.command)) {
    return {
      ok: false,
      message: 'поле command обязательно: {kind:"shell",command} или {kind:"argv",file,args?}',
    };
  }
  const value: ExecRequestBody = { command: raw.command };

  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string' || raw.cwd.length === 0) {
      return { ok: false, message: 'поле cwd должно быть непустой строкой' };
    }
    value.cwd = raw.cwd;
  }

  if (raw.env !== undefined) {
    if (typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env)) {
      return { ok: false, message: 'поле env должно быть объектом со строковыми значениями' };
    }
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof val !== 'string') {
        return { ok: false, message: `поле env.${key} должно быть строкой` };
      }
      env[key] = val;
    }
    value.env = env;
  }

  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== 'number' || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs <= 0) {
      return { ok: false, message: 'поле timeoutMs должно быть целым числом > 0' };
    }
    value.timeoutMs = raw.timeoutMs;
  }

  if (raw.maxOutputBytes !== undefined) {
    if (
      typeof raw.maxOutputBytes !== 'number' ||
      !Number.isInteger(raw.maxOutputBytes) ||
      raw.maxOutputBytes <= 0
    ) {
      return { ok: false, message: 'поле maxOutputBytes должно быть целым числом > 0' };
    }
    value.maxOutputBytes = raw.maxOutputBytes;
  }

  return { ok: true, value };
}

/** Ошибочный ответ с корректным HTTP-кодом. */
export function errorResponse(
  reason: ExecutorErrorReason,
  message: string,
  extra: Partial<Omit<ExecErrorBody, 'reason' | 'message'>> = {},
): { status: ExecErrorStatus; body: ExecErrorResponse } {
  const body: ExecErrorBody = {
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
  return { status: EXEC_ERROR_STATUS[reason], body: { error: body } };
}
