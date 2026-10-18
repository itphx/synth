/**
 * ADR-094: коллекторы событий шины сессии (`EventBus.subscribeAll`).
 *
 * Считаем только терминальные исходы хода — `stream.done`/`stream.error`/
 * `stream.cancelled` — по одному разу на запущенный стрим (`stream.start`).
 * `stream.usage` — live-событие и в счётчики не попадает (иначе двойной учёт);
 * из него берём только provider/model для ретраев и контекста.
 *
 * Стоимость (`synth_llm_cost_total{currency}`) — только терминальные события:
 * `stream.usage` публикуется многократно и не должен суммироваться.
 */
import type { BusEvent } from '@itphx/synth-shared';
import type { MetricsRegistry } from '../registry.js';
import type { EventBus } from '../../events/bus.js';

/** Исходы хода (контракт ADR-094). */
export type TurnOutcome = 'ok' | 'error' | 'cancelled';

/** Терминальные типы событий и их исход. */
const TERMINAL: Record<string, TurnOutcome> = {
  'stream.done': 'ok',
  'stream.error': 'error',
  'stream.cancelled': 'cancelled',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Подписать коллекторы на шину. Возвращает функцию отписки (останавливает
 * счётчики; gauge активных стримов обнуляется).
 */
export function attachBusMetrics(registry: MetricsRegistry, eventBus: EventBus): () => void {
  const turns = registry.counter(
    'synth_turns_total',
    'Total number of agent turns by outcome.',
    ['outcome'],
  );
  const activeStreams = registry.gauge(
    'synth_active_streams',
    'Number of agent turns currently streaming.',
  );
  const retries = registry.counter(
    'synth_llm_retries_total',
    'Total number of LLM retries.',
    ['provider', 'model'],
  );
  const cost = registry.counter(
    'synth_llm_cost_total',
    'Total LLM cost by currency.',
    ['currency'],
  );

  /** sessionId → число активных стримов (защита от двойного терминала). */
  const active = new Map<string, number>();
  /** Последние provider/model стрима — для ретраев (в `stream.retry` их нет). */
  const lastModel = new Map<string, { provider: string; model: string }>();

  const rememberModel = (event: BusEvent): void => {
    const data = asRecord(event.data);
    const provider = asString(data.provider);
    const model = asString(data.model);
    if (provider || model) {
      lastModel.set(event.sessionId, {
        provider: provider ?? lastModel.get(event.sessionId)?.provider ?? 'unknown',
        model: model ?? lastModel.get(event.sessionId)?.model ?? 'unknown',
      });
    }
  };

  const recordCost = (data: Record<string, unknown>): void => {
    // `cost_usd` — исторически USD-поле; `cost` + `currency` — общая форма.
    const usd = asNumber(data.cost_usd);
    const amount = usd ?? asNumber(data.cost);
    if (amount === undefined) return;
    const currency = asString(data.cost_currency) ?? asString(data.currency) ?? (usd !== undefined ? 'USD' : undefined);
    if (!currency) return;
    cost.inc({ currency }, amount);
  };

  const unsubscribe = eventBus.subscribeAll((event: BusEvent) => {
    try {
      const data = asRecord(event.data);
      if (event.type === 'stream.start') {
        active.set(event.sessionId, (active.get(event.sessionId) ?? 0) + 1);
        activeStreams.inc();
        rememberModel(event);
        return;
      }

      if (event.type === 'stream.usage') {
        rememberModel(event);
        return;
      }

      if (event.type === 'stream.retry') {
        const known = lastModel.get(event.sessionId);
        retries.inc({
          provider: known?.provider ?? 'unknown',
          model: known?.model ?? 'unknown',
        });
        return;
      }

      const outcome = TERMINAL[event.type];
      if (!outcome) return;

      rememberModel(event);
      recordCost(data);

      // Терминал без наблюдённого старта (коллектор подключён позже/рестарт
      // процесса) не считается, иначе счётчик и gauge разъедутся.
      const running = active.get(event.sessionId) ?? 0;
      if (running <= 0) return;
      if (running === 1) active.delete(event.sessionId);
      else active.set(event.sessionId, running - 1);
      turns.inc({ outcome });
      activeStreams.dec();
    } catch {
      // Ошибки метрик не должны ломать доставку событий.
    }
  });

  return () => {
    unsubscribe();
    active.clear();
    lastModel.clear();
    activeStreams.set(0);
  };
}
