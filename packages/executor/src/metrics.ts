/**
 * Метрики исполнителя (ADR-077, шаг 7d; ADR-094) — **собственный** `/metrics`.
 *
 * Исполнитель — отдельный процесс, поэтому у него **свой** реестр метрик:
 * тот же `MetricsRegistry` из core (peer-зависимость пакета) и тот же рендер
 * exposition 0.0.4 — второй реестр/рендер в проекте не заводим (ADR-094).
 *
 * Каталог:
 * - `synth_executor_commands_total{outcome}` — counter: исполненные команды по
 *   исходу (`ok`/`error`/`timeout`/`cancelled`);
 * - `synth_executor_inflight` — gauge: выполняющихся сейчас команд;
 * - `synth_executor_exec_duration_seconds` — histogram: длительность исполнения;
 * - `synth_executor_mcp_servers{status}` — gauge: MCP-серверы по состоянию
 *   (`idle`/`up`/`down`).
 *
 * ## Контракт ADR-094
 *
 * - имена — только `synth_*`;
 * - лейблы — только из закрытого списка (`outcome`, `status` — оба в нём);
 * - идентификаторов (адресов, id команд, имён MCP-серверов) в лейблах нет:
 *   число MCP-серверов — это **счётчик по состоянию**, а не список имён;
 * - ошибка метрик не влияет на исполнение команды (вызовы обёрнуты в
 *   try/catch).
 *
 * ## Стороны счёта
 *
 * `synth_executor_commands_total` здесь считает **исполненные команды**
 * исполнителя; на стороне control plane такой же счётчик считает
 * **доставленные исполнителю вызовы**. Счётчика «одна команда в двух
 * местах» нет — при скрейпе обоих эндпоинтов серии различаются лейблом
 * `job` Prometheus (см. `docs/OBSERVABILITY.md`).
 */
import {
  MetricsRegistry,
  type CounterMetric,
  type GaugeMetric,
  type HistogramMetric,
} from '@itphx/synth-core';

/** Исход исполненной команды — закрытый набор (лейбл `outcome`). */
export type ExecutorCommandOutcome = 'ok' | 'error' | 'timeout' | 'cancelled';

/** Состояние MCP-сервера у исполнителя (лейбл `status`). */
export type ExecutorMcpStatus = 'idle' | 'up' | 'down';

/** Причина неудачи порта → исход команды (ADR-094). */
export type ExecutorFailureReason =
  | 'timeout'
  | 'aborted'
  | 'spawn_failed'
  | 'nonzero_exit'
  | 'max_output'
  | 'invalid_request'
  | 'cwd_outside_workspace'
  | 'too_many_requests'
  | 'internal_error';

/**
 * Корзины гистограммы длительности исполнения (секунды).
 *
 * Сетка рассчитана на типичные команды агента: миллисекунды (проба бинаря) →
 * секунды (git, сборка) → минуты (долгая сборка, тест).
 */
export const EXECUTOR_EXEC_DURATION_BUCKETS: readonly number[] = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600,
];

/** Состояния MCP-серверов — закрытый набор (лейбл `status`). */
const MCP_STATUSES: readonly ExecutorMcpStatus[] = ['idle', 'up', 'down'];

/** Исходы команд — закрытый набор (лейбл `outcome`). */
const OUTCOMES: readonly string[] = ['ok', 'error', 'timeout', 'cancelled'];

/**
 * Приведение исхода к конечному набору: неизвестное → `error`.
 *
 * Кардинальность серий ограничена: значение лейбла приходит из порта и
 * всегда приводится к одному из четырёх значений.
 */
export function normalizeExecutorOutcome(value: string | undefined): ExecutorCommandOutcome {
  if (!value) return 'error';
  return (OUTCOMES.includes(value) ? value : 'error') as ExecutorCommandOutcome;
}

/**
 * Причина неудачи → исход команды.
 *
 * Таймаут — `timeout`, отмена («Стоп») — `cancelled`, всё прочее (ненулевой
 * код выхода, не найденный бинарь, обрезанный вывод, лимит) — `error`.
 */
export function outcomeFromFailureReason(
  reason: string | undefined,
): ExecutorCommandOutcome {
  if (reason === 'timeout') return 'timeout';
  if (reason === 'aborted') return 'cancelled';
  return 'error';
}

