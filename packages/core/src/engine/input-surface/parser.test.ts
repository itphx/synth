/**
 * ADR-126 §0/§2: тесты общего core-парсера префиксов ввода (`@`, `$`, `#`).
 *
 * Проверяем лексику: границы токена, кодовые блоки, экранирование, span'ы и
 * нормализацию `id`. Разрешение сущностей (реестры) — не зона этого модуля.
 */

import { describe, it, expect } from 'vitest';
import { collectInputTokens, parseInput } from './parser.js';

describe('parseInput — упоминания `@`', () => {
  it('разбирает простое упоминание агента', () => {
    const parsed = parseInput('@alice');
    expect(parsed.mentions).toEqual([
      { kind: 'agent', id: 'alice', label: 'alice', span: { start: 0, end: 6 } },
    ]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.snippets).toEqual([]);
  });

  it('разбирает путь как file-упоминание (в id — без префикса)', () => {
    const parsed = parseInput('@src/index.ts');
    expect(parsed.mentions).toEqual([
      {
        kind: 'file',
        id: 'src/index.ts',
        label: 'src/index.ts',
        span: { start: 0, end: 13 },
      },
    ]);
  });

  it('совпадает с payload-примером ADR-126 §2 (границы и виды)', () => {
    const parsed = parseInput('@src/index.ts @reviewer посмотри');
    expect(parsed.mentions).toEqual([
      {
        kind: 'file',
        id: 'src/index.ts',
        label: 'src/index.ts',
        span: { start: 0, end: 13 },
      },
      {
        kind: 'agent',
        id: 'reviewer',
        label: 'reviewer',
        span: { start: 14, end: 23 },
      },
    ]);
  });

  it('не считает email упоминанием (токен не в начале слова)', () => {
    const parsed = parseInput('a@b.com');
    expect(parsed.mentions).toEqual([]);
  });

  it('не считает упоминанием адрес в середине слова', () => {
    expect(parseInput('mail@example.com').mentions).toEqual([]);
    expect(parseInput('почта@user').mentions).toEqual([]);
  });

  it('нормализует id: убирает завершающую пунктуацию, label сохраняет как набрано', () => {
    const parsed = parseInput('@alice,');
    expect(parsed.mentions).toEqual([
      { kind: 'agent', id: 'alice', label: 'alice,', span: { start: 0, end: 7 } },
    ]);
  });

  it('убирает закрывающую скобку из id (тело `@`-токена — без пробелов)', () => {
    const parsed = parseInput('(@alice)');
    expect(parsed.mentions).toEqual([
      { kind: 'agent', id: 'alice', label: 'alice)', span: { start: 1, end: 8 } },
    ]);
  });

  it('не создаёт токен, если после префикса пусто или пробел', () => {
    expect(parseInput('@').mentions).toEqual([]);
    expect(parseInput('@ alice').mentions).toEqual([]);
    expect(parseInput('@@alice').mentions).toEqual([]);
  });
});

describe('parseInput — скиллы `$`', () => {
  it('разбирает вызов скилла', () => {
    const parsed = parseInput('$skill');
    expect(parsed.skills).toEqual([{ id: 'skill', label: 'skill', span: { start: 0, end: 6 } }]);
  });

  it('не считает цену скиллом (имя не начинается с буквы)', () => {
    expect(parseInput('$5').skills).toEqual([]);
    expect(parseInput('стоит $5').skills).toEqual([]);
  });

  it('разбирает имя скилла с дефисом и подчёркиванием', () => {
    const parsed = parseInput('$my-skill_2');
    expect(parsed.skills).toEqual([
      { id: 'my-skill_2', label: 'my-skill_2', span: { start: 0, end: 11 } },
    ]);
  });
});

describe('parseInput — сниппеты `#`', () => {
  it('разбирает ссылку на сниппет', () => {
    const parsed = parseInput('#snippet');
    expect(parsed.snippets).toEqual([
      { id: 'snippet', label: 'snippet', span: { start: 0, end: 8 } },
    ]);
  });

  it('не считает markdown-заголовок сниппетом', () => {
    expect(parseInput('# Heading').snippets).toEqual([]);
    expect(parseInput('## heading').snippets).toEqual([]);
    expect(parseInput('### heading').snippets).toEqual([]);
    expect(parseInput('#123').snippets).toEqual([]);
  });
});

