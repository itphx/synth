import { describe, it, expect } from 'vitest';
import type { BusEvent } from '@itphx/synth-shared';
import { EventBus } from './bus.js';

describe('события скиллов (ADR-046 §8.2)', () => {
  it('skill.invoked публикуется с данными', () => {
    const bus = new EventBus();
    const events: BusEvent[] = [];
    bus.subscribe('s1', (e) => events.push(e));
    bus.publish('s1', 'skill.invoked', { session_id: 's1', name: 'api-review', source: 'model', scope: 'instance', agent: 'assistant' });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('skill.invoked');
    expect(events[0]!.data.name).toBe('api-review');
  });

  it('command.invoked — валидный тип (Фаза 2)', () => {
    const bus = new EventBus();
    const events: BusEvent[] = [];
    bus.subscribe('s1', (e) => events.push(e));
    bus.publish('s1', 'command.invoked', { session_id: 's1', command: '/help' });
    expect(events[0]!.type).toBe('command.invoked');
  });
});
