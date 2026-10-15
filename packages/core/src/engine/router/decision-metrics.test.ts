/**
 * Тесты агрегатных метрик decision-слоя (ADR-084): накопление счётчиков,
 * разбивка по моделям, фоллбек/эскалация, сброс.
 */
import { describe, it, expect } from 'vitest';
import { DecisionMetrics } from './decision-metrics.js';
import type { DecisionCascadeOutcome } from './decision-cascade.js';

function acceptedPrimary(provider = 'p', model = 'm', latencyMs = 10): DecisionCascadeOutcome {
  return {
    accepted: true,
    label: 'a',
    confidence: 0.9,
    tier: 'primary',
    providerName: provider,
    modelName: model,
    latencyMs,
    attempts: [
      { tier: 'primary', providerName: provider, modelName: model, status: 'ok', latencyMs, label: 'a', confidence: 0.9 },
    ],
    lastStatus: 'ok',
  };
}

function escalated(provider = 'e', model = 'em', latencyMs = 20): DecisionCascadeOutcome {
  return {
    accepted: true,
    label: 'a',
    confidence: 0.95,
    tier: 'escalation',
    providerName: provider,
    modelName: model,
    latencyMs: 3 + latencyMs,
    attempts: [
      { tier: 'primary', providerName: 'p', modelName: 'm', status: 'low_confidence', latencyMs: 3, label: 'a', confidence: 0.4 },
      { tier: 'escalation', providerName: provider, modelName: model, status: 'ok', latencyMs, label: 'a', confidence: 0.95 },
    ],
    lastStatus: 'ok',
  };
}

function rejected(provider = 'p', model = 'm'): DecisionCascadeOutcome {
  return {
    accepted: false,
    latencyMs: 5,
    attempts: [
      { tier: 'primary', providerName: provider, modelName: model, status: 'low_confidence', latencyMs: 5, label: 'a', confidence: 0.1 },
    ],
    lastStatus: 'low_confidence',
    lastLabel: 'a',
  };
}

describe('DecisionMetrics (ADR-084)', () => {
  it('начинается с нулей', () => {
    const snap = new DecisionMetrics().snapshot();
    expect(snap).toEqual({
      calls: 0,
      handled: 0,
      fallback: 0,
      escalated: 0,
      attempts: { primary: 0, escalation: 0 },
      rejected: { ok: 0, low_confidence: 0, invalid: 0, no_answer: 0, no_provider: 0, error: 0 },
      by_model: {},
    });
  });

  it('считает calls/handled/fallback и распределение статусов', () => {
    const metrics = new DecisionMetrics();
    metrics.recordOutcome(acceptedPrimary());
    metrics.recordOutcome(rejected());
    metrics.recordOutcome({
      accepted: false,
      latencyMs: 0,
      attempts: [{ tier: 'primary', providerName: 'p', modelName: 'm', status: 'no_provider', latencyMs: 0 }],
      lastStatus: 'no_provider',
    });

    const snap = metrics.snapshot();
    expect(snap.calls).toBe(3);
    expect(snap.handled).toBe(1);
    expect(snap.fallback).toBe(2);
    expect(snap.attempts).toEqual({ primary: 3, escalation: 0 });
    expect(snap.rejected.ok).toBe(1);
    expect(snap.rejected.low_confidence).toBe(1);
    expect(snap.rejected.no_provider).toBe(1);
  });

  it('escalated и счётчики попыток по тирам', () => {
    const metrics = new DecisionMetrics();
    metrics.recordOutcome(escalated());

    const snap = metrics.snapshot();
    expect(snap.calls).toBe(1);
    expect(snap.handled).toBe(1);
    expect(snap.escalated).toBe(1);
    expect(snap.attempts).toEqual({ primary: 1, escalation: 1 });
    expect(snap.rejected.low_confidence).toBe(1);
    expect(snap.rejected.ok).toBe(1);
  });

  it('by_model: calls/handled/latency avg и max по попыткам модели', () => {
    const metrics = new DecisionMetrics();
    metrics.recordOutcome(acceptedPrimary('p', 'm', 10));
    metrics.recordOutcome(acceptedPrimary('p', 'm', 30));
    metrics.recordOutcome(escalated('e', 'em', 20));

    const snap = metrics.snapshot();
    // p/m: два успешных primary (10, 30) + low_confidence primary из escalated (3).
    expect(snap.by_model['p/m']).toEqual({
      calls: 3,
      handled: 2,
      latency_ms_avg: 14,
      latency_ms_max: 30,
    });
    expect(snap.by_model['e/em']).toEqual({
      calls: 1,
      handled: 1,
      latency_ms_avg: 20,
      latency_ms_max: 20,
    });
  });

  it('reset очищает все накопители', () => {
    const metrics = new DecisionMetrics();
    metrics.recordOutcome(acceptedPrimary());
    metrics.recordOutcome(escalated());
    metrics.reset();
    expect(metrics.snapshot()).toEqual({
      calls: 0,
      handled: 0,
      fallback: 0,
      escalated: 0,
      attempts: { primary: 0, escalation: 0 },
      rejected: { ok: 0, low_confidence: 0, invalid: 0, no_answer: 0, no_provider: 0, error: 0 },
      by_model: {},
    });
  });
});
