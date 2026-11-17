/**
 * PROP-141 (Часть B): контракты таймеров и будильников.
 *
 * Таймер и будильник — **один тип** с двумя видами (`kind`): таймер
 * относительный («через 15 минут»), будильник — абсолютный/повторяющийся
 * («завтра в 09:00», «каждые 10 минут»). Отличие от расписания (ADR-051):
 * у расписания есть **свой текст задания**, здесь несёт только комментарий —
 * смысл срабатывания восстанавливает сам агент по комментарию и истории.
 *
 * Здесь только контракты (типы + Zod-схемы) — без бизнес-логики: вычисление
 * `firesAt`, догон (catch-up), дедуп и доставка живут в core (`engine/timers/`,
 * следующий этап PROP-141). Персистентность — доменные порты
 * `TimerRepository`/`TimerFiringRepository` (ADR-096).
 */
import { z } from 'zod';

/**
 * Вид автоматизации:
 * - `timer` — относительный отсчёт («через N секунд»);
 * - `alarm` — абсолютное время (`at`) либо повтор (`daily`/`every`).
 */
export type TimerKind = 'timer' | 'alarm';

/** Канонический набор видов автоматизации. */
export const TIMER_KINDS: readonly TimerKind[] = ['timer', 'alarm'];

/**
 * Режим повтора срабатывания:
 * - `once` — одноразовое срабатывание;
 * - `daily` — ежедневно в `time` (`HH:MM`) в часовом поясе `timezone`;
 * - `every` — каждые `everySec` секунд.
 *
 * `weekly`/cron нет (решение владельца, PROP-141).
 */
export type TimerRepeat =
  | { mode: 'once' }
  | { mode: 'daily'; time: string; timezone: string }
  | { mode: 'every'; everySec: number };

/** Канонический набор режимов повтора. */
export const TIMER_REPEAT_MODES: readonly TimerRepeat['mode'][] = ['once', 'daily', 'every'];

/**
 * Статус таймера:
 * - `active` — ждёт срабатывания;
 * - `paused` — приостановлен (срабатывание не наступит);
 * - `fired` — сработал (one-shot);
 * - `cancelled` — отменён (в т.ч. каскадом при удалении сессии).
 */
export type TimerStatus = 'active' | 'paused' | 'fired' | 'cancelled';

/** Канонический набор статусов таймера. */
export const TIMER_STATUSES: readonly TimerStatus[] = ['active', 'paused', 'fired', 'cancelled'];

/**
 * Минимальный интервал/повтор — 10 секунд (решение владельца, PROP-141).
 * Интервал меньше — заведомо «мгновенное» повторение, а не автоматизация.
 */
export const TIMER_MIN_INTERVAL_SEC = 10;

/** Потолок длины комментария (единственный «смысл» срабатывания). */
export const TIMER_COMMENT_MAX = 500;

/** Потолок числа активных таймеров на сессию. */
export const TIMER_MAX_ACTIVE_PER_SESSION = 50;

/** Горизонт one-shot таймера, суток (30 дней). */
export const TIMER_ONE_SHOT_HORIZON_DAYS = 30;

/**
 * Допуск для времени «в прошлом» при создании/правке будильника, секунды.
 *
 * Абсолютное время `at` в прошлом — ошибка ввода (частая опечатка), но
 * небольшой допуск нужен из-за сетевой задержки и гонки «создал в 12:00:00.9
 * на 12:00:00». Догон уже сохранённых записей после рестарта этим не
 * ограничивается (там запись существовала до простоя).
 */
export const TIMER_PAST_GRACE_SEC = 60;

/**
 * Потолок интервала повтора `every` — 30 суток в секундах
 * (совпадает с горизонтом one-shot: дольше — это уже не «каждые N секунд»).
 */
export const TIMER_MAX_INTERVAL_SEC = 2_592_000;

/**
 * Запись таймера/будильника (`tmr_<uuid>`).
 *
 * `projectId` и `sessionId` обязательны: инстансных автоматизаций не бывает
 * (PROP-141, решение владельца) — каждая автоматизация привязана к проекту,
 * а сообщение уходит в конкретную сессию. Проект хранится денормализованно
 * (для выборок и RBAC — ADR-140).
 */
