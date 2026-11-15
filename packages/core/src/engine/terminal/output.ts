/**
 * Обрамление и нормализация вывода терминала для модели (PROP-132, Ф5).
 *
 * ## Зачем
 *
 * Весь вывод терминала, который возвращается модели, обязан быть:
 *
 * - **в обрамлении** — `[CONTENT]` … `[CONTENT END]`. Обрамление — константы,
 *   не i18n: это маркер протокола, а не переводимый текст (ADR-041 — про
 *   строки движка; маркер протокола переводить нельзя);
 * - **с метаданными в открывающем маркере** — `[CONTENT key=value …]`.
 *   Метаданные (id терминала, статус, диапазон последовательностей, код
 *   возврата) читаются прямо из маркера: закрывающий маркер **не меняется**
 *   (`[CONTENT END]`), поэтому разбор вывода остаётся прежним;
 * - **без хвостовых пустых строк** — «вывод в конце пуст» читается как
 *   «вывод не пришёл»;
 * - **с нормализованными переводами строк** — `\r\n` → `\n`. PTY отдаёт
 *   `\r\n` (режим терминала ONLCR), а модель не должна различать «CRLF» и
 *   «LF».
 *
 * ## Границы
 *
 * - **Нормализация — только для возвращаемого текста.** Кольцевой буфер
 *   хранит поток как есть: буфер — источник истины для UI (xterm.js сам
 *   разбирает `\r\n`), и переписывать его значило бы ломать отображение.
 * - **Одиночный `\r` не трогаем** — это «возврат каретки» прогрес-вывода
 *   (`\r` перезаписывает строку), а не перевод строки.
 */

/** Маркер начала обрамления вывода терминала. */
export const TERMINAL_CONTENT_OPEN = '[CONTENT]';

/**
 * Префикс открывающего маркера — основа формы с атрибутами
 * (`[CONTENT key=value …]`).
 */
const TERMINAL_CONTENT_OPEN_PREFIX = '[CONTENT';

/** Маркер конца обрамления вывода терминала. */
export const TERMINAL_CONTENT_CLOSE = '[CONTENT END]';

/**
 * Максимальная длина значения атрибута открывающего маркера.
 *
 * Значение длиннее — обрезается: маркер читает модель, а не парсер, и
 * «хвост» из сотен символов ничего не добавляет.
 */
export const MAX_TERMINAL_ATTRIBUTE_VALUE_LENGTH = 120;

/**
 * Значение атрибута открывающего маркера `[CONTENT …]`.
 *
 * `undefined` — атрибут не выводится вовсе (нет значения — нет и атрибута).
 */
export type TerminalContentAttributeValue = string | number | boolean | undefined;

/**
 * Санитизировать значение атрибута маркера.
 *
 * В значении не должно быть:
 *
 * - **переводов строк** — маркер однострочный, иначе он «разорвал» бы
 *   обрамление;
 * - **пробелов** — атрибуты разделены пробелом, пробел внутри значения сделал
 *   бы разбор неоднозначным;
 * - **`]`** — закрывающая скобка маркера: значение не должно закрывать его
 *   досрочно.
 *
 * Плюс кап длины (`MAX_TERMINAL_ATTRIBUTE_VALUE_LENGTH`).
 */
function sanitizeAttributeValue(value: string): string {
  return value
    .replace(/\s+/g, '')
    .replace(/\]/g, '')
    .slice(0, MAX_TERMINAL_ATTRIBUTE_VALUE_LENGTH);
}

/**
 * Собрать строку атрибутов открывающего маркера: `key=value key2=value2`.
 *
 * - атрибут без значения (`undefined`) **не выводится**;
 * - значение санитизируется (см. `sanitizeAttributeValue`);
 * - пустое значение после санитизации — атрибут не выводится;
 * - порядок атрибутов — порядок ключей объекта (детерминированный).
 *
 * Пустой результат — «без атрибутов»: маркер остаётся прежним `[CONTENT]`.
 */
export function formatTerminalContentAttributes(
  attributes?: Record<string, TerminalContentAttributeValue>,
): string {
  if (!attributes) return '';
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(attributes)) {
    if (raw === undefined) continue;
    const safeKey = key.replace(/[^A-Za-z0-9_.-]/g, '_');
    if (safeKey === '') continue;
    const value = sanitizeAttributeValue(typeof raw === 'string' ? raw : String(raw));
    if (value === '') continue;
    parts.push(`${safeKey}=${value}`);
  }
  return parts.join(' ');
}

/**
 * Нормализовать переводы строк вывода терминала (`\r\n` → `\n`).
 *
 * Только для возвращаемого текста: буфер хранит поток как есть (UI/xterm.js
 * разбирает `\r\n` сам). Одиночный `\r` не трогаем — это «возврат каретки»
 * прогрес-вывода, а не перевод строки.
 */
export function normalizeTerminalLineEndings(text: string): string {
  if (text === '') return '';
  return text.replace(/\r\n/g, '\n');
}

/**
 * Нормализовать текст вывода терминала для модели.
 *
 * - `\r\n` → `\n` (только для возвращаемого текста — буфер не трогаем);
 * - хвостовые пустые строки отбрасываются (строка из одних пробелов/табуляций
 *   тоже считается пустой).
 *
 * Хвостовой перевод строки убирается вместе с пустой строкой за ним:
 * `'a\nb\n'` → `'a\nb'` (та же трактовка, что у `tail` в `terminal_read`).
 */
export function normalizeTerminalOutput(text: string): string {
  if (text === '') return '';
  const normalized = normalizeTerminalLineEndings(text);
  return normalized.replace(/(?:\n[ \t]*)+$/, '');
}

/**
 * Обрамить вывод терминала для модели.
 *
 * Пустой вывод → `[CONTENT]\n[CONTENT END]` (без пустой строки между
 * маркерами): иначе модель читает «пустую строку вывода» как результат.
 *
 * С атрибутами — открывающий маркер становится `[CONTENT key=value …]`
 * (метаданные — в маркере, закрывающий маркер не меняется). Без атрибутов
 * (или с пустым набором) — прежний вид `[CONTENT]`.
 */
export function frameTerminalOutput(
  text: string,
  attributes?: Record<string, TerminalContentAttributeValue>,
): string {
  const body = normalizeTerminalOutput(text);
  const attrs = formatTerminalContentAttributes(attributes);
  const open =
    attrs === '' ? TERMINAL_CONTENT_OPEN : `${TERMINAL_CONTENT_OPEN_PREFIX} ${attrs}]`;
  if (body === '') return `${open}\n${TERMINAL_CONTENT_CLOSE}`;
  return `${open}\n${body}\n${TERMINAL_CONTENT_CLOSE}`;
}
