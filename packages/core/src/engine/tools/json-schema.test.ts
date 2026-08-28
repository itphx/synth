import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from './json-schema.js';

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
