import { describe, it, expect } from 'vitest';
import { deepMerge } from './merge.js';

describe('deepMerge', () => {
  it('мержит простые значения (b перезаписывает a)', () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('мержит вложенные объекты рекурсивно', () => {
    const a = { server: { port: 5000, host: '0.0.0.0' } };
    const b = { server: { port: 9999 } };
    expect(deepMerge(a as never, b as never)).toEqual({ server: { port: 9999, host: '0.0.0.0' } });
  });

  it('мержит глубоко вложенные объекты', () => {
    const a = { runner: { enginePorts: { opencode: 4100, cline: 4200 } } };
    const b = { runner: { enginePorts: { opencode: 9999 } } };
    expect(deepMerge(a as never, b as never)).toEqual({
      runner: { enginePorts: { opencode: 9999, cline: 4200 } },
    });
  });

  it('не мержит массивы рекурсивно — перезаписывает целиком', () => {
    expect(deepMerge({ arr: [1, 2] }, { arr: [3] })).toEqual({ arr: [3] });
  });

  it('не мутирует исходный объект a', () => {
    const a = { x: 1 };
    deepMerge(a, { y: 2 });
    expect(a).toEqual({ x: 1 });
  });

  it('значение null в b перезаписывает поле a', () => {
    expect(deepMerge({ x: { y: 1 } }, { x: null as unknown as Record<string, unknown> })).toEqual({
      x: null,
    });
  });

  it('значение null в a не мешает копированию из b', () => {
    expect(deepMerge({ x: null as unknown as Record<string, unknown> }, { x: { y: 2 } })).toEqual({
      x: { y: 2 },
    });
  });

  it('возвращает копию a, если b пустой', () => {
    const result = deepMerge({ a: 1 }, {});
    expect(result).toEqual({ a: 1 });
    expect(result).not.toBe({ a: 1 });
  });

  it('определение в b undefined перезаписывает поле в a', () => {
    expect(deepMerge({ x: 1 }, { x: undefined as unknown })).toEqual({ x: undefined });
  });

  it('обрабатывает пустые оба объекта', () => {
    expect(deepMerge({}, {})).toEqual({});
  });
});
