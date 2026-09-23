import { describe, it, expect } from 'vitest';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';

describe('parseFrontmatter (AD-046 §3.1)', () => {
  it('разбирает frontmatter и тело', () => {
    const raw = '---\nname: api-review\ndescription: Проверяет API\n---\n\n# Тело\n';
    const parsed = parseFrontmatter(raw);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.issues).toEqual([]);
    expect(parsed.data).toEqual({ name: 'api-review', description: 'Проверяет API' });
    expect(parsed.body).toBe('\n# Тело\n');
  });

  it('файл без frontmatter — тело целиком, без ошибок', () => {
    const parsed = parseFrontmatter('# Just markdown\n');
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe('# Just markdown\n');
    expect(parsed.issues).toEqual([]);
  });

  it('неизвестные ключи не являются ошибкой (совместимость)', () => {
    const raw = '---\nname: x\ndescription: y\nfuture_key: 42\nnested: {a: 1}\n---\nbody';
    const parsed = parseFrontmatter(raw);
    expect(parsed.issues).toEqual([]);
    expect(parsed.data.future_key).toBe(42);
    expect(parsed.data.nested).toEqual({ a: 1 });
  });

  it('невалидный YAML — issue, не throw', () => {
    const raw = '---\nname: [unclosed\n---\nbody';
    const parsed = parseFrontmatter(raw);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.issues.map((i) => i.code)).toContain('invalid-frontmatter');
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe('body');
  });

  it('frontmatter-не-объект — issue invalid-frontmatter-type', () => {
    const raw = '---\n- a\n- b\n---\nbody';
    const parsed = parseFrontmatter(raw);
    expect(parsed.issues.map((i) => i.code)).toEqual(['invalid-frontmatter-type']);
    expect(parsed.body).toBe('body');
  });

  it('пустой frontmatter — пустой объект без ошибок', () => {
    const raw = '---\n---\nbody';
    const parsed = parseFrontmatter(raw);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe('body');
  });

  it('поддерживает BOM и CRLF', () => {
    const raw = '\uFEFF---\r\nname: x\r\ndescription: y\r\n---\r\nbody';
    const parsed = parseFrontmatter(raw);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.data.name).toBe('x');
    expect(parsed.body).toBe('body');
  });
});

describe('stringifyFrontmatter', () => {
  it('сериализует данные и тело, round-trip сохраняет значения', () => {
    const out = stringifyFrontmatter({ name: 'x', description: 'y' }, '# Тело');
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('---\n\n# Тело');
    const parsed = parseFrontmatter(out);
    expect(parsed.data).toEqual({ name: 'x', description: 'y' });
    expect(parsed.body).toBe('\n# Тело');
  });
});
