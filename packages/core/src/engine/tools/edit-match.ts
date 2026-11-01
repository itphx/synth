/**
 * «Умное» сопоставление `old_string` в `edit_file` (образец opencode).
 *
 * Модель копирует текст из `read_file`, но типографские кавычки, тире и
 * неразрывные пробелы приходят в сообщении уже «нормализованными» — или
 * наоборот, файл сохранён с типографскими кавычками, а модель прислала
 * прямые. Раньше такая правка падала с `fs.replace_not_found`, хотя нужный
 * текст в файле есть.
 *
 * Стратегии применяются по порядку; побеждает первая, давшая хотя бы одно
 * совпадение:
 *
 * 1. `exact` — побайтовое совпадение (прежнее поведение);
 * 2. `normalized` — совпадение после нормализации юникод-символов
 *    (типографские кавычки, тире, неразрывные пробелы);
 * 3. `loose` — построчное сравнение с игнором trailing whitespace в каждой
 *    строке (ведущие отступы по-прежнему значимы, переводы строк файла
 *    сохраняются).
 *
 * Замена всегда применяется к ОРИГИНАЛЬНОМУ фрагменту (по найденным
 * границам), поэтому типографские кавычки в остальных местах файла не
 * портятся — нормализованный текст используется только для сравнения.
 *
 * Правка применяется только при ОДНОЗНАЧНОМ совпадении: несколько
 * совпадений → `fs.replace_multiple` (как и раньше).
 */

/**
 * Стратегия сопоставления — попадает в `metadata.matchStrategy` тула
 * (аддитивное поле, для диагностики).
 */
export type EditMatchStrategy = 'exact' | 'normalized' | 'loose';

/** Границы найденного фрагмента в исходном тексте: `[start, end)`. */
export interface EditMatch {
  readonly start: number;
  readonly end: number;
}

/** Результат сопоставления: стратегия + найденные вхождения. */
export interface EditMatchResult {
  readonly strategy: EditMatchStrategy;
  readonly matches: EditMatch[];
}

/**
 * Нормализация юникод-символов для сравнения.
 *
 * Важно: нормализация **сохраняет длину** (каждый символ заменяется ровно
 * на один символ) — поэтому смещения в нормализованном тексте совпадают со
 * смещениями в исходном, и найденные границы можно применять к оригиналу.
 *
 * Заменяются: одинарные типографские кавычки → `'`, двойные и «ёлочки» →
 * `"`, типографские тире/минусы → `-`, неразрывные и прочие «невидимые»
 * пробелы (NBSP, narrow/medium spaces, ideographic space) → обычный пробел.
 */
export function normalizeForMatch(value: string): string {
  return value
    .replace(/[‘’‚‛]/g, "'")
    // Двойные кавычки: типографские + «ёлочки» (русская/французская типографика).
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    // Неразрывные и прочие «невидимые» пробелы (NBSP, narrow/medium spaces,
    // ideographic space) — escape-последовательностями: символы невидимы в
    // редакторе и легко теряются при копировании.
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

/** Все вхождения `search` в `content` (непересекающиеся, слева направо). */
export function findExactMatches(content: string, search: string): EditMatch[] {
  const matches: EditMatch[] = [];
  if (search === '') return matches;
  let offset = content.indexOf(search);
  while (offset !== -1) {
    matches.push({ start: offset, end: offset + search.length });
    offset = content.indexOf(search, offset + search.length);
  }
  return matches;
}

/**
 * Вхождения по нормализованному тексту.
 *
 * Смещения нормализованного текста совпадают со смещениями исходного
 * (нормализация сохраняет длину), поэтому границы сразу применимы к
 * оригиналу.
 */
export function findNormalizedMatches(content: string, search: string): EditMatch[] {
  return findExactMatches(normalizeForMatch(content), normalizeForMatch(search));
}

/** Строка файла с её границами в исходном тексте. */
interface LineSpan {
  /** Начало строки (включая перевод строки на конце, если он есть). */
  readonly start: number;
  /** Конец строки вместе с переводом строки. */
  readonly end: number;
  /** Текст строки без перевода строки. */
  readonly text: string;
  /** Конец текста строки (без перевода строки). */
  readonly contentEnd: number;
  /** Есть ли перевод строки в конце. */
  readonly newline: boolean;
}

/** Разбить текст на строки с границами (переводы строк — `\n`, LF-вид). */
function splitLineSpans(content: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let offset = 0;
  while (offset < content.length) {
    const nl = content.indexOf('\n', offset);
    if (nl === -1) {
      spans.push({ start: offset, end: content.length, text: content.slice(offset), contentEnd: content.length, newline: false });
      break;
    }
    spans.push({ start: offset, end: nl + 1, text: content.slice(offset, nl), contentEnd: nl, newline: true });
    offset = nl + 1;
  }
  return spans;
}

/**
 * Вхождения при построчном сравнении с игнором trailing whitespace.
 *
 * Сравниваются строки целиком (ведущие отступы значимы), отличаться могут
 * только концевые пробелы/табуляции; дополнительно применяется
 * нормализация юникод-символов — так «loose» включает возможности
 * «normalized» (как в opencode).
 */
export function findLooseMatches(content: string, search: string): EditMatch[] {
  // Поиск из одних пробелов/переводов строк не должен «находить» любую
  // пустую строку файла — слишком широкое совпадение.
  if (search.trim() === '') return [];

  const trailingNewline = search.endsWith('\n');
  const expected = search.split('\n');
  if (trailingNewline) expected.pop();
  if (expected.length === 0) return [];

  const lines = splitLineSpans(content);
  const matches: EditMatch[] = [];

  for (let index = 0; index + expected.length <= lines.length; index++) {
    let same = true;
    for (let line = 0; line < expected.length; line++) {
      const actual = lines[index + line]!;
      const wanted = expected[line]!;
      if (normalizeForMatch(actual.text.trimEnd()) !== normalizeForMatch(wanted.trimEnd())) {
        same = false;
        break;
      }
    }
    if (!same) continue;

    const first = lines[index]!;
    const last = lines[index + expected.length - 1]!;
    // Поиск с завершающим переводом строки требует, чтобы и найденный
    // фрагмент его заканчивал.
    if (trailingNewline && !last.newline) continue;

    const match: EditMatch = {
      start: first.start,
      end: trailingNewline ? last.end : last.contentEnd,
    };
    // Пересекающиеся совпадения (паттерн из нескольких строк, встречающийся
    // внахлёст) оставляем только первое — иначе одна правка попала бы в
    // файл дважды.
    if (matches.some((prev) => prev.end > match.start && prev.start < match.end)) continue;
    matches.push(match);
  }

  return matches;
}

/**
 * Сопоставить `search` с `content` по трём стратегиям по порядку.
 *
 * Возвращает первую стратегию, давшую хотя бы одно совпадение, либо
 * `null`, если совпадений нет ни в одной.
 */
export function matchEdit(content: string, search: string): EditMatchResult | null {
  if (search === '') return null;

  const exact = findExactMatches(content, search);
  if (exact.length > 0) return { strategy: 'exact', matches: exact };

  const normalized = findNormalizedMatches(content, search);
  if (normalized.length > 0) return { strategy: 'normalized', matches: normalized };

  const loose = findLooseMatches(content, search);
  if (loose.length > 0) return { strategy: 'loose', matches: loose };

  return null;
}
