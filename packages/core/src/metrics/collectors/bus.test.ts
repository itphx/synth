/**
 * ADR-094: коллекторы шины сессий. Терминальные события считаются один раз на
 * `stream.start`; `stream.usage` не суммируется; ретраи наследуют provider/model.
 */
import { describe, it, expect } from 'vitest';
import { MetricsRegistry } from '../registry.js';
import { EventBus } from '../../events/bus.js';
import { attachBusMetrics } from './bus.js';

function text(registry: MetricsRegistry): string {
  return registry.render().text;
}

describe('attachBusMetrics', () => {
  it('start → done: исход ok, активные стримы обнуляются, стоимость в USD', () => {
    const registry = new MetricsRegistry();
    const bus = new EventBus();
    const stop = attachBusMetrics(registry, bus);

    bus.publish('s1', 'stream.start', { provider: 'itphx', model: 'm1' });
    expect(text(registry)).toContain('synth_active_streams 1');

    bus.publish('s1', 'stream.usage', { provider: 'itphx', model: 'm1', cost_usd: 999 });
    // usage не суммирует стоимость (публикуется многократно).
    expect(text(registry)).not.toContain('synth_llm_cost_total{currency="USD"} 999');

    bus.publish('s1', 'stream.done', { cost_usd: 0.25 });
    const rendered = text(registry);
    expect(rendered).toContain('synth_turns_total{outcome="ok"} 1');
    expect(rendered).toContain('synth_active_streams 0');
    expect(rendered).toContain('synth_llm_cost_total{currency="USD"} 0.25');

    stop();
    // После отписки события не учитываются, gauge обнулён.
    bus.publish('s1', 'stream.start');
    expect(text(registry)).toContain('synth_turns_total{outcome="ok"} 1');
  });

  it('error/cancelled — отдельные исходы; терминал без старта не считается', () => {
    const registry = new MetricsRegistry();
    const bus = new EventBus();
    const stop = attachBusMetrics(registry, bus);

    bus.publish('s1', 'stream.start');
    bus.publish('s1', 'stream.error');
    bus.publish('s2', 'stream.cancelled'); // без start — игнор
    bus.publish('s3', 'stream.start');
    bus.publish('s3', 'stream.cancelled');

    const rendered = text(registry);
    expect(rendered).toContain('synth_turns_total{outcome="error"} 1');
    expect(rendered).toContain('synth_turns_total{outcome="cancelled"} 1');
    expect(rendered).toContain('synth_active_streams 0');

    stop();
  });

  it('stream.retry наследует provider/model последнего события сессии', () => {
    const registry = new MetricsRegistry();
    const bus = new EventBus();
    const stop = attachBusMetrics(registry, bus);

    bus.publish('s1', 'stream.start', { provider: 'itphx', model: 'clef' });
    bus.publish('s1', 'stream.retry');
    bus.publish('s2', 'stream.retry'); // модель неизвестна

    const rendered = text(registry);
    expect(rendered).toContain('synth_llm_retries_total{provider="itphx",model="clef"} 1');
    expect(rendered).toContain('synth_llm_retries_total{provider="unknown",model="unknown"} 1');

    stop();
  });
});
