/**
 * Тесты маппинга входа шага (ADR-101, §1 «маппинг входа»).
 *
 * Проверяются: разбор `prev.output.*`/`trigger.payload.*`/`vars.*`, пропуск
 * отсутствующих путей и разбор вложенных объектов.
 */
import { describe, it, expect } from 'vitest';
import type { PipelineNode, PipelineRunTrigger, StepResult } from '@itphx/synth-shared';

import { resolveSpecVars, resolveStepInput } from './mapping.js';

const trigger: PipelineRunTrigger = {
  kind: 'gateway',
  payload: {
    issue: 'Что-то сломалось',
    nested: { deep: { value: 'x' } },
    count: 2,
  },
};

const prev: StepResult = {
  status: 'ok',
  attempt: 1,
  output: {
    report: 'отчёт',
    nested: { deep: { value: 'x' } },
  },
};

function node(input?: string[]): PipelineNode {
  return { id: 'step', kind: 'tool', tool: 'noop', ...(input ? { input } : {}) };
}

describe('resolveStepInput', () => {
  it('раскладывает пути маппинга по ключам-путям', () => {
    const input = resolveStepInput(node(['prev.output.report', 'trigger.payload.issue']), {
      prev,
      trigger,
      vars: {},
    });
    expect(input).toEqual({
      'prev.output.report': 'отчёт',
      'trigger.payload.issue': 'Что-то сломалось',
    });
  });

  it('добавляет переменные спецификации по именам', () => {
    const input = resolveStepInput(node(), { prev, trigger, vars: { branch: 'main', limit: 5 } });
    expect(input).toEqual({ branch: 'main', limit: 5 });
  });

  it('пропускает пути, которых нет в данных', () => {
    const input = resolveStepInput(node(['prev.output.missing', 'trigger.payload.issue']), {
      prev,
      trigger,
      vars: {},
    });
    expect(input).toEqual({ 'trigger.payload.issue': 'Что-то сломалось' });
    expect('prev.output.missing' in input).toBe(false);
  });

  it('разбирает вложенные объекты и индексы массивов', () => {
    const input = resolveStepInput(node(['trigger.payload.nested.deep.value']), {
      prev,
      trigger,
      vars: {},
    });
    expect(input).toEqual({ 'trigger.payload.nested.deep.value': 'x' });
  });

  it('пустой маппинг даёт пустой объект', () => {
    expect(resolveStepInput(node(), { prev, trigger, vars: {} })).toEqual({});
  });
});

describe('resolveSpecVars', () => {
  it('разрешает переменные по путям (имя → значение)', () => {
    const vars = resolveSpecVars(
      {
        id: 'p',
        name: 'p',
        version: 1,
        status: 'published',
        mode: 'act',
        vars: { branch: 'trigger.payload.issue', count: 'trigger.payload.count' },
        nodes: [],
        exits: [],
      },
      { trigger },
    );
    expect(vars).toEqual({ branch: 'Что-то сломалось', count: 2 });
  });

  it('переменная, значение которой не определено, не добавляется', () => {
    const vars = resolveSpecVars(
      {
        id: 'p',
        name: 'p',
        version: 1,
        status: 'published',
        mode: 'act',
        vars: { missing: 'trigger.payload.nope' },
        nodes: [],
        exits: [],
      },
      { trigger },
    );
    expect(vars).toEqual({});
  });

  it('переменная может ссылаться на выход предыдущего шага', () => {
    const vars = resolveSpecVars(
      {
        id: 'p',
        name: 'p',
        version: 1,
        status: 'published',
        mode: 'act',
        vars: { report: 'prev.output.report' },
        nodes: [],
        exits: [],
      },
      { prev, trigger },
    );
    expect(vars).toEqual({ report: 'отчёт' });
  });
});
