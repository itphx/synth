/**
 * Санитайзер JSON-схем параметров тулов на границе LLM.
 *
 * Провайдерам уходит схема, которую модель читает как инструкцию. Две вещи
 * в ней вредны для слабых моделей:
 *
 * 1. вложенный `$schema` — MCP-серверы отдают его внутри `input_schema`
 *    (`"https://json-schema.org/draft/2020-12/schema"`), провайдеру он не нужен
 *    и только раздувает схему;
 * 2. `anyOf: [T, {type:'array', items:T}]` («одно-или-много») — модель не
 *    понимает, что одиночное значение тоже допустимо, и повторяет один и тот же
 *    аргумент. Такая ветка сводится к `{type:'array', items:T}`: массив —
 *    надмножество, поэтому сведение ничего не теряет.
 *
 * Сворачивается **только** вырожденный случай: ровно две ветви, одна из которых
 * массив ровно того же элемента, а другая — один конкретный тип. Union скаляров
 * (`string | number`), `nullable` (`anyOf: [X, null]`) и вложенный `anyOf`
 * (например `pipeline_save` → `scalar | scalar[]`, где скаляр сам union)
 * остаются как есть.
 *
 * Модуль не зависит от zod: он применяется и к нашим схемам (после
 * `zodToJsonSchema`), и к чужим (MCP/плагины), которые мы не контролируем.
 */

/** Типы, которые в JSON Schema описывают одно конкретное значение. */
export const CONCRETE_SCHEMA_TYPES = ['object', 'string', 'number', 'integer', 'boolean'] as const;

export type ConcreteSchemaType = (typeof CONCRETE_SCHEMA_TYPES)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Структурное равенство двух JSON-значений (порядок ключей не важен). */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqualJson(item, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => key in b && deepEqualJson(a[key], b[key]));
}

/** Конкретный тип схемы (`object`/`string`/`number`/`integer`/`boolean`) или `null`. */
export function concreteTypeOf(schema: unknown): ConcreteSchemaType | null {
  if (!isPlainObject(schema)) return null;
  const type = schema.type;
  if (typeof type !== 'string') return null;
  return (CONCRETE_SCHEMA_TYPES as readonly string[]).includes(type)
    ? (type as ConcreteSchemaType)
    : null;
}

/** Пометка в `description`: одиночное значение тоже принимается. */
export function singleValueHint(type: ConcreteSchemaType): string {
  switch (type) {
    case 'object':
      return 'a single item object is also accepted';
    case 'string':
      return 'a single string is also accepted';
    case 'number':
      return 'a single number is also accepted';
    case 'integer':
      return 'a single integer is also accepted';
    default:
      return 'a single boolean is also accepted';
  }
}

/** Добавляет к описанию пометку про одиночное значение (идемпотентно). */
export function withSingleValueHint(
  description: string | undefined,
  type: ConcreteSchemaType,
): string | undefined {
  if (!description) return undefined;
  const hint = singleValueHint(type);
  if (description.includes(hint)) return description;
  return `${description} — ${hint}`;
}

/** Ровно `{type:'array', items: …[, description]}` → элемент массива. */
function arrayItemsOf(branch: unknown): unknown | null {
  if (!isPlainObject(branch)) return null;
  if (branch.type !== 'array') return null;
  if (!('items' in branch)) return null;
  if (Object.keys(branch).some((key) => key !== 'type' && key !== 'items' && key !== 'description')) {
    return null;
  }
  return branch.items;
}

/** Описание ветви-массива (если оно там есть) — сохраняется при сворачивании. */
function arrayDescriptionOf(branch: unknown): string | undefined {
  if (!isPlainObject(branch)) return undefined;
  return typeof branch.description === 'string' ? branch.description : undefined;
}

/**
 * Сворачивает ветви union вида `[T, array(T)]` в `{items: T}`.
 *
 * Возвращает `null`, если union не вырожденный: ветвей не две, одна из них не
 * массив ровно того же элемента или «одиночная» ветвь — не один конкретный тип
 * (union скаляров, `null`, вложенный `anyOf`).
 */
export function foldSingleOrArray(
  branches: readonly unknown[],
  description?: string,
): { items: unknown; description?: string } | null {
  if (branches.length !== 2) return null;

  for (let index = 0; index < 2; index += 1) {
    const single = branches[index];
    const type = concreteTypeOf(single);
    if (!type) continue;

    const arrayBranch = branches[1 - index];
    const items = arrayItemsOf(arrayBranch);
    if (items === null) continue;
    if (!deepEqualJson(items, single)) continue;

    const described = withSingleValueHint(description ?? arrayDescriptionOf(arrayBranch), type);
    return described === undefined ? { items: single } : { items: single, description: described };
  }

  return null;
}

/** `anyOf` вырожденного вида → `{type:'array', items}`; иначе `null`. */
function foldAnyOf(node: Record<string, unknown>): Record<string, unknown> | null {
  const anyOf = node.anyOf;
  if (!Array.isArray(anyOf)) return null;
  // Соседние ключи (кроме описания) не переписываем — их семантика не наша.
  if (Object.keys(node).some((key) => key !== 'anyOf' && key !== 'description')) return null;

  const description = typeof node.description === 'string' ? node.description : undefined;
  const folded = foldSingleOrArray(anyOf, description);
  if (!folded) return null;

  const result: Record<string, unknown> = { type: 'array', items: folded.items };
  if (folded.description) result.description = folded.description;
  return result;
}

function sanitizeNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeNode);
  if (!isPlainObject(node)) return node;

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    // `$schema` внутри вложенных объектов-схем провайдеру не нужен.
    if (key === '$schema') continue;
    cleaned[key] = sanitizeNode(value);
  }

  return foldAnyOf(cleaned) ?? cleaned;
}

/**
 * Санитайзер схемы параметров тула: рекурсивно убирает `$schema` и сворачивает
 * вырожденный «одно-или-много» `anyOf`. Остальное (nullable, enum, required,
 * additionalProperties, прочие union'ы) не переписывается.
 */
export function sanitizeToolSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return {};
  const sanitized = sanitizeNode(schema);
  return isPlainObject(sanitized) ? sanitized : schema;
}