describe('parseInput — код', () => {
  it('не распознаёт токены внутри fenced-блока', () => {
    expect(parseInput('```\n@alice\n```').mentions).toEqual([]);
    expect(parseInput('```ts\n$skill\n#snippet\n```').skills).toEqual([]);
    expect(parseInput('```ts\n$skill\n#snippet\n```').snippets).toEqual([]);
  });

  it('не распознаёт токены внутри fenced-блока на тильдах', () => {
    expect(parseInput('~~~\n@alice\n~~~').mentions).toEqual([]);
  });

  it('не распознаёт токены внутри inline-кода, но распознаёт соседние', () => {
    const parsed = parseInput('проверь `@alice` и $skill');
    expect(parsed.mentions).toEqual([]);
    expect(parsed.skills).toEqual([{ id: 'skill', label: 'skill', span: { start: 19, end: 25 } }]);
  });

  it('незакрытый backtick — обычный текст, токен после него распознаётся', () => {
    const parsed = parseInput('` @alice');
    expect(parsed.mentions).toEqual([
      { kind: 'agent', id: 'alice', label: 'alice', span: { start: 2, end: 8 } },
    ]);
  });
});

describe('parseInput — экранирование', () => {
  it('экранированный префикс не создаёт токен, обратный слэш остаётся в тексте', () => {
    const parsed = parseInput('\\@alice \\$skill \\#snippet');
    expect(parsed.mentions).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.snippets).toEqual([]);
    expect(parsed.text).toBe('\\@alice \\$skill \\#snippet');
  });

  it('экранированный путь-токен не создаёт file-упоминание', () => {
    expect(parseInput('путь \\@src/index.ts').mentions).toEqual([]);
  });

  it('не экранированный соседний токен распознаётся', () => {
    const parsed = parseInput('\\@alice @bob');
    expect(parsed.mentions).toEqual([
      { kind: 'agent', id: 'bob', label: 'bob', span: { start: 8, end: 12 } },
    ]);
  });
});

describe('parseInput — несколько токенов и позиции', () => {
  it('разбирает несколько токенов с корректными span', () => {
    const parsed = parseInput('@alice и @bob');
    expect(parsed.mentions).toEqual([
      { kind: 'agent', id: 'alice', label: 'alice', span: { start: 0, end: 6 } },
      { kind: 'agent', id: 'bob', label: 'bob', span: { start: 9, end: 13 } },
    ]);
  });

  it('разбирает токены в начале, середине и после пунктуации', () => {
    const parsed = parseInput('@one, @two. @three');
    expect(parsed.mentions.map((m) => m.span)).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 18 },
    ]);
    expect(parsed.mentions.map((m) => m.id)).toEqual(['one', 'two', 'three']);
  });

  it('токен в начале строки распознаётся', () => {
    const parsed = parseInput('первая строка\n@alice');
    expect(parsed.mentions).toEqual([
      { kind: 'agent', id: 'alice', label: 'alice', span: { start: 14, end: 20 } },
    ]);
  });

  it('смешанные префиксы разбираются в свои списки', () => {
    const parsed = parseInput('@agent $skill #snippet');
    expect(parsed.mentions.map((m) => m.id)).toEqual(['agent']);
    expect(parsed.skills.map((s) => s.id)).toEqual(['skill']);
    expect(parsed.snippets.map((s) => s.id)).toEqual(['snippet']);
  });
});

describe('parseInput — кириллица и границы', () => {
  it('поддерживает кириллицу в label и id', () => {
    const parsed = parseInput('@Алиса $привет #заметка');
    expect(parsed.mentions).toEqual([
      { kind: 'agent', id: 'Алиса', label: 'Алиса', span: { start: 0, end: 6 } },
    ]);
    expect(parsed.skills).toEqual([{ id: 'привет', label: 'привет', span: { start: 7, end: 14 } }]);
    expect(parsed.snippets).toEqual([
      { id: 'заметка', label: 'заметка', span: { start: 15, end: 23 } },
    ]);
  });

  it('пустой текст даёт пустой результат', () => {
    const parsed = parseInput('');
    expect(parsed.text).toBe('');
    expect(parsed.mentions).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.snippets).toEqual([]);
  });

  it('текст не изменяется', () => {
    const text = '@alice, $skill #snippet';
    expect(parseInput(text).text).toBe(text);
  });
});

describe('collectInputTokens', () => {
  it('склеивает токены в один список в порядке появления', () => {
    const parsed = parseInput('@alice $skill #snippet');
    expect(collectInputTokens(parsed)).toEqual([
      { kind: 'mention', id: 'alice', label: 'alice', span: { start: 0, end: 6 } },
      { kind: 'skill', id: 'skill', label: 'skill', span: { start: 7, end: 13 } },
      { kind: 'snippet', id: 'snippet', label: 'snippet', span: { start: 14, end: 22 } },
    ]);
  });
});
