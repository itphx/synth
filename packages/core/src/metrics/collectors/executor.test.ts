/**
 * ADR-094/ADR-077: тесты коллектора метрик пула исполнителя.
 *
 * Проверяется контракт:
 * - метрики `synth_executor_queue_depth`/`synth_executor_workers_busy`/
 *   `synth_executor_wait_seconds`/`synth_executor_commands_total` — с теми
 *   именами и лейблами, что в `docs/OBSERVABILITY.md`;
 * - лейбл `outcome` — **только** из закрытого набора (`ok`/`error`/`timeout`/
 *   `cancelled`), неизвестное значение сводится к `error`;
 * - идентификаторов (адресов пула, id команд, сессий) в лейблах нет;
 * - ошибка метрик не влияет на исполнение (best-effort).
 */
import { describe, expect, it } from 'vitest';

import { MetricsRegistry } from '../registry.js';
import { createExecutorMetricsCollector, normalizeExecutorOutcome } from './executor.js';

/** Снимок метрики по имени. */
function metric(registry: MetricsRegistry, name: string) {
  return registry.snapshot().find((m) => m.name === name);
}

describe('метрики исполнителя: нормализация исхода', () => {
  it('известные значения сохраняются', () => {
    expect(normalizeExecutorOutcome('ok')).toBe('ok');
    expect(normalizeExecutorOutcome('error')).toBe('error');
    expect(normalizeExecutorOutcome('timeout')).toBe('timeout');
    expect(normalizeExecutorOutcome('cancelled')).toBe('cancelled');
  });

  it('неизвестное/пустое значение → error', () => {
    expect(normalizeExecutorOutcome('weird')).toBe('error');
    expect(normalizeExecutorOutcome('')).toBe('error');
    expect(normalizeExecutorOutcome(undefined)).toBe('error');
  });
});

describe('метрики исполнителя: регистрация', () => {
  it('метрики зарегистрированы с контрактными именами и типами', () => {
    const registry = new MetricsRegistry();
    createExecutorMetricsCollector(registry);

    const queue = metric(registry, 'synth_executor_queue_depth');
    expect(queue?.type).toBe('gauge');
    expect(queue?.labelNames).toEqual([]);

    const busy = metric(registry, 'synth_executor_workers_busy');
    expect(busy?.type).toBe('gauge');
    expect(busy?.labelNames).toEqual([]);

    const wait = metric(registry, 'synth_executor_wait_seconds');
    expect(wait?.type).toBe('histogram');
    expect(wait?.labelNames).toEqual([]);

    const commands = metric(registry, 'synth_executor_commands_total');
    expect(commands?.type).toBe('counter');
    expect(commands?.labelNames).toEqual(['outcome']);
  });
});

describe('метрики исполнителя: события приёмника', () => {
  it('очередь и занятость пула двигаются по событиям', () => {
    const registry = new MetricsRegistry();
    const sink = createExecutorMetricsCollector(registry);

    sink.onQueued?.();
    sink.onQueued?.();
    expect(metric(registry, 'synth_executor_queue_depth')?.series[0]?.value).toBe(2);

    sink.onDequeued?.(120);
    expect(metric(registry, 'synth_executor_queue_depth')?.series[0]?.value).toBe(1);

    sink.onStarted?.();
    expect(metric(registry, 'synth_executor_workers_busy')?.series[0]?.value).toBe(1);

    sink.onFinished?.('ok', 50);
    expect(metric(registry, 'synth_executor_workers_busy')?.series[0]?.value).toBe(0);
  });

  it('ожидание в очереди попадает в гистограмму (секунды)', () => {
    const registry = new MetricsRegistry();
    const sink = createExecutorMetricsCollector(registry);

    sink.onQueued?.();
    sink.onDequeued?.(1500);

    const wait = metric(registry, 'synth_executor_wait_seconds');
    expect(wait?.series[0]?.count).toBe(1);
    expect(wait?.series[0]?.sum).toBeCloseTo(1.5, 6);
  });

  it('исход команды учитывается счётчиком', () => {
    const registry = new MetricsRegistry();
    const sink = createExecutorMetricsCollector(registry);

    sink.onFinished?.('ok', 10);
    sink.onFinished?.('error', 10);
    sink.onFinished?.('timeout', 10);
    sink.onFinished?.('cancelled', 10);

    const commands = metric(registry, 'synth_executor_commands_total');
    expect(commands?.series).toHaveLength(4);
    const byOutcome = new Map(commands!.series.map((s) => [s.labels.outcome, s.value]));
    expect(byOutcome.get('ok')).toBe(1);
    expect(byOutcome.get('error')).toBe(1);
    expect(byOutcome.get('timeout')).toBe(1);
    expect(byOutcome.get('cancelled')).toBe(1);
  });

  it('неизвестный исход сводится к error (кардинальность ограничена)', () => {
    const registry = new MetricsRegistry();
    const sink = createExecutorMetricsCollector(registry);

    sink.onFinished?.('boom' as never, 10);

    const commands = metric(registry, 'synth_executor_commands_total');
    expect(commands?.series).toHaveLength(1);
    expect(commands?.series[0]?.labels.outcome).toBe('error');
  });

  it('счётчики не уходят в минус (сброс состояния не ломает дашборд)', () => {
    const registry = new MetricsRegistry();
    const sink = createExecutorMetricsCollector(registry);

    sink.onFinished?.('ok', 10);

    expect(metric(registry, 'synth_executor_workers_busy')?.series[0]?.value).toBe(0);
    expect(metric(registry, 'synth_executor_queue_depth')?.series[0]?.value).toBe(0);
  });
});

describe('метрики исполнителя: экспозиция', () => {
  it('в тексте нет идентификаторов и лишних лейблов', () => {
    const registry = new MetricsRegistry();
    const sink = createExecutorMetricsCollector(registry);

    sink.onQueued?.();
    sink.onDequeued?.(10);
    sink.onStarted?.();
    sink.onFinished?.('ok', 10);

    const rendered = registry.render().text;
    expect(rendered).toContain('synth_executor_queue_depth');
    expect(rendered).toContain('synth_executor_workers_busy');
    expect(rendered).toContain('synth_executor_wait_seconds');
    expect(rendered).toContain('synth_executor_commands_total');
    expect(rendered).not.toContain('session_id');
    expect(rendered).not.toContain('user_id');
    expect(rendered).not.toContain('address');
    expect(rendered).not.toContain('http://');
  });

  it('сброс реестра очищает и метрики (тестовый сценарий)', () => {
    const registry = new MetricsRegistry();
    const sink = createExecutorMetricsCollector(registry);
    sink.onFinished?.('ok', 10);

    registry.reset();

    expect(metric(registry, 'synth_executor_commands_total')).toBeUndefined();
  });
});
