/**
 * Порт исполнения команд (ADR-077, шаг 1).
 *
 * Домен (тулы `execute_shell`/`grep_files`, git-тулы, inline-shell, детект
 * внешних зависимостей) работает через интерфейс, а не через прямой вызов
 * `execFile`: физический исполнитель взаимозаменяем — сегодня
 * `InlineExecutionPort` (исполнение в процессе), позже `RemoteExecutionPort`
 * (HTTP к отдельному исполнителю). Образец — порты слоя хранения
 * (ADR-096/ADR-097).
 *
 * ## Почему команда — не строка
 *
 * В коде две формы вызова, и обе должны выражаться портом без потери
 * семантики:
 *
 * - **shell** — `sh -c <команда>`: тул `execute_shell`, inline-shell
 *   (`` !`cmd` ``). Строка идёт в shell без разбора — пайпы, редиректы,
 *   подстановки переменных работают как раньше;
 * - **argv** — прямой запуск бинарника **без shell**: `git`, `rg`, проба
 *   `bin --version`. Значения аргументов не проходят через shell — значит
 *   классическая инъекция невозможна, аallowlist значений в git-тулах
 *   (ADR-076) остаётся осмысленным.
 *
 * Поэтому запрос — дискриминированный union (`ExecCommand`), а не строка:
 * иначе «argv без shell» пришлось бы выражать строкой и потерять различие
 * (либо получить инъекцию, либо запретить shell-семантику).
 */

/** Форма команды: shell-строка или argv-массив (без shell). */
export type ExecCommand =
  /** Shell-семантика: `<shell> -c <command>` (по умолчанию — `sh`). */
  | { kind: 'shell'; command: string; shell?: string }
  /** Прямой запуск: `<file> <args…>` — без shell. */
  | { kind: 'argv'; file: string; args?: string[] };

export interface ExecRequest {
  /** Команда: shell-строка или argv. */
  command: ExecCommand;
  /** Рабочий каталог команды. Не задан — каталог процесса-исполнителя. */
  cwd?: string;
  /**
   * ДОПОЛНИТЕЛЬНОЕ окружение: мержится поверх базового окружения
   * исполнителя (в inline-режиме — `process.env`). Не заменяет его.
   */
  env?: Record<string, string>;
  /** Таймаут вызова (мс). Не задан — без таймаута. */
  timeoutMs?: number;
  /** Сигнал отмены («Стоп» сессии) — процесс прерывается. */
  signal?: AbortSignal;
  /**
   * Лимит буфера вывода (байт). Не задан — `DEFAULT_MAX_OUTPUT_BYTES`
   * (10 МБ, как `maxBuffer` у нынешних вызовов).
   */
  maxOutputBytes?: number;
}

export interface ExecResult {
  /** Стандартный вывод. */
  stdout: string;
  /** Стандартный вывод ошибок. */
  stderr: string;
  /**
   * Код завершения. Успешный вызов — всегда `0`: неуспешный код приходит
   * **ошибкой** (`ExecutionError.code`), а не полем результата — так сохраняется
   * дословный текст «Command failed: …», который видит модель.
   */
  exitCode: number;
  /** Вывод обрезан по лимиту порта. */
  truncated: boolean;
  /** Длительность исполнения (мс). */
  durationMs: number;
}

/**
 * Порт исполнения команд. Реализации: `InlineExecutionPort` (в процессе) и
 * `RemoteExecutionPort` (HTTP к исполнителю, шаг 7 плана ADR-077).
 */
export interface ExecutionPort {
  execute(req: ExecRequest): Promise<ExecResult>;
}

/** Причина неудачного вызова. */
export type ExecFailureReason =
  /** Превышен таймаут — процесс прерван. */
  | 'timeout'
  /** Отмена по `AbortSignal` («Стоп»). */
  | 'aborted'
  /** Не удалось запустить процесс (нет бинарника, EACCES, …). */
  | 'spawn_failed'
  /** Процесс завершился с ненулевым кодом. */
  | 'nonzero_exit'
  /** Превышен лимит буфера вывода — вывод обрезан. */
  | 'max_output';

/** Базовая оболочка shell-формы (совпадает с текущим `sh -c`). */
export const DEFAULT_SHELL_BINARY = 'sh';

/** Лимит буфера вывода по умолчанию (10 МБ — как нынешний `maxBuffer`). */
export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface ExecutionErrorInit {
  /** Текст ошибки (дословно как у процесса — его видит модель). */
  message: string;
  /** Имя ошибки (`Error`/`AbortError`) — сохраняется, чтобы не сломать распознавание отмены. */
  name?: string;
  /** Код: `'ENOENT'`, код выхода или `null`. */
  code?: string | number | null;
  /** Частичный stdout. */
  stdout?: string;
  /** Частичный stderr. */
  stderr?: string;
  /** Процесс был убит (таймаут/отмена). */
  killed?: boolean;
  /** Сигнал завершения. */
  signal?: string | null;
  /** Причина неудачи. */
  reason: ExecFailureReason;
  /** Вывод был обрезан по лимиту. */
  truncated?: boolean;
  /** Длительность до ошибки (мс). */
  durationMs?: number;
}

/**
 * Типизированная ошибка исполнения (ADR-077). Несёт те же поля, что и
 * ошибка `execFile` (`code`/`stdout`/`stderr`/`killed`/`message`), поэтому
 * тексты, которые видит модель, не меняются.
 */
export class ExecutionError extends Error {
  readonly reason: ExecFailureReason;
  readonly code: string | number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
  readonly signal: string | null;
  readonly truncated: boolean;
  readonly durationMs: number;

  constructor(init: ExecutionErrorInit) {
    super(init.message);
    // Имя класса не подменяем: у отмены — `AbortError` (её распознаёт
    // `isAbortError`), у прочих ошибок — `Error`. Дословность `String(err)`
    // (её показывают тулы) сохраняется.
    this.name = init.name ?? 'Error';
    this.reason = init.reason;
    this.code = init.code ?? null;
    this.stdout = init.stdout ?? '';
    this.stderr = init.stderr ?? '';
    this.killed = init.killed === true;
    this.signal = init.signal ?? null;
    this.truncated = init.truncated === true;
    this.durationMs = init.durationMs ?? 0;
  }
}

/** Структурная проверка: переданное значение — порт исполнения. */
export function isExecutionPort(value: unknown): value is ExecutionPort {
  return typeof (value as { execute?: unknown } | null | undefined)?.execute === 'function';
}
