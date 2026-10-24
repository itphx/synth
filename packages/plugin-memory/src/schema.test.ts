/**
 * Тесты мини-валидатора параметров (`schema.ts`).
 *
 * Проверяется контракт, который ждёт хост (ADR-090): `safeParse` → либо
 * `{success: true, data}`, либо `{success: false, error: {issues}}` — с путём
 * до поля и текстом проблемы.
 */
import { describe, expect, it } from 'vitest';

import {
  array,
  boolean,
  defaulted,
  enumOf,
  number,
  object,
  optional,
  string,
} from './schema.js';

describe('мини-валидатор параметров', () => {
  it('объект: обязательное поле отсутствует → issue с путём', () => {
    const schema = object({ text: string({ min: 1 }) });
    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toHaveLength(1);
    expect(parsed.error.issues[0]!.path).toEqual(['text']);
    expect(parsed.error.issues[0]!.message).toContain('Обязательное поле');
  });

  it('объект: лишние ключи отбрасываются, как в zod', () => {
    const schema = object({ text: string({ min: 1 }) });
    const parsed = schema.safeParse({ text: 'факт', injected: 'лишнее' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({ text: 'факт' });
    expect('injected' in parsed.data).toBe(false);
  });

  it('объект: необязательное поле отсутствует — ключа нет в данных', () => {
    const schema = object({ text: string({ min: 1 }), note: optional(string()) });
    const parsed = schema.safeParse({ text: 'факт' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.text).toBe('факт');
    expect('note' in parsed.data).toBe(false);
  });

  it('объект: поле со значением по умолчанию — подставляется', () => {
    const schema = object({ limit: defaulted(number({ int: true }), 5) });
    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.limit).toBe(5);
  });

  it('строка: тип, min, max и шаблон', () => {
    const schema = object({ text: string({ min: 2, max: 5, pattern: /^[a-z]+$/ }) });
    expect(schema.safeParse({ text: 'abc' }).success).toBe(true);
    expect(schema.safeParse({ text: 42 }).success).toBe(false);
    const short = schema.safeParse({ text: 'a' });
    expect(short.success).toBe(false);
    if (short.success) return;
    expect(short.error.issues[0]!.message).toContain('короче');
    const long = schema.safeParse({ text: 'abcdef' });
    expect(long.success).toBe(false);
    if (long.success) return;
    expect(long.error.issues[0]!.message).toContain('длиннее');
    const pattern = schema.safeParse({ text: 'ABC' });
    expect(pattern.success).toBe(false);
    if (pattern.success) return;
    expect(pattern.error.issues[0]!.message).toContain('шаблону');
  });

  it('число: тип, границы и целочисленность', () => {
    const schema = object({ ttl: number({ min: 1, max: 10, int: true }) });
    expect(schema.safeParse({ ttl: 5 }).success).toBe(true);
    expect(schema.safeParse({ ttl: '5' }).success).toBe(false);
    const below = schema.safeParse({ ttl: 0 });
    expect(below.success).toBe(false);
    if (below.success) return;
    expect(below.error.issues[0]!.message).toContain('меньше');
    const above = schema.safeParse({ ttl: 11 });
    expect(above.success).toBe(false);
    if (above.success) return;
    expect(above.error.issues[0]!.message).toContain('больше');
    const fractional = schema.safeParse({ ttl: 1.5 });
    expect(fractional.success).toBe(false);
    if (fractional.success) return;
    expect(fractional.error.issues[0]!.message).toContain('целое');
  });

  it('перечисление: значение вне списка отвергается', () => {
    const schema = object({ mode: enumOf(['supersede', 'retract']) });
    expect(schema.safeParse({ mode: 'retract' }).success).toBe(true);
    const parsed = schema.safeParse({ mode: 'unknown' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]!.path).toEqual(['mode']);
    expect(parsed.error.issues[0]!.message).toContain('supersede, retract');
  });

  it('логическое значение: не-boolean отвергается', () => {
    const schema = object({ dryRun: optional(boolean()) });
    expect(schema.safeParse({ dryRun: true }).success).toBe(true);
    expect(schema.safeParse({ dryRun: 'yes' }).success).toBe(false);
  });

  it('массив: лимит длины и проверка элементов с индексом в пути', () => {
    const schema = object({ items: array(string({ min: 1 }), { max: 2 }) });
    expect(schema.safeParse({ items: ['a', 'b'] }).success).toBe(true);
    const tooLong = schema.safeParse({ items: ['a', 'b', 'c'] });
    expect(tooLong.success).toBe(false);
    if (tooLong.success) return;
    expect(tooLong.error.issues[0]!.message).toContain('длиннее');
    const badItem = schema.safeParse({ items: ['a', ''] });
    expect(badItem.success).toBe(false);
    if (badItem.success) return;
    expect(badItem.error.issues[0]!.path).toEqual(['items', 1]);
  });

  it('вложенный объект: путь до вложенного поля', () => {
    const schema = object({
      action: enumOf(['status', 'create']),
      source: optional(
        object({
          kind: enumOf(['files', 'facts']),
          filter: optional(string({ min: 1, max: 500 })),
        }),
      ),
    });
    const ok = schema.safeParse({ action: 'create', source: { kind: 'files' } });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.source).toEqual({ kind: 'files' });
    }
    const bad = schema.safeParse({ action: 'create', source: { kind: 'unknown' } });
    expect(bad.success).toBe(false);
    if (bad.success) return;
    expect(bad.error.issues[0]!.path).toEqual(['source', 'kind']);
  });
});
