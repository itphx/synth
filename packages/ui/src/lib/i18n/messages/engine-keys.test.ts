import { describe, it, expect } from 'vitest';
import { ENGINE_MESSAGE_KEYS, ENGINE_MESSAGE_PARAMS, extractParams } from '@itphx/synth-shared/i18n';
import { dict as ruDict } from './ru';
import { dict as enDict } from './en';

/**
 * Автопроверка синхронизации движковых ключей (i18n ядра) с ru-словарём UI.
 *
 * Контракт в @itphx/synth-shared: ENGINE_MESSAGE_KEYS + ENGINE_MESSAGE_PARAMS.
 * ru-словарь обязан содержать перевод каждого движкового ключа с тем же набором
 * {param}-плейсхолдеров, что и en-шаблон в core.
 *
 * en-локаль движковые ключи НЕ дублирует (en деградирует на content): если ключ
 * в en.ts есть, набор параметров должен совпадать; отсутствие — допустимо и не
 * проверяется.
 */
describe('engine message keys ↔ ru dictionary', () => {
  it('каждый движковый ключ присутствует в ru-словаре с совпадающим набором {param}', () => {
    for (const key of ENGINE_MESSAGE_KEYS) {
      const translated = Object.prototype.hasOwnProperty.call(ruDict, key);
      expect(translated, `ключ ${key} отсутствует в ru-словаре`).toBe(true);

      const actual = extractParams(ruDict[key]).slice().sort();
      const expected = [...ENGINE_MESSAGE_PARAMS[key]].sort();
      expect(
        actual,
        `набор параметров ключа ${key} в ru-переводе не совпадает с контрактом`,
      ).toEqual(expected);
    }
  });

  it('en-словарь: если движковый ключ присутствует, набор {param} совпадает с контрактом', () => {
    // en намеренно не дублирует движковые ключи (деградация на content), поэтому
    // доступ произвольный — приводим к Record<string, string> (как I18nDictionary).
    const en: Record<string, string> = enDict;
    for (const key of ENGINE_MESSAGE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(en, key)) {
        // en не дублирует движковые ключи (деградация на content) — пропускаем отсутствие
        continue;
      }
      const actual = extractParams(en[key]).slice().sort();
      const expected = [...ENGINE_MESSAGE_PARAMS[key]].sort();
      expect(
        actual,
        `набор параметров ключа ${key} в en-словаре не совпадает с контрактом`,
      ).toEqual(expected);
    }
  });
});
