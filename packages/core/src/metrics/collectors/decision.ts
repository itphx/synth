/**
 * ADR-094: зеркало агрегатных метрик decision-слоя (ADR-084).
 *
 * Снимок `decisionMetrics.snapshot()` отдаётся при каждом скрейпе
 * (`registry.addCollector`) и превращается в counter-серии. Счётчики монотонны:
 * пишем только прирост относительно предыдущего снимка, поэтому `reset()`
 * метрик не «уменьшает» Prometheus-счётчики.
 */
import { decisionMetrics, type DecisionMetricsSnapshot } from '../../engine/router/decision-metrics.js';
import type { CounterMetric, MetricsRegistry } from '../registry.js';

/** Создать collector-зеркало decision-метрик. Возвращает функцию отписки. */
export function registerDecisionMetrics(
  registry: MetricsRegistry,
  snapshot: () => DecisionMetricsSnapshot = () => decisionMetrics.snapshot(),
): () => void {
  const calls = registry.counter('synth_decision_calls_total', 'Total number of decision-layer calls.');
  const handled = registry.counter('synth_decision_handled_total', 'Total number of handled decisions.');
  const fallback = registry.counter('synth_decision_fallback_total', 'Total number of decision fallbacks.');
  const escalated = registry.counter('synth_decision_escalated_total', 'Total number of escalated decisions.');
  const attempts = registry.counter('synth_decision_attempts_total', 'Total number of decision attempts.');
  const rejected = registry.counter('synth_decision_rejected_total', 'Total number of rejected decision attempts.');

  const last = new Map<CounterMetric, number>();

  const setTotal = (counter: CounterMetric, value: number): void => {
    const previous = last.get(counter) ?? 0;
    if (value > previous) counter.inc(value - previous);
    last.set(counter, value);
  };

  return registry.addCollector(() => {
    const s = snapshot();
    const rejectedTotal = Object.values(s.rejected).reduce((sum, value) => sum + value, 0);
    setTotal(calls, s.calls);
    setTotal(handled, s.handled);
    setTotal(fallback, s.fallback);
    setTotal(escalated, s.escalated);
    setTotal(attempts, s.attempts.primary + s.attempts.escalation);
    setTotal(rejected, rejectedTotal);
  });
}
