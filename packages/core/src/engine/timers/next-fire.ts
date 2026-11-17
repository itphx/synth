/**
 * PROP-141 (Часть B): вычисление ближайшего срабатывания таймера/будильника.
 *
 * Без новых зависимостей: календарь — через `Intl.DateTimeFormat` (часовой
 * пояс берётся у движка, а не у машины), поэтому переход на летнее/зимнее
 * время учитывается, а «настенное» время трактуется буквально: будильник на
 * `09:00` в `Europe/Moscow` срабатывает в 09:00 по Москве, а не в 09:00 UTC.
 *
 * ## Правила повторов
 *
 * - `daily` — ближайшее **настенное** время `HH:MM` в часовом поясе таймера;
 * - `every` — `now + everySec` (интервал отсчитывается от момента срабатывания);
 * - `once` — для таймера `delaySec` (от `now`), для будильника `at` (абсолютное
 *   время из интента).
 *
 * ## Переход часов (DST)
 *
 * Настенное время в зоне перехода может быть:
 * - **неоднозначным** (переход на зимнее время: `02:30` встречается дважды) —
 *   берётся **первое** вхождение (до перехода);
 * - **несуществующим** (переход на летнее время: `02:30` не существует) —
 *   время сдвигается вперёд на величину разрыва (`02:30` → `03:30`), чтобы
 *   будильник не «пропал» в день перевода.
 */
import { TIMER_TIME_REGEX } from '@itphx/synth-shared';
import type { TimerRepeat } from '@itphx/synth-shared';
import { TimerValidationError } from './types.js';
import type { TimerIntent } from './types.js';

/** Части настенного времени в часовом поясе. */
interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Календарная дата (без времени). */
interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** Кэш форматтеров по часовым поясам (создание `Intl.DateTimeFormat` дорого). */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** Форматтер настенного времени для часового пояса. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    // `h23` — полночь всегда `00` (при `h24` часть ICU отдаёт `24`, из-за чего
    // дата «уезжает» на день назад).
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** Разложить момент на настенные части в часовом поясе. */
function zonedParts(timeZone: string, at: Date): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : Number.NaN;
  };
  const hour = read('hour');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Защита от `24` (h24 в старых ICU) — это полночь того же дня.
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
  };
}

