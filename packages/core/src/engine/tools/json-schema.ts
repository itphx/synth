import { z } from 'zod';

type JsonSchema =
  | { type?: 'string' | 'null'; description?: string; enum?: string[]; format?: string }
  | { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items: JsonSchema }
  | { type: 'object'; description?: string; properties: Record<string, JsonSchema>; required?: string[] }
  | { anyOf: JsonSchema[]; description?: string };

/**
 * Внутренняя структура `_def` zod 4: у обёрток (`default`/`optional`/`pipe`) —
 * `innerType`/`in`, у перечислений — `entries`, у литералов — `values`,
 * у строк/чисел проверки лежат в `_zod.def.checks`.
 */
type Zod4CheckDef = {
  check?: string;
  format?: string;
  value?: number;
  inclusive?: boolean;
};

type Zod4Def = {
  innerType?: z.ZodType;
  in?: z.ZodType;
  discriminator?: string;
  entries?: Record<string, unknown>;
  values?: unknown[];
  checks?: Array<{ _zod?: { def?: Zod4CheckDef } } | undefined>;
};

function def(schema: z.ZodType): Zod4Def {
  return (schema as unknown as { _def: Zod4Def })._def;
}

export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return _convert(schema) as Record<string, unknown>;
}

function _convert(schema: z.ZodType): JsonSchema {
  let processed = schema;

  // Обёртки zod 4: default/optional разворачиваются в innerType, pipe (transform) — в `in`.
  while (
    processed instanceof z.ZodDefault ||
    processed instanceof z.ZodOptional ||
    processed instanceof z.ZodPipe
  ) {
    processed =
      processed instanceof z.ZodPipe ? def(processed).in! : def(processed).innerType!;
  }

  const description = processed.description;

  if (processed instanceof z.ZodNullable) {
    const result = _convert(def(processed).innerType!);
    return { anyOf: [result, { type: 'null' }], description: result.description };
  }

  if (processed instanceof z.ZodString) {
    const checks = def(processed).checks ?? [];
    const result: { type: 'string'; description?: string; enum?: string[]; format?: string } = { type: 'string' };
    if (description) result.description = description;

    for (const check of checks) {
      const checkDef = check?._zod?.def;
      if (checkDef?.check !== 'string_format') continue;
      if (checkDef.format === 'datetime') result.format = 'date-time';
      if (checkDef.format === 'email') result.format = 'email';
      if (checkDef.format === 'url') result.format = 'uri';
      if (checkDef.format === 'uuid') result.format = 'uuid';
      if (checkDef.format === 'ip') result.format = 'ip';
    }
    return result;
  }

  if (processed instanceof z.ZodNumber) {
    const checks = def(processed).checks ?? [];
    const result: { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number } = {
      type: 'number',
    };
    if (description) result.description = description;

    for (const check of checks) {
      const checkDef = check?._zod?.def;
      if (checkDef?.check === 'number_format' && checkDef.format === 'safeint') result.type = 'integer';
      if (checkDef?.check === 'greater_than' && checkDef.inclusive !== false && typeof checkDef.value === 'number') {
        result.minimum = checkDef.value;
      }
      if (checkDef?.check === 'less_than' && checkDef.inclusive !== false && typeof checkDef.value === 'number') {
        result.maximum = checkDef.value;
      }
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
      items: _convert(processed.element as unknown as z.ZodType),
    };
  }

  if (processed instanceof z.ZodObject) {
    const shape = processed.shape;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = _convert(value);
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

  if (processed instanceof z.ZodEnum) {
    // zod 4: и `z.enum`, и `z.nativeEnum` — это `ZodEnum`; числовые значения нативного
    // enum отбрасываем — JSON-схема тула описывает только строковые варианты.
    const values = Object.values(def(processed).entries ?? {}).filter(
      (value): value is string => typeof value === 'string',
    );
    return { type: 'string', description, enum: values };
  }

  // discriminatedUnion — наследник ZodUnion, поэтому проверяется ДО него.
  if (processed instanceof z.ZodDiscriminatedUnion) {
    // discriminatedUnion → объектная схема с единым enum-дискриминатором.
    // Без этого схема падала в fallback {type:'string'}, а DeepSeek строго
    // требует верхнеуровневый type:'object' для tool-параметров.
    const options = processed.options as z.ZodType[];
    const discriminator = def(processed).discriminator ?? '';
    const properties: Record<string, JsonSchema> = {};
    const values: string[] = [];

    for (const opt of options) {
      const converted = _convert(opt);
      if (!('properties' in converted) || converted.type !== 'object') continue;
      // Сливаем properties всех вариантов; уже существующие ключи не перезаписываем.
      for (const [key, value] of Object.entries(converted.properties)) {
        if (!(key in properties)) {
          properties[key] = value;
        }
      }
      // Значение дискриминатора каждого варианта — из enum[0] literal-поля.
      const disc = converted.properties[discriminator];
      if (disc && 'enum' in disc && disc.enum && disc.enum.length > 0) {
        values.push(disc.enum[0]!);
      }
    }

    const result: {
      type: 'object';
      description?: string;
      properties: Record<string, JsonSchema>;
      required?: string[];
    } = {
      type: 'object',
      properties: {
        ...properties,
        [discriminator]: { type: 'string', enum: values },
      },
      // Остальные поля вариантов опциональны — required только дискриминатор,
      // иначе create_item.title станет обязательным для delete_item.
      required: [discriminator],
    };
    if (description) result.description = description;
    return result;
  }

  if (processed instanceof z.ZodUnion) {
    const options = processed.options as z.ZodType[];
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
    const value = def(processed).values?.[0];
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
