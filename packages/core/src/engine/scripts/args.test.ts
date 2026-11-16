import { describe, it, expect } from 'vitest';
import { ScriptError } from './types.js';
import { splitScriptArguments } from './args.js';

/**
 * ADR-126 §5: разбор аргументов скрипта.
 *
 * Разбор лексический, без shell: подстановок переменных и glob нет.
 */

describe('splitScriptArguments — разделение', () => {
  it('пустая строка — пустой список', () => {
    expect(splitScriptArguments('')).toEqual([]);
  });

  it('пробелы и табы разделяют аргументы', () => {
    expect(splitScriptArguments('one two\tthree')).toEqual(['one', 'two', 'three']);
  });

  it('лишние разделители не создают пустых аргументов', () => {
    expect(splitScriptArguments('  one   two  ')).toEqual(['one', 'two']);
  });

  it('пустые кавычки дают пустой аргумент', () => {
    expect(splitScriptArguments('""')).toEqual(['']);
    expect(splitScriptArguments('a "" b')).toEqual(['a', '', 'b']);
  });
});

describe('splitScriptArguments — кавычки', () => {
  it('двойные кавычки сохраняют пробелы', () => {
    expect(splitScriptArguments('"one two" three')).toEqual(['one two', 'three']);
  });

  it('одинарные кавычки сохраняют пробелы', () => {
    expect(splitScriptArguments("'one two' three")).toEqual(['one two', 'three']);
  });

  it('экранирование кавычки внутри кавычек', () => {
    expect(splitScriptArguments('"say \\"hi\\""')).toEqual(['say "hi"']);
    expect(splitScriptArguments("'it\\'s'")).toEqual(["it's"]);
  });

  it('экранирование обратного слэша', () => {
    expect(splitScriptArguments('a\\\\b')).toEqual(['a\\b']);
    expect(splitScriptArguments('"a\\\\b"')).toEqual(['a\\b']);
  });

  it('экранирование вне кавычек', () => {
    expect(splitScriptArguments('one\\ two')).toEqual(['one two']);
  });
});

describe('splitScriptArguments — ошибки', () => {
  it('незакрытая двойная кавычка — script_args_invalid', () => {
    expect(() => splitScriptArguments('"one two')).toThrowError(ScriptError);
    try {
      splitScriptArguments('"one two');
    } catch (err) {
      expect((err as ScriptError).code).toBe('script_args_invalid');
    }
  });

  it('незакрытая одинарная кавычка — script_args_invalid', () => {
    try {
      splitScriptArguments("'one two");
      throw new Error('ожидалась ошибка');
    } catch (err) {
      expect((err as ScriptError).code).toBe('script_args_invalid');
    }
  });

  it('висячий escape в конце строки — script_args_invalid', () => {
    try {
      splitScriptArguments('one\\');
      throw new Error('ожидалась ошибка');
    } catch (err) {
      expect((err as ScriptError).code).toBe('script_args_invalid');
    }
  });
});
