import type { Locale } from './runtime';

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/**
 * Категория множественного числа по CLDR-лайт (ru/en).
 *
 * Правила применяются к целой части по модулю (`Math.abs(Math.trunc(count))`),
 * поэтому отрицательные числа плюрализуются как положительные. Не-целые
 * (и NaN/Infinity) → `other`.
 *
 * ru: 1, 21, 101 → one; 2–4, 22–24 → few; 0, 5–20, 11–14, 25… → many.
 * en: 1 → one; всё остальное → other.
 */
export function pluralCategory(locale: Locale, count: number): PluralCategory {
  if (!Number.isFinite(count) || !Number.isInteger(count)) {
    return 'other';
  }

  const n = Math.abs(Math.trunc(count));

  if (locale === 'ru') {
    if (n % 10 === 1 && n % 100 !== 11) {
      return 'one';
    }
    if (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) {
      return 'few';
    }
    return 'many';
  }

  return n === 1 ? 'one' : 'other';
}
