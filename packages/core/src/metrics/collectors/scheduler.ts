/**
 * ADR-094: метрики планировщика.
 *
 * `synth_scheduler_jobs_total{outcome}` — завершённые Job (`ok`/`error`;
 * `skipped` — не ошибка и учитывается как `ok`), `synth_scheduler_drift_seconds`
 * — дрейф последнего cron-срабатывания (факт минус плановое время).
 */
import type { ScheduleJob } from '@itphx/synth-shared';
import type { MetricsRegistry } from '../registry.js';

/** Информация о записанном Job планировщика. */
export interface SchedulerJobInfo {
  status: ScheduleJob['status'];
  durationMs: number;
  driftSec?: number;
}

/** Колбэк метрик планировщика (передаётся в `SchedulerService`). */
export type SchedulerJobMetrics = (info: SchedulerJobInfo) => void;

/** Создать колбэк метрик Job'ов. */
export function createSchedulerMetrics(registry: MetricsRegistry): SchedulerJobMetrics {
  const jobs = registry.counter(
    'synth_scheduler_jobs_total',
    'Total number of scheduler jobs by outcome.',
    ['outcome'],
  );
  const drift = registry.gauge(
    'synth_scheduler_drift_seconds',
    'Drift of the last scheduled run in seconds.',
  );

  return (info: SchedulerJobInfo): void => {
    try {
      jobs.inc({ outcome: info.status === 'error' ? 'error' : 'ok' });
      if (typeof info.driftSec === 'number' && Number.isFinite(info.driftSec)) {
        drift.set(info.driftSec);
      }
    } catch {
      // ignore
    }
  };
}
