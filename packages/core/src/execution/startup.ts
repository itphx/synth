/**
 * Проверка режима исполнения при старте процесса (PROP-077, шаг 3).
 *
 * `execution.mode` — **параметр запуска** (инвариант 24): смена режима — только
 * рестартом. На этом шаге реализован только `inline` (исполнение в процессе);
 * `remote` (отдельные исполнители, шаг 7 плана PROP-077) — **fail-closed**:
 * старт прерывается с понятным сообщением, а не «молча уходит в inline».
 *
 * Тексты — через ключи `shared/i18n` (ADR-041), как остальные строки движка.
 */
import type { ResolvedExecutionConfig } from '@itphx/synth-shared';
import { t } from '../engine/system-messages.js';

/** Причина отказа на старте. */
export type ExecutionStartupIssue = 'remote_not_supported' | 'remote_url_required';

/** Итог проверки режима исполнения. */
export interface ExecutionStartupCheck {
  /** `true` — старт можно продолжать (режим `inline`). */
  ok: boolean;
  /** Причина отказа (при `ok: false`). */
  issue?: ExecutionStartupIssue;
  /** Локализованное сообщение для оператора (при `ok: false`). */
  message?: string;
}

/**
 * Проверяет, поддерживается ли заданный режим исполнения.
 *
 * - `inline` — всегда ок (прежнее поведение, обратная совместимость);
 * - `remote` без адресов исполнителей — отдельная причина
 *   (`remote_url_required`: «пусто при `remote` → fail-closed на старте»);
 * - `remote` с адресами — `remote_not_supported`: удалённый исполнитель ещё не
 *   реализован (шаг 7 плана PROP-077).
 */
export function checkExecutionMode(execution: ResolvedExecutionConfig): ExecutionStartupCheck {
  if (execution.mode !== 'remote') return { ok: true };

  if (execution.remote.url.length === 0) {
    return {
      ok: false,
      issue: 'remote_url_required',
      message: t('execution.remote_url_required'),
    };
  }

  return {
    ok: false,
    issue: 'remote_not_supported',
    message: t('execution.remote_not_supported'),
  };
}

/**
 * То же, что `checkExecutionMode`, но бросает ошибку с локализованным
 * сообщением — для вызывающих, которые прерывают старт исключением.
 */
export function assertExecutionModeSupported(execution: ResolvedExecutionConfig): void {
  const check = checkExecutionMode(execution);
  if (check.ok) return;
  throw new Error(check.message ?? 'execution mode is not supported');
}
