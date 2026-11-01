import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from './json-schema.js';
import { sanitizeToolSchema } from './schema-sanitize.js';

describe('zodToJsonSchema — discriminatedUnion', () => {
  it('discriminatedUnion превращается в object-схему с единым enum-дискриминатором', () => {
    const schema = z.discriminatedUnion('action', [
      z.object({ action: z.literal('create_item'), title: z.string() }),
      z.object({ action: z.literal('delete_item'), itemId: z.string() }),
    ]);

    const json = zodToJsonSchema(schema);
    const props = json.properties as Record<string, unknown>;
    const action = props.action as { type?: string; enum?: string[] };
    const title = props.title as { type?: string };

    expect(json.type).toBe('object');
    expect(action.type).toBe('string');
    expect(action.enum).toEqual(['create_item', 'delete_item']);
    expect(title.type).toBe('string');
    expect(props.itemId).toBeDefined();
    expect(json.required).toEqual(['action']);
  });

  it('поля вариантов остаются опциональными (required только дискриминатор)', () => {
    const schema = z.discriminatedUnion('action', [
      z.object({ action: z.literal('create_item'), title: z.string() }),
      z.object({ action: z.literal('delete_item'), itemId: z.string() }),
    ]);

    const json = zodToJsonSchema(schema);

    expect(json.required).toEqual(['action']);
  });

  it('регрессия: z.object по-прежнему даёт object-схему', () => {
    const json = zodToJsonSchema(z.object({ title: z.string() }));

    expect(json.type).toBe('object');
    const title = (json.properties as Record<string, unknown>).title as { type?: string };
    expect(title.type).toBe('string');
  });

  it('регрессия: z.string() → {type: string}', () => {
    const json = zodToJsonSchema(z.string());

    expect(json).toEqual({ type: 'string' });
  });
});

/**
 * «Одно-или-много» (`T | T[]`): в JSON Schema `anyOf` из объекта и массива
 * модель читает как противоречие и повторяет тот же аргумент (`todos:
 * Invalid input` ×10 подряд на test). Массив — надмножество, поэтому схема для
 * модели сводится к `type: 'array'`, а zod по-прежнему принимает и одиночное
 * значение (валидацию делает сам zod, схема — только инструкция модели).
 */
describe('zodToJsonSchema — «одно-или-много» (union [T, array(T)])', () => {
  const item = z.object({ content: z.string() });

  function todosSchema(schema: z.ZodType): Record<string, unknown> {
    const json = zodToJsonSchema(z.object({ todos: schema }));
    return (json.properties as Record<string, Record<string, unknown>>).todos!;
  }

  it('todo-подобная схема → type: array + пометка про одиночное значение', () => {
    const json = todosSchema(
      z.union([item, z.array(item)]).describe('Todo item or array of todo items to add'),
    );

    expect(json.type).toBe('array');
    expect(json.anyOf).toBeUndefined();
    expect(json.items).toMatchObject({ type: 'object' });
    expect(json.description).toBe(
      'Todo item or array of todo items to add — a single item object is also accepted',
    );
  });

  it('обратный порядок ветвей (array первым) сворачивается так же', () => {
    const json = todosSchema(z.union([z.array(item), item]).describe('items'));

    expect(json.type).toBe('array');
    expect(json.anyOf).toBeUndefined();
    expect(json.items).toMatchObject({ type: 'object' });
    expect(json.description).toContain('a single item object is also accepted');
  });

  it('string | array(string) → array of string', () => {
    const json = todosSchema(z.union([z.string(), z.array(z.string())]).describe('ids'));

    expect(json.type).toBe('array');
    expect(json.items).toEqual({ type: 'string' });
    expect(json.description).toContain('a single string is also accepted');
  });

  it('union скаляров остаётся anyOf (не сворачивается)', () => {
    const json = zodToJsonSchema(z.object({ value: z.union([z.string(), z.number()]) }));
    const value = (json.properties as Record<string, Record<string, unknown>>).value!;

    expect(value.type).toBeUndefined();
    expect(value.anyOf).toHaveLength(2);
  });

  it('nullable остаётся anyOf [X, null]', () => {
    const json = zodToJsonSchema(z.object({ note: z.string().nullable() }));
    const note = (json.properties as Record<string, Record<string, unknown>>).note!;

    expect(note.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
  });

  it('ветви с описанием внутри не сворачиваются в чужой элемент', () => {
    // Массив другого элемента — не «одно-или-много».
    const json = todosSchema(z.union([z.string(), z.array(z.number())]));

    expect(json.anyOf).toHaveLength(2);
    expect(json.type).toBeUndefined();
  });
});

/**
 * Санитайзер на границе LLM: MCP-серверы (playwright и др.) отдают `$schema`
 * внутри `input_schema` и собственные `anyOf` — их мы не контролируем, поэтому
 * правило применяется к готовой JSON-схеме, а не к zod.
 */
describe('sanitizeToolSchema', () => {
  it('убирает вложенный $schema и сворачивает anyOf[T, array(T)]', () => {
    const mcpSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        target: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { selector: { type: 'string' } },
          required: ['selector'],
        },
        urls: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
      },
      required: ['target'],
    };

    const sanitized = sanitizeToolSchema(mcpSchema);
    const text = JSON.stringify(sanitized);

    expect(text).not.toContain('$schema');
    const properties = sanitized.properties as Record<string, Record<string, unknown>>;
    expect(properties.urls).toEqual({ type: 'array', items: { type: 'string' } });
    // Остальное не переписано.
    expect(properties.target).toMatchObject({ type: 'object', required: ['selector'] });
    expect(sanitized.required).toEqual(['target']);
  });

  it('nullable/enum/прочие union-ы остаются как есть', () => {
    const schema = {
      type: 'object',
      properties: {
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        mode: { type: 'string', enum: ['plan', 'act'] },
        value: {
          anyOf: [
            { anyOf: [{ type: 'string' }, { type: 'number' }] },
            {
              type: 'array',
              items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            },
          ],
        },
      },
      additionalProperties: false,
    };

    expect(sanitizeToolSchema(schema)).toEqual(schema);
  });

  it('не мутирует исходную схему', () => {
    const schema = {
      type: 'object',
      properties: { urls: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } },
    };
    const copy = JSON.parse(JSON.stringify(schema)) as unknown;

    sanitizeToolSchema(schema);

    expect(schema).toEqual(copy);
  });
});
