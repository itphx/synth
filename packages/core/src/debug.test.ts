/**
 * Тесты DebugCollector.addContext — формат debug-контекста (extra_context).
 * ADR-084: микрослой/роутер пишут сюда `decision`/`decision_routing`.
 */
import { describe, it, expect } from 'vitest';
import { DebugCollector } from './debug.js';

describe('DebugCollector.addContext', () => {
  it('складывает контекст в extra_context и отдаёт через getDebugInfo', () => {
    const dc = new DebugCollector(true);
    dc.addContext('decision', { where: 'micro', label: 'command', confidence: 0.9 });
    dc.addContext('decision_routing', {
      category: 'coding',
      confidence: 0.8,
      signals: ['decision:coding'],
    });

    expect(dc.getDebugInfo()?.extra_context).toEqual({
      decision: { where: 'micro', label: 'command', confidence: 0.9 },
      decision_routing: { category: 'coding', confidence: 0.8, signals: ['decision:coding'] },
    });
  });

  it('перезаписывает контекст по ключу', () => {
    const dc = new DebugCollector(true);
    dc.addContext('decision', { where: 'micro', status: 'fallback', signals: ['decision:chat'] });
    dc.addContext('decision', { where: 'micro', status: 'fallback', signals: ['decision:coding'] });

    const extra = dc.getDebugInfo()?.extra_context as Record<string, Record<string, unknown>>;
    expect(extra.decision?.signals).toEqual(['decision:coding']);
  });

  it('при выключенном сборщике контекст не сохраняется', () => {
    const dc = new DebugCollector(false);
    dc.addContext('decision', { where: 'micro' });
    expect(dc.getDebugInfo()).toBeNull();
  });
});