export interface Timer {
  /** `tmr_<uuid>`, уникален в пределах инстанса. */
  id: string;
  /** Вид автоматизации (таймер/будильник). */
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
  /** Режим повтора. */
  repeat: TimerRepeat;
  /** Статус записи. */
  status: TimerStatus;
  /** Ближайшее срабатывание, ISO-8601 (вычисляет движок). */
  firesAt: string;
  /** Момент создания, ISO-8601. */
  createdAt: string;
  /** Момент последнего изменения, ISO-8601. */
  updatedAt: string;
  /** Момент фактического срабатывания, ISO-8601 (если сработал). */
  firedAt?: string;
  /** Текст последней ошибки доставки/срабатывания. */
  lastError?: string;
}

/**
 * Итог срабатывания таймера:
 * - `ok` — доставлено;
 * - `error` — ошибка доставки;
 * - `skipped` — срабатывание пропущено (например, таймер отменён к моменту тика).
 */
export type TimerFiringOutcome = 'ok' | 'error' | 'skipped';

/**
 * Запись истории срабатываний (`tmf_<uuid>`) — append-only.
 *
 * `scheduledFor` — плановое время срабатывания, `firedAt` — фактическое,
 * `lagMs` — расхождение (метрика «задержка срабатывания»). Дедуп по
 * `(timerId, scheduledFor)` делает движок, а не порт (PROP-141, Часть B).
 */
export interface TimerFiring {
  /** `tmf_<uuid>`, уникален в пределах инстанса. */
  id: string;
  /** Таймер, к которому относится срабатывание. */
  timerId: string;
  /** Фактическое время срабатывания, ISO-8601. */
  firedAt: string;
  /** Плановое время срабатывания, ISO-8601. */
  scheduledFor: string;
  /** Задержка срабатывания относительно плана, мс (может быть отрицательной). */
  lagMs: number;
  /** Итог срабатывания. */
  outcome: TimerFiringOutcome;
  /** Сессия, в которую доставлено сообщение. */
  sessionId: string;
}

/** Фильтр выборки таймеров (все условия — по «И»). */
export interface TimerFilter {
  /** Сессия-получатель. */
  sessionId?: string;
  /** Проект автоматизации. */
  projectId?: string;
  /** Статус записи. */
  status?: TimerStatus;
  /** Вид автоматизации. */
  kind?: TimerKind;
  /** Смещение выборки (постраничный листинг, ADR-118 §4). */
  offset?: number;
  /** Потолок выборки. */
  limit?: number;
}

/**
 * Вход создания таймера — без `id`, таймстемпов и результата срабатывания
 * (ими владеет порт/движок).
 */
export interface TimerCreateInput {
  /** Вид автоматизации. */
  kind: TimerKind;
  /** Необязательное имя. */
  name?: string;
  /** Комментарий (1…500 символов). */
  comment: string;
  /** Проект автоматизации (обязателен). */
  projectId: string;
  /** Сессия-получатель (обязательна). */
  sessionId: string;
  /** Владелец. */
  ownerId: string;
  /** Режим повтора. */
  repeat: TimerRepeat;
  /** Статус при создании (по умолчанию — `active`). */
  status?: TimerStatus;
  /** Ближайшее срабатывание, ISO-8601 (вычисляет вызывающий — движок). */
  firesAt: string;
}

/**
 * Частичная правка таймера. Неизменяемые поля (`id`, `projectId`,
 * `sessionId`, `ownerId`, `createdAt`) в патче отсутствуют: смена проекта
 * сессии — отдельная операция с явными последствиями (PROP-141, Часть D).
 */
export interface TimerPatch {
  /** Вид автоматизации. */
  kind?: TimerKind;
  /** Имя (`null` — сбросить). */
  name?: string | null;
  /** Комментарий. */
  comment?: string;
  /** Режим повтора. */
  repeat?: TimerRepeat;
  /** Статус. */
  status?: TimerStatus;
  /** Ближайшее срабатывание, ISO-8601. */
  firesAt?: string;
  /** Момент фактического срабатывания (`null` — сбросить). */
  firedAt?: string | null;
  /** Текст последней ошибки (`null` — сбросить). */
  lastError?: string | null;
}

// ── Zod-схемы ───────────────────────────────────────────────────────────────

/** Время суток в формате `HH:MM` (00:00…23:59). */
export const TIMER_TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Схема времени суток `HH:MM`. */
export const timerTimeSchema = z
  .string()
  .regex(
    TIMER_TIME_REGEX,
    'Ожидается время в формате HH:MM (часы 00–23, минуты 00–59)',
  );

/** Схема вида автоматизации. */
export const timerKindSchema = z.enum(TIMER_KINDS);

