/**
 * ADR-094: golden-тесты рендера реестра метрик (exposition 0.0.4).
 * Ожидаемый текст задан inline (не snapshot) — контракт имён/порядка/экранирования
 * виден в тесте и не «принимается» автоматически.
 */
import { describe, it, expect } from 'vitest';
import { MetricsRegistry, SERIES_DROPPED_METRIC } from './registry.js';

describe('MetricsRegistry: golden-рендер exposition 0.0.4', () => {
  it('counter/gauge/histogram: HELP/TYPE, сортировка, экранирование, _bucket/_sum/_count', () => {
    const registry = new MetricsRegistry();

    const requests = registry.counter(
      'synth_test_requests_total',
      'Total requests.\nSecond line',
      ['method', 'status'],
    );
    requests.inc({ method: 'GET', status: 200 });
    requests.inc({ method: 'GET', status: 200 });
    requests.inc({ method: 'POST', status: 500 }, 2);

    const queue = registry.gauge('synth_test_queue_depth', 'Queue depth', ['queue']);
    queue.set({ queue: 'a"b' }, 3);

    const duration = registry.histogram(
      'synth_test_duration_seconds',
      'Duration "help"',
      ['route'],
      [1, 0.1],
    );
    duration.observe({ route: '/x' }, 0.05);
    duration.observe({ route: '/x' }, 2);

    const rendered = registry.render();

    expect(rendered.text).toBe(
      [
        '# HELP synth_test_duration_seconds Duration \\"help\\"',
        '# TYPE synth_test_duration_seconds histogram',
        'synth_test_duration_seconds_bucket{route="/x",le="0.1"} 1',
        'synth_test_duration_seconds_bucket{route="/x",le="1"} 1',
        'synth_test_duration_seconds_bucket{route="/x",le="+Inf"} 2',
        'synth_test_duration_seconds_sum{route="/x"} 2.05',
        'synth_test_duration_seconds_count{route="/x"} 2',
        '# HELP synth_test_queue_depth Queue depth',
        '# TYPE synth_test_queue_depth gauge',
        'synth_test_queue_depth{queue="a\\"b"} 3',
        '# HELP synth_test_requests_total Total requests.\\nSecond line',
        '# TYPE synth_test_requests_total counter',
        'synth_test_requests_total{method="GET",status="200"} 2',
        'synth_test_requests_total{method="POST",status="500"} 2',
        '',
      ].join('\n'),
    );
    // histogram-серия считается один раз (не по строкам _bucket).
    expect(rendered.series).toBe(4);
  });

  it('специальные числа: NaN / +Inf / -Inf', () => {
    const registry = new MetricsRegistry();
    const gauge = registry.gauge('synth_test_special', 'Special numbers', ['kind']);
    gauge.set({ kind: 'nan' }, Number.NaN);
    gauge.set({ kind: 'plus' }, Number.POSITIVE_INFINITY);
    gauge.set({ kind: 'minus' }, Number.NEGATIVE_INFINITY);

    expect(registry.render().text).toBe(
      [
        '# HELP synth_test_special Special numbers',
        '# TYPE synth_test_special gauge',
        'synth_test_special{kind="minus"} -Inf',
        'synth_test_special{kind="nan"} NaN',
        'synth_test_special{kind="plus"} +Inf',
        '',
      ].join('\n'),
    );
  });

  it('лейблы в стабильном порядке labelNames, значения приводятся к строке', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter('synth_test_labels_total', 'Labels', ['b', 'a']);
    counter.inc({ a: 'x', b: 1, ignored: 'no-cardinality' });

    expect(registry.render().text).toContain('synth_test_labels_total{b="1",a="x"} 1');
    expect(registry.render().text).not.toContain('ignored');
  });

  it('предел серий: лишние серии отбрасываются, растёт synth_metrics_series_dropped_total', () => {
    const registry = new MetricsRegistry({ maxSeriesPerMetric: 2 });
    const counter = registry.counter('synth_test_limit_total', 'Limit', ['id']);
    counter.inc({ id: 'a' });
    counter.inc({ id: 'b' });
    counter.inc({ id: 'c' });
    counter.inc({ id: 'd' });

    expect(counter.seriesCount).toBe(2);
    const text = registry.render().text;
    expect(text).toContain('synth_test_limit_total{id="a"} 1');
    expect(text).toContain('synth_test_limit_total{id="b"} 1');
    expect(text).not.toContain('id="c"');
    expect(text).toContain(`${SERIES_DROPPED_METRIC}{metric="synth_test_limit_total"} 2`);
  });

  it('reset() очищает метрики и коллекторы', () => {
    const registry = new MetricsRegistry();
    registry.counter('synth_test_reset_total', 'Reset').inc();
    expect(registry.render().series).toBe(1);
    registry.reset();
    expect(registry.render().text).toBe('');
  });
});
