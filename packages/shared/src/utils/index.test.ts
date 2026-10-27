import { describe, it, expect, vi } from 'vitest';
import { generateId, generateStreamId, formatISODate, nowISO, safeJsonParse, atomicWrite, AsyncLock, pickLocalized, stripNullBytes, stripNullBytesDeep, makeMediaPart, makeTextPart, buildContentFromParts, mediaTypeOfMime, appendMediaPlaceholders } from './index.js';

describe('generateId', () => {
  it('возвращает строку в формате timestamp-counter-random', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    const parts = id.split('-');
    expect(parts.length).toBeGreaterThanOrEqual(3);
  });

  it('генерирует уникальные ID при последовательных вызовах', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateId());
    }
    expect(ids.size).toBe(100);
  });
});

describe('generateStreamId', () => {
  it('начинается с stream-', () => {
    expect(generateStreamId()).toMatch(/^stream-/);
  });

  it('генерирует уникальные ID', () => {
    const a = generateStreamId();
    const b = generateStreamId();
    expect(a).not.toBe(b);
  });
});

describe('formatISODate', () => {
  it('возвращает ISO строку', () => {
    const date = new Date('2025-01-15T10:30:00Z');
    expect(formatISODate(date)).toBe('2025-01-15T10:30:00.000Z');
  });
});

describe('nowISO', () => {
  it('возвращает строку заканчивающуюся на Z', () => {
    expect(nowISO()).toContain('Z');
  });
});

describe('safeJsonParse', () => {
  it('парсит валидный JSON', () => {
    expect(safeJsonParse('{"a":1}', { a: 0 })).toEqual({ a: 1 });
  });

  it('возвращает fallback при невалидном JSON', () => {
    const fallback = { default: true };
    expect(safeJsonParse('not json', fallback)).toBe(fallback);
  });

  it('возвращает fallback при пустой строке', () => {
    expect(safeJsonParse('', [])).toEqual([]);
  });

  it('НЕ валидирует структуру — возвращает результат как T', () => {
    // safeJsonParse кастует результат к T без проверки
    const result = safeJsonParse<{ name: string; age: number }>('{"x":1}', {} as never);
    // TS позволяет, но структура не та
    expect(result).toEqual({ x: 1 });
  });
});

describe('atomicWrite', () => {
  it('пишет во временный файл, затем переименовывает', async () => {
    const calls: string[] = [];
    const fakeWrite = vi.fn(async (path: string, data: string) => {
      calls.push(`write:${path}`);
    });
    const fakeRename = vi.fn(async (oldPath: string, newPath: string) => {
      calls.push(`rename:${oldPath}->${newPath}`);
    });

    await atomicWrite(fakeWrite, fakeRename, '/target/path.json', 'content');

    expect(fakeWrite).toHaveBeenCalledTimes(1);
    expect(fakeRename).toHaveBeenCalledTimes(1);

    // Проверяем что временный файл содержит .tmp. в имени
    const tmpPath = fakeWrite.mock.calls[0]?.[0] ?? '';
    expect(tmpPath).toContain('.tmp.');

    // Ренейм идёт на целевой путь
    expect(fakeRename.mock.calls[0]?.[1]).toBe('/target/path.json');
  });

  it('не оставляет временный файл после успешного rename (проверка корректности сигнатуры)', async () => {
    // atomicWrite не делает cleanup после rename — это проверка контракта
    const fakeWrite = vi.fn();
    const fakeRename = vi.fn();

    await atomicWrite(fakeWrite, fakeRename, '/path.json', 'data');

    // writeFile был вызван ровно 1 раз (нет повторного вызова для cleanup)
    expect(fakeWrite).toHaveBeenCalledTimes(1);
  });
});

