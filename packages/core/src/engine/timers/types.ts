/**
 * PROP-141 (Часть B): типы и ошибки движка таймеров/будильников.
 *
 * Контракты сущностей (`Timer`/`TimerFiring`/повторы/лимиты) живут в
 * `@itphx/synth-shared` (`types/timers.ts`) — здесь только то, что нужно
 * самому движку: вход создания («интент»), шов доставки и именованные ошибки
 * с машинными кодами (без кодов бросать `Error` нельзя — по нему роут/тул
 * решает, что показать человеку).
 */
import type { Timer, TimerFiring, TimerKind, TimerPatch } from '@itphx/synth-shared';

/**
 * Вход создания таймера/будильника.
 *
 * Отличие от записи `Timer` (контракт хранилища): интент несёт **правило**
 * первого срабатывания, а не вычисленную метку времени:
 * - таймер (`kind:'timer'`, режим `once`) — относительная задержка `delaySec`;
 * - будильник (`kind:'alarm'`, режим `once`) — абсолютное время `at` (ISO-8601);
 * - `daily`/`every` — правило повтора в `repeat`, метка времени вычисляется
 *   движком (`engine/timers/next-fire.ts`).
 */
export interface TimerIntent {
  /** Вид автоматизации. */
  kind: TimerKind;
  /** Необязательное имя (карточка в панели «Автоматизация»). */
  name?: string;
  /** Комментарий (1…500 символов) — единственный «смысл» срабатывания. */
  comment: string;
  /** Проект автоматизации (обязателен — инстансных автоматизаций нет). */
  projectId: string;
  /** Сессия-получатель сообщения (обязательна). */
  sessionId: string;
  /** Владелец (принципал-человек; в standalone — `local`). */
  ownerId: string;
  /** Правило повтора. */
  repeat: TimerIntentRepeat;
  /** Таймер, режим `once`: относительная задержка, с. */
  delaySec?: number;
  /** Будильник, режим `once`: абсолютное время (ISO-8601). */
  at?: string;
  /**
   * Разрешить семантический дубликат (та же сессия, вид, комментарий и имя
   * среди активных). По умолчанию `false`: повторный `create` с тем же
   * содержанием — ошибка `timer_duplicate` с id существующей записи.
   */
  allowDuplicate?: boolean;
}

/**
 * Правило повтора интента.
 *
 * Отдельный тип от `TimerRepeat` нужен только для TYPE-уровня: контракт
 * хранилища (`TimerRepeat`) — источник истины, а здесь — тот же набор
 * вариантов, чтобы интент не зависел от правок хранилища.
 */
export type TimerIntentRepeat = Timer['repeat'];

/** Частичная правка таймера (контракт хранилища). */
export type TimerUpdatePatch = TimerPatch;

/**
 * Метаданные срабатывания, передаваемые доставке.
 *
 * `catchup` — срабатывание «догоняющее»: плановое время прошло, а
 * срабатывание случилось позже (рестарт инстанса или просевший тик). Для
 * обычного срабатывания по расписанию — `false`.
 */
export interface TimerDeliveryMeta {
  /** Срабатывание догоняющее (план уже прошёл). */
  catchup: boolean;
}

/**
 * Шов доставки срабатывания.
 *
 * Доставка подключается на этапе 4 (PROP-141) через инъекцию — движок не
 * знает ни про шину событий, ни про механизм фоновых процессов.
 *
 * Передаётся **черновик** записи срабатывания (`outcome` ещё не известен —
 * он определяется по итогу доставки); в историю попадает уже итоговая
 * запись с фактическим `outcome`.
 */
export type TimerDeliver = (
  timer: Timer,
  firing: TimerFiring,
  meta: TimerDeliveryMeta,
) => Promise<void>;

/** Машинные коды ошибок подсистемы таймеров. */
export const TIMER_ERROR_CODES = [
  'timer_invalid_comment',
  'timer_invalid_interval',
  'timer_invalid_time',
  'timer_invalid_timezone',
  'timer_invalid_horizon',
  'timer_invalid_target',
  'timer_limit_exceeded',
  'timer_duplicate',
  'timer_time_in_past',
  'timer_not_active',
] as const;

/** Код ошибки подсистемы таймеров. */
export type TimerErrorCode = (typeof TIMER_ERROR_CODES)[number];

/** База ошибок подсистемы таймеров: машинный код + текст (для логов/UI). */
export class TimerError extends Error {
  readonly code: TimerErrorCode;

  constructor(code: TimerErrorCode, message: string) {
    super(message);
    this.name = 'TimerError';
    this.code = code;
  }
}

/**
 * Некорректный вход таймера (комментарий, интервал, время, часовой пояс,
 * горизонт, обязательные поля).
 *
 * `field` — имя проверяемого поля (для подсказки в UI/туле).
 */
export class TimerValidationError extends TimerError {
  /** Имя некорректного поля (если применимо). */
  readonly field?: string;

  constructor(code: TimerErrorCode, message: string, field?: string) {
    super(code, message);
    this.name = 'TimerValidationError';
    if (field !== undefined) this.field = field;
  }
}

/**
 * Превышен лимит подсистемы таймеров.
 *
 * Сейчас один — число активных таймеров на сессию
 * (`TIMER_MAX_ACTIVE_PER_SESSION` = 50, решение владельца, PROP-141).
 */
/**
 * Семантический дубликат: активная автоматизация того же вида с тем же
 * комментарием и именем уже есть в сессии.
 *
 * `existingId` — id существующей записи (чтобы модель могла переиспользовать
 * её или осознанно передать `allow_duplicate: true`).
 */
export class TimerDuplicateError extends TimerValidationError {
  /** Id уже существующей активной автоматизации. */
  readonly existingId: string;

  constructor(existingId: string) {
    super(
      'timer_duplicate',
      `Активная автоматизация с тем же комментарием уже есть: ${existingId}`,
      'comment',
    );
    this.name = 'TimerDuplicateError';
    this.existingId = existingId;
  }
}

export class TimerLimitExceededError extends TimerValidationError {
  /** Текущий лимит. */
  readonly limit: number;
  /** Вид превышенного лимита. */
  readonly limitKind: 'active_per_session';

  constructor(limit: number, message: string) {
    super('timer_limit_exceeded', message);
    this.name = 'TimerLimitExceededError';
    this.limit = limit;
    this.limitKind = 'active_per_session';
  }
}
