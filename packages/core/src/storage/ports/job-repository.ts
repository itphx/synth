import type { ScheduleJob } from '@itphx/synth-shared';
import type { JobListOptions } from '../job-store.js';

/**
 * Порт append-only истории срабатываний расписаний (ADR-051, реализация — `JobStore`).
 */
export interface JobRepository {
  append(job: ScheduleJob): Promise<void>;
  /**
   * История в порядке добавления (старые → новые); фильтр `scheduleId`, `limit` — последние N.
   * @future-backend — `WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?`.
   */
  list(opts?: JobListOptions): Promise<ScheduleJob[]>;
  /** Retention-очистка по `startedAt`; число удалённых. */
  prune(retentionDays: number): Promise<number>;
}
