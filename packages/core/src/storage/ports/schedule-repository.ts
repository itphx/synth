import type { Schedule, ScheduleInput } from '@itphx/synth-shared';
import type { ScheduleRunUpdate } from '../schedule-store.js';

/**
 * Порт реестра расписаний планировщика (ADR-051/ADR-089, реализация — `ScheduleStore`).
 */
export interface ScheduleRepository {
  list(): Promise<Schedule[]>;
  /**
   * Есть ли включённое расписание, нацеленное на сессию (не `ephemeral`).
   * @future-backend — `EXISTS`-подзапрос по индексу `target.sessionId`.
   */
  hasEnabledTargetFor(sessionId: string): Promise<boolean>;
  get(id: string): Promise<Schedule | null>;
  create(input: ScheduleInput): Promise<Schedule>;
  update(id: string, patch: Partial<ScheduleInput>): Promise<Schedule | null>;
  remove(id: string): Promise<boolean>;
  /** Фиксация результата запуска (`lastRunAt`/`lastStatus`/`lastError`/`nextRunAt`). */
  markRun(id: string, run: ScheduleRunUpdate): Promise<Schedule | null>;
  /** Обновление только `nextRunAt` (служебное поле сервиса). */
  setNextRun(id: string, nextRunAt: string | undefined): Promise<Schedule | null>;
}
