/**
 * ADR-094: метрики движка пайплайнов (ADR-101).
 *
 * Каталог:
 * - `synth_pipeline_runs_total{status}` — завершённые прогоны по статусу
 *   (`done`/`failed`/`cancelled`);
 * - `synth_pipeline_runs_started_total{source}` — запуски прогонов по виду
 *   триггера (`user`/`gateway`/`schedule`/`tool`/`webhook`/`manual`);
 * - `synth_pipeline_run_duration_seconds{status}` — длительность прогона;
 * - `synth_pipeline_steps_total{kind,outcome}` — шаги по виду узла и исходу
 *   (`agent`/`script`/`tool`/`human` × `ok`/`failed`/`skipped`);
 * - `synth_pipeline_step_duration_seconds{kind}` — длительность шага;
 * - `synth_pipeline_human_waits_total{kind}` — ожидания решения человека
 *   (`human`/`tool_approval`);
 * - `synth_pipeline_human_wait_duration_seconds` — длительность ожидания.
 *
 * ## Контракт ADR-094
 *
 * - имена — только `synth_*`;
 * - лейблы — только из фиксированного списка (`method`/`route`/`status`/
 *   `provider`/`model`/`kind`/`outcome`/`source`/`op`/`currency`/`backend`/
 *   `store`); здесь используются `status`, `source`, `kind`, `outcome`;
 * - **никаких id** (пайплайна/прогона/узла/сессии) и сырых путей в лейблах —
 *   иначе кардинальность серий взорвётся. Значения лейблов приводятся к
 *   конечному набору (`normalize*` ниже): неизвестное значение → `other`;
 * - секреты и payload прогонов в метрики не попадают (только счётчики и
 *   длительности).
 */
import type { MetricsRegistry } from '../registry.js';

/** Статус завершённого прогона (конечный набор). */
export type PipelineRunMetricStatus = 'done' | 'failed' | 'cancelled';

/** Исход шага (конечный набор). */
export type PipelineStepMetricOutcome = 'ok' | 'failed' | 'skipped';

/** Вид узла пайплайна (конечный набор). */
export type PipelineNodeMetricKind = 'agent' | 'script' | 'tool' | 'human';

/** Вид гейта ожидания человека (конечный набор). */
export type PipelineGateMetricKind = 'human' | 'tool_approval';

/** Вид триггера прогона (конечный набор). */
export type PipelineTriggerMetricSource =
  | 'user'
  | 'gateway'
  | 'schedule'
  | 'tool'
  | 'webhook'
  | 'manual';

/** Корзины гистограммы длительности прогона (секунды). */
export const PIPELINE_RUN_DURATION_BUCKETS: readonly number[] = [
  0.5, 1, 2.5, 5, 10, 30, 60, 300, 900, 3600,
];

/** Корзины гистограммы длительности шага (секунды). */
export const PIPELINE_STEP_DURATION_BUCKETS: readonly number[] = [
  0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900,
];

/** Корзины гистограммы ожидания человека (секунды). */
export const PIPELINE_WAIT_DURATION_BUCKETS: readonly number[] = [
  1, 5, 30, 60, 300, 900, 3600, 21600,
];

const RUN_STATUSES: readonly string[] = ['done', 'failed', 'cancelled'];
const STEP_OUTCOMES: readonly string[] = ['ok', 'failed', 'skipped'];
const NODE_KINDS: readonly string[] = ['agent', 'script', 'tool', 'human'];
const GATE_KINDS: readonly string[] = ['human', 'tool_approval'];
const TRIGGER_SOURCES: readonly string[] = [
  'user', 'gateway', 'schedule', 'tool', 'webhook', 'manual',
];

/** Приведение значения к конечному набору: неизвестное → `other`. */
function normalize(value: string | undefined, allowed: readonly string[]): string {
  if (!value) return 'other';
  return allowed.includes(value) ? value : 'other';
}

/** Нормализация статуса прогона. */
export function normalizePipelineRunStatus(value: string | undefined): PipelineRunMetricStatus {
  const status = normalize(value, RUN_STATUSES);
  return (status === 'failed' || status === 'cancelled' ? status : 'done') as PipelineRunMetricStatus;
}

/** Нормализация исхода шага. */
export function normalizePipelineStepOutcome(value: string | undefined): PipelineStepMetricOutcome {
  const outcome = normalize(value, STEP_OUTCOMES);
  return (outcome === 'failed' || outcome === 'skipped' ? outcome : 'ok') as PipelineStepMetricOutcome;
}

