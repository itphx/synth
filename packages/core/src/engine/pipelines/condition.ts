/**
 * ADR-101 (Pipeline Engine): вычисление условий перехода (структурированный DSL).
 *
 * Условие — `{ path, op, value }` (`PipelineCondition`, shared). Никакого
 * `eval` и произвольного кода в ядре (ADR-101 §5): только точечный путь,
 * оператор сравнения и литерал.
 *
 * ## Операторы
 *
 * | Оператор  | Смысл                                                     |
 * |-----------|-----------------------------------------------------------|
 * | `eq`      | Строгое равенство (по типу): `1` ≠ `'1'`, `true` ≠ `'true'` |
 * | `ne`      | Отрицание `eq` (по типу)                                  |
 * | `in`      | Значение пути ∈ массиву- литералу `value`                 |
 * | `exists`  | Путь существует и не `undefined`/`null`                    |
 * | `gt`      | Числовое «больше» (не-числа → условие не выполнено)        |
 * | `lt`      | Числовое «меньше» (не-числа → условие не выполнено)       |
 *
 * ## Fail-soft
 *
 * Неизвестный путь, отсутствующее значение или несовпадение типов ⇒ условие
 * **не выполнено** (`false`), без исключения и без падения прогона. Это
 * означает и то, что `ne` на отсутствующем пути — `false` (а не `true`):
 * «нет значения» — не «значение отличается».
 */
import type { PipelineCondition } from '@itphx/synth-shared';

import { resolvePipelinePath } from './paths.js';
import type { ConditionContext } from './types.js';

/**
 * Вычисление условия перехода.
 *
 * @param cond — условие `{ path, op, value }`.
 * @param ctx — данные прогона (`prev`/`trigger`/`vars`).
 * @returns `true`, если условие выполнено; иначе `false` (fail-soft).
 */
export function evaluateCondition(cond: PipelineCondition, ctx: ConditionContext): boolean {
  if (!cond || typeof cond.path !== 'string' || !cond.path) return false;
  const raw = resolvePipelinePath(cond.path, ctx);
  const value = cond.value;

  switch (cond.op) {
    case 'exists':
      // Путь есть и значение не «пустое» (`undefined`/`null`).
      return raw !== undefined && raw !== null;
    case 'eq':
      if (raw === undefined) return false;
      return strictEquals(raw, value);
    case 'ne':
      // Отсутствующее значение — условие не выполнено (fail-soft), а не «не равно».
      if (raw === undefined) return false;
      return !strictEquals(raw, value);
    case 'in':
      if (raw === undefined || raw === null) return false;
      if (!Array.isArray(value)) return false;
      return value.some((item) => strictEquals(raw, item));
    case 'gt':
    case 'lt': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return false;
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      return cond.op === 'gt' ? raw > value : raw < value;
    }
    default:
      // Неизвестный оператор — условие не выполнено (fail-soft).
      return false;
  }
}

/**
 * Строгое равенство по типу.
 *
 * Примитивы сравниваются по типу и значению (`1` ≠ `'1'`), массивы и объекты —
 * поэлементно/пополям (глубина 1 для объектов: сравниваются ключи и значения
 * примитивов; вложенные объекты сравниваются рекурсивно).
 */
function strictEquals(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => strictEquals(item, b[index]));
  }
  if (typeof a !== 'object' || typeof b !== 'object') {
    if (typeof a !== typeof b) return false;
    return a === b;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) && strictEquals(left[key], right[key]),
  );
}
