/**
 * Ошибки публичного API Synth (@itphx/synth-sdk).
 *
 * Единый формат ошибок публичных роутов — `{ error: { code, message } }`
 * (см. `packages/core/src/server/openapi/public-openapi.ts`). Сетевые сбои
 * (fetch бросил исключение) оборачиваются в `SynthApiError` со `status: 0`
 * и кодом `NETWORK_ERROR`.
 *
 * Браузер-совместимо: модуль не тянет Node-only зависимости.
 */

/** Код ошибки, когда HTTP-статус известен, но тело не содержит `error.code`. */
export const HTTP_ERROR_CODE = 'HTTP_ERROR';

/** Код ошибки сетевого сбоя (fetch не смог выполнить запрос). */
export const NETWORK_ERROR_CODE = 'NETWORK_ERROR';

/** Параметры создания `SynthApiError`. */
export interface SynthApiErrorInit {
  /** HTTP-статус ответа; `0` — сетевой сбой (ответ не получен). */
  status: number;
  /** Машиночитаемый код из `{ error: { code } }` (`NETWORK_ERROR` при сбое сети). */
  code: string;
  /** Человекочитаемое сообщение. */
  message: string;
  /** Сырое тело ответа (объект или строка), если удалось разобрать. */
  body?: unknown;
}

/**
 * Ошибка вызова публичного API Synth.
 *
 * `status` — HTTP-статус (`0` при сетевой ошибке), `code` — код из
 * `{ error: { code } }` (либо `HTTP_ERROR`/`NETWORK_ERROR`), `body` — сырое
 * тело ответа.
 */
export class SynthApiError extends Error {
  /** HTTP-статус ответа; `0` — сетевой сбой. */
  readonly status: number;
  /** Машиночитаемый код ошибки. */
  readonly code: string;
  /** Сырое тело ответа (если было). */
  readonly body?: unknown;

  constructor(init: SynthApiErrorInit) {
    super(init.message);
    this.name = 'SynthApiError';
    this.status = init.status;
    this.code = init.code;
    this.body = init.body;
    // Сохраняем корректный prototype-чейн при транспиляции вниз.
    Object.setPrototypeOf(this, SynthApiError.prototype);
  }
}

/** Проверка, что значение — `SynthApiError` (в т.ч. из другого realm). */
export function isSynthApiError(value: unknown): value is SynthApiError {
  return value instanceof SynthApiError;
}

/**
 * Разбор тела ошибки публичного API. Поддерживает единый формат
 * `{ error: { code, message } }`; при ином формате (строка/пусто) возвращает
 * `HTTP_ERROR` и пустое сообщение (вызывающий подставляет fallback).
 */
export function parseErrorBody(body: unknown): { code: string; message: string } {
  if (body && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object') {
      const e = error as { code?: unknown; message?: unknown; error?: unknown };
      const code = typeof e.code === 'string' ? e.code : undefined;
      const message =
        typeof e.message === 'string'
          ? e.message
          : typeof e.error === 'string'
            ? e.error
            : undefined;
      if (code || message) {
        return {
          code: code ?? HTTP_ERROR_CODE,
          message: message ?? '',
        };
      }
    }
  }
  return { code: HTTP_ERROR_CODE, message: '' };
}
