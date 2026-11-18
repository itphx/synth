/**
 * Порог включения CodeMirror в просмотрщике/редакторе файла.
 *
 * CodeMirror строит DOM-дерево по строкам и держит документ в `Text` — на
 * мегабайтных файлах это дороже, чем честный `<pre>`/`<textarea>`. Поэтому
 * большой файл показываем простым текстом (без номеров строк и подсветки),
 * а не подвешиваем вкладку.
 */

/** Больше символов — без CodeMirror (`1 000 000`). */
export const MAX_CODE_VIEW_CHARS = 1_000_000

/** Больше строк — без CodeMirror (`20 000`). */
export const MAX_CODE_VIEW_LINES = 20_000

/**
 * Годится ли текст для CodeMirror: не больше лимита символов **и** строк.
 * Считаем строки без `split` — на предельном файле это лишний массив строк.
 */
export function isCodeViewSupported(text: string): boolean {
  if (text.length > MAX_CODE_VIEW_CHARS) return false
  let lines = 1
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 10) continue
    lines += 1
    if (lines > MAX_CODE_VIEW_LINES) return false
  }
  return lines <= MAX_CODE_VIEW_LINES
}
