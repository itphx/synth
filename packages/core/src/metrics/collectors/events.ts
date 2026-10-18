/**
 * ADR-094: метрики внешних событий.
 *
 * `synth_events_ingested_total{source,outcome}` — приём (`EventIngress.ingest`),
 * `synth_event_decisions_total{kind}` — решение Router (`bound`/`ephemeral`/
 * `queue`/`drop`; `bind` нормализуется к `bound`), `synth_event_journal_size` —
 * размер журнала (фоновой подсчёт раз в 5 минут).
 */
import type { RouteDecision } from '@itphx/synth-shared';
import type { EventJournalRepository } from '../../storage/ports/event-journal-repository.js';
import type { MetricsRegistry } from '../registry.js';

/** Период подсчёта журнала, мс. */
export const EVENT_JOURNAL_INTERVAL_MS = 300_000;

/** Колбэки метрик событий (передаются в EventIngress/EventRouter). */
export interface EventMetricsHooks {
  onIngest: (info: { source: string; outcome: 'ok' | 'error' }) => void;
  onDecision: (decision: RouteDecision) => void;
}

/** Создать колбэки метрик приёма/решений. */
export function createEventMetrics(registry: MetricsRegistry): EventMetricsHooks {
  const ingested = registry.counter(
    'synth_events_ingested_total',
    'Total number of ingested external events.',
    ['source', 'outcome'],
  );
  const decisions = registry.counter(
    'synth_event_decisions_total',
    'Total number of event routing decisions by kind.',
    ['kind'],
  );

  return {
    onIngest(info) {
      try {
        ingested.inc({ source: info.source || 'unknown', outcome: info.outcome });
      } catch {
        // ignore
      }
    },
    onDecision(decision) {
      try {
        const kind = decision.kind === 'bind' ? 'bound' : decision.kind;
        decisions.inc({ kind });
      } catch {
        // ignore
      }
    },
  };
}

/** Фоновой gauge размера журнала событий. */
export function startEventJournalMetrics(
  registry: MetricsRegistry,
  journal: EventJournalRepository,
  options: { intervalMs?: number } = {},
): () => void {
  const size = registry.gauge(
    'synth_event_journal_size',
    'Number of entries in the external event journal.',
  );

  let stopped = false;
  const collect = async (): Promise<void> => {
    if (stopped) return;
    try {
      const entries = await journal.list();
      size.set(entries.length);
    } catch {
      // ignore
    }
  };

  void collect();
  const timer = setInterval(() => {
    void collect();
  }, options.intervalMs ?? EVENT_JOURNAL_INTERVAL_MS);
  timer.unref?.();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
