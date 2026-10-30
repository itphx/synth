/**
 * ADR-094: коллекторы событий шины сессии (`EventBus.subscribeAll`).
 *
 * Считаем только терминальные исходы хода — по одному разу на запущенный ход.
 * Начало хода — `turn.started` (ADR-118 §4) либо прежний `stream.start`
 * (процессор очереди) — это два сигнала одного хода, поэтому второй не
 * увеличивает счётчик активных ходов. Терминал — `turn.finished` (статус хода)
 * либо `stream.error`/`stream.cancelled` (контракт вне ADR-118).
 *
 * Расход шага (`usage` + стоимость) приходит в `step.finished` — замена
 * удалённого `stream.usage`/`stream.done` (ADR-118 §4, таблица «Удаляемые
 * события и их замена»). Стоимость суммируется по шагам: шаг = один вызов
 * LLM, поэтому сумма шагов равна стоимости хода.
 */
import type { BusEvent } from '@itphx/synth-shared';
import type { MetricsRegistry } from '../registry.js';
import type { EventBus } from '../../events/bus.js';

/** Исходы хода (контракт ADR-094). */
export type TurnOutcome = 'ok' | 'error' | 'cancelled';

/**
 * Терминальные события вне ADR-118 (контракт не менялся) и их исход.
 */
const TERMINAL: Record<string, TurnOutcome> = {
  'stream.error': 'error',
  'stream.cancelled': 'cancelled',
};

/**
 * Исход хода по терминальному статусу `turn.finished` (ADR-118 §4).
 * `stopped` — ход остановлен без ошибки, поэтому исход прежний (`ok`).
 */
const TURN_OUTCOME: Record<string, TurnOutcome> = {
  completed: 'ok',
  error: 'error',
  cancelled: 'cancelled',
  stopped: 'ok',
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

  /** sessionId → число активных ходов (защита от двойного терминала). */
  const active = new Map<string, number>();
  /** Последние provider/model хода — для ретраев (в `stream.retry` их нет). */
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
    // ADR-118: шаг несёт `costUsd`/`costCurrency` — читаем оба написания.
    const usd = asNumber(data.cost_usd) ?? asNumber(data.costUsd);
    const amount = usd ?? asNumber(data.cost);
    if (amount === undefined) return;
    const currency = asString(data.cost_currency)
      ?? asString(data.costCurrency)
      ?? asString(data.currency)
      ?? (usd !== undefined ? 'USD' : undefined);
    if (!currency) return;
    cost.inc({ currency }, amount);
  };

  const unsubscribe = eventBus.subscribeAll((event: BusEvent) => {
    try {
      const data = asRecord(event.data);

      // Начало хода: `turn.started` (ADR-118) либо `stream.start` (прежний
      // сигнал процессора очереди) — это один и тот же ход, поэтому активный
      // ход считается один раз.
      if (event.type === 'turn.started' || event.type === 'stream.start') {
        rememberModel(event);
        if ((active.get(event.sessionId) ?? 0) === 0) {
          active.set(event.sessionId, 1);
          activeStreams.inc();
        }
        return;
      }

      // ADR-118 §4: `step.finished` несёт расход шага (`usage` + стоимость) —
      // замена `stream.usage`. Провайдер/модель запоминаем отсюда (в шаге их
      // несёт сам payload).
      if (event.type === 'step.finished') {
        rememberModel(event);
        recordCost(data);
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

      // Терминал хода: `turn.finished` (ADR-118) либо `stream.error`/
      // `stream.cancelled` (контракт вне ADR-118).
      const outcome = event.type === 'turn.finished'
        ? TURN_OUTCOME[asString(data.status) ?? '']
        : TERMINAL[event.type];
      if (!outcome) return;

      rememberModel(event);

      // Терминал без наблюдённого старта (коллектор подключён позже/рестарт
      // процесса) не считается, иначе счётчик и gauge разъедутся.
      const running = active.get(event.sessionId) ?? 0;
      if (running <= 0) return;
      active.delete(event.sessionId);
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
