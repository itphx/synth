/**
 * Стиль переводов строк в текстовом файле.
 *
 * `read_file` отдаёт содержимое с нормализованными переводами строк (LF:
 * `crlfDelay: Infinity`), а правка ищет текст байт-в-байт. Без учёта стиля
 * правка CRLF-файла не находит текст (модель скопировала `\n` из вывода
 * `read_file`), а вставка LF-текста в CRLF-файл ломает стиль файла.
 */
export type LineEndingStyle = 'lf' | 'crlf' | 'mixed';

/**
 * Стиль переводов строк:
 * - `lf` — только `\n`;
 * - `crlf` — все `\n` идут за `\r` ( `\r\n` );
 * - `mixed` — в файле есть и `CRLF`, и `LF` (правка такому файлу запрещена).
 */
export function detectLineEndings(content: string): LineEndingStyle {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '\n') continue;
    if (i > 0 && content[i - 1] === '\r') crlf++;
    else lf++;
  }
  if (crlf === 0) return 'lf';
  if (lf === 0) return 'crlf';
  return 'mixed';
}

/** `CRLF` → `LF`: вид, в котором ищем и заменяем текст. */
export function toLfView(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

/**
 * `LF` → `CRLF`: обратный перевод результата правки в CRLF-файл.
 *
 * Ожидает на входе LF-вид (`toLfView`): каждый `\n` становится `\r\n`, поэтому
 * CRLF-файл не теряет ни одного перевода строки.
 */
export function fromLfView(content: string): string {
  return content.replace(/\n/g, '\r\n');
}