/** Настенное время момента в TZ, приведённое к «UTC-миллисекундам». */
function wallMsOf(timeZone: string, at: Date): number {
  const parts = zonedParts(timeZone, at);
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

/** Смещение часового пояса (мс) в указанный момент: настенное время минус UTC. */
function zoneOffsetMs(timeZone: string, at: Date): number {
  return wallMsOf(timeZone, at) - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Валиден ли часовой пояс (`Intl`-совместимый IANA-идентификатор).
 *
 * Невалидный пояс — ошибка, а не молчаливый UTC: «молчаливый UTC» означал бы,
 * что будильник на 09:00 сработает не в то время, о котором думал человек.
 */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Разобрать время суток `HH:MM`; некорректное — ошибка с кодом. */
function parseTimeOfDay(time: string): { hour: number; minute: number } {
  const match = typeof time === 'string' ? TIMER_TIME_REGEX.exec(time) : null;
  if (!match) {
    throw new TimerValidationError(
      'timer_invalid_time',
      `Ожидается время в формате HH:MM (часы 00–23, минуты 00–59), получено «${String(time)}»`,
      'time',
    );
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Следующая календарная дата (по календарю, а не по +24 часа). */
function nextCalendarDate(date: CalendarDate): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Момент UTC, соответствующий настенному времени `y-m-d hh:mm` в часовом
 * поясе.
 *
 * - обычное время — один кандидат;
 * - неоднозначность (переход на зимнее время) — два кандидата, берётся
 *   **первый** (раньше перехода);
 * - разрыв (переход на летнее время) — кандидатов нет, время сдвигается
 *   вперёд на величину разрыва (минимальное смещение зоны).
 */
function resolveWallInstant(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // Смещения зоны по обе стороны возможного перехода: пробаем ±12/24/36 часов
  // от целевого настенного времени (переходы зон — раз в полгода, суточное
  // окно вокруг цели покрывает их все).
  const offsets = new Set<number>();
  for (const deltaHours of [-36, -24, -12, 0, 12, 24, 36]) {
    offsets.add(zoneOffsetMs(timeZone, new Date(target + deltaHours * 3_600_000)));
  }

  const valid: number[] = [];
  for (const offset of offsets) {
    const candidate = target - offset;
    if (wallMsOf(timeZone, new Date(candidate)) === target) valid.push(candidate);
  }
  if (valid.length > 0) {
    valid.sort((a, b) => a - b);
    // Первое вхождение (при неоднозначности — до перехода на зимнее время).
    return new Date(valid[0]!);
  }

  // Разрыв (переход на летнее время): настенного времени не существует —
  // сдвигаем вперёд на величину разрыва (минимальное смещение зоны).
  const minOffset = Math.min(...offsets);
  return new Date(target - minOffset);
}

/**
 * Ближайшее срабатывание ежедневного будильника: настенное время `time`
 * (`HH:MM`) в часовом поясе `timezone`, **строго после** `now`.
 *
 * Невалидное время или часовой пояс — ошибка (`TimerValidationError`).
 */
export function nextDailyFire(time: string, timezone: string, now: Date): Date {
  const { hour, minute } = parseTimeOfDay(time);
  if (!isValidTimezone(timezone)) {
    throw new TimerValidationError(
      'timer_invalid_timezone',
      `Неизвестный часовой пояс «${String(timezone)}»`,
      'timezone',
    );
  }

  const parts = zonedParts(timezone, now);
  const today = resolveWallInstant(timezone, parts.year, parts.month, parts.day, hour, minute);
  if (today.getTime() > now.getTime()) return today;

  const tomorrow = nextCalendarDate(parts);
  return resolveWallInstant(timezone, tomorrow.year, tomorrow.month, tomorrow.day, hour, minute);
}

/** Ближайшее срабатывание повтора `every`: `now + everySec`. */
export function nextEveryFire(everySec: number, now: Date): Date {
  return new Date(now.getTime() + everySec * 1000);
}

/**
 * Ближайшее срабатывание по правилу повтора (без учёта `once`-вида).
 *
 * Для `once` правила повтора нет — функция не вызывается.
 */
export function nextFireForRepeat(repeat: TimerRepeat, from: Date): Date | null {
  if (repeat.mode === 'daily') return nextDailyFire(repeat.time, repeat.timezone, from);
  if (repeat.mode === 'every') return nextEveryFire(repeat.everySec, from);
  return null;
}

/**
 * Ближайшее срабатывание по интенту.
 *
 * - `once` + таймер — `now + delaySec`;
 * - `once` + будильник — абсолютное время `at`;
 * - `daily`/`every` — по правилу повтора.
 */
export function resolveFirstFire(intent: TimerIntent, now: Date): Date {
  const repeat = intent.repeat;
  if (repeat.mode === 'daily') return nextDailyFire(repeat.time, repeat.timezone, now);
  if (repeat.mode === 'every') return nextEveryFire(repeat.everySec, now);

  if (intent.kind === 'timer') {
    const delay = intent.delaySec;
    if (delay === undefined || !Number.isFinite(delay)) {
      throw new TimerValidationError(
        'timer_invalid_interval',
        'Для таймера требуется задержка `delay` (секунды)',
        'delay',
      );
    }
    return new Date(now.getTime() + delay * 1000);
  }

  if (!intent.at) {
    throw new TimerValidationError(
      'timer_invalid_target',
      'Для будильника требуется абсолютное время `at`',
      'at',
    );
  }
  const at = new Date(intent.at);
  if (Number.isNaN(at.getTime())) {
    throw new TimerValidationError(
      'timer_invalid_target',
      `Некорректное время срабатывания «${String(intent.at)}»`,
      'at',
    );
  }
  return at;
}
