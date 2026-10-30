import { describe, it, expect } from 'vitest';
import { EFFORT_LEVELS, effortForReasoningLevel, isEffortLevel } from './llm.js';

describe('EffortLevel — тиры усилия (ADR-117)', () => {
  it('канонический набор — как в opencode', () => {
    expect([...EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('isEffortLevel принимает только известные тиры', () => {
    for (const level of EFFORT_LEVELS) expect(isEffortLevel(level)).toBe(true);
    for (const bad of ['default', 'none', '', null, 1, true]) expect(isEffortLevel(bad)).toBe(false);
  });

  it('маппинг reasoningLevel → effort: только low/medium/high', () => {
    expect(effortForReasoningLevel('low')).toBe('low');
    expect(effortForReasoningLevel('medium')).toBe('medium');
    expect(effortForReasoningLevel('high')).toBe('high');
    // Выключить размышления effort-тиром нельзя — параметр не отправляется.
    expect(effortForReasoningLevel('none')).toBeUndefined();
    expect(effortForReasoningLevel('default')).toBeUndefined();
    expect(effortForReasoningLevel(undefined)).toBeUndefined();
  });
});