/** Нормализация вида узла. */
export function normalizePipelineNodeKind(value: string | undefined): PipelineNodeMetricKind {
  const kind = normalize(value, NODE_KINDS);
  return (NODE_KINDS.includes(kind) ? kind : 'other') as PipelineNodeMetricKind;
}

/** Нормализация вида гейта ожидания человека. */
export function normalizePipelineGateKind(value: string | undefined): PipelineGateMetricKind {
  const kind = normalize(value, GATE_KINDS);
  return (kind === 'human' || kind === 'tool_approval' ? kind : 'other') as PipelineGateMetricKind;
}

/** Нормализация вида триггера. */
export function normalizePipelineTriggerSource(value: string | undefined): PipelineTriggerMetricSource {
  const source = normalize(value, TRIGGER_SOURCES);
  return (TRIGGER_SOURCES.includes(source) ? source : 'other') as PipelineTriggerMetricSource;
}

/**
 * Колбэки метрик пайплайнов — их вызывает движок (`PipelineEngine`).
 *
 * Ошибки метрик не должны влиять на прогон: вызовы обёрнуты в try/catch
 * на стороне коллектора.
 */
export interface PipelineMetricsHooks {
  /** Прогон начался (вид триггера). */
  onRunStarted: (info: { source: string }) => void;
  /** Прогон завершён (статус + длительность). */
  onRunFinished: (info: { status: string; durationMs: number }) => void;
  /** Шаг завершён (вид узла + исход + длительность). */
  onStepFinished: (info: { kind: string; outcome: string; durationMs: number }) => void;
  /** Прогон встал на ожидание решения человека (вид гейта). */
  onHumanWaitStarted: (info: { kind: string }) => void;
  /** Ожидание человека завершилось (длительность ожидания). */
  onHumanWaitFinished: (info: { durationMs: number }) => void;
}

/**
 * Создать колбэки метрик пайплайнов (ADR-094).
 *
 * Реестр метрик — общий (`MetricsRegistry`); новых зависимостей нет.
 */
export function createPipelineMetrics(registry: MetricsRegistry): PipelineMetricsHooks {
  const runs = registry.counter(
    'synth_pipeline_runs_total',
    'Total number of finished pipeline runs by status.',
    ['status'],
  );
  const runsStarted = registry.counter(
    'synth_pipeline_runs_started_total',
    'Total number of started pipeline runs by trigger kind.',
    ['source'],
  );
  const runDuration = registry.histogram(
    'synth_pipeline_run_duration_seconds',
    'Duration of finished pipeline runs in seconds.',
    ['status'],
    PIPELINE_RUN_DURATION_BUCKETS,
  );
  const steps = registry.counter(
    'synth_pipeline_steps_total',
    'Total number of finished pipeline steps by node kind and outcome.',
    ['kind', 'outcome'],
  );
  const stepDuration = registry.histogram(
    'synth_pipeline_step_duration_seconds',
    'Duration of finished pipeline steps in seconds.',
    ['kind'],
    PIPELINE_STEP_DURATION_BUCKETS,
  );
  const humanWaits = registry.counter(
    'synth_pipeline_human_waits_total',
    'Total number of pipeline runs waiting for a human decision.',
    ['kind'],
  );
  const waitDuration = registry.histogram(
    'synth_pipeline_human_wait_duration_seconds',
    'Duration of waiting for a human decision in seconds.',
    [],
    PIPELINE_WAIT_DURATION_BUCKETS,
  );

  return {
    onRunStarted(info) {
      try {
        runsStarted.inc({ source: normalizePipelineTriggerSource(info.source) });
      } catch {
        // ignore
      }
    },
    onRunFinished(info) {
      try {
        const status = normalizePipelineRunStatus(info.status);
        runs.inc({ status });
        if (Number.isFinite(info.durationMs) && info.durationMs >= 0) {
          runDuration.observe({ status }, info.durationMs / 1000);
        }
      } catch {
        // ignore
      }
    },
    onStepFinished(info) {
      try {
        const kind = normalizePipelineNodeKind(info.kind);
        const outcome = normalizePipelineStepOutcome(info.outcome);
        steps.inc({ kind, outcome });
        if (Number.isFinite(info.durationMs) && info.durationMs >= 0) {
          stepDuration.observe({ kind }, info.durationMs / 1000);
        }
      } catch {
        // ignore
      }
    },
    onHumanWaitStarted(info) {
      try {
        humanWaits.inc({ kind: normalizePipelineGateKind(info.kind) });
      } catch {
        // ignore
      }
    },
    onHumanWaitFinished(info) {
      try {
        if (Number.isFinite(info.durationMs) && info.durationMs >= 0) {
          waitDuration.observe(info.durationMs / 1000);
        }
      } catch {
        // ignore
      }
    },
  };
}
