/**
 * ADR-104: форсированная отправка сообщения во время хода (steering).
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

/** Режимы отправки сообщения (ADR-104 §«Решение»). */
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
 * Лимит инъекций на ход (ADR-104 §«Модель исполнения»): столько сообщений
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
 * Признак инъекции в режиме `interrupt` (ADR-104, этап 2):
 * `metadata.interrupt === true` (вместе с `metadata.steer === true`).
 * UI рисует такой ввод отдельным маркером — «ход прерван», а не «остановлен».
 */
export const STEER_INTERRUPT_METADATA_KEY = 'interrupt';

/**
 * Признак прерванной генерации в `metadata` assistant-сообщения:
 * `metadata.interrupted === true` (частичный ответ прерванного стрима).
 */
export const STEER_INTERRUPTED_METADATA_KEY = 'interrupted';

/**
 * Классы инъекций по приоритету применения (ADR-104, этап 3).
 *
 * Порядок классов — это порядок применения: `interrupt` (прерывание
 * генерации) вплетается раньше `steer` (вмешательство без прерывания);
 * внутри класса порядок — FIFO (порядок постановки в очередь).
 */
export const STEER_INJECTION_CLASSES = ['interrupt', 'steer'] as const;

/** Класс инъекции (`interrupt` | `steer`). */
export type SteerInjectionClass = (typeof STEER_INJECTION_CLASSES)[number];

/** Минимальный вид сообщения, по которому определяется класс инъекции. */
export interface SteerInjectionLike {
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Класс инъекции по маркеру `metadata.interrupt` (ADR-104, этап 3).
 * Всё, что не помечено как прерывание, — обычное вмешательство (`steer`).
 */
export function steerInjectionClass(message: SteerInjectionLike): SteerInjectionClass {
  return message.metadata?.[STEER_INTERRUPT_METADATA_KEY] === true ? 'interrupt' : 'steer';
}

/**
 * Порядок применения инъекций (ADR-104, этап 3): сначала класс `interrupt`,
 * затем `steer`; внутри класса — FIFO. Возвращает НОВЫЙ массив (вход не
 * мутируется) — порядок предсказуем и не зависит от момента постановки.
 */
export function orderSteerInjections<T extends SteerInjectionLike>(messages: readonly T[]): T[] {
  const interrupts: T[] = [];
  const steers: T[] = [];
  for (const message of messages) {
    (steerInjectionClass(message) === 'interrupt' ? interrupts : steers).push(message);
  }
  return [...interrupts, ...steers];
}

/** Машинные коды ошибок steering (контракт ошибок API v2). */
export const STEERING_ERROR_CODES = {
  /** Превышен лимит инъекций на ход. */
  limitExceeded: 'STEER_LIMIT_EXCEEDED',
} as const;

/** Машинный код ошибки steering. */
export type SteeringErrorCode =
  (typeof STEERING_ERROR_CODES)[keyof typeof STEERING_ERROR_CODES];
