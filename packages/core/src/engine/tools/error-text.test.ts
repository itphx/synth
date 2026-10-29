/**
 * Тесты извлечения текста ошибки (tools/error-text.ts): git-слой бросает
 * plain-объекты `{ error, code }`, их текст не должен теряться в `[object Object]`.
 */
import { describe, it, expect } from 'vitest';
import { errorText } from './error-text.js';

describe('errorText', () => {
  it('Error → message', () => {
    expect(errorText(new Error('сеть недоступна'))).toBe('сеть недоступна');
  });

  it('plain-объект { error, code } → поле error, не [object Object]', () => {
    const err = { error: 'Директория не является git-репозиторием', code: 'NOT_FOUND' };
    expect(errorText(err)).toBe('Директория не является git-репозиторием');
    expect(String(err)).toBe('[object Object]');
  });

  it('прочие значения → String(err)', () => {
    expect(errorText('просто строка')).toBe('просто строка');
    expect(errorText(42)).toBe('42');
    expect(errorText(undefined)).toBe('undefined');
    expect(errorText(null)).toBe('null');
  });

  it('plain-объект без строкового error → String(err)', () => {
    expect(errorText({ code: 'git.repo_exists' })).toBe('[object Object]');
    expect(errorText({ error: 42 })).toBe('[object Object]');
    expect(errorText({ error: '' })).toBe('[object Object]');
  });
});
