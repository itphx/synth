/**
 * ADR-094: `createLlmCallRecorder` — телеметрия одного LLM-вызова.
 *
 * Контракт: counter запросов по `provider`/`model`/`outcome`, histogram
 * длительности по `provider`/`model`, counter токенов по `kind`
 * (`input`/`output`/`cache_read`/`cache_write`/`reasoning`); нулевые/отсутствующие
 * токены не создают серий.
 */
import { describe, it, expect } from 'vitest';
import { MetricsRegistry } from '../registry.js';
import { createLlmCallRecorder } from './llm.js';

describe('createLlmCallRecorder (ADR-094)', () => {
  it('пишет requests/duration/tokens по контрактным лейблам', () => {
    const registry = new MetricsRegistry();
    const record = createLlmCallRecorder(registry);

    record({
      provider: 'itphx',
      model: 'gpt-x',
      outcome: 'ok',
      durationMs: 1500,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        reasoningTokens: 1,
      },
    });

    const byName = new Map(registry.snapshot().map((m) => [m.name, m]));

    const requests = byName.get('synth_llm_requests_total');
    expect(requests?.type).toBe('counter');
    expect(requests?.series).toEqual([
      {
        labels: { provider: 'itphx', model: 'gpt-x', outcome: 'ok' },
        value: 1,
        count: 0,
        sum: 0,
        buckets: [],
      },
    ]);

    const durations = byName.get('synth_llm_duration_seconds');
    expect(durations?.type).toBe('histogram');
    expect(durations?.series).toHaveLength(1);
    expect(durations?.series[0]?.labels).toEqual({ provider: 'itphx', model: 'gpt-x' });
    expect(durations?.series[0]?.count).toBe(1);
    expect(durations?.series[0]?.sum).toBeCloseTo(1.5, 6);

    const tokens = byName.get('synth_llm_tokens_total');
    const tokenKinds = Object.fromEntries(
      (tokens?.series ?? []).map((s) => [s.labels.kind, s.value]),
    );
    expect(tokenKinds).toEqual({
      input: 10,
      output: 5,
      cache_read: 3,
      cache_write: 2,
      reasoning: 1,
    });
  });

  it('без usage токенные серии не создаются; ошибка метрик не влияет на вызов', () => {
    const registry = new MetricsRegistry();
    const record = createLlmCallRecorder(registry);

    expect(() => record({ provider: '', model: '', outcome: 'error', durationMs: 10 })).not.toThrow();

    const byName = new Map(registry.snapshot().map((m) => [m.name, m]));
    expect(byName.get('synth_llm_requests_total')?.series[0]?.labels).toEqual({
      provider: 'unknown',
      model: 'unknown',
      outcome: 'error',
    });
    expect(byName.get('synth_llm_tokens_total')?.series).toEqual([]);
  });
});