/** Источник состояний MCP-серверов (для gauge `mcp_servers`). */
export type ExecutorMcpStatusSource = () => ReadonlyArray<{ status: ExecutorMcpStatus }>;

/** Метрики исполнителя: реестр + обновление счётчиков. */
export class ExecutorMetrics {
  /** Реестр метрик (тот же класс, что в core). */
  readonly registry: MetricsRegistry;

  private readonly _commands: CounterMetric;
  private readonly _inflight: GaugeMetric;
  private readonly _duration: HistogramMetric;
  private readonly _mcpServers: GaugeMetric;
  private _mcpSource: ExecutorMcpStatusSource | undefined;
  private _inflightCount = 0;

  constructor(opts: { mcpServers?: ExecutorMcpStatusSource } = {}) {
    this.registry = new MetricsRegistry();
    this._commands = this.registry.counter(
      'synth_executor_commands_total',
      'Total number of commands executed by the executor, by outcome.',
      ['outcome'],
    );
    this._inflight = this.registry.gauge(
      'synth_executor_inflight',
      'Number of commands currently executing on the executor.',
    );
    this._duration = this.registry.histogram(
      'synth_executor_exec_duration_seconds',
      'Duration of executed commands in seconds.',
      [],
      EXECUTOR_EXEC_DURATION_BUCKETS,
    );
    this._mcpServers = this.registry.gauge(
      'synth_executor_mcp_servers',
      'Number of MCP servers hosted by the executor, by status.',
      ['status'],
    );
    this._mcpSource = opts.mcpServers;
    // Состояние MCP-серверов пересчитывается **перед рендером**: список
    // серверов меняется лениво (ленивый старт), опросить его чаще незачем.
    this.registry.addCollector(() => {
      this._updateMcpServers();
    });
    // Нули на старте: серии существуют с первого скрейпа (иначе «нет данных» и
    // «ноль» неразличимы).
    this._inflight.set(0);
    for (const status of MCP_STATUSES) this._mcpServers.set({ status }, 0);
  }

  /** Команда начата (слот занят). */
  commandStarted(): void {
    try {
      this._inflightCount += 1;
      this._inflight.set(this._inflightCount);
    } catch {
      // ignore
    }
  }

  /**
   * Команда завершена: исход + длительность.
   *
   * @param outcome исход (`ok`/`error`/`timeout`/`cancelled`)
   * @param durationMs длительность исполнения, мс
   */
  commandFinished(outcome: ExecutorCommandOutcome, durationMs: number): void {
    try {
      this._inflightCount = Math.max(0, this._inflightCount - 1);
      this._inflight.set(this._inflightCount);
      this._commands.inc({ outcome: normalizeExecutorOutcome(outcome) });
      if (Number.isFinite(durationMs) && durationMs >= 0) {
        this._duration.observe(durationMs / 1000);
      }
    } catch {
      // ignore
    }
  }

  /** Отрендерить метрики (текст exposition 0.0.4). */
  render(): { text: string; series: number } {
    return this.registry.render();
  }

  /**
   * Задать источник состояний MCP-серверов (поздняя привязка).
   *
   * Хост MCP-серверов создаётся при сборке приложения исполнителя — он и
   * привязывает источник. Источник можно заменить (тесты, другой хост).
   */
  setMcpSource(source: ExecutorMcpStatusSource): void {
    this._mcpSource = source;
  }

  /** Пересчитать gauge MCP-серверов по текущему состоянию хоста. */
  private _updateMcpServers(): void {
    if (!this._mcpSource) return;
    const counts = new Map<ExecutorMcpStatus, number>(MCP_STATUSES.map((s) => [s, 0]));
    try {
      for (const server of this._mcpSource()) {
        const status = server.status;
        if (!MCP_STATUSES.includes(status)) continue;
        counts.set(status, (counts.get(status) ?? 0) + 1);
      }
    } catch {
      // ignore
    }
    for (const status of MCP_STATUSES) {
      this._mcpServers.set({ status }, counts.get(status) ?? 0);
    }
  }
}

/**
 * Создать метрики исполнителя.
 *
 * @param opts источник состояний MCP-серверов (для gauge `mcp_servers`)
 */
export function createExecutorMetrics(opts?: {
  mcpServers?: ExecutorMcpStatusSource;
}): ExecutorMetrics {
  return new ExecutorMetrics(opts ?? {});
}
