/**
 * Юнит-тесты детектора секретов (ADR-036).
 * Чистая функция: text → уникальные значения секретов.
 */

import { describe, it, expect } from 'vitest';

import { detectSecrets, maskSecret } from './secret-detector.js';

// Валидные секреты по regex детектора (см. secret-detector.ts)
const SK_KEY = 'sk-abcdefghijklmnopqrst'; // 20 символов после sk-
const GHP_TOKEN = 'ghp_' + 'A'.repeat(36); // ровно 36 символов
const AWS_KEY = 'AKIA' + 'B'.repeat(16); // 16 [0-9A-Z]
const GOOGLE_KEY = 'AIza' + 'C'.repeat(35); // 35 [0-9A-Za-z_-]
const EMAIL = 'user@example.com';
const CARD_VALID = '4111111111111111'; // VISA, Luhn-валидна
const CARD_INVALID = '4111111111111112'; // Luhn невалидна
const BEARER_TOKEN = 'Bearer ' + 'x'.repeat(24);

describe('detectSecrets', () => {
  it('находит OpenAI sk-ключ', () => {
    expect(detectSecrets(`мой ключ ${SK_KEY} используй для подключения`)).toContain(SK_KEY);
  });

  it('находит GitHub ghp_ токен', () => {
    expect(detectSecrets(`токен ${GHP_TOKEN}`)).toContain(GHP_TOKEN);
  });

  it('находит AWS AKIA ключ', () => {
    expect(detectSecrets(`aws=${AWS_KEY}`)).toContain(AWS_KEY);
  });

  it('находит Google AIza ключ', () => {
    expect(detectSecrets(`gkey ${GOOGLE_KEY}`)).toContain(GOOGLE_KEY);
  });

  it('находит email', () => {
    expect(detectSecrets(`пишите на ${EMAIL}`)).toContain(EMAIL);
  });

  it('находит валидную по Luhn карту', () => {
    expect(detectSecrets(`номер ${CARD_VALID}`)).toContain(CARD_VALID);
  });

  it('НЕ находит невалидную по Luhn карту', () => {
    expect(detectSecrets(`номер ${CARD_INVALID}`)).toEqual([]);
  });

  it('находит Bearer-токен', () => {
    expect(detectSecrets(BEARER_TOKEN)).toContain(BEARER_TOKEN);
  });

  it('короткие строки (<12) не дают false positive', () => {
    expect(detectSecrets('sk-abc')).toEqual([]);
    expect(detectSecrets('ghp_123')).toEqual([]);
    expect(detectSecrets('AIza9')).toEqual([]);
    expect(detectSecrets('Bearer xyz')).toEqual([]);
    expect(detectSecrets('123456789012')).toEqual([]); // 12 цифр < 13 (card regex)
  });

  it('чистый текст без секретов → пустой массив', () => {
    expect(detectSecrets('обычный текст без секретов, привет мир')).toEqual([]);
    expect(detectSecrets('')).toEqual([]);
    expect(detectSecrets('')).toEqual([]);
  });

  it('возвращает уникальные значения (без дубликатов)', () => {
    const result = detectSecrets(`${SK_KEY} ... ${SK_KEY} ... ${SK_KEY}`);
    expect(result).toEqual([SK_KEY]);
  });

  it('находит несколько секретов разных типов в одном тексте', () => {
    const result = detectSecrets(`ключ ${SK_KEY}, почта ${EMAIL}, карта ${CARD_VALID}`);
    expect(result).toContain(SK_KEY);
    expect(result).toContain(EMAIL);
    expect(result).toContain(CARD_VALID);
  });

  it('принимает кастомные паттерны вторым аргументом (RegExp)', () => {
    const custom = [{ type: 'custom', regex: /\bcustom-[A-Za-z0-9]{20,}/g }];
    expect(detectSecrets('секрет custom-abcdefghijklmnopqrstuvwxyz', custom)).toContain(
      'custom-abcdefghijklmnopqrstuvwxyz',
    );
    expect(detectSecrets(SK_KEY, custom)).toEqual([]);
  });

  it('принимает паттерны как строки и компилирует их с флагом g', () => {
    const custom = [{ type: 'custom', regex: 'custom-[A-Za-z0-9]{20,}' }];
    const result = detectSecrets('a custom-abcdefghijklmnopqrst b custom-abcdefghijklmnopqrst', custom);
    expect(result).toEqual(['custom-abcdefghijklmnopqrst']);
  });

  it('пустой список паттернов → ничего не детектится', () => {
    expect(detectSecrets(`ключ ${SK_KEY}`, [])).toEqual([]);
  });

  it('НЕ детектит длинный путь ФС как base64-секрет (регрессия: WS1)', () => {
    expect(detectSecrets('/mnt/data/Agent/dev/Synth/data/workspaces/WS1')).toEqual([]);
    expect(detectSecrets('дефолт /mnt/data/Agent/dev/Synth/data/workspaces/WS1 для работы')).toEqual([]);
  });
});

describe('maskSecret', () => {
  it('маскирует sk-ключ', () => {
    expect(maskSecret(SK_KEY)).toBe('sk-***');
  });

  it('маскирует ghp_ токен', () => {
    expect(maskSecret(GHP_TOKEN)).toBe('ghp_***');
  });

  it('маскирует AWS ключ', () => {
    expect(maskSecret(AWS_KEY)).toBe('AKIA***');
  });

  it('маскирует email и карту', () => {
    expect(maskSecret(EMAIL)).toBe('email***');
    expect(maskSecret(CARD_VALID)).toBe('card***');
  });

  it('маскирует Bearer-токен', () => {
    expect(maskSecret(BEARER_TOKEN)).toBe('Bearer ***');
  });

  it('не содержит полного значения секрета', () => {
    const masked = maskSecret(SK_KEY);
    expect(masked).not.toContain(SK_KEY);
  });

  it('пустая строка → пустая строка', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret('   ')).toBe('');
  });
});