/** Схема статуса таймера. */
export const timerStatusSchema = z.enum(TIMER_STATUSES);

/** Схема режима повтора. */
export const timerRepeatSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('once') }).strict(),
  z.object({
    mode: z.literal('daily'),
    time: timerTimeSchema,
    timezone: z.string().min(1),
  }).strict(),
  z.object({
    mode: z.literal('every'),
    everySec: z
      .number()
      .int()
      .min(TIMER_MIN_INTERVAL_SEC)
      .max(TIMER_MAX_INTERVAL_SEC),
  }).strict(),
]);

/** Схема комментария таймера (1…500 символов). */
export const timerCommentSchema = z.string().min(1).max(TIMER_COMMENT_MAX);

/** Схема времени срабатывания (ISO-8601). */
export const timerTimestampSchema = z.iso.datetime({ offset: true });

/** Схема записи таймера (полная). */
export const timerSchema = z.object({
  id: z.string().min(1),
  kind: timerKindSchema,
  name: z.string().min(1).optional(),
  comment: timerCommentSchema,
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  ownerId: z.string().min(1),
  repeat: timerRepeatSchema,
  status: timerStatusSchema,
  firesAt: timerTimestampSchema,
  createdAt: timerTimestampSchema,
  updatedAt: timerTimestampSchema,
  firedAt: timerTimestampSchema.optional(),
  lastError: z.string().optional(),
});

/** Схема входа создания таймера. */
export const timerCreateInputSchema = z.object({
  kind: timerKindSchema,
  name: z.string().min(1).optional(),
  comment: timerCommentSchema,
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  ownerId: z.string().min(1),
  repeat: timerRepeatSchema,
  status: timerStatusSchema.optional(),
  firesAt: timerTimestampSchema,
});

/** Схема частичной правки таймера. */
export const timerPatchSchema = z.object({
  kind: timerKindSchema.optional(),
  name: z.string().min(1).nullable().optional(),
  comment: timerCommentSchema.optional(),
  repeat: timerRepeatSchema.optional(),
  status: timerStatusSchema.optional(),
  firesAt: timerTimestampSchema.optional(),
  firedAt: timerTimestampSchema.nullable().optional(),
  lastError: z.string().nullable().optional(),
});

/** Схема записи срабатывания таймера. */
export const timerFiringSchema = z.object({
  id: z.string().min(1),
  timerId: z.string().min(1),
  firedAt: timerTimestampSchema,
  scheduledFor: timerTimestampSchema,
  lagMs: z.number().int(),
  outcome: z.enum(['ok', 'error', 'skipped']),
  sessionId: z.string().min(1),
});

/**
 * Тело создания таймера/будильника через HTTP (PROP-141, этап 5 B-2).
 *
 * Отличие от записи `Timer`/`timerCreateInputSchema`: это **интент** — правило
 * первого срабатывания, а не вычисленная метка времени:
 * - `repeat.mode = 'once'` + `kind:'timer'` — относительная задержка `delaySec`;
 * - `repeat.mode = 'once'` + `kind:'alarm'` — абсолютное время `at`;
 * - `repeat.mode = 'daily'|'every'` — правило повтора (метку вычисляет движок).
 *
 * `projectId` в теле необязателен: сервер выводит его из сессии
 * (`sessionId`) и сверяет с переданным (несовпадение → 400). `ownerId` в теле
 * **нет**: владелец — текущий пользователь (для service-key — `service:<keyId>`).
 */
export const timerIntentRequestSchema = z.object({
  kind: timerKindSchema,
  name: z.string().min(1).optional(),
  comment: timerCommentSchema,
  sessionId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  repeat: timerRepeatSchema,
  delaySec: z.number().int().optional(),
  at: timerTimestampSchema.optional(),
  /** Разрешить семантический дубликат (см. ADR-141); по умолчанию — нет. */
  allow_duplicate: z.boolean().optional(),
});

/**
 * Тело частичной правки таймера через HTTP (PROP-141, этап 5 B-2).
 *
 * Правятся только «смысловые» поля: `name` (`null` — сбросить), `comment`
 * и `repeat` (смена правила повтора пересчитывает ближайшее срабатывание —
 * это делает движок). Статус (`status`) и метка времени (`firesAt`) — не в
 * HTTP-контракте: их меняют операции паузы/возобновления.
 */
export const timerPatchRequestSchema = z.object({
  name: z.string().min(1).nullable().optional(),
  comment: timerCommentSchema.optional(),
  repeat: timerRepeatSchema.optional(),
});
