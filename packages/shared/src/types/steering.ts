/**
 * PROP-098: форсированная отправка сообщения во время хода (steering).
 *
 * Контракт режима отправки `POST /api/v2/sessions/:id/prompt`:
 * - `queue` — текущее поведение (по умолчанию): сообщение ждёт окончания хода;
 * - `steer` — инъекция в активный ход без прерывания генерации;
 * - `interrupt` — прерывание текущей генерации с продолжением того же хода:
 *   стрим обрывается (событие `stream.interrupted`), ход НЕ завершается —
 *   сообщение вплетается на ближайшей безопасной границе шага.
 *
 * Модуль browser-safe (только типы и чистые функции) — используется в UI.
 */

/** Режимы отправки сообщения (PROP-098 §«Решение»). */
export const STEER_MODES = ['queue', 'steer', 'interrupt'] as const;

/** Режим отправки сообщения. */
export type SteerMode = (typeof STEER_MODES)[number];

/** Режим по умолчанию — обратная совместимость (поле `mode` необязательное). */
export const DEFAULT_STEER_MODE: SteerMode = 'queue';

/** Проверка значения режима (значение из тела запроса). */
export function isSteerMode(value: unknown): value is SteerMode {
  return typeof value === 'string' && (STEER_MODES as readonly string[]).includes(value);
}

/**
 * Лимит инъекций на ход (PROP-098 §«Модель исполнения»): столько сообщений
 * можно вбросить в один ход; превышение — понятная ошибка + событие
 * `steer.dropped`.
 */
export const MAX_STEER_INJECTIONS_PER_TURN = 5;

/**
 * Признак инъекции в `metadata` сообщения: `metadata.steer === true`.
 * Тип `Message` не меняется — `metadata` уже свободная карта.
 */
export const STEER_METADATA_KEY = 'steer';

/**
 * Признак инъекции в режиме `interrupt` (PROP-098, этап 2):
 * `metadata.interrupt === true` (вместе с `metadata.steer === true`).
 * UI рисует такой ввод отдельным маркером — «ход прерван», а не «остановлен».
 */
export const STEER_INTERRUPT_METADATA_KEY = 'interrupt';

/**
 * Признак прерванной генерации в `metadata` assistant-сообщения:
 * `metadata.interrupted === true` (частичный ответ прерванного стрима).
 */
export const STEER_INTERRUPTED_METADATA_KEY = 'interrupted';

/** Машинные коды ошибок steering (контракт ошибок API v2). */
export const STEERING_ERROR_CODES = {
  /**
   * `mode: 'interrupt'` — этап 2 PROP-098: движок умеет прерывать генерацию,
   * но HTTP-контур ещё не открывает режим (гейт снимается в том же этапе,
   * вместе с веткой `interrupt` в `/prompt`).
   */
  interruptUnsupported: 'STEERING_INTERRUPT_UNSUPPORTED',
  /** Превышен лимит инъекций на ход. */
  limitExceeded: 'STEER_LIMIT_EXCEEDED',
} as const;

/** Машинный код ошибки steering. */
export type SteeringErrorCode =
  (typeof STEERING_ERROR_CODES)[keyof typeof STEERING_ERROR_CODES];
