/**
 * Лёгкий glob-матчер для permission-паттернов (ADR-029).
 * Поддерживаемый синтаксис:
 *   *  — любой набор символов, НЕ пересекает '/'
 *   ** — любой набор сегментов пути (включая ноль)
 *   ?  — ровно один символ (не '/')
 *   [abc] / [!abc] — класс символов
 *   {a,b} — альтернативы
 * Паттерн применяется к пути как есть (абсолютному или относительному);
 * '\\' приводится к '/', завершающий '/' игнорируется.
 */

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Преобразует один сегмент glob в RegExp (без поддержки '**' внутри сегмента). */
function segmentToRegex(segment: string): RegExp {
  let out = '';
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i]!;
    if (ch === '*') {
      out += '[^/]*';
      i++;
    } else if (ch === '?') {
      out += '[^/]';
      i++;
    } else if (ch === '[') {
      const end = segment.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
        i++;
      } else {
        let cls = segment.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        out += '[' + cls + ']';
        i = end + 1;
      }
    } else if (ch === '{') {
      const end = segment.indexOf('}', i + 1);
      if (end === -1) {
        out += '\\{';
        i++;
      } else {
        const alts = segment
          .slice(i + 1, end)
          .split(',')
          .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|');
        out += '(' + alts + ')';
        i = end + 1;
      }
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp('^' + out + '$');
}

function matchSegment(pattern: string, value: string): boolean {
  if (pattern === '**') return true;
  // '**' в середине сегмента обрабатываем жадно
  if (pattern.includes('**')) {
    const parts = pattern.split('**');
    let regex = '';
    parts.forEach((part, idx) => {
      regex += idx > 0 ? '.*' : '';
      if (part) regex += segmentToRegex(part).source.slice(1, -1);
    });
    return new RegExp('^' + regex + '$').test(value);
  }
  return segmentToRegex(pattern).test(value);
}

function matchSegments(patterns: string[], values: string[]): boolean {
  if (patterns.length === 0) return values.length === 0;
  const head = patterns[0]!;
  const rest = patterns.slice(1);
  if (head === '**') {
    if (rest.length === 0) return true;
    for (let i = 0; i <= values.length; i++) {
      if (matchSegments(rest, values.slice(i))) return true;
    }
    return false;
  }
  if (values.length === 0) return false;
  if (!matchSegment(head, values[0]!)) return false;
  return matchSegments(rest, values.slice(1));
}

/**
 * Проверяет, соответствует ли путь glob-паттерну.
 * Паттерн и путь нормализуются (backslash → '/', без завершающего '/').
 */
export function globMatch(pattern: string, value: string): boolean {
  const p = normalize(pattern);
  const v = normalize(value);
  if (p === '') return v === '';
  return matchSegments(p.split('/'), v.split('/'));
}
