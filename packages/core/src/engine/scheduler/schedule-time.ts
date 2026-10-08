import type { Schedule } from '@itphx/synth-shared';
import { nextCronDate } from './cron.js';
import { parseDurationMs } from './duration.js';

/** AD-051/AD-089: триггер расписания — ровно одно из `cron` / `every`. */
export type ScheduleTrigger = Pick<Schedule, 'cron' | 'every'>;

/**
 * Ближайшее срабатывание расписания после `from`: для `cron` — `nextCronDate`,
 * для `every` — `from + интервал`. Ни одно поле не задано → `Error`.
 */
export function nextRunAt(schedule: ScheduleTrigger, from: Date): Date {
  if (schedule.cron && schedule.cron.trim()) return nextCronDate(schedule.cron, from);
  if (schedule.every && schedule.every.trim()) {
    return new Date(from.getTime() + parseDurationMs(schedule.every));
  }
  throw new Error('nextRunAt: у расписания должно быть задано поле cron или every');
}
