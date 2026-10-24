/**
 * Мини-валидатор параметров тулов — без сторонних зависимостей.
 *
 * **Зачем свой, а не zod.** Бандл плагина памяти с вшитым zod сканируется как
 * `caution`: правило `obfuscation/base64` срабатывает на JWT-валидации внутри
 * zod (`z.string().jwt()` → `atob`). Вердикт `caution` + install-policy `ask`
 * означает, что плагин ждёт подтверждения владельца (срок 24 ч) и после
 * рестарта молча не активируется. Собственный валидатор убирает и
 * зависимость, и ложное срабатывание сканера.
 *
 * **Контракт — тот же, что ждёт хост** (`engine/tools/tool-execution.ts`):
 * `parameters.safeParse(args)` возвращает `{success: true, data}` либо
 * `{success: false, error: {issues: [{path, message}]}}`. Хост зовёт
 * `safeParse` и читает `error.issues` — больше ничего не требуется.
 *
 * **Поведение — нужные части zod:**
 * - `object()` — неизвестные ключи **отбрасываются** (как `.object()` по
 *   умолчанию), отсутствующее обязательное поле → issue;
 * - `optional()` — поле может отсутствовать, в данных его нет;
 * - `defaulted()` — поле может отсутствовать, в данных — значение по
 *   умолчанию.
 *
 * JSON-схема для модели задаётся в тулах **вручную** (`jsonSchema`) — она
 * не зависит от этого модуля и остаётся стабильным контрактом (ADR-090).
 */

/** Путь проблемного поля (пустой — корень значения). */
export type SchemaPath = (string | number)[];

/** Одна проблема значения. */
export interface SchemaIssue {
  /** Путь до поля (у вложенных объектов — сегменты пути). */
  path: SchemaPath;
  /** Текст проблемы (уходит в текст ошибки тула). */
  message: string;
}

/** Ошибка разбора — список проблем. */
export interface SchemaError {
  issues: SchemaIssue[];
}

/** Результат разбора значения. */
export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: SchemaError };

/** Схема значения: умеет `safeParse` — этого ходу достаточно. */
export interface Schema<T> {
  /** Разбор значения (контракт хоста, ADR-090). */
  safeParse(value: unknown): SafeParseResult<T>;
  /**
   * Признак необязательного поля (`optional()`) — нужен для вывода типа
   * объекта: такие ключи в данных могут отсутствовать.
   */
  readonly optional?: boolean;
}

/** Тип значения схемы. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

/** Форма объекта: набор полей-схем. */
export type SchemaShape = Record<string, Schema<unknown>>;

/** Ключи объекта, которые необязательны (значение может отсутствовать). */
type OptionalKeys<S extends SchemaShape> = {
  [K in keyof S]: S[K] extends { readonly optional: true } ? K : never;
}[keyof S];

/** Тип данных объекта после разбора. */
export type ObjectData<S extends SchemaShape> = {
  [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]>;
} & {
  [K in OptionalKeys<S>]?: Infer<S[K]>;
};

/**
 * Внутреннее представление схемы: разбор **с путём** (для вложенных полей)
 * и служебные признаки (значение по умолчанию).
 */
interface InternalSchema<T> extends Schema<T> {
  /** Разбор значения с готовым путём (для вложенных объектов/массивов). */
  run(value: unknown, path: SchemaPath): SafeParseResult<T>;
  /** Есть значение по умолчанию (`defaulted()`). */
  readonly hasDefault?: boolean;
  /** Значение по умолчанию (`defaulted()`). */
  readonly defaultValue?: unknown;
}

/** Успешный результат разбора. */
function ok<T>(data: T): SafeParseResult<T> {
  return { success: true, data };
}

/** Неуспешный результат с одной проблемой. */
function fail(path: SchemaPath, message: string): SafeParseResult<never> {
  return { success: false, error: { issues: [{ path, message }] } };
}

/** Неуспешный результат со списком проблем. */
function failIssues(issues: SchemaIssue[]): SafeParseResult<never> {
  return { success: false, error: { issues } };
}

/** Собрать схему из функции разбора. */
function make<T>(
  run: (value: unknown, path: SchemaPath) => SafeParseResult<T>,
): InternalSchema<T> {
  return {
    run,
    safeParse: (value: unknown) => run(value, []),
  };
}

/** Ограничения строки. */
export interface StringOptions {
  /** Минимальная длина. */
  min?: number;
  /** Максимальная длина. */
  max?: number;
  /** Шаблон (регулярное выражение). */
  pattern?: RegExp;
}

/**
 * Схема строки.
 *
 * Длина считается в кодах UTF-16 (как `String.length` в zod).
 */
export function string(options: StringOptions = {}): Schema<string> {
  const { min, max, pattern } = options;
  return make<string>((value, path) => {
    if (typeof value !== 'string') return fail(path, 'Ожидается строка');
    const issues: SchemaIssue[] = [];
    if (min !== undefined && value.length < min) {
      issues.push({ path, message: `Строка короче ${min} символов` });
    }
    if (max !== undefined && value.length > max) {
      issues.push({ path, message: `Строка длиннее ${max} символов` });
    }
    if (pattern && !matchesPattern(pattern, value)) {
      issues.push({ path, message: `Строка не соответствует шаблону ${pattern.source}` });
    }
    return issues.length > 0 ? failIssues(issues) : ok(value);
  });
}

