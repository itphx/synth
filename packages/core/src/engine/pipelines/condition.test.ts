/**
 * Тесты вычисления условий перехода (ADR-101, DSL условий).
 *
 * Проверяются: все операторы, отсутствующие пути, несовпадение типов,
 * вложенные пути и fail-soft (условие не выполнено, исключения нет).
 */
import { describe, it, expect } from 'vitest';
import type { PipelineCondition, PipelineRunTrigger, StepResult } from '@itphx/synth-shared';

import { evaluateCondition } from './condition.js';

const trigger: PipelineRunTrigger = {
  kind: 'gateway',
  source: 'ci',
  type: 'release_published',
  payload: {
    branch: 'main',
    number: 42,
    ok: true,
    nested: { deep: { value: 'x' } },
    tags: ['a', 'b'],
    nothing: null,
  },
};

const prev: StepResult = {
  status: 'ok',
  attempt: 1,
  output: {
    report: 'готово',
    count: 3,
    ok: true,
    nested: { deep: { value: 'x' } },
    tags: ['a', 'b'],
    nothing: null,
  },
};

const ctx = { prev, trigger, vars: { branch: 'main', limit: 10 } };

function check(cond: PipelineCondition, context = ctx): boolean {
  return evaluateCondition(cond, context);
}

describe('evaluateCondition', () => {
  it('eq: строгое равенство по типу', () => {
    expect(check({ path: 'trigger.payload.branch', op: 'eq', value: 'main' })).toBe(true);
    expect(check({ path: 'trigger.payload.branch', op: 'eq', value: 'other' })).toBe(false);
    // Тип значения различается — условие не выполнено.
    expect(check({ path: 'trigger.payload.number', op: 'eq', value: '42' })).toBe(false);
    expect(check({ path: 'trigger.payload.number', op: 'eq', value: 42 })).toBe(true);
    expect(check({ path: 'trigger.payload.ok', op: 'eq', value: true })).toBe(true);
    expect(check({ path: 'trigger.payload.ok', op: 'eq', value: 'true' })).toBe(false);
  });

  it('ne: отрицание eq по типу', () => {
    expect(check({ path: 'trigger.payload.branch', op: 'ne', value: 'dev' })).toBe(true);
    expect(check({ path: 'trigger.payload.branch', op: 'ne', value: 'main' })).toBe(false);
    expect(check({ path: 'trigger.payload.number', op: 'ne', value: '42' })).toBe(true);
  });

  it('in: значение принадлежит массиву- литералу', () => {
    expect(check({ path: 'trigger.payload.branch', op: 'in', value: ['main', 'dev'] })).toBe(true);
    expect(check({ path: 'trigger.payload.branch', op: 'in', value: ['dev'] })).toBe(false);
    // Литерал не массив — условие не выполнено.
    expect(check({ path: 'trigger.payload.branch', op: 'in', value: 'main' })).toBe(false);
  });

  it('exists: путь есть и значение не пустое', () => {
    expect(check({ path: 'trigger.payload.branch', op: 'exists' })).toBe(true);
    expect(check({ path: 'trigger.payload.nothing', op: 'exists' })).toBe(false);
    expect(check({ path: 'trigger.payload.missing', op: 'exists' })).toBe(false);
  });

  it('gt/lt: числовое сравнение; не-числа — условие не выполнено', () => {
    expect(check({ path: 'trigger.payload.number', op: 'gt', value: 41 })).toBe(true);
    expect(check({ path: 'trigger.payload.number', op: 'gt', value: 42 })).toBe(false);
    expect(check({ path: 'trigger.payload.number', op: 'lt', value: 43 })).toBe(true);
    expect(check({ path: 'trigger.payload.branch', op: 'gt', value: 1 })).toBe(false);
    expect(check({ path: 'trigger.payload.branch', op: 'lt', value: 1 })).toBe(false);
  });

  it('неизвестный путь — условие не выполнено (fail-soft, без исключения)', () => {
    expect(check({ path: 'unknown.root.value', op: 'eq', value: 'x' })).toBe(false);
    expect(check({ path: 'unknown.root.value', op: 'exists' })).toBe(false);
    expect(check({ path: 'trigger.payload.missing.deep', op: 'eq', value: 'x' })).toBe(false);
  });

  it('отсутствующее значение — условие не выполнено даже для ne', () => {
    expect(check({ path: 'trigger.payload.missing', op: 'ne', value: 'x' })).toBe(false);
    expect(check({ path: 'trigger.payload.missing', op: 'in', value: ['x'] })).toBe(false);
    expect(check({ path: 'trigger.payload.missing', op: 'gt', value: 1 })).toBe(false);
  });

  it('поддерживаются prev.output.*, prev.status, vars.*', () => {
    expect(check({ path: 'prev.output.report', op: 'eq', value: 'готово' })).toBe(true);
    expect(check({ path: 'prev.status', op: 'eq', value: 'ok' })).toBe(true);
    expect(check({ path: 'prev.error.code', op: 'exists' })).toBe(false);
    expect(check({ path: 'vars.branch', op: 'eq', value: 'main' })).toBe(true);
    expect(check({ path: 'vars.limit', op: 'gt', value: 5 })).toBe(true);
  });

  it('вложенные пути разрешаются по объектам и массивам', () => {
    expect(check({ path: 'trigger.payload.nested.deep.value', op: 'eq', value: 'x' })).toBe(true);
    expect(check({ path: 'prev.output.nested.deep.value', op: 'eq', value: 'x' })).toBe(true);
    expect(check({ path: 'trigger.payload.tags.0', op: 'eq', value: 'a' })).toBe(true);
    // Индекс за пределами массива — значение не определено.
    expect(check({ path: 'trigger.payload.tags.5', op: 'eq', value: 'a' })).toBe(false);
  });

  it('неизвестный оператор и пустой путь — условие не выполнено', () => {
    expect(
      evaluateCondition(
        { path: 'trigger.payload.branch', op: 'unknown' as never, value: 'main' },
        ctx,
      ),
    ).toBe(false);
    expect(evaluateCondition({ path: '', op: 'exists' }, ctx)).toBe(false);
  });
});
