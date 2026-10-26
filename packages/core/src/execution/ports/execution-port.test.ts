/**
 * Предикат `isExecutionError` — устойчивость к копиям класса (ADR-077).
 *
 * `instanceof` здесь ненадёжен: клиент удалённого порта создаёт ошибку через
 * динамический `import('@itphx/synth-core')` (то есть из `dist`), а код в
 * core импортирует класс из исходников — это два разных объекта класса.
 * Поэтому ошибка опознаётся структурно: по стабильному признаку типа (`name`)
 * и по форме ошибки (`reason`/`message`).
 */

import { describe, expect, it } from 'vitest';
import { ExecutionError, isExecutionError } from './execution-port.js';

describe('isExecutionError', () => {
  it('настоящая ExecutionError — распознаётся', () => {
    const err = new ExecutionError({
      message: 'Command failed: exit 3',
      reason: 'nonzero_exit',
      code: 3,
    });
    expect(isExecutionError(err)).toBe(true);
  });

  it('похожий объект из другой копии класса (src/dist) — распознаётся', () => {
    // Так выглядит `ExecutionError`, созданная другой копией модуля:
    // `instanceof` здесь не срабатывает, а структурная проверка — да.
    const foreign = {
      name: 'ExecutionError',
      reason: 'nonzero_exit',
      message: 'Command failed: exit 3',
      code: 3,
      stdout: '',
      stderr: '',
      killed: false,
      signal: null,
      truncated: false,
      durationMs: 1,
    };
    expect(foreign).not.toBeInstanceOf(ExecutionError);
    expect(isExecutionError(foreign)).toBe(true);
  });

  it('произвольная ошибка — не распознаётся', () => {
    expect(isExecutionError(new Error('boom'))).toBe(false);
    expect(isExecutionError(new TypeError('boom'))).toBe(false);
    expect(isExecutionError({ name: 'Error', message: 'boom' })).toBe(false);
  });

  it('не-ошибка — не распознаётся', () => {
    expect(isExecutionError(null)).toBe(false);
    expect(isExecutionError(undefined)).toBe(false);
    expect(isExecutionError('ExecutionError')).toBe(false);
    expect(isExecutionError(42)).toBe(false);
  });

  it('объект с именем класса, но без формы ошибки — не распознаётся', () => {
    expect(isExecutionError({ name: 'ExecutionError' })).toBe(false);
    expect(isExecutionError({ name: 'ExecutionError', reason: 'nonzero_exit' })).toBe(false);
    expect(isExecutionError({ name: 'ExecutionError', message: 'boom' })).toBe(false);
  });
});