describe('AsyncLock', () => {
  it('первый acquire проходит мгновенно', async () => {
    const lock = new AsyncLock();
    const start = Date.now();
    await lock.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('второй acquire ждёт release', async () => {
    const lock = new AsyncLock();
    await lock.acquire();

    let resolved = false;
    const p2 = lock.acquire().then(() => {
      resolved = true;
    });

    // Не должно разрешиться до release
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    lock.release();
    await p2;
    expect(resolved).toBe(true);
  });

  it('вызовы acquire обрабатываются в порядке FIFO', async () => {
    const lock = new AsyncLock();
    await lock.acquire();

    const order: number[] = [];
    const p2 = lock.acquire().then(() => order.push(2));
    const p3 = lock.acquire().then(() => order.push(3));

    lock.release();
    // После первого release должен разблокироваться p2
    await new Promise((r) => setTimeout(r, 10));
    // Но p2 сам залочил — нужно ещё release
    lock.release();

    await Promise.all([p2, p3]);
    expect(order).toEqual([2, 3]);
  });

  it('release без acquire не ломается', () => {
    const lock = new AsyncLock();
    expect(() => lock.release()).not.toThrow();
  });

  it('множественные acquire/release циклы работают', async () => {
    const lock = new AsyncLock();
    for (let i = 0; i < 5; i++) {
      await lock.acquire();
      lock.release();
    }
    // После цикла замок должен быть свободен
    const start = Date.now();
    await lock.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe('pickLocalized', () => {
  it('выбирает значение для указанного языка', () => {
    const record = { en: 'Hello', ru: 'Привет' };
    expect(pickLocalized(record, 'en')).toBe('Hello');
    expect(pickLocalized(record, 'ru')).toBe('Привет');
  });

  it('возвращается к fallbackLang если язык не найден', () => {
    const record = { ru: 'Привет' };
    expect(pickLocalized(record, 'en', 'ru')).toBe('Привет');
  });

  it('возвращает undefined если ни язык ни fallback не найдены', () => {
    const record: Record<string, string> = {};
    expect(pickLocalized(record, 'en')).toBeUndefined();
  });
});

describe('stripNullBytes', () => {
  it('удаляет реальные U+0000, остальные символы сохраняет', () => {
    expect(stripNullBytes('a\u0000b\u0000')).toBe('ab');
    expect(stripNullBytes('привет\u0000 мир')).toBe('привет мир');
  });

  it('не трогает литеральную последовательность «\\u0000»', () => {
    expect(stripNullBytes('a\\u0000b')).toBe('a\\u0000b');
  });

  it('возвращает ту же строку, если NUL нет', () => {
    const value = 'clean text';
    expect(stripNullBytes(value)).toBe(value);
  });

  it('обрабатывает пустую строку', () => {
    expect(stripNullBytes('')).toBe('');
  });
});

describe('stripNullBytesDeep', () => {
  it('рекурсивно чистит строки в массивах и plain-объектах', () => {
    const input = {
      content: 'a\u0000b',
      parts: [{ type: 'text', data: 'c\u0000d' }],
      nested: { list: ['e\u0000', 42, null] },
    };
    expect(stripNullBytesDeep(input)).toEqual({
      content: 'ab',
      parts: [{ type: 'text', data: 'cd' }],
      nested: { list: ['e', 42, null] },
    });
  });

  it('не трогает Date, Buffer и прочие non-plain объекты', () => {
    const date = new Date('2025-01-15T10:30:00Z');
    const buffer = Buffer.from('a\u0000b');
    const map = new Map([['k', 'a\u0000b']]);
    const input = { date, buffer, map };
    const result = stripNullBytesDeep(input);
    expect(result).toBe(input);
    expect(result.date).toBe(date);
    expect(result.buffer).toBe(buffer);
    expect(result.map).toBe(map);
    expect(result.buffer.toString()).toBe('a\u0000b');
  });

  it('возвращает исходное значение (ту же ссылку), если изменений нет', () => {
    const input = { content: 'clean', parts: [{ data: 'ok' }], count: 1 };
    expect(stripNullBytesDeep(input)).toBe(input);
    const list = ['a', 'b'];
    expect(stripNullBytesDeep(list)).toBe(list);
  });

  it('возвращает новую ссылку только для изменённой ветки', () => {
    const untouched = { value: 'ok' };
    const input = { dirty: 'a\u0000b', untouched };
    const result = stripNullBytesDeep(input);
    expect(result).not.toBe(input);
    expect(result.untouched).toBe(untouched);
    expect(result.dirty).toBe('ab');
  });

  it('не ломает null-prototype объекты', () => {
    const input: Record<string, unknown> = Object.create(null);
    input.value = 'a\u0000b';
    const result = stripNullBytesDeep(input);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(result.value).toBe('ab');
  });

  it('примитивы и null/undefined возвращает как есть', () => {
    expect(stripNullBytesDeep(42)).toBe(42);
    expect(stripNullBytesDeep(null)).toBeNull();
    expect(stripNullBytesDeep(undefined)).toBeUndefined();
    const str = 'a\u0000b';
    expect(stripNullBytesDeep(str)).toBe('ab');
  });
});

/**
 * ADR-115: медиа-части сообщений (вложения) — плейсхолдер в строковых
 * производных и конструктор части.
 */
describe('makeMediaPart / buildContentFromParts (ADR-115)', () => {
  const data = {
    blobPath: 'attachments/ab/abcd',
    sha256: 'abcd',
    mime: 'image/png',
    size: 12,
    name: 'photo.png',
  };

  it('makeMediaPart создаёт часть нужного типа с данными', () => {
    const part = makeMediaPart('image', data);
    expect(part.type).toBe('image');
    expect(part.data).toEqual(data);
    expect(part.id).toBeTruthy();
  });

  it('медиа-часть даёт плейсхолдер с именем файла', () => {
    const content = buildContentFromParts([makeTextPart('привет'), makeMediaPart('image', data)]);
    expect(content).toContain('[image: photo.png]');
  });

  it('медиа-часть без имени даёт плейсхолдер только с типом', () => {
    const { name: _name, ...withoutName } = data;
    const content = buildContentFromParts([makeMediaPart('file', withoutName)]);
    expect(content).toBe('[file]');
  });

  it('все медиа-типы поддержаны', () => {
    for (const type of ['image', 'audio', 'video', 'file'] as const) {
      expect(buildContentFromParts([makeMediaPart(type, data)])).toBe(`[${type}: photo.png]`);
    }
  });

  it('не дублирует плейсхолдер, уже присутствующий в тексте', () => {
    const content = buildContentFromParts([
      makeTextPart('смотри [image: photo.png]'),
      makeMediaPart('image', data),
    ]);
    expect(content).toBe('смотри [image: photo.png]');
  });
});

describe('mediaTypeOfMime (ADR-115)', () => {
  it('определяет тип по MIME (как partTypeOf ядра)', () => {
    expect(mediaTypeOfMime('image/png')).toBe('image');
    expect(mediaTypeOfMime('audio/mpeg')).toBe('audio');
    expect(mediaTypeOfMime('video/mp4')).toBe('video');
    expect(mediaTypeOfMime('application/pdf')).toBe('file');
    expect(mediaTypeOfMime('text/plain')).toBe('file');
  });

  it('не зависит от регистра и пробелов', () => {
    expect(mediaTypeOfMime(' IMAGE/PNG ')).toBe('image');
  });
});

describe('appendMediaPlaceholders (ADR-115)', () => {
  const image = (name: string) =>
    makeMediaPart('image', { blobPath: `attachments/ab/${name}`, sha256: 'sha', mime: 'image/png', size: 1, name });

  it('дописывает маркеры медиа-частей через перевод строки', () => {
    expect(appendMediaPlaceholders('смотри', [image('photo.png')])).toBe(
      'смотри\n[image: photo.png]',
    );
  });

  it('пустой текст не получает ведущего перевода строки', () => {
    expect(appendMediaPlaceholders('', [image('photo.png')])).toBe('[image: photo.png]');
  });

  it('не дублирует маркер, уже набранный вручную (идемпотентность)', () => {
    const text = 'смотри [image: photo.png]';
    expect(appendMediaPlaceholders(text, [image('photo.png')])).toBe(text);
    expect(appendMediaPlaceholders(text, [image('photo.png')])).toBe(text);
  });

  it('добавляет только отсутствующие маркеры и сохраняет порядок частей', () => {
    const result = appendMediaPlaceholders('текст [image: first.png]', [
      image('first.png'),
      image('second.png'),
    ]);
    expect(result).toBe('текст [image: first.png]\n[image: second.png]');
  });

  it('игнорирует не-медиа части и возвращает текст как есть', () => {
    const text = 'просто текст';
    expect(appendMediaPlaceholders(text, [makeTextPart('просто текст')])).toBe(text);
    expect(appendMediaPlaceholders('', [])).toBe('');
  });
});
