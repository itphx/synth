/**
 * ADR-094 / PROP-141: метрики движка таймеров и будильников.
 *
 * Каталог:
 * - `synth_timer_active{kind}` — активных таймеров по виду (`timer`/`alarm`);
 * - `synth_timer_firings_total{kind,outcome}` — срабатываний по виду и исходу
 *   (`ok`/`error`/`skipped`);
 * - `synth_timer_lag_seconds` — задержка срабатывания относительно плана
 *   (гистограмма, секунды).
 *
 * ## Контракт ADR-094
 *
 * - имена — только `synth_*`;
 * - лейблы — только из фиксированного списка (`kind`/`outcome` входят в него);
 * - **никаких id** (таймера/сессии/проекта) и текстов комментария в лейблях —
 *   иначе кардинальность серий взорвётся, а пользовательский текст утечёт в
 *   скрейп;
 * - значения лейблов приводятся к конечным наборам, неизвестное → `other`.
 */
import type { TimerFiringOutcome, TimerKind } from '@itphx/synth-shared';
import type { MetricsRegistry } from '../registry.js';

/** Корзины гистограммы задержки срабатывания (секунды). */
export const TIMER_LAG_BUCKETS: readonly number[] = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300,
];

/** Виды автоматизации (конечный набор лейбла `kind`). */
export const TIMER_METRIC_KINDS: readonly TimerKind[] = ['timer', 'alarm'];

/** Исходы срабатывания (конечный набор лейбла `outcome`). */
export const TIMER_METRIC_OUTCOMES: readonly TimerFiringOutcome[] = ['ok', 'error', 'skipped'];

/** Счётчики активных таймеров по видам. */
export type TimerActiveCounts = Record<TimerKind, number>;

/**
 * Колбэки метрик таймеров — их вызывает движок (`TimerService`).
 *
 * Ошибки метрик не должны влиять на движок: вызовы обёрнуты в try/catch
 * на стороне коллектора.
 */
export interface TimerMetricsHooks {
  /** Число активных таймеров по видам (пересчитывает движок). */
  setActive: (counts: TimerActiveCounts) => void;
  /** Срабатывание завершено (исход + задержка). */
  onFiring: (info: {
    kind: TimerKind;
    outcome: TimerFiringOutcome;
    lagSeconds: number;
  }) => void;
}

/** Приведение вида автоматизации к конечному набору: неизвестное → `other`. */
export function normalizeTimerMetricKind(value: string | undefined): string {
  if (!value) return 'other';
  return TIMER_METRIC_KINDS.includes(value as TimerKind) ? value : 'other';
}

/** Приведение исхода срабатывания к конечному набору: неизвестное → `other`. */
export function normalizeTimerFiringOutcome(value: string | undefined): string {
  if (!value) return 'other';
  return TIMER_METRIC_OUTCOMES.includes(value as TimerFiringOutcome) ? value : 'other';
}

/** Создать колбэки метрик таймеров (регистрируют серии в общем реестре). */
export function createTimerMetrics(registry: MetricsRegistry): TimerMetricsHooks {
  const active = registry.gauge(
    'synth_timer_active',
    'Number of active timers by kind.',
    ['kind'],
  );
  const firings = registry.counter(
    'synth_timer_firings_total',
    'Total number of timer firings by kind and outcome.',
    ['kind', 'outcome'],
  );
  const lag = registry.histogram(
    'synth_timer_lag_seconds',
    'Delay of timer firing relative to the scheduled time in seconds.',
    [],
    TIMER_LAG_BUCKETS,
  );

  return {
    setActive: (counts: TimerActiveCounts): void => {
      try {
        for (const kind of TIMER_METRIC_KINDS) {
          active.set({ kind }, counts[kind] ?? 0);
        }
      } catch {
        // Метрики не должны ломать движок.
      }
    },
    onFiring: (info): void => {
      try {
        firings.inc({
          kind: normalizeTimerMetricKind(info.kind),
          outcome: normalizeTimerFiringOutcome(info.outcome),
        });
        lag.observe(info.lagSeconds);
      } catch {
        // Метрики не должны ломать движок.
      }
    },
  };
}
