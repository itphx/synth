import { describe, it, expect } from 'vitest';
import { decisionFromTarget } from './target-decision.js';

/**
 * ADR-089: единый маппинг цели правила в решение Router'а.
 *
 * `pipeline` (ссылка на шаг пайплайна) прокидывается в решение для целей
 * `ephemeral`/`bind` — там, где решение порождает сессию. В `bound`/`queue`
 * сессия фиксирована, поля в цели нет (его отвергает схема), поэтому в
 * решении оно не появляется.
 */
describe('decisionFromTarget (ADR-089)', () => {
  it('bound: решение без pipeline (сессия фиксирована)', () => {
    const decision = decisionFromTarget({ mode: 'bound', sessionId: 's1' }, '24h');
    expect(decision).toEqual({ kind: 'bound', sessionId: 's1' });
    expect('pipeline' in decision).toBe(false);
  });

  it('queue: решение без pipeline', () => {
    const decision = decisionFromTarget({ mode: 'queue', sessionId: 's1' }, '24h');
    expect(decision).toEqual({ kind: 'queue', owner: 's1', reason: 'target' });
    expect('pipeline' in decision).toBe(false);
  });

  it('ephemeral: pipeline прокидывается в решение', () => {
    const decision = decisionFromTarget(
      { mode: 'ephemeral', agentTemplate: 'writer', ttl: '30m', pipeline: { id: 'pl_1', step: 'publish' } },
      '24h',
    );
    expect(decision).toEqual({
      kind: 'ephemeral',
      agentTemplate: 'writer',
      ttl: '30m',
      pipeline: { id: 'pl_1', step: 'publish' },
    });
  });

  it('bind: pipeline прокидывается в решение', () => {
    const decision = decisionFromTarget(
      { mode: 'bind', agentTemplate: 'writer', project: 'p1', pipeline: { id: 'pl_1', step: 'publish' } },
      '24h',
    );
    expect(decision).toEqual({
      kind: 'bind',
      agentTemplate: 'writer',
      project: 'p1',
      pipeline: { id: 'pl_1', step: 'publish' },
    });
  });

  it('без pipeline решение не меняется (регресс)', () => {
    expect(decisionFromTarget({ mode: 'ephemeral', agentTemplate: 'a' }, '24h')).toEqual({
      kind: 'ephemeral',
      agentTemplate: 'a',
      ttl: '24h',
    });
    expect(decisionFromTarget({ mode: 'bind' }, '24h')).toEqual({ kind: 'bind', agentTemplate: '' });
  });

  it('pipeline не теряется вместе с диагностической метой', () => {
    const decision = decisionFromTarget(
      { mode: 'ephemeral', pipeline: { id: 'pl_1', step: 'publish' } },
      '24h',
      { reason: 'rule', confidence: 0.8, signals: ['decision-rules'] },
    );
    expect(decision).toEqual({
      kind: 'ephemeral',
      agentTemplate: '',
      ttl: '24h',
      pipeline: { id: 'pl_1', step: 'publish' },
      confidence: 0.8,
      signals: ['decision-rules'],
    });
  });
});
