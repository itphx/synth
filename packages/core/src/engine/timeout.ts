/**
 * Таймауты тулов — **секунды** (PROP-141, Часть A).
 *
 * Входной параметр `timeout` любого тула — целое число **секунд**. Потолок
 * зависит от **режима исполнения**, а не от тула:
 *
 * - foreground (синхронный вызов) — до 600 с (10 минут): дольше — значит
 *   «подвесить» ход агента;
 * - background (фоновый процесс) — до 86 400 с (сутки): фоновый процесс
 *   переживает ход агента.
 *
 * Внутри всё остаётся в миллисекундах: порты исполнения, `ExecRequest.timeoutMs`,
 * конфиг-дефолты (`git.*TimeoutMs`, `browserTimeoutMs`). Перевод — **на
 * границе** (`timeoutMs = timeout * 1000`).
 *
 * `0` («без лимита») больше не принимается: у фонового процесса лимит —
 * сутки, у синхронного — 10 минут.
 */
import { z } from 'zod';

/** Предел таймаута в foreground, секунды (10 минут). */
export const TIMEOUT_FG_MAX_SEC = 600;

/** Предел таймаута в background, секунды (сутки). */
export const TIMEOUT_BG_MAX_SEC = 86_400;

/** Дефолт таймаута в foreground, секунды. */
export const TIMEOUT_FG_DEFAULT_SEC = 120;

/** Дефолт таймаута в background, секунды (сутки). */
export const TIMEOUT_BG_DEFAULT_SEC = TIMEOUT_BG_MAX_SEC;

/**
 * Текст отказа «таймаут выше потолка foreground» — понятный модели:
 * что не так и куда идти вместо этого.
 */
export const TIMEOUT_FG_LIMIT_MESSAGE =
  `timeout must be 1..${TIMEOUT_FG_MAX_SEC} seconds in foreground; `
  + `use background mode for up to ${TIMEOUT_BG_MAX_SEC}`;

/** Текст отказа «таймаут вне диапазона background». */
export const TIMEOUT_BG_LIMIT_MESSAGE =
  `timeout must be 1..${TIMEOUT_BG_MAX_SEC} seconds in background mode`;

/**
 * Мс → с — для model-facing поверхности (сообщения, метаданные).
 *
 * Внутренние значения остаются в миллисекундах; округление до ближайшей
 * секунды нужно только там, где величина показывается модели.
 */
export function msToTimeoutSec(timeoutMs: number): number {
  return Math.round(timeoutMs / 1000);
}

/** Схема параметра `timeout` (секунды) тула. */
export interface TimeoutParamOptions {
  /** Верхняя граница, секунды. */
  max: number;
  /** Описание для модели (единица измерения и режим — обязательны). */
  description: string;
  /** Нижняя граница, секунды (по умолчанию 1 — «0 = без лимита» больше нет). */
  min?: number;
  /** Текст отказа при превышении верхней границы. */
  maxMessage?: string;
}

/**
 * Zod-схема параметра `timeout` (секунды) с понятными текстами отказа.
 *
 * Тексты отказа — **для модели**: «не число», «меньше минимума», «больше
 * потолка» должны читаться как объяснение, а не как `invalid_type`.
 */
export function timeoutParam(options: TimeoutParamOptions): z.ZodOptional<z.ZodNumber> {
  const min = options.min ?? 1;
  return z
    .number()
    .int('timeout must be an integer number of seconds')
    .min(min, `timeout must be at least ${min} seconds`)
    .max(options.max, options.maxMessage ?? `timeout must be at most ${options.max} seconds`)
    .optional()
    .describe(options.description);
}
