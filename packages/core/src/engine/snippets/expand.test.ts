/**
 * ADR-126 §4: раскрытие сниппетов — один проход, без рекурсии, лимиты
 * (15 раскрытий / 64 КБ), код-блоки не трогаются, недоверенные не раскрываются.
 */

import { describe, it, expect } from 'vitest';
import { mergeSnippetScans } from './registry.js';
import { expandSnippetMentions } from './expand.js';
import { MAX_SNIPPET_BYTES, MAX_SNIPPET_EXPANSIONS } from './types.js';
import type { Snippet, SnippetScope } from './types.js';

function snippet(
  name: string,
  body: string,
  opts: { aliases?: string[]; trusted?: boolean; scope?: SnippetScope } = {},
): Snippet {
  return {
    name,
    description: undefined,
    aliases: opts.aliases ?? [],
    body,
    scope: opts.scope ?? 'instance',
    file: `/tmp/snippets/${name}.md`,
    trusted: opts.trusted ?? true,
  };
}

function indexOf(snippets: Snippet[], trusted = true) {
  return mergeSnippetScans([
    {
      source: { scope: 'instance', dir: '/tmp/snippets', trusted },
      result: { snippets, diagnostics: [] },
    },
  ]);
}

describe('expandSnippetMentions — базовое раскрытие', () => {
  it('раскрывает один токен', () => {
    const index = indexOf([snippet('greet', 'Привет!')]);
    const res = expandSnippetMentions('скажи #greet пожалуйста', { index });
    expect(res.text).toBe('скажи Привет! пожалуйста');
    expect(res.applied).toEqual(['greet']);
    expect(res.diagnostics).toEqual([]);
  });

  it('раскрывает несколько разных токенов', () => {
    const index = indexOf([snippet('a', 'AAA'), snippet('b', 'BBB')]);
    const res = expandSnippetMentions('#a и #b', { index });
    expect(res.text).toBe('AAA и BBB');
    expect(res.applied).toEqual(['a', 'b']);
  });

  it('раскрывает дубликаты (каждое вхождение)', () => {
    const index = indexOf([snippet('a', 'AAA')]);
    const res = expandSnippetMentions('#a #a', { index });
    expect(res.text).toBe('AAA AAA');
    expect(res.applied).toEqual(['a', 'a']);
  });

  it('раскрывает по алиасу', () => {
    const index = indexOf([snippet('greet', 'Привет!', { aliases: ['hi'] })]);
    const res = expandSnippetMentions('#hi', { index });
    expect(res.text).toBe('Привет!');
    expect(res.applied).toEqual(['greet']);
  });

  it('неизвестный токен остаётся текстом', () => {
    const index = indexOf([snippet('a', 'AAA')]);
    const res = expandSnippetMentions('текст #unknown тут', { index });
    expect(res.text).toBe('текст #unknown тут');
    expect(res.applied).toEqual([]);
    expect(res.diagnostics).toEqual([]);
  });

  it('текст без токенов не меняется', () => {
    const index = indexOf([snippet('a', 'AAA')]);
    const res = expandSnippetMentions('обычный текст', { index });
    expect(res.text).toBe('обычный текст');
    expect(res.applied).toEqual([]);
  });
});

describe('expandSnippetMentions — код и экранирование', () => {
  it('не трогает fenced code-блок', () => {
    const index = indexOf([snippet('a', 'AAA')]);
    const text = ['```', '#a', '```', 'и #a'].join('\n');
    const res = expandSnippetMentions(text, { index });
    expect(res.text).toBe(['```', '#a', '```', 'и AAA'].join('\n'));
    expect(res.applied).toEqual(['a']);
  });

  it('не трогает inline code', () => {
    const index = indexOf([snippet('a', 'AAA')]);
    const res = expandSnippetMentions('`#a` и #a', { index });
    expect(res.text).toBe('`#a` и AAA');
  });

  it('экранированный \\# не раскрывается', () => {
    const index = indexOf([snippet('a', 'AAA')]);
    const res = expandSnippetMentions('\\#a', { index });
    expect(res.text).toBe('\\#a');
    expect(res.applied).toEqual([]);
  });
});

describe('expandSnippetMentions — рекурсии нет', () => {
  it('# внутри тела сниппета остаётся текстом', () => {
    const index = indexOf([snippet('outer', 'начало #inner конец'), snippet('inner', 'ВНУТРИ')]);
    const res = expandSnippetMentions('#outer', { index });
    expect(res.text).toBe('начало #inner конец');
    expect(res.applied).toEqual(['outer']);
  });
});

describe('expandSnippetMentions — лимиты', () => {
  it('не более 15 раскрытий на сообщение', () => {
    const snippets = Array.from({ length: 20 }, (_, i) => snippet(`s${i}`, `S${i}`));
    const index = indexOf(snippets);
    const text = snippets.map((s) => `#${s.name}`).join(' ');
    const res = expandSnippetMentions(text, { index });
    expect(res.applied).toHaveLength(MAX_SNIPPET_EXPANSIONS);
    expect(res.text.startsWith('S0 S1')).toBe(true);
    expect(res.text).toContain('#s15');
    expect(res.diagnostics.some((d) => d.code === 'limit-exceeded')).toBe(true);
  });

  it('не более 64 КБ на сообщение', () => {
    const big = 'x'.repeat(MAX_SNIPPET_BYTES + 100);
    const index = indexOf([snippet('big', big)]);
    const res = expandSnippetMentions('#big', { index });
    expect(res.text).toBe('#big');
    expect(res.applied).toEqual([]);
    expect(res.diagnostics.some((d) => d.code === 'limit-exceeded')).toBe(true);
  });

  it('в пределах лимита раскрытие проходит', () => {
    const body = 'y'.repeat(1000);
    const index = indexOf([snippet('ok', body)]);
    const res = expandSnippetMentions('#ok', { index });
    expect(res.text).toBe(body);
    expect(res.applied).toEqual(['ok']);
  });
});

describe('expandSnippetMentions — доверие', () => {
  it('недоверенный сниппет не раскрывается, но объясняется диагностикой', () => {
    const index = indexOf([snippet('p', 'ПРОЕКТ', { trusted: false, scope: 'project' })]);
    const res = expandSnippetMentions('см. #p', { index });
    expect(res.text).toBe('см. #p');
    expect(res.applied).toEqual([]);
    expect(res.diagnostics.some((d) => d.code === 'untrusted' && d.snippet === 'p')).toBe(true);
  });
});
