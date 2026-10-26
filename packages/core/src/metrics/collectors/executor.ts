/**
 * ADR-094: метрики исполнения команд (ADR-077, шаг 7d) — сторона control plane.
 *
 * Каталог:
 * - `synth_executor_queue_depth` — gauge: запросов в очереди на отправку
 *   исполнителю (ждут слот пула);
 * - `synth_executor_workers_busy` — gauge: занятых слотов пула;
 * - `synth_executor_wait_seconds` — histogram: ожидание в очереди до отправки;
 * - `synth_executor_commands_total{outcome}` — counter: доставленные исполнителю
 *   вызовы по исходу (`ok`/`error`/`timeout`/`cancelled`).
 *
 * ## Контракт ADR-094
 *
 * - имена — только `synth_*`;
 * - лейблы — только из фиксированного списка; здесь единственный — `outcome`
 *   (в закрытом списке ADR-094);
 * - **никаких id**: адреса исполнителей, идентификаторы команд и сессий в
 *   лейблах нет — иначе кардинальность серий взорвётся. Значения `outcome`
 *   приводятся к конечному набору (неизвестное → `error`);
 * - ошибка метрик не влияет на исполнение команды (вызовы обёрнуты в
 *   try/catch).
 *
 * ## Стороны счёта
 *
 * `synth_executor_commands_total` на этой стороне считает **доставленные
 * исполнителю вызовы** (control plane), а такой же счётчик на исполнителе —
 * **исполненные команды**. Счётчика «одна команда в двух местах» нет: при
 * скрейпе обоих эндпоинтов серии различаются лейблом `job` Prometheus, но
 * суммировать их в одну метрику нельзя (см. `docs/OBSERVABILITY.md`).
 */
import type { ExecutionMetricsOutcome, ExecutionMetricsSink } from '../../execution/ports/index.js';
import type { MetricsRegistry } from '../registry.js';

/**
 * Корзины гистограммы ожидания в очереди (секунды).
 *
 * Сетка рассчитана на типичный порядок величин: миллисекунды (слот есть) →
 * секунды (ожидание) → десятки секунд (пул занят).
 */
export const EXECUTOR_WAIT_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

/** Исходы команд — закрытый набор (лейбл `outcome`). */
const OUTCOMES: readonly string[] = ['ok', 'error', 'timeout', 'cancelled'];

/**
 * Приведение исхода к конечному набору: неизвестное → `error`.
 *
 * Причина неудачи порта (`ExecutionError.reason`) приводится к исходу
 * **вызывающей** стороной (клиент удалённого порта); коллектор лишь
 * страхуется от значения, которого в контракте нет.
 */
export function normalizeExecutorOutcome(value: string | undefined): ExecutionMetricsOutcome {
  if (!value) return 'error';
  return (OUTCOMES.includes(value) ? value : 'error') as ExecutionMetricsOutcome;
}

/**
 * Создать приёмник метрик исполнения поверх реестра (ADR-094).
 *
 * Реестр — **общий** (`MetricsRegistry` процесса); второй реестр не
 * заводится. Ошибки метрик не пробрасываются: метрика не должна ломать
 * исполнение команды.
 *
 * @param registry реестр метрик процесса
 * @returns приёмник для порта исполнения (`ExecutionMetricsSink`)
 */
export function createExecutorMetricsCollector(registry: MetricsRegistry): ExecutionMetricsSink {
  const queueDepth = registry.gauge(
    'synth_executor_queue_depth',
    'Number of executor requests waiting in the queue for a pool slot.',
  );
  const workersBusy = registry.gauge(
    'synth_executor_workers_busy',
    'Number of busy executor pool slots.',
  );
  const waitSeconds = registry.histogram(
    'synth_executor_wait_seconds',
    'Time spent waiting in the queue before sending a command to an executor.',
    [],
    EXECUTOR_WAIT_BUCKETS,
  );
  const commands = registry.counter(
    'synth_executor_commands_total',
    'Total number of executor commands delivered by outcome.',
    ['outcome'],
  );

  // Счётчики ведём сами: gauge не должен уходить в минус (иначе «−1 ожидающих»
  // — бессмысленное значение в дашборде).
  let queued = 0;
  let busy = 0;

  // Нули на старте: серии существуют с первого скрейпа (иначе «нет данных» и
  // «ноль» неразличимы, а дашборд «очередь пула» показывает пустоту).
  queueDepth.set(0);
  workersBusy.set(0);

  return {
    onQueued(): void {
      try {
        queued += 1;
        queueDepth.set(queued);
      } catch {
        // ignore
      }
    },
    onDequeued(waitMs: number): void {
      try {
        queued = Math.max(0, queued - 1);
        queueDepth.set(queued);
        if (Number.isFinite(waitMs) && waitMs >= 0) {
          waitSeconds.observe(waitMs / 1000);
        }
      } catch {
        // ignore
      }
    },
    onStarted(): void {
      try {
        busy += 1;
        workersBusy.set(busy);
      } catch {
        // ignore
      }
    },
    // Длительность команды на стороне control plane не измеряется: её считает
    // исполнитель (свой `synth_executor_exec_duration_seconds`) — двойного
    // счёта нет.
    onFinished(outcome: ExecutionMetricsOutcome): void {
      try {
        busy = Math.max(0, busy - 1);
        workersBusy.set(busy);
        commands.inc({ outcome: normalizeExecutorOutcome(outcome) });
      } catch {
        // ignore
      }
    },
  };
}
