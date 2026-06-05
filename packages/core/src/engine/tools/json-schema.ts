import { z } from 'zod';

type JsonSchema =
  | { type?: 'string' | 'null'; description?: string; enum?: string[]; format?: string }
  | { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items: JsonSchema }
  | { type: 'object'; description?: string; properties: Record<string, JsonSchema>; required?: string[] }
  | { anyOf: JsonSchema[]; description?: string };

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return _convert(schema) as Record<string, unknown>;
}

function _convert(schema: z.ZodTypeAny): JsonSchema {
  let processed = schema;
  let description: string | undefined;

  if (processed instanceof z.ZodDefault) {
    processed = processed._def.innerType;
  }

  if (processed instanceof z.ZodOptional) {
    processed = processed._def.innerType;
  }

  if (processed instanceof z.ZodEffects) {
    processed = processed._def.schema;
  }

  if (processed instanceof z.ZodBranded) {
    processed = processed._def.type;
  }

  if (processed instanceof z.ZodPipeline) {
    processed = processed._def.in;
  }

  if (processed instanceof z.ZodNullable) {
    const result = _convert(processed._def.innerType);
    if ('type' in result && result.type === 'string' && result.enum) {
      return { anyOf: [result, { type: 'null' }], description: result.description };
    }
    return { anyOf: [result, { type: 'null' }], description: result.description };
  }

  description = processed._def.description;

  if (processed instanceof z.ZodString) {
    const checks = processed._def.checks || [];
    const result: { type: 'string'; description?: string; enum?: string[]; format?: string } = { type: 'string' };
    if (description) result.description = description;

    for (const check of checks) {
      if (check.kind === 'datetime') result.format = 'date-time';
      if (check.kind === 'email') result.format = 'email';
      if (check.kind === 'url') result.format = 'uri';
      if (check.kind === 'uuid') result.format = 'uuid';
      if (check.kind === 'ip') result.format = 'ip';
    }
    return result;
  }

  if (processed instanceof z.ZodNumber) {
    const checks = processed._def.checks || [];
    const result: { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number } = {
      type: processed._def.coerce ? 'number' : 'number',
    };
    if (description) result.description = description;

    for (const check of checks) {
      if (check.kind === 'int') result.type = 'integer';
      if (check.kind === 'min') result.minimum = check.value;
      if (check.kind === 'max') result.maximum = check.value;
    }
    return result;
  }

  if (processed instanceof z.ZodBoolean) {
    return { type: 'boolean', description };
  }

  if (processed instanceof z.ZodArray) {
    return {
      type: 'array',
      description,
      items: _convert(processed._def.type),
    };
  }

  if (processed instanceof z.ZodObject) {
    const shape = processed._def.shape();
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = _convert(value as z.ZodTypeAny);
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
        required.push(key);
      }
    }

    const result: { type: 'object'; description?: string; properties: Record<string, JsonSchema>; required?: string[] } = {
      type: 'object',
      properties,
    };
    if (description) result.description = description;
    if (required.length > 0) result.required = required;

    return result;
  }

  if (processed instanceof z.ZodEnum || processed instanceof z.ZodNativeEnum) {
    const values = processed instanceof z.ZodEnum
      ? processed._def.values
      : Object.values(processed._def.values).filter((v) => typeof v === 'string');
    return { type: 'string', description, enum: values as string[] };
  }

  if (processed instanceof z.ZodUnion) {
    const options = processed._def.options as z.ZodTypeAny[];
    return {
      anyOf: options.map((opt) => _convert(opt)),
      description,
    };
  }

  if (processed instanceof z.ZodRecord) {
    return {
      type: 'object',
      description: description || 'Record of key-value pairs',
      properties: {},
    };
  }

  if (processed instanceof z.ZodLiteral) {
    const value = processed._def.value;
    if (typeof value === 'string') return { type: 'string', description, enum: [value] };
    if (typeof value === 'number') return { type: 'number', description, minimum: value, maximum: value };
    if (typeof value === 'boolean') return { type: 'boolean', description };
    return { type: 'string', description };
  }

  if (processed instanceof z.ZodAny) {
    return { type: 'string', description: description || 'any value' };
  }

  return { type: 'string', description: description || '' };
}
