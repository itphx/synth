/**
 * Юнит-тесты Output Guard (ADR-036): детекция секретов в ответе модели.
 */

import { describe, it, expect } from 'vitest';

import { runOutputGuard } from './output-guard.js';

const SK_KEY = 'sk-abcdefghijklmnopqrst';

describe('runOutputGuard', () => {
  it('ответ содержит sk-ключ → found непустой, suspicious true', () => {
    const result = runOutputGuard(`вот мой ключ ${SK_KEY}`);
    expect(result.found).toContain(SK_KEY);
    expect(result.suspicious).toBe(true);
  });

  it('чистый ответ → found пустой, suspicious false', () => {
    const result = runOutputGuard('обычный ответ без секретов');
    expect(result.found).toEqual([]);
    expect(result.suspicious).toBe(false);
  });

  it('http-ссылка → suspicious true, но это не секрет (found пустой)', () => {
    // Реализация: подозрительность = найденные секреты ИЛИ http-ссылки.
    // Ссылка сама по себе не считается секретом (в found не попадает).
    const result = runOutputGuard('смотри https://example.com/path?q=1');
    expect(result.found).toEqual([]);
    expect(result.suspicious).toBe(true);
  });

  it('пустая строка → ничего не найдено', () => {
    const result = runOutputGuard('');
    expect(result.found).toEqual([]);
    expect(result.suspicious).toBe(false);
  });
});
