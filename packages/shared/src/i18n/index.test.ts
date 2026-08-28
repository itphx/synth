import { describe, it, expect } from 'vitest';
import {
  ENGINE_MESSAGE_KEYS,
  ENGINE_MESSAGE_PARAMS,
  extractParams,
  type EngineMessageKey,
} from './index.js';

describe('extractParams', () => {
  it('извлекает имена {param}-плейсхолдеров в порядке появления', () => {
    expect(extractParams('Session link: {label} ({id}, messages {from}-{to})')).toEqual([
      'label',
      'id',
      'from',
      'to',
    ]);
  });

  it('не содержит дубликатов', () => {
    expect(extractParams('x {a} {a} y {b}')).toEqual(['a', 'b']);
  });

  it('игнорирует пустые/чисто-пробельные плейсхолдеры и возвращает пустой массив для строк без плейсхолдеров', () => {
    expect(extractParams('plain text')).toEqual([]);
    expect(extractParams('{ }')).toEqual([]);
    expect(extractParams('')).toEqual([]);
  });
});

describe('контракт движковых сообщений', () => {
  it('ключи непустые и уникальные', () => {
    expect(ENGINE_MESSAGE_KEYS.length).toBeGreaterThan(0);
    expect(new Set(ENGINE_MESSAGE_KEYS).size).toBe(ENGINE_MESSAGE_KEYS.length);
  });

  it('ENGINE_MESSAGE_PARAMS покрывает ровно все ENGINE_MESSAGE_KEYS', () => {
    const paramKeys = Object.keys(ENGINE_MESSAGE_PARAMS).sort();
    expect(paramKeys).toEqual([...ENGINE_MESSAGE_KEYS].sort());
  });

  it('значения ENGINE_MESSAGE_PARAMS — строковые массивы без дубликатов', () => {
    for (const key of Object.keys(ENGINE_MESSAGE_PARAMS) as EngineMessageKey[]) {
      const params = ENGINE_MESSAGE_PARAMS[key];
      expect(Array.isArray(params), `params для ${key} не массив`).toBe(true);
      expect(new Set(params).size).toBe(params.length);
      for (const p of params) {
        expect(typeof p).toBe('string');
      }
    }
  });
});
