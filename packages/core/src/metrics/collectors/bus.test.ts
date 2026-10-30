/**
 * ADR-094: коллекторы шины сессий. Терминальные события считаются один раз на
 * начало хода (`turn.started`/`stream.start`); расход шага приходит в
 * `step.finished` (ADR-118) и суммируется по шагам; ретраи наследуют
 * provider/model.
 */
import { describe, it, expect } from 'vitest';
import { MetricsRegistry } from '../registry.js';
import { EventBus } from '../../events/bus.js';
import { attachBusMetrics } from './bus.js';

function text(registry: MetricsRegistry): string {
  return registry.render().text;
}

describe('attachBusMetrics', () => {
  it('ход: turn.started → turn.finished — исход ok, активные ходы обнуляются, стоимость в USD', () => {
    const registry = new MetricsRegistry();
    const bus = new EventBus();
    const stop = attachBusMetrics(registry, bus);

    bus.publish('s1', 'turn.started', { turnId: 't1', messageId: 'm1' });
    expect(text(registry)).toContain('synth_active_streams 1');

    // ADR-118: расход шага — в `step.finished` (замена `stream.usage`).
    bus.publish('s1', 'step.finished', {
      turnId: 't1',
      stepIndex: 0,
      messageId: 'a1',
      status: 'completed',
      provider: 'itphx',
      model: 'm1',
      costUsd: 0.1,
      costCurrency: 'USD',
    });
    // Стоимость шага суммируется (шаг = один вызов LLM).
    expect(text(registry)).toContain('synth_llm_cost_total{currency="USD"} 0.1');

    bus.publish('s1', 'turn.finished', { turnId: 't1', status: 'completed' });
    const rendered = text(registry);
    expect(rendered).toContain('synth_turns_total{outcome="ok"} 1');
    expect(rendered).toContain('synth_active_streams 0');

    stop();
    // После отписки события не учитываются, gauge обнулён.
    bus.publish('s1', 'turn.started', { turnId: 't2', messageId: 'm2' });
    expect(text(registry)).toContain('synth_turns_total{outcome="ok"} 1');
  });

  it('stream.start и turn.started одного хода не удваивают активный ход', () => {
    const registry = new MetricsRegistry();
    const bus = new EventBus();
    const stop = attachBusMetrics(registry, bus);

    bus.publish('s1', 'stream.start', { provider: 'itphx', model: 'm1' });
    bus.publish('s1', 'turn.started', { turnId: 't1', messageId: 'm1' });
    expect(text(registry)).toContain('synth_active_streams 1');

    bus.publish('s1', 'turn.finished', { turnId: 't1', status: 'completed' });
    const rendered = text(registry);
    expect(rendered).toContain('synth_turns_total{outcome="ok"} 1');
    expect(rendered).toContain('synth_active_streams 0');

    stop();
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
    bus.publish('s4', 'turn.started', { turnId: 't4', messageId: 'm4' });
    bus.publish('s4', 'turn.finished', { turnId: 't4', status: 'error' });

    const rendered = text(registry);
    expect(rendered).toContain('synth_turns_total{outcome="error"} 2');
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

  it('step.finished без cost — стоимость не считается', () => {
    const registry = new MetricsRegistry();
    const bus = new EventBus();
    const stop = attachBusMetrics(registry, bus);

    bus.publish('s1', 'step.finished', {
      turnId: 't1',
      stepIndex: 0,
      messageId: 'a1',
      status: 'completed',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });

    expect(text(registry)).not.toContain('synth_llm_cost_total');
    stop();
  });
});
