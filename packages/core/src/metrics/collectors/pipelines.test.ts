/**
 * ADR-094/ADR-101: метрики движка пайплайнов (`synth_pipeline_*`).
 *
 * Проверяется контракт наблюдаемости (ADR-094):
 * - имена метрик и их лейблы — фиксированы (снимок);
 * - **запрещённые** лейблы (`session_id`/`user_id`) и id пайплайна/прогона/узла
 *   в лейблы не попадают — только в payload события;
 * - кардинальность конечна: значения лейблов приводятся к конечным наборам,
 *   неизвестное значение → `other`.
 */
import { describe, it, expect } from 'vitest';
import { MetricsRegistry } from '../registry.js';
import {
  createPipelineMetrics,
  normalizePipelineGateKind,
  normalizePipelineNodeKind,
  normalizePipelineRunStatus,
  normalizePipelineStepOutcome,
  normalizePipelineTriggerSource,
} from './pipelines.js';

/** Лейблы, которые ADR-094 запрещает в метриках. */
const FORBIDDEN_LABELS = ['session_id', 'user_id', 'pipeline_id', 'run_id', 'node_id', 'path', 'query'];

describe('createPipelineMetrics', () => {
  it('имена метрик и их лейблы — фиксированный снимок', () => {
    const registry = new MetricsRegistry();
    createPipelineMetrics(registry);

    const snapshot = registry.snapshot()
      .map((metric) => ({ name: metric.name, labels: [...metric.labelNames] }))
      .sort((a, b) => a.name.localeCompare(b.name));

    expect(snapshot).toEqual([
      { name: 'synth_pipeline_human_wait_duration_seconds', labels: [] },
      { name: 'synth_pipeline_human_waits_total', labels: ['kind'] },
      { name: 'synth_pipeline_run_duration_seconds', labels: ['status'] },
      { name: 'synth_pipeline_runs_started_total', labels: ['source'] },
      { name: 'synth_pipeline_runs_total', labels: ['status'] },
      { name: 'synth_pipeline_step_duration_seconds', labels: ['kind'] },
      { name: 'synth_pipeline_steps_total', labels: ['kind', 'outcome'] },
    ]);
  });

  it('запрещённых лейблов нет ни в одной метрике', () => {
    const registry = new MetricsRegistry();
    createPipelineMetrics(registry);

    for (const metric of registry.snapshot()) {
      for (const label of metric.labelNames) {
        expect(FORBIDDEN_LABELS).not.toContain(label);
      }
    }
  });

  it('id прогонов/пайплайнов/узлов в лейблы не попадают', () => {
    const registry = new MetricsRegistry();
    const metrics = createPipelineMetrics(registry);

    metrics.onRunStarted({ source: 'manual' });
    metrics.onRunFinished({ status: 'done', durationMs: 120 });
    metrics.onStepFinished({ kind: 'agent', outcome: 'ok', durationMs: 30 });
    metrics.onHumanWaitStarted({ kind: 'human' });
    metrics.onHumanWaitFinished({ durationMs: 900 });

    const text = registry.render().text;
    expect(text).toContain('synth_pipeline_runs_started_total{source="manual"} 1');
    expect(text).toContain('synth_pipeline_runs_total{status="done"} 1');
    expect(text).toContain('synth_pipeline_steps_total{kind="agent",outcome="ok"} 1');
    expect(text).toContain('synth_pipeline_human_waits_total{kind="human"} 1');
    // В тексте экспозиции нет ни id, ни меток с id.
    expect(text).not.toContain('prun_');
    expect(text).not.toContain('pipeline_id');
    expect(text).not.toContain('run_id');
    expect(text).not.toContain('session_id');
    expect(text).not.toContain('user_id');
  });

  it('кардинальность конечна: неизвестные значения нормализуются к наборам', () => {
    const registry = new MetricsRegistry();
    const metrics = createPipelineMetrics(registry);

    // 200 «разных» прогонов с нестандартными значениями.
    for (let i = 0; i < 200; i += 1) {
      metrics.onRunStarted({ source: `src-${i}` });
      metrics.onRunFinished({ status: `st-${i}`, durationMs: i });
      metrics.onStepFinished({ kind: `kind-${i}`, outcome: `out-${i}`, durationMs: i });
      metrics.onHumanWaitStarted({ kind: `gate-${i}` });
    }

    const series = registry.snapshot().reduce((sum, metric) => sum + metric.series.length, 0);
    // Каждая метрика — максимум несколько серий (конечные наборы значений).
    expect(series).toBeLessThanOrEqual(16);

    const text = registry.render().text;
    expect(text).toContain('synth_pipeline_runs_started_total{source="other"} 200');
    expect(text).toContain('synth_pipeline_steps_total{kind="other",outcome="ok"} 200');
    expect(text).not.toContain('src-17');
  });
});

describe('нормализация значений лейблов пайплайнов', () => {
  it('статус прогона: конечный набор, неизвестное → done', () => {
    expect(normalizePipelineRunStatus('done')).toBe('done');
    expect(normalizePipelineRunStatus('failed')).toBe('failed');
    expect(normalizePipelineRunStatus('cancelled')).toBe('cancelled');
    expect(normalizePipelineRunStatus('running')).toBe('done');
    expect(normalizePipelineRunStatus(undefined)).toBe('done');
  });

  it('исход шага: конечный набор, неизвестное → ok', () => {
    expect(normalizePipelineStepOutcome('ok')).toBe('ok');
    expect(normalizePipelineStepOutcome('failed')).toBe('failed');
    expect(normalizePipelineStepOutcome('skipped')).toBe('skipped');
    expect(normalizePipelineStepOutcome('что-то')).toBe('ok');
    expect(normalizePipelineStepOutcome(undefined)).toBe('ok');
  });

  it('вид узла и вид гейта: неизвестное → other', () => {
    expect(normalizePipelineNodeKind('agent')).toBe('agent');
    expect(normalizePipelineNodeKind('script')).toBe('script');
    expect(normalizePipelineNodeKind('tool')).toBe('tool');
    expect(normalizePipelineNodeKind('human')).toBe('human');
    expect(normalizePipelineNodeKind('что-то')).toBe('other');

    expect(normalizePipelineGateKind('human')).toBe('human');
    expect(normalizePipelineGateKind('tool_approval')).toBe('tool_approval');
    expect(normalizePipelineGateKind('что-то')).toBe('other');
  });

  it('вид триггера: конечный набор, неизвестное → other', () => {
    expect(normalizePipelineTriggerSource('user')).toBe('user');
    expect(normalizePipelineTriggerSource('gateway')).toBe('gateway');
    expect(normalizePipelineTriggerSource('schedule')).toBe('schedule');
    expect(normalizePipelineTriggerSource('tool')).toBe('tool');
    expect(normalizePipelineTriggerSource('webhook')).toBe('webhook');
    expect(normalizePipelineTriggerSource('manual')).toBe('manual');
    expect(normalizePipelineTriggerSource('что-то')).toBe('other');
    expect(normalizePipelineTriggerSource(undefined)).toBe('other');
  });
});
