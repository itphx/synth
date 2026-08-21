import { describe, it, expect } from 'vitest';
import { normalizeAgentModes } from './normalize.js';

describe('normalizeAgentModes', () => {
  it('undefined → ["primary"]', () => {
    expect(normalizeAgentModes(undefined)).toEqual(['primary']);
    expect(normalizeAgentModes(null)).toEqual(['primary']);
  });

  it('валидная строка → массив из одного класса', () => {
    expect(normalizeAgentModes('primary')).toEqual(['primary']);
    expect(normalizeAgentModes('subagent')).toEqual(['subagent']);
    expect(normalizeAgentModes('system')).toEqual(['system']);
  });

  it("'all' (старые данные) → ['primary','subagent']", () => {
    expect(normalizeAgentModes('all')).toEqual(['primary', 'subagent']);
  });

  it('массив → те же уникальные валидные значения', () => {
    expect(normalizeAgentModes(['primary', 'subagent'])).toEqual(['primary', 'subagent']);
    expect(normalizeAgentModes(['system', 'subagent', 'primary'])).toEqual(['system', 'subagent', 'primary']);
  });

  it('дедупликация повторяющихся значений', () => {
    expect(normalizeAgentModes(['primary', 'primary'])).toEqual(['primary']);
    expect(normalizeAgentModes(['subagent', 'primary', 'subagent'])).toEqual(['subagent', 'primary']);
  });

  it('невалидная строка → ["primary"]', () => {
    expect(normalizeAgentModes('foo')).toEqual(['primary']);
  });

  it('невалидные значения в массиве отбрасываются', () => {
    expect(normalizeAgentModes(['foo', 'primary'])).toEqual(['primary']);
  });

  it('пустой массив → ["primary"]', () => {
    expect(normalizeAgentModes([])).toEqual(['primary']);
  });

  it("'all' внутри массива раскрывается и дедуплицируется", () => {
    expect(normalizeAgentModes(['all', 'primary'])).toEqual(['primary', 'subagent']);
  });
});
