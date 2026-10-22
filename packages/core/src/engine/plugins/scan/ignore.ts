/**
 * PROP-068 §4.3: `.skillignore` — исключения при обходе структуры бандла.
 *
 * Формат — **в стиле `.gitignore`** (упрощённый):
 *
 * ```text
 * # комментарий (целая строка)
 * node_modules/          # каталог (только каталог)
 * dist/*.map             # glob (якорь — от корня бандла)
 * **\/*.test.js          # любой вложенности
 * !dist/keep.js          # отрицание — вернуть файл в обход
 * ```
 *
 * Правила разбора:
 * - пустые строки и строки, начинающиеся с `#`, — комментарии;
 * - ведущий `!` — **отрицание** (правило возвращает файл в обход);
 * - хвостовой `/` — правило относится только к каталогам;
 * - ведущий `/` — якорь от корня бандла;
 * - наличие `/` внутри правила — якорь от корня бандла (как в gitignore);
 * - правило без `/` — совпадает с любым сегментом пути на любой глубине;
 * - `*` — любые символы кроме `/`, `?` — один символ кроме `/`, `**` — любые
 *   символы вместе с `/`.
 *
 * Порядок правил важен: **последнее совпадение выигрывает** (как в gitignore).
 */

/** Одно правило `.skillignore`. */
export interface IgnorePattern {
  /** Исходная строка правила (для диагностики). */
  source: string;
  /** Отрицание (`!`-префикс): правило возвращает путь в обход. */
  negated: boolean;
  /** Правило относится только к каталогам (хвостовой `/`). */
  dirOnly: boolean;
  /** Якорь от корня бандла. */
  anchored: boolean;
  /** Скомпилированное регулярное выражение. */
  regex: RegExp;
}

const REGEXP_SPECIALS = /[.+^${}()|[\]\\]/g;

/** Экранирование спецсимволов регулярного выражения. */
function escapeRegExp(value: string): string {
  return value.replace(REGEXP_SPECIALS, '\\$&');
}

/**
 * Перевод glob-паттерна в регулярное выражение (без якорей и хвостов).
 *
 * `**` — любые символы вместе с `/`; `*` — любые символы кроме `/`;
 * `?` — один символ кроме `/`.
 */
function globToBody(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 2;
        if (pattern[i] === '/') {
          // `**/` — ноль или больше каталогов.
          out += '(?:[^/]+/)*';
          i += 1;
        } else {
          out += '.*';
        }
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    out += escapeRegExp(ch);
    i += 1;
  }
  return out;
}

/** Собрать регулярное выражение правила с учётом якоря и «только каталог». */
function compilePattern(source: string, negated: boolean, dirOnly: boolean, anchored: boolean): IgnorePattern {
  const body = globToBody(source);
  const tail = dirOnly ? '(?:/.*)?' : '';
  const regex = anchored
    ? new RegExp(`^${body}${tail}$`)
    : new RegExp(`(?:^|/)${body}${tail}$`);
  return { source, negated, dirOnly, anchored, regex };
}

/**
 * Разобрать содержимое `.skillignore` в список правил.
 *
 * Некорректные строки (пустые после разбора) молча пропускаются — файл
 * исключений не должен ломать скан.
 */
export function parseIgnorePatterns(text: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1).trim();
      if (!line) continue;
    }

    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1).trim();
      if (!line) continue;
    }

    let anchored = false;
    if (line.startsWith('/')) {
      anchored = true;
      line = line.slice(1).trim();
    } else if (line.includes('/')) {
      // Слэш внутри правила — якорь от корня (как в gitignore).
      anchored = true;
    }
    if (!line) continue;

    patterns.push(compilePattern(line, negated, dirOnly, anchored));
  }
  return patterns;
}

/**
 * Исключён ли путь правилами `.skillignore`.
 *
 * Правило «только каталог» (`node_modules/`) не применяется к файлам: каталог
 * исключается целиком при обходе, поэтому до файла обход не дойдёт.
 *
 * @param relPath относительный путь (posix-разделители, без ведущего `./`).
 * @param isDir каталог ли путь.
 */
export function isIgnored(patterns: readonly IgnorePattern[], relPath: string, isDir: boolean): boolean {
  let ignored = false;
  for (const pattern of patterns) {
    if (pattern.dirOnly && !isDir) continue;
    if (!pattern.regex.test(relPath)) continue;
    ignored = !pattern.negated;
  }
  return ignored;
}
