/**
 * ADR-041: контракт отказа `tool.args_error`.
 *
 * Текст для модели и `metadata.i18n` обязаны строиться **вместе**: UI берёт шаблон
 * и параметры из metadata, поэтому пропущенный `issues` давал бы сырое `{issues}`
 * в интерфейсе (сам `content` при этом был бы полным). Тесты фиксируют формат
 * `issues`, `root` для пустого пути и полноту параметров по контракту движка.
 */
import { describe, it, expect } from 'vitest';
import { z, type ZodIssue } from 'zod';
import { ENGINE_MESSAGE_PARAMS } from '@itphx/synth-shared/i18n';
import { argErrorResult, formatIssues } from './arg-error.js';

/** Минимальный ZodIssue нужной формы (поля, которые читает хелпер). */
function issue(path: (string | number)[], message: string): ZodIssue {
  return { code: 'custom', path, message } as ZodIssue;
}

interface I18nMeta {
  key: string;
  params?: Record<string, unknown>;
}

describe('argErrorResult — контракт tool.args_error (ADR-041)', () => {
  it('ZodIssue[]: path попадает в content и в metadata.i18n.params.issues', () => {
    const issues = [issue(['path'], 'Required')];
    const result = argErrorResult('read_file', issues);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('path: Required');

    const i18n = result.metadata?.i18n as I18nMeta;
    expect(i18n.key).toBe('tool.args_error');
    expect(i18n.params).toMatchObject({ tool: 'read_file' });
    expect(i18n.params?.issues).toBe('path: Required');
    // Один и тот же фрагмент уходит и в текст, и в metadata — иначе UI
    // подставил бы в шаблон не то, что видит модель.
    expect(result.content).toContain(String(i18n.params?.issues));
  });

  it('пустой path → `root`', () => {
    const result = argErrorResult('glob', [issue([], 'Invalid input')]);

    expect(result.content).toContain('root: Invalid input');
    const i18n = result.metadata?.i18n as I18nMeta;
    expect(i18n.params?.issues).toBe('root: Invalid input');
  });

  it('несколько issues склеиваются через `; `, вложенный путь — через точку', () => {
    const result = argErrorResult('patch', [
      issue(['edits', 0, 'file_path'], 'Required'),
      issue(['edits', 1, 'old_string'], 'Too small'),
    ]);

    expect(result.content).toContain('edits.0.file_path: Required; edits.1.old_string: Too small');
  });

  it('строка передаётся как есть (проверки вне Zod)', () => {
    const text = 'name: either "name" or "worktreeId" is required';
    const result = argErrorResult('git_worktree_remove', text);

    expect(result.content).toContain(text);
    const i18n = result.metadata?.i18n as I18nMeta;
    expect(i18n.params?.issues).toBe(text);
    expect(result.content).not.toContain('[object Object]');
  });

  it('formatIssues — единый формат списка issue', () => {
    expect(formatIssues([issue(['a'], 'one'), issue([], 'two')])).toBe('a: one; root: two');
    expect(formatIssues([])).toBe('');
  });

  it('metadata не теряет обязательные параметры шаблона (контракт движка)', () => {
    const result = argErrorResult('read_file', [issue(['path'], 'Required')]);
    const i18n = result.metadata?.i18n as I18nMeta;

    const required = ENGINE_MESSAGE_PARAMS['tool.args_error'];
    expect(required.length).toBeGreaterThan(0);
    for (const name of required) {
      expect(i18n.params, `параметр ${name} отсутствует в metadata.i18n`).toHaveProperty([name]);
      expect(String(i18n.params?.[name]).length).toBeGreaterThan(0);
    }
  });
});

/**
 * `invalid_union` (zod 4: issue несёт `errors: ZodIssue[][]` по вариантам).
 *
 * Голое `todos: Invalid input` не говорит модели, что не так, и она повторяет
 * тот же аргумент (10 раз подряд на test). Поэтому варианты печатаются
 * по отдельности, с путём **относительно ветви** (`value` — корень).
 */
describe('formatIssues — invalid_union', () => {
  const item = z.object({ content: z.string() });

  it('реальная zod-ошибка union: варианты вместо `Invalid input`', () => {
    const schema = z.object({ todos: z.union([item, z.array(item)]) });
    const parsed = schema.safeParse({ todos: { item: [{ content: 'a' }] } });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const text = formatIssues(parsed.error.issues);

    expect(text).toContain('todos: does not match any variant — variant 1:');
    expect(text).toContain('variant 2:');
    expect(text).toContain('content:');
    // Корень ветви печатается как `value`, а не как пустая строка/root.
    expect(text).toContain('variant 2: value:');
    // Голое сообщение zod (без разбора вариантов) не остаётся.
    expect(text).not.toMatch(/(^|; )[\w.]*: Invalid input(;|$)/);
  });

  it('content и metadata.i18n несут расширенный текст, формат остальных issues прежний', () => {
    const schema = z.object({ todos: z.union([z.string(), z.array(z.string())]) });
    const parsed = schema.safeParse({ todos: 42 });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const result = argErrorResult('todo_add', parsed.error.issues);
    const i18n = result.metadata?.i18n as I18nMeta;

    expect(result.content).toContain('does not match any variant');
    expect(i18n.params?.issues).toContain('variant 1:');
    expect(String(i18n.params?.issues)).toBe(formatIssues(parsed.error.issues));
  });

  it('длина ветви ограничена (~300 символов), лишние issues не печатаются', () => {
    const longIssues = Array.from({ length: 6 }, (_, i) =>
      issue(['field' + String(i)], 'x'.repeat(200)),
    );
    const unionIssue = {
      code: 'invalid_union',
      path: ['payload'],
      message: 'Invalid input',
      errors: [longIssues, longIssues],
    } as unknown as ZodIssue;

    const text = formatIssues([unionIssue]);

    expect(text).toContain('variant 1:');
    expect(text).toContain('variant 2:');
    expect(text).toContain('…');
    // Обе ветви усечены — общий текст остаётся разумным.
    expect(text.length).toBeLessThan(2 * 300 + 80);
    // Больше 3 issues на ветвь не печатаем.
    expect(text).not.toContain('field5');
  });

  it('union-issue без ветвей и обычные issues не ломаются', () => {
    const emptyUnion = {
      code: 'invalid_union',
      path: ['x'],
      message: 'Invalid input',
      errors: [],
    } as unknown as ZodIssue;

    expect(formatIssues([emptyUnion])).toBe('x: Invalid input');
    expect(formatIssues([issue(['a'], 'one'), issue([], 'two')])).toBe('a: one; root: two');
  });
});
