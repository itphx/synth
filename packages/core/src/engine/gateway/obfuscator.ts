/**
 * Обфускация секретов и работа с картой плейсхолдеров (AD-036).
 * Плейсхолдер: ⟦SYNTH_SECRET_N⟧ (юникод-скобки U+27E6/27E7, префикс SYNTH_).
 */

import { detectSecrets } from './secret-detector.js';

/** Одиночный паттерн плейсхолдера (для поиска номера). */
export const PLACEHOLDER_PATTERN = /⟦SYNTH_SECRET_(\d+)⟧/;
/** Глобальный паттерн плейсхолдера (для replace). */
export const PLACEHOLDER_REGEX = /⟦SYNTH_SECRET_(\d+)⟧/g;

/** Следующий свободный номер плейсхолдера: max существующих + 1. */
function _nextPlaceholderIndex(map: Record<string, string>): number {
  let max = 0;
  for (const key of Object.keys(map)) {
    const match = key.match(PLACEHOLDER_PATTERN);
    if (match) {
      const num = parseInt(match[1] ?? '0', 10);
      if (num > max) max = num;
    }
  }
  return max + 1;
}

export interface ObfuscateResult {
  text: string;
  map: Record<string, string>;
  found: string[];
}

/**
 * Ищет секреты в тексте и заменяет их на плейсхолдеры.
 * Уже известные секреты (есть в карте) получают существующий плейсхолдер,
 * новые — ⟦SYNTH_SECRET_{next}⟧ и добавляются в карту.
 * Возвращает обновлённый текст, карту и список реально заменённых секретов.
 */
export function obfuscateSecrets(
  text: string,
  map: Record<string, string>,
): ObfuscateResult {
  if (!text) return { text, map: { ...map }, found: [] };

  const secrets = detectSecrets(text).sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return { text, map: { ...map }, found: [] };

  const newMap = { ...map };
  let next = _nextPlaceholderIndex(newMap);
  let result = text;
  const found: string[] = [];

  for (const secret of secrets) {
    // Секрет уже заменён как часть более длинного секрета (например, Bearer+token).
    if (!result.includes(secret)) continue;

    let placeholder = Object.keys(newMap).find((key) => newMap[key] === secret);
    if (!placeholder) {
      placeholder = `⟦SYNTH_SECRET_${next}⟧`;
      next++;
      newMap[placeholder] = secret;
    }

    found.push(secret);
    result = result.split(secret).join(placeholder);
  }

  return { text: result, map: newMap, found };
}

/**
 * Заменяет известные плейсхолдеры обратно на секреты.
 * Неизвестные плейсхолдеры (нет в карте) остаются как есть.
 */
export function deobfuscateSecrets(text: string, map: Record<string, string>): string {
  if (!text || Object.keys(map).length === 0) return text;

  return text.replace(PLACEHOLDER_REGEX, (match) => {
    return map[match] ?? match;
  });
}

/**
 * Рекурсивно деобфусцирует строки внутри объектов/массивов
 * (для аргументов инструментов и точек потребления).
 */
export function restoreSecrets(input: unknown, map: Record<string, string>): unknown {
  if (typeof input === 'string') return deobfuscateSecrets(input, map);
  if (Array.isArray(input)) return input.map((item) => restoreSecrets(item, map));
  if (input !== null && typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      result[key] = restoreSecrets(value, map);
    }
    return result;
  }
  return input;
}
