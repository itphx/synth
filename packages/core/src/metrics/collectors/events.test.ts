/**
 * ADR-094: метрики внешних событий.
 * `onIngest` — source/outcome, `onDecision` — kind (решение `bind`
 * нормализуется к `bound`), размер журнала — фоновой gauge.
 */
import { describe, it, expect, vi } from 'vitest';
import type { EventJournalRepository } from '../../storage/ports/event-journal-repository.js';
import { MetricsRegistry } from '../registry.js';
import { createEventMetrics, startEventJournalMetrics } from './events.js';

describe('createEventMetrics', () => {
  it('ingest по source/outcome, decision kind с нормализацией bind→bound', () => {
    const registry = new MetricsRegistry();
    const metrics = createEventMetrics(registry);

    metrics.onIngest({ source: 'telegram', outcome: 'ok' });
    metrics.onIngest({ source: 'telegram', outcome: 'error' });
    metrics.onIngest({ source: '', outcome: 'ok' });

    metrics.onDecision({ kind: 'bound', sessionId: 's1' });
    metrics.onDecision({ kind: 'bind', agentTemplate: 'assistant', signals: ['auto-bind'] });
    metrics.onDecision({ kind: 'drop', reason: 'no_route', audited: true });

    const text = registry.render().text;
    expect(text).toContain('synth_events_ingested_total{source="telegram",outcome="ok"} 1');
    expect(text).toContain('synth_events_ingested_total{source="telegram",outcome="error"} 1');
    expect(text).toContain('synth_events_ingested_total{source="unknown",outcome="ok"} 1');
    expect(text).toContain('synth_event_decisions_total{kind="bound"} 2');
    expect(text).toContain('synth_event_decisions_total{kind="drop"} 1');
  });
});

describe('startEventJournalMetrics', () => {
  it('публикует размер журнала и останавливается', async () => {
    const registry = new MetricsRegistry();
    const list = vi.fn(async () => [{ id: '1' }, { id: '2' }, { id: '3' }]);
    const journal = { list } as unknown as EventJournalRepository;

    const stop = startEventJournalMetrics(registry, journal, { intervalMs: 10_000 });
    await vi.waitFor(() => {
      expect(registry.render().text).toContain('synth_event_journal_size 3');
    });

    stop();
    const calls = list.mock.calls.length;
    stop();
    expect(list.mock.calls.length).toBe(calls);
  });
});
