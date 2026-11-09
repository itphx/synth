/**
 * Кап длины одной возвращаемой строки — общий для файловых и поисковых тулов.
 *
 * Единая точка: строка длиннее капа не должна съедать контекстное окно
 * модели. Реальный случай — минифицированный бандл или source map: файл
 * целиком в одну строку на сотни килобайт, и одно совпадение поиска уносило
 * в контекст ~236 КБ (инцидент 2026-11-08).
 *
 * Паритет с opencode (`packages/core/src/ripgrep.ts`: `MAX_LINE_CHARS = 2_000`).
 */

/** Максимальная длина одной возвращаемой строки (дальше — суффикс-маркер). */
export const MAX_LINE_LENGTH = 2_000;

/**
 * Обрезка слишком длинной строки с маркером усечения.
 *
 * @param line — исходная строка.
 * @param marker — маркер усечения (локализованный текст вызывающего тула:
 *   `fsread.line_truncated` для чтения файлов, `search.line_truncated` — для
 *   поиска; ключи — в `shared/i18n`).
 */
export function clampLine(line: string, marker: string): string {
  if (line.length <= MAX_LINE_LENGTH) return line;
  return line.slice(0, MAX_LINE_LENGTH) + marker;
}
