/**
 * Тесты планировщика переходов (ADR-101, правила переходов).
 *
 * Проверяются: выбор по условию (первое совпавшее), линейный переход,
 * отсутствие перехода, правило «провал шага → нет линейного перехода» и
 * лимит переходов (защита от бесконечного цикла).
 */
import { describe, it, expect } from 'vitest';
import type { PipelineNode, PipelineRunTrigger, PipelineSpec, StepResult } from '@itphx/synth-shared';

import { MAX_PIPELINE_TRANSITIONS, nextNodeId } from './planner.js';

const trigger: PipelineRunTrigger = { kind: 'manual', payload: { branch: 'main' } };

function spec(nodes: PipelineNode[]): PipelineSpec {
  return {
    id: 'p',
    name: 'p',
    version: 1,
    status: 'published',
    mode: 'act',
    nodes,
    exits: [{ kind: 'none' }],
  };
}

const ok: StepResult = { status: 'ok', attempt: 1, output: { status: 'ok' } };
const failed: StepResult = { status: 'failed', attempt: 1, error: { code: 'x', message: 'boom' } };

describe('nextNodeId', () => {
  it('выбирает узел по первому совпавшему условию', () => {
    const s = spec([
      {
        id: 'a',
        kind: 'tool',
        tool: 'noop',
        on: [
          { when: { path: 'prev.output.status', op: 'eq', value: 'failed' }, then: 'fix' },
          { when: { path: 'prev.output.status', op: 'eq', value: 'ok' }, then: 'verify' },
          { when: { path: 'prev.output.status', op: 'exists' }, then: 'never' },
        ],
      },
      { id: 'verify', kind: 'tool', tool: 'noop' },
      { id: 'fix', kind: 'tool', tool: 'noop' },
    ]);
    expect(nextNodeId(s, { node: s.nodes[0]!, prev: ok, trigger, vars: {} })).toBe('verify');
    expect(
      nextNodeId(s, {
        node: s.nodes[0]!,
        prev: { status: 'ok', attempt: 1, output: { status: 'failed' } },
        trigger,
        vars: {},
      }),
    ).toBe('fix');
  });

  it('если ни одно условие не выполнено — перехода нет', () => {
    const s = spec([
      {
        id: 'a',
        kind: 'tool',
        tool: 'noop',
        on: [{ when: { path: 'prev.output.status', op: 'eq', value: 'ok' }, then: 'b' }],
      },
      { id: 'b', kind: 'tool', tool: 'noop' },
    ]);
    expect(
      nextNodeId(s, {
        node: s.nodes[0]!,
        prev: { status: 'ok', attempt: 1, output: { status: 'other' } },
        trigger,
        vars: {},
      }),
    ).toBeNull();
  });

  it('узел без on: линейный переход к следующему узлу', () => {
    const s = spec([
      { id: 'a', kind: 'tool', tool: 'noop' },
      { id: 'b', kind: 'tool', tool: 'noop' },
      { id: 'c', kind: 'tool', tool: 'noop' },
    ]);
    expect(nextNodeId(s, { node: s.nodes[0]!, prev: ok, trigger, vars: {} })).toBe('b');
    expect(nextNodeId(s, { node: s.nodes[1]!, prev: ok, trigger, vars: {} })).toBe('c');
  });

  it('последний узел — перехода нет (прогон идёт к выходам)', () => {
    const s = spec([{ id: 'a', kind: 'tool', tool: 'noop' }]);
    expect(nextNodeId(s, { node: s.nodes[0]!, prev: ok, trigger, vars: {} })).toBeNull();
  });

  it('провал шага без явного перехода — линейного перехода нет', () => {
    const s = spec([
      { id: 'a', kind: 'tool', tool: 'noop' },
      { id: 'b', kind: 'tool', tool: 'noop' },
    ]);
    expect(nextNodeId(s, { node: s.nodes[0]!, prev: failed, trigger, vars: {} })).toBeNull();
  });

  it('провал шага с явным переходом — переход разрешён', () => {
    const s = spec([
      {
        id: 'a',
        kind: 'tool',
        tool: 'noop',
        on: [{ when: { path: 'prev.status', op: 'eq', value: 'failed' }, then: 'fix' }],
      },
      { id: 'fix', kind: 'tool', tool: 'noop' },
    ]);
    expect(nextNodeId(s, { node: s.nodes[0]!, prev: failed, trigger, vars: {} })).toBe('fix');
  });

  it('условие может читать переменные спецификации', () => {
    const s = spec([
      {
        id: 'a',
        kind: 'tool',
        tool: 'noop',
        on: [{ when: { path: 'vars.branch', op: 'eq', value: 'main' }, then: 'b' }],
      },
      { id: 'b', kind: 'tool', tool: 'noop' },
    ]);
    expect(nextNodeId(s, { node: s.nodes[0]!, prev: ok, trigger, vars: { branch: 'main' } })).toBe(
      'b',
    );
    expect(nextNodeId(s, { node: s.nodes[0]!, prev: ok, trigger, vars: { branch: 'dev' } })).toBeNull();
  });

  it('лимит переходов ограничен (защита от бесконечного цикла)', () => {
    expect(MAX_PIPELINE_TRANSITIONS).toBeGreaterThan(0);
    expect(MAX_PIPELINE_TRANSITIONS).toBe(100);
  });
});
