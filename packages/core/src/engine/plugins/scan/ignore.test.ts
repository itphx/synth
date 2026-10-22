/**
 * PROP-068 §4.3: тесты `.skillignore` — исключения при обходе бандла.
 *
 * Формат — в стиле `.gitignore`: комментарии, отрицание, якорь от корня,
 * glob (`*`/`?`/`**`) и «последнее совпадение выигрывает».
 */
import { describe, expect, it } from 'vitest';

import { isIgnored, parseIgnorePatterns } from './ignore.js';

describe('.skillignore: комментарии и пустые строки', () => {
  it('`#` — комментарий, правил не создаёт', () => {
    expect(parseIgnorePatterns('# это комментарий\n')).toEqual([]);
  });

  it('пустые строки игнорируются', () => {
    expect(parseIgnorePatterns('\n\n   \n')).toEqual([]);
  });

  it('комментарий не отключает правило', () => {
    const patterns = parseIgnorePatterns('# комментарий\n*.log\n');
    expect(patterns).toHaveLength(1);
    expect(isIgnored(patterns, 'a.log', false)).toBe(true);
  });
});

describe('.skillignore: отрицание `!`', () => {
  it('отрицание возвращает файл в обход', () => {
    const patterns = parseIgnorePatterns('*.log\n!keep.log\n');
    expect(isIgnored(patterns, 'a.log', false)).toBe(true);
    expect(isIgnored(patterns, 'keep.log', false)).toBe(false);
  });
});

describe('.skillignore: якорь от корня', () => {
  it('ведущий `/` — только корень бандла', () => {
    const patterns = parseIgnorePatterns('/build\n');
    expect(isIgnored(patterns, 'build', false)).toBe(true);
    expect(isIgnored(patterns, 'a/build', false)).toBe(false);
  });

  it('слэш внутри правила — тоже якорь от корня', () => {
    const patterns = parseIgnorePatterns('dist/*.map\n');
    expect(isIgnored(patterns, 'dist/a.map', false)).toBe(true);
    expect(isIgnored(patterns, 'a/dist/a.map', false)).toBe(false);
  });

  it('правило без слэша совпадает на любой глубине', () => {
    const patterns = parseIgnorePatterns('node_modules\n');
    expect(isIgnored(patterns, 'node_modules', false)).toBe(true);
    expect(isIgnored(patterns, 'a/node_modules', false)).toBe(true);
    expect(isIgnored(patterns, 'a/b/node_modules', false)).toBe(true);
  });
});

describe('.skillignore: glob', () => {
  it('`*` — любые символы кроме `/`', () => {
    const patterns = parseIgnorePatterns('*.log\n');
    expect(isIgnored(patterns, 'a.log', false)).toBe(true);
    expect(isIgnored(patterns, 'dir/a.log', false)).toBe(true);
    expect(isIgnored(patterns, 'a.log.txt', false)).toBe(false);
    // `*` не пересекает `/`: сегмент пути матчится целиком.
    expect(isIgnored(patterns, 'a/b.log', false)).toBe(true);
  });

  it('`*` не пересекает разделитель пути', () => {
    const patterns = parseIgnorePatterns('x*y\n');
    expect(isIgnored(patterns, 'xzy', false)).toBe(true);
    expect(isIgnored(patterns, 'x/y', false)).toBe(false);
  });

  it('`?` — ровно один символ кроме `/`', () => {
    const patterns = parseIgnorePatterns('file?.txt\n');
    expect(isIgnored(patterns, 'file1.txt', false)).toBe(true);
    expect(isIgnored(patterns, 'file12.txt', false)).toBe(false);
    expect(isIgnored(patterns, 'file.txt', false)).toBe(false);
  });

  it('`**` — любые символы вместе с `/`', () => {
    const patterns = parseIgnorePatterns('**/*.test.js\n');
    expect(isIgnored(patterns, 'a.test.js', false)).toBe(true);
    expect(isIgnored(patterns, 'src/a.test.js', false)).toBe(true);
    expect(isIgnored(patterns, 'src/deep/a.test.js', false)).toBe(true);
    expect(isIgnored(patterns, 'src/a.spec.js', false)).toBe(false);
  });
});

describe('.skillignore: правило только для каталогов', () => {
  it('хвостовой `/` — правило не применяется к файлам', () => {
    const patterns = parseIgnorePatterns('build/\n');
    expect(isIgnored(patterns, 'build', true)).toBe(true);
    expect(isIgnored(patterns, 'build', false)).toBe(false);
  });
});

describe('.skillignore: последнее совпадение выигрывает', () => {
  it('отрицание после правила снимает исключение', () => {
    const patterns = parseIgnorePatterns('*.log\n!important.log\n');
    expect(isIgnored(patterns, 'important.log', false)).toBe(false);
    expect(isIgnored(patterns, 'other.log', false)).toBe(true);
  });

  it('правило после отрицания снова исключает файл', () => {
    const patterns = parseIgnorePatterns('!important.log\n*.log\n');
    expect(isIgnored(patterns, 'important.log', false)).toBe(true);
  });
});
