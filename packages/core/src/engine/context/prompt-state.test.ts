/**
 * ADR-070 §2.4/§2.7 (Ф2-часть 2): юнит-тесты состояния промпта per-agent и
 * предсказания/валидации prompt-cache.
 */

import { describe, it, expect } from 'vitest';
import type { PromptState } from '@itphx/synth-shared';
import type { PromptBlock } from './prompt-blocks.js';
import {
  DEFAULT_AGENT_KEY,
  agentKeyOf,
  buildPromptState,
  computeExpected,
  hashText,
  isBlockChanged,
  isPrefixUnchanged,
  validateExpected,
} from './prompt-state.js';

function block(key: string, content: string): PromptBlock {
  return { key, tier: 'stable', order: 0, content };
}

function composed(system = 'SYS', stablePrefix = 'STABLE') {
  return {
    system,
    stablePrefix,
    blocks: [block('role', stablePrefix), block('session.info', 'CTX')],
  };
}

describe('agentKeyOf', () => {
  it('возвращает agentRole, если задан', () => {
    expect(agentKeyOf('developer')).toBe('developer');
  });

  it('возвращает __default__ без агента', () => {
    expect(agentKeyOf(undefined)).toBe(DEFAULT_AGENT_KEY);
    expect(agentKeyOf('')).toBe(DEFAULT_AGENT_KEY);
    expect(DEFAULT_AGENT_KEY).toBe('__default__');
  });
});

describe('hashText', () => {
  it('детерминированный sha256 hex', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashText('abc')).not.toBe(hashText('abd'));
  });
});

describe('buildPromptState', () => {
  it('init: generation=1, хэши префикса/системы/блоков', () => {
    const c = composed();
    const state = buildPromptState(c, null, 'init');

    expect(state.generation).toBe(1);
    expect(state.reason).toBe('init');
    expect(state.staticPrefix).toBe('STABLE');
    expect(state.staticPrefixHash).toBe(hashText('STABLE'));
    expect(state.systemHash).toBe(hashText('SYS'));
    expect(state.blocks).toEqual([
      { key: 'role', hash: hashText('STABLE'), chars: 6 },
      { key: 'session.info', hash: hashText('CTX'), chars: 3 },
    ]);
    expect(typeof state.updatedAt).toBe('string');
  });

  it('инкремент generation от предыдущего состояния', () => {
    const prev = buildPromptState(composed(), null, 'init');
    const next = buildPromptState(composed('SYS2', 'STABLE2'), prev, 'generation-change');

    expect(next.generation).toBe(2);
    expect(next.reason).toBe('generation-change');
  });
});

describe('isPrefixUnchanged', () => {
  it('false без предыдущего состояния', () => {
    expect(isPrefixUnchanged(null, composed())).toBe(false);
  });

  it('true при том же стабильном префиксе', () => {
    const prev = buildPromptState(composed(), null, 'init');
    expect(isPrefixUnchanged(prev, composed('SYS-другой', 'STABLE'))).toBe(true);
  });

  it('false при другом стабильном префиксе', () => {
    const prev = buildPromptState(composed(), null, 'init');
    expect(isPrefixUnchanged(prev, composed('SYS', 'STABLE-НОВЫЙ'))).toBe(false);
  });
});

describe('isBlockChanged (ADR-069 §11)', () => {
  const withInstructions = (content: string) => ({
    system: 'SYS',
    stablePrefix: 'STABLE',
    blocks: [block('role', 'STABLE'), block('instructions', content)],
  });

  it('false без предыдущего состояния (обрабатывается отдельно как init)', () => {
    expect(isBlockChanged(null, withInstructions('A').blocks, 'instructions')).toBe(false);
  });

  it('false при неизменном контенте блока (stable-префикс тоже не менялся)', () => {
    const prev = buildPromptState(withInstructions('A'), null, 'init');
    expect(isBlockChanged(prev, withInstructions('A').blocks, 'instructions')).toBe(false);
  });

  it('true при изменении контента блока, даже если stable-префикс прежний', () => {
    const prev = buildPromptState(withInstructions('A'), null, 'init');
    // Стабильный префикс не меняется, но context-блок instructions — да.
    expect(isPrefixUnchanged(prev, withInstructions('B'))).toBe(true);
    expect(isBlockChanged(prev, withInstructions('B').blocks, 'instructions')).toBe(true);
  });

  it('true при появлении/исчезновении блока', () => {
    const prev = buildPromptState(withInstructions('A'), null, 'init');
    expect(isBlockChanged(prev, composed().blocks, 'instructions')).toBe(true);
  });
});

describe('computeExpected', () => {
  it('miss без предыдущего состояния', () => {
    expect(computeExpected(null, composed())).toBe('miss');
  });

  it('hit при неизменном префиксе', () => {
    const prev = buildPromptState(composed(), null, 'init');
    expect(computeExpected(prev, composed('SYS-другой', 'STABLE'))).toBe('hit');
  });

  it('miss при изменённом префиксе', () => {
    const prev = buildPromptState(composed(), null, 'init');
    expect(computeExpected(prev, composed('SYS', 'STABLE-НОВЫЙ'))).toBe('miss');
  });
});

describe('validateExpected', () => {
  it('hit + cachedTokens>0 → true', () => {
    expect(validateExpected('hit', 42)).toBe(true);
  });

  it('hit + 0 → false', () => {
    expect(validateExpected('hit', 0)).toBe(false);
  });

  it('miss + 0 → true', () => {
    expect(validateExpected('miss', 0)).toBe(true);
  });

  it('miss + cachedTokens>0 → false', () => {
    expect(validateExpected('miss', 42)).toBe(false);
  });
});

describe('сценарий A→B→A per-agent', () => {
  it('состояния агентов изолированы', () => {
    const a1 = buildPromptState(composed(), null, 'init');
    const b1 = buildPromptState(composed('SYS-B', 'STABLE-B'), null, 'init');

    // Возврат к A: префикс A не менялся → hit.
    expect(computeExpected(a1, composed('SYS-A2', 'STABLE'))).toBe('hit');
    // B не смешивается с A.
    expect(a1.staticPrefix).not.toBe(b1.staticPrefix);
    expect(a1.blocks[0]!.hash).not.toBe(b1.blocks[0]!.hash);
  });
});

describe('PromptState сериализуем как данные', () => {
  it('JSON round-trip сохраняет поля', () => {
    const state: PromptState = buildPromptState(composed(), null, 'init');
    const restored = JSON.parse(JSON.stringify(state)) as PromptState;
    expect(restored).toEqual(state);
  });
});
