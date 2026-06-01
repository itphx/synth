import { describe, it, expect, vi } from 'vitest';
import { generateId, generateStreamId, formatISODate, nowISO, safeJsonParse, atomicWrite, AsyncLock, pickLocalized } from './index.js';

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
