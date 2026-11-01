/**
 * Защитный тест: «одно-или-много» не должно просачиваться в JSON-схему
 * параметров тула.
 *
 * Причина: `z.union([T, z.array(T)])` давал в схеме `anyOf: [object, array]`,
 * а zod-ошибка для union — бесполезное `todos: Invalid input`. Модель (DeepSeek
 * на test) не понимала, что не так, и повторяла один и тот же аргумент.
 *
 * Правило: `anyOf` с ветвью `{type:'array', items:T}` и второй ветвью ровно `T`
 * (T — один конкретный тип) в схему для модели попадать не должен. Разрешены
 * `anyOf` с `null` (nullable) и union скаляров (`pipeline_save` → `when.value`).
 */
import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from './json-schema.js';
import { sanitizeToolSchema, concreteTypeOf, deepEqualJson } from './schema-sanitize.js';
import { ALL_BUILTIN_TOOLS } from './index.js';

/** Элемент ветви-массива, если ветвь — ровно `{type:'array', items[, description]}`. */
function arrayItemsOf(branch: unknown): unknown | null {
  if (typeof branch !== 'object' || branch === null || Array.isArray(branch)) return null;
  const node = branch as Record<string, unknown>;
  if (node.type !== 'array') return null;
  const extra = Object.keys(node).filter(
    (key) => key !== 'type' && key !== 'items' && key !== 'description',
  );
  if (extra.length > 0) return null;
  return node.items;
}

/** Пути всех `anyOf` вида «одно-или-много» в схеме. */
function findSingleOrManyAnyOf(node: unknown, path: string, found: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) => findSingleOrManyAnyOf(child, `${path}[${index}]`, found));
    return;
  }
  if (typeof node !== 'object' || node === null) return;

  const record = node as Record<string, unknown>;
  const anyOf = record.anyOf;
  if (Array.isArray(anyOf) && anyOf.length === 2) {
    for (let index = 0; index < 2; index += 1) {
      const single = anyOf[index];
      const type = concreteTypeOf(single);
      if (!type) continue;
      const items = arrayItemsOf(anyOf[1 - index]);
      if (items !== null && deepEqualJson(items, single)) {
        found.push(`${path}.anyOf`);
      }
    }
  }

  for (const [key, value] of Object.entries(record)) {
    findSingleOrManyAnyOf(value, `${path}.${key}`, found);
  }
}

describe('JSON-схемы встроенных тулов: «одно-или-много» не просачивается', () => {
  it('ни один тул не отдаёт модели anyOf[T, array(T)]', () => {
    const leaks: string[] = [];

    for (const tool of ALL_BUILTIN_TOOLS) {
      const schema = sanitizeToolSchema(tool.jsonSchema ?? zodToJsonSchema(tool.parameters));
      findSingleOrManyAnyOf(schema, tool.name, leaks);
    }

    expect(leaks).toEqual([]);
  });

  it('todo_add/todo_delete объявляют массив (одиночное значение принимает zod)', () => {
    for (const name of ['todo_add', 'todo_delete']) {
      const tool = ALL_BUILTIN_TOOLS.find((candidate) => candidate.name === name);
      expect(tool, `тул ${name} отсутствует`).toBeDefined();
      const schema = sanitizeToolSchema(zodToJsonSchema(tool!.parameters));
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      const field = name === 'todo_add' ? properties.todos! : properties.ids!;

      expect(field.type).toBe('array');
      expect(field.anyOf).toBeUndefined();
      expect(field.description).toContain('is also accepted');
    }
  });

  it('pipeline_save сохраняет anyOf: `eq`/`ne` сравнивают строго, массив сломал бы семантику', () => {
    const tool = ALL_BUILTIN_TOOLS.find((candidate) => candidate.name === 'pipeline_save')!;
    const schema = sanitizeToolSchema(tool.jsonSchema ?? zodToJsonSchema(tool.parameters));
    const text = JSON.stringify(schema);

    // `when.value` — `scalar | scalar[]`, где скаляр сам union: сводить к массиву
    // нельзя (иначе `eq`/`ne` начнут молча сравнивать массивы).
    expect(text).toContain('"anyOf"');
    const resources = {
      type: 'object',
      properties: {
        value: {
          anyOf: [
            { anyOf: [{ type: 'string' }, { type: 'number' }] },
            { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
          ],
        },
      },
    };
    expect(sanitizeToolSchema(resources)).toEqual(resources);
  });
});
