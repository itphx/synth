/**
 * М1: детерминированный keyword-скоринг памяти.
 *
 * Векторный поиск — М2 (эмбеддинги через `facade.embed`, ADR-107). Пока
 * работает keyword-arm: **доля токенов запроса, найденных в тексте факта**.
 *
 * Детерминированность — обязательное свойство (ADR-070, граница
 * prompt-cache): один и тот же вход даёт один и тот же порядок выдачи, иначе
 * блок памяти дрожит между ходами и инвалидирует кэш префикса.
 */

/**
 * Токены текста: последовательности букв и цифр, нижний регистр.
 *
 * Разделители — всё, что не буква и не цифра (пунктуация, пробелы, `_`).
 * Регулярка с флагом `u` — чтобы `\p{L}`/`\p{N}` работали с кириллицей.
 */
export function tokenize(text: string): string[] {
  return (text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Keyword-скоринг: доля токенов запроса, найденных в тексте факта (0..1).
 *
 * Повторы токена в запросе не повышают score (токены запроса
 * уникализируются) — иначе «деплой деплой деплой» перевешивала бы реальные
 * совпадения. Пустой запрос или пустой текст факта → `0`.
 */
export function keywordScore(query: string, text: string): number {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return 0;
  const textTokens = new Set(tokenize(text));
  if (textTokens.size === 0) return 0;
  let hits = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) hits += 1;
  }
  return hits / queryTokens.length;
}
