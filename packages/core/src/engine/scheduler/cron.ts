/**
 * AD-051 (минимальный срез): собственный mini-cron-парсер без внешних
 * зависимостей.
 *
 * Поддерживается 5 полей `minute hour day-of-month month day-of-week`; значение
 * считается в UTC. Токены поля: `*`, `n`, `a-b`, `a,b`, `*` со шагом (`/n`),
 * `a-b/шаг`.
 * `day-of-week` — `0..7`, где `0` и `7` — воскресенье.
 *
 * Семантика дня (как в Vixie cron): если **оба** поля `day-of-month` и
 * `day-of-week` ограничены (не `*`), день подходит при совпадении **любого** из
 * них; иначе — при совпадении ограниченного поля.
 */

const MINUTE_MS = 60_000;
/** Горизонт поиска следующего срабатывания: ~366 дней. */
const MAX_SEARCH_MS = 366 * 24 * 60 * 60 * 1000;

interface CronFieldSpec {
  min: number;
  max: number;
  title: string;
}

const FIELD_SPECS: readonly CronFieldSpec[] = [
  { min: 0, max: 59, title: 'минута' },
  { min: 0, max: 23, title: 'час' },
  { min: 1, max: 31, title: 'день месяца' },
  { min: 1, max: 12, title: 'месяц' },
  { min: 0, max: 7, title: 'день недели' },
];

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseValue(text: string, spec: CronFieldSpec): number {
  if (!/^\d+$/.test(text)) {
    throw new Error(`cron: недопустимое значение "${text}" в поле «${spec.title}»`);
  }
  const value = Number(text);
  if (value < spec.min || value > spec.max) {
    throw new Error(
      `cron: значение ${value} вне диапазона ${spec.min}-${spec.max} в поле «${spec.title}»`,
    );
  }
  return value;
}

function parseField(raw: string, spec: CronFieldSpec): { values: Set<number>; restricted: boolean } {
  const field = raw.trim();
  if (!field) throw new Error(`cron: пустое поле «${spec.title}»`);

  const values = new Set<number>();
  for (const part of field.split(',')) {
    const token = part.trim();
    if (!token) throw new Error(`cron: пустой элемент списка в поле «${spec.title}»`);

    let step = 1;
    let rangePart = token;
    const slash = token.indexOf('/');
    if (slash >= 0) {
      rangePart = token.slice(0, slash).trim();
      const stepText = token.slice(slash + 1).trim();
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        throw new Error(`cron: недопустимый шаг "${stepText}" в поле «${spec.title}»`);
      }
      step = Number(stepText);
    }

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes('-')) {
      const [fromText, toText] = rangePart.split('-');
      start = parseValue(fromText ?? '', spec);
      end = parseValue(toText ?? '', spec);
      if (start > end) {
        throw new Error(
          `cron: диапазон ${start}-${end} задан в обратном порядке в поле «${spec.title}»`,
        );
      }
    } else {
      start = parseValue(rangePart, spec);
      // `n` — одиночное значение; `n/step` — от n с шагом до максимума поля.
      end = slash >= 0 ? spec.max : start;
    }

    for (let value = start; value <= end; value += step) values.add(value);
  }

  return { values, restricted: field !== '*' };
}

function parseCron(cron: string): ParsedCron {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== FIELD_SPECS.length) {
    throw new Error(
      `cron: ожидается 5 полей (minute hour day-of-month month day-of-week), получено ${fields.length}: "${cron}"`,
    );
  }

  const minute = parseField(fields[0]!, FIELD_SPECS[0]!);
  const hour = parseField(fields[1]!, FIELD_SPECS[1]!);
  const dayOfMonth = parseField(fields[2]!, FIELD_SPECS[2]!);
  const month = parseField(fields[3]!, FIELD_SPECS[3]!);
  const dayOfWeekRaw = parseField(fields[4]!, FIELD_SPECS[4]!);
  // 0 и 7 — воскресенье: нормализуем 7 → 0.
  const dayOfWeek = new Set<number>(
    [...dayOfWeekRaw.values].map((v) => (v === 7 ? 0 : v)),
  );

  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    dayOfWeek,
    domRestricted: dayOfMonth.restricted,
    dowRestricted: dayOfWeekRaw.restricted,
  };
}

function dayMatches(parsed: ParsedCron, date: Date): boolean {
  const dom = parsed.dayOfMonth.has(date.getUTCDate());
  const dow = parsed.dayOfWeek.has(date.getUTCDay());
  if (parsed.domRestricted && parsed.dowRestricted) return dom || dow;
  return dom && dow;
}

/** Проверяет валидность 5-полевого cron-выражения (без вычисления даты). */
export function isValidCron(cron: string): boolean {
  try {
    parseCron(cron);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ближайшая дата срабатывания cron-выражения строго после `from` (значение в
 * UTC, секунды/миллисекунды обнуляются). Невалидное выражение или отсутствие
 * срабатывания в течение ~366 дней → `Error`.
 */
export function nextCronDate(cron: string, from: Date): Date {
  const parsed = parseCron(cron);
  const start = new Date(from.getTime());
  start.setUTCSeconds(0, 0);

  const startMs = start.getTime();
  const limit = startMs + MAX_SEARCH_MS;
  for (let t = startMs + MINUTE_MS; t <= limit; t += MINUTE_MS) {
    const date = new Date(t);
    if (!parsed.month.has(date.getUTCMonth() + 1)) continue;
    if (!parsed.hour.has(date.getUTCHours())) continue;
    if (!parsed.minute.has(date.getUTCMinutes())) continue;
    if (!dayMatches(parsed, date)) continue;
    return date;
  }

  throw new Error(`cron: не найдено срабатывание в течение года для "${cron}"`);
}
