/**
 * ADR-094: зеркало decision-метрик (`registerDecisionMetrics`).
 * Счётчики монотонны: прирост относительно предыдущего снимка, сброс источника
 * не уменьшает Prometheus-counter.
 */
import { describe, it, expect } from 'vitest';
import { MetricsRegistry } from '../registry.js';
import type { DecisionMetricsSnapshot } from '../../engine/router/decision-metrics.js';
import { registerDecisionMetrics } from './decision.js';

function snapshot(overrides: Partial<DecisionMetricsSnapshot> = {}): DecisionMetricsSnapshot {
  return {
    calls: 0,
    handled: 0,
    fallback: 0,
    escalated: 0,
    attempts: { primary: 0, escalation: 0 },
    rejected: { ok: 0, low_confidence: 0, invalid: 0, no_answer: 0, no_provider: 0, error: 0 },
    by_model: {},
    ...overrides,
  };
}

describe('registerDecisionMetrics', () => {
  it('пишет прирост снимка и не уменьшает counter при reset источника', () => {
    const registry = new MetricsRegistry();
    let current = snapshot({
      calls: 3,
      handled: 2,
      fallback: 1,
      escalated: 1,
      attempts: { primary: 4, escalation: 1 },
      rejected: { ...snapshot().rejected, ok: 3, error: 2 },
    });
    const stop = registerDecisionMetrics(registry, () => current);

    const first = registry.render().text;
    expect(first).toContain('synth_decision_calls_total 3');
    expect(first).toContain('synth_decision_handled_total 2');
    expect(first).toContain('synth_decision_fallback_total 1');
    expect(first).toContain('synth_decision_escalated_total 1');
    expect(first).toContain('synth_decision_attempts_total 5');
    expect(first).toContain('synth_decision_rejected_total 5');

    current = snapshot({ calls: 5, handled: 4, attempts: { primary: 6, escalation: 0 } });
    const second = registry.render().text;
    expect(second).toContain('synth_decision_calls_total 5');
    expect(second).toContain('synth_decision_handled_total 4');

    // Сброс источника (ADR-084 `DELETE /settings/decision/metrics`) не откатывает counter.
    current = snapshot();
    const third = registry.render().text;
    expect(third).toContain('synth_decision_calls_total 5');
    expect(third).toContain('synth_decision_handled_total 4');

    stop();
    // После отписки коллектор больше не вызывается.
    current = snapshot({ calls: 10 });
    expect(registry.render().text).toContain('synth_decision_calls_total 5');
  });
});