/**
 * Проверка шаблона без состояния: флаги `g`/`y` сделали бы регулярное
 * выражение зависимым от порядка проверок (последний `test` сдвигает
 * `lastIndex`).
 */
function matchesPattern(pattern: RegExp, value: string): boolean {
  const flags = pattern.flags.replace(/[gy]/g, '');
  return new RegExp(pattern.source, flags).test(value);
}

/** Ограничения числа. */
export interface NumberOptions {
  /** Минимальное значение (включительно). */
  min?: number;
  /** Максимальное значение (включительно). */
  max?: number;
  /** Только целые. */
  int?: boolean;
}

/** Схема числа (конечного). */
export function number(options: NumberOptions = {}): Schema<number> {
  const { min, max, int } = options;
  return make<number>((value, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fail(path, 'Ожидается число');
    }
    const issues: SchemaIssue[] = [];
    if (int && !Number.isInteger(value)) {
      issues.push({ path, message: 'Ожидается целое число' });
    }
    if (min !== undefined && value < min) {
      issues.push({ path, message: `Значение меньше ${min}` });
    }
    if (max !== undefined && value > max) {
      issues.push({ path, message: `Значение больше ${max}` });
    }
    return issues.length > 0 ? failIssues(issues) : ok(value);
  });
}

/** Схема логического значения. */
export function boolean(): Schema<boolean> {
  return make<boolean>((value, path) =>
    typeof value === 'boolean' ? ok(value) : fail(path, 'Ожидается true или false'),
  );
}

/**
 * Схема перечисления: значение должно входить в список.
 *
 * Тип-параметр `const` — литеральный список в вызове даёт union литералов
 * (`'active' | 'candidate' | 'all'`), а не `string`.
 */
export function enumOf<const T extends string>(values: readonly T[]): Schema<T> {
  return make<T>((value, path) => {
    if (typeof value !== 'string' || !values.includes(value as T)) {
      return fail(path, `Ожидается одно из: ${values.join(', ')}`);
    }
    return ok(value as T);
  });
}

/** Ограничения массива. */
export interface ArrayOptions {
  /** Максимальное число элементов. */
  max?: number;
}

/** Схема массива: каждый элемент проверяется своей схемой. */
export function array<T>(item: Schema<T>, options: ArrayOptions = {}): Schema<T[]> {
  const inner = item as InternalSchema<T>;
  return make<T[]>((value, path) => {
    if (!Array.isArray(value)) return fail(path, 'Ожидается массив');
    const issues: SchemaIssue[] = [];
    if (options.max !== undefined && value.length > options.max) {
      issues.push({ path, message: `Массив длиннее ${options.max} элементов` });
    }
    const data: T[] = [];
    value.forEach((element, index) => {
      const parsed = inner.run(element, [...path, index]);
      if (!parsed.success) {
        issues.push(...parsed.error.issues);
        return;
      }
      data.push(parsed.data);
    });
    return issues.length > 0 ? failIssues(issues) : ok(data);
  });
}

/**
 * Необязательное поле: значение может отсутствовать (`undefined`).
 *
 * В данных объекта отсутствующее необязательное поле **не появляется** —
 * как и в zod.
 */
export function optional<T>(
  schema: Schema<T>,
): Schema<T | undefined> & { readonly optional: true } {
  const inner = schema as InternalSchema<T>;
  const run = (value: unknown, path: SchemaPath): SafeParseResult<T | undefined> =>
    value === undefined ? ok(undefined) : inner.run(value, path);
  const result: InternalSchema<T | undefined> & { readonly optional: true } = {
    run,
    safeParse: (value: unknown) => run(value, []),
    optional: true,
  };
  return result;
}

/**
 * Поле со значением по умолчанию: может отсутствовать, в данных будет
 * `value` (как `.default()` в zod).
 */
export function defaulted<T>(schema: Schema<T>, value: T): Schema<T> {
  const inner = schema as InternalSchema<T>;
  const run = (input: unknown, path: SchemaPath): SafeParseResult<T> =>
    input === undefined ? ok(value) : inner.run(input, path);
  const result: InternalSchema<T> = {
    run,
    safeParse: (input: unknown) => run(input, []),
    hasDefault: true,
    defaultValue: value,
  };
  return result;
}

/**
 * Схема объекта.
 *
 * Неизвестные ключи **отбрасываются** (как `.object()` в zod по умолчанию):
 * модель не сможет подсунуть лишние поля в аргументы тула.
 */
export function object<S extends SchemaShape>(shape: S): Schema<ObjectData<S>> {
  return make<ObjectData<S>>((value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(path, 'Ожидается объект');
    }
    const input = value as Record<string, unknown>;
    const issues: SchemaIssue[] = [];
    const data: Record<string, unknown> = {};
    for (const key of Object.keys(shape) as Array<keyof S & string>) {
      const field = shape[key] as InternalSchema<unknown>;
      const raw = input[key];
      if (raw === undefined) {
        if (field.optional) continue;
        if (field.hasDefault) {
          data[key] = field.defaultValue;
          continue;
        }
        issues.push({ path: [...path, key], message: 'Обязательное поле отсутствует' });
        continue;
      }
      const parsed = field.run(raw, [...path, key]);
      if (!parsed.success) {
        issues.push(...parsed.error.issues);
        continue;
      }
      if (parsed.data !== undefined) data[key] = parsed.data;
    }
    return issues.length > 0 ? failIssues(issues) : ok(data as unknown as ObjectData<S>);
  });
}
